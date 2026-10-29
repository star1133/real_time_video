from __future__ import annotations

import argparse
import asyncio
import json
import math
import re
import ssl
import statistics
import time
import uuid
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlparse

import httpx
import websockets


def local_ms() -> float:
    return time.perf_counter_ns() / 1_000_000.0


def distribution(values: list[float]) -> dict[str, float | int | None]:
    """Nearest-rank percentiles: tails must not be averaged away at small n."""
    ordered = sorted(values)
    return {
        "count": len(ordered),
        "median": statistics.median(ordered) if ordered else None,
        "p95": ordered[math.ceil(len(ordered) * 0.95) - 1] if ordered else None,
        "p99": ordered[math.ceil(len(ordered) * 0.99) - 1] if ordered else None,
        "max": ordered[-1] if ordered else None,
    }


@dataclass(slots=True)
class ReceivedEvent:
    message: dict[str, object]
    received_ms: float
    delivered_ms: float


@dataclass(slots=True)
class ProbeClient:
    websocket: object
    role: str
    receive_delay_ms: float = 0.0
    read_pause_ms: float = 0.0
    offset_ms: float = 0.0
    rtt_ms: float = math.inf
    uncertainty_ms: float = math.inf
    latest_state: dict[str, object] | None = None
    last_cohort: dict[str, object] | None = None
    received_bytes: int = 0
    received_messages: int = 0
    reader_task: asyncio.Task | None = None
    receive_error: Exception | None = None
    waiters: list[tuple[str, Callable, asyncio.Future]] = field(default_factory=list)

    def server_now(self, now_ms: float | None = None) -> float:
        return (local_ms() if now_ms is None else now_ms) + self.offset_ms

    def expect_type(
        self, event_type: str, predicate: Callable | None = None
    ) -> asyncio.Future:
        future = asyncio.get_running_loop().create_future()
        if self.receive_error is not None:
            future.set_exception(self.receive_error)
        else:
            self.waiters.append((event_type, predicate or (lambda _: True), future))
        return future

    async def read_messages(self) -> None:
        """One reader per connection; drain heartbeats even while other peers lag."""
        try:
            while True:
                if self.read_pause_ms:
                    await asyncio.sleep(self.read_pause_ms / 1000.0)
                raw = await self.websocket.recv()
                received_ms = local_ms()
                self.received_bytes += len(raw.encode() if isinstance(raw, str) else raw)
                self.received_messages += 1
                message = json.loads(raw)
                if not isinstance(message, dict):
                    raise RuntimeError("server sent a non-object message")
                if message.get("type") == "ERROR":
                    raise RuntimeError(str(message.get("message")))
                # Fixed processing delay is separate from the socket receive timestamp.
                if self.receive_delay_ms:
                    await asyncio.sleep(self.receive_delay_ms / 1000.0)
                event = ReceivedEvent(message, received_ms, local_ms())
                if message.get("type") in {"STATE", "TIMELINE"}:
                    self.latest_state = message
                    if isinstance(message.get("cohort"), dict):
                        self.last_cohort = message["cohort"]
                pending = []
                for event_type, predicate, future in self.waiters:
                    if future.done():
                        continue
                    if message.get("type") == event_type and predicate(message):
                        future.set_result(event)
                    else:
                        pending.append((event_type, predicate, future))
                self.waiters = pending
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self.receive_error = exc
            for _, _, future in self.waiters:
                if not future.done():
                    future.set_exception(exc)
            self.waiters.clear()

    async def calibrate_clock(self, sample_count: int = 12, keep_count: int = 6) -> None:
        measurements = []
        for sample_id in range(sample_count):
            pong_future = self.expect_type(
                "CLOCK_PONG", lambda message, expected=sample_id: message.get("id") == expected
            )
            t0 = local_ms()
            await self.websocket.send(json.dumps({
                "type": "CLOCK_PING", "id": sample_id, "client_send_ms": t0,
            }))
            event = await asyncio.wait_for(pong_future, 5.0)
            t1 = float(event.message["server_receive_ms"])
            t2 = float(event.message["server_send_ms"])
            t3 = event.received_ms
            rtt = max(0.0, (t3 - t0) - (t2 - t1))
            measurements.append((rtt, ((t1 - t0) + (t2 - t3)) / 2.0))
        best = sorted(measurements)[:keep_count]
        self.rtt_ms = statistics.median(item[0] for item in best)
        self.offset_ms = statistics.median(item[1] for item in best)
        self.uncertainty_ms = self.rtt_ms / 2.0

    async def close(self) -> None:
        if self.reader_task is not None:
            self.reader_task.cancel()
            await asyncio.gather(self.reader_task, return_exceptions=True)
        for _, _, future in self.waiters:
            future.cancel()
        self.waiters.clear()
        await self.websocket.close()


async def open_client(
    ws_url: str, origin: str, token: str | None, insecure: bool = False,
) -> ProbeClient:
    # Bound buffering so a paused application can eventually apply TCP backpressure.
    connect_options: dict[str, object] = {
        "origin": origin, "max_queue": 1, "compression": None,
        "open_timeout": 10.0, "close_timeout": 2.0,
    }
    if insecure and ws_url.startswith("wss://"):
        connect_options["ssl"] = ssl._create_unverified_context()
    websocket = await websockets.connect(ws_url, **connect_options)
    try:
        await websocket.send(json.dumps({"type": "HELLO", "host_token": token}))
        welcome = json.loads(await asyncio.wait_for(websocket.recv(), 5.0))
        if welcome.get("type") != "WELCOME":
            raise RuntimeError(f"expected WELCOME, got {welcome.get('type')}")
        client = ProbeClient(websocket=websocket, role=str(welcome["role"]))
        client.latest_state = welcome.get("state")
        client.reader_task = asyncio.create_task(client.read_messages())
        return client
    except BaseException:
        await websocket.close()
        raise


async def create_room(base_url: str, insecure: bool = False) -> tuple[str, str]:
    async with httpx.AsyncClient(
        base_url=base_url, follow_redirects=False, verify=not insecure,
    ) as client:
        response = await client.post("/rooms")
        if response.status_code != 303:
            response.raise_for_status()
            raise RuntimeError(f"expected 303 room redirect, got {response.status_code}")
    location = response.headers["location"]
    match = re.fullmatch(r"/room/(\d{3})#host=([A-Za-z0-9_-]+)", location)
    if not match:
        raise RuntimeError("unexpected room redirect format")
    return match.group(1), match.group(2)


async def run_probe(
    base_url: str,
    client_count: int,
    receive_jitter_ms: float = 0.0,
    calibration_stagger_ms: float = 1000.0,
    cohort_timeout_s: float = 8.0,
    insecure: bool = False,
    *,
    command_count: int = 20,
    command_interval_ms: float = 100.0,
    command_timeout_s: float = 5.0,
    slow_readers: int = 0,
    slow_read_ms: float = 250.0,
) -> dict[str, object]:
    parsed = urlparse(base_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("base URL must be an absolute http(s) URL")
    if client_count < 2 or command_count < 1 or not 0 <= slow_readers < client_count:
        raise ValueError("need >=2 clients, >=1 command, and fewer slow readers than clients")
    for name, value in {
        "receive_jitter_ms": receive_jitter_ms,
        "calibration_stagger_ms": calibration_stagger_ms,
        "command_interval_ms": command_interval_ms,
        "slow_read_ms": slow_read_ms,
    }.items():
        if not math.isfinite(value) or value < 0:
            raise ValueError(f"{name} must be finite and non-negative")
    if not all(math.isfinite(value) and value > 0 for value in (
        cohort_timeout_s, command_timeout_s,
    )):
        raise ValueError("timeouts must be finite and positive")
    origin = f"{parsed.scheme}://{parsed.netloc}"
    ws_scheme = "wss" if parsed.scheme == "https" else "ws"
    room_id, host_token = await create_room(base_url, insecure=insecure)
    ws_url = f"{ws_scheme}://{parsed.netloc}/ws/{room_id}"
    clients: list[ProbeClient] = []
    pending_tasks: list[asyncio.Task] = []
    try:
        async def connect(index: int) -> ProbeClient:
            client = await open_client(ws_url, origin, host_token if index == 0 else None, insecure)
            clients.append(client)  # Retain successful connections even if another fails.
            return client

        connections = await asyncio.gather(
            *(connect(index) for index in range(client_count)), return_exceptions=True,
        )
        for result in connections:
            if isinstance(result, BaseException):
                raise result
        clients = list(connections)
        if clients[0].role != "host" or sum(c.role == "host" for c in clients) != 1:
            raise RuntimeError("probe did not establish exactly one Host")
        host = clients[0]

        async def calibrate(index: int, client: ProbeClient) -> None:
            await asyncio.sleep(calibration_stagger_ms * index / (client_count - 1) / 1000.0)
            await client.calibrate_clock()

        await asyncio.gather(*(calibrate(i, c) for i, c in enumerate(clients)))

        async def issue(action: str, media_time_s: float = 0.0):
            command_id = str(uuid.uuid4())
            futures = [client.expect_type(
                "STATE", lambda message: message.get("command_id") == command_id,
            ) for client in clients]
            sent_ms = local_ms()
            # Start receipt deadlines before send; slow readers do not throttle issuance.
            tasks = [asyncio.create_task(asyncio.wait_for(future, command_timeout_s)) for future in futures]
            pending_tasks.extend(tasks)
            await host.websocket.send(json.dumps({
                "type": "CONTROL", "action": action, "command_id": command_id,
                "media_time_s": media_time_s, "observed_server_ms": host.server_now(sent_ms),
                **({"url": "https://youtu.be/M7lc1UVf-VE"} if action == "SET_VIDEO" else {}),
            }))
            return command_id, sent_ms, tasks

        _, _, setup_tasks = await issue("SET_VIDEO")
        await asyncio.gather(*setup_tasks)
        for index, client in enumerate(clients):
            # Delays begin after calibration; they cannot masquerade as clock offsets.
            client.receive_delay_ms = receive_jitter_ms * index / (client_count - 1)
            if slow_readers and index >= client_count - slow_readers:
                client.read_pause_ms = slow_read_ms

        rounds = []
        measure_started_ms = local_ms()
        for sequence in range(command_count):
            scheduled_ms = measure_started_ms + sequence * command_interval_ms
            await asyncio.sleep(max(0.0, scheduled_ms - local_ms()) / 1000.0)
            command_id, sent_ms, tasks = await issue("PLAY" if sequence == 0 else "SEEK", 10.0 + sequence)
            rounds.append((command_id, sent_ms, scheduled_ms, tasks))
        # Gather all timeouts/errors, including those that finish while sending later commands.
        await asyncio.gather(*pending_tasks, return_exceptions=True)
        measurement_elapsed_s = (local_ms() - measure_started_ms) / 1000.0

        latencies, fast_latencies, slow_latencies, receive_latencies, skews, spreads = [], [], [], [], [], []
        failures = []
        command_results = []
        for command_id, sent_ms, scheduled_ms, tasks in rounds:
            events = await asyncio.gather(*tasks, return_exceptions=True)
            arrivals = []
            projected = []
            for index, event in enumerate(events):
                if not isinstance(event, ReceivedEvent):
                    failures.append({"command_id": command_id, "client_index": index,
                                     "error_type": type(event).__name__, "message": str(event)})
                    continue
                latency = event.delivered_ms - sent_ms
                latencies.append(latency)
                (slow_latencies if clients[index].read_pause_ms else fast_latencies).append(latency)
                receive_latencies.append(event.received_ms - sent_ms)
                arrivals.append(event.delivered_ms)
                state = event.message
                # Project to the same command timestamp, independent of arrival ordering.
                projected.append(float(state["media_time_s"]) + max(
                    0.0, clients[index].server_now(sent_ms + 10_000.0) - float(state["anchor_server_ms"]),
                ) / 1000.0)
            skew = max(arrivals) - min(arrivals) if len(arrivals) == client_count else None
            spread = (max(projected) - min(projected)) * 1000.0 if len(projected) == client_count else None
            if skew is not None:
                skews.append(skew)
                spreads.append(spread)
            command_results.append({
                "command_id": command_id, "delivered_clients": len(arrivals),
                "send_schedule_lag_ms": sent_ms - scheduled_ms,
                "fanout_skew_ms": skew, "projected_timeline_spread_ms": spread,
                "max_delivery_latency_ms": max(arrivals) - sent_ms if arrivals else None,
                "delivery_latency_ms_by_client": [
                    event.delivered_ms - sent_ms if isinstance(event, ReceivedEvent) else None
                    for event in events
                ],
            })

        async def pump_samples(client: ProbeClient) -> None:
            while True:
                state = client.latest_state
                observed_ms = client.server_now()
                media_time = float(state["media_time_s"]) + max(
                    0.0, observed_ms - float(state["anchor_server_ms"]),
                ) / 1000.0
                await client.websocket.send(json.dumps({
                    "type": "CLIENT_SAMPLE", "media_time_s": media_time,
                    "observed_server_ms": observed_ms, "is_playing": True,
                    "buffering": False, "playback_rate": 1.0,
                    "rtt_ms": client.rtt_ms, "uncertainty_ms": client.uncertainty_ms,
                }))
                await asyncio.sleep(0.5 if client.role == "host" else 1.0)

        cohort = None
        sample_tasks = [asyncio.create_task(pump_samples(client)) for client in clients]
        pending_tasks.extend(sample_tasks)
        try:
            deadline = time.monotonic() + cohort_timeout_s
            while time.monotonic() < deadline:
                if host.last_cohort and host.last_cohort.get("healthy_count") == client_count:
                    cohort = host.last_cohort
                    break
                await asyncio.sleep(0.05)
        finally:
            for task in sample_tasks:
                task.cancel()
            await asyncio.gather(*sample_tasks, return_exceptions=True)
        uncertainties = [client.uncertainty_ms for client in clients]
        result = {
            "room_id": room_id, "client_count": client_count, "host_count": 1,
            "command_count": command_count,
            "command_interval_ms": command_interval_ms,
            "measurement_elapsed_s": measurement_elapsed_s,
            "expected_deliveries": command_count * client_count,
            "completed_deliveries": len(latencies), "delivery_failures": failures,
            "injected_receive_jitter_ms": receive_jitter_ms,
            "calibration_stagger_ms": calibration_stagger_ms,
            "slow_readers": slow_readers, "slow_read_ms": slow_read_ms,
            "delivery_latency_ms": distribution(latencies),
            "healthy_reader_delivery_latency_ms": distribution(fast_latencies),
            "slow_reader_delivery_latency_ms": distribution(slow_latencies),
            "socket_receive_latency_ms": distribution(receive_latencies),
            "send_schedule_lag_ms": distribution([r["send_schedule_lag_ms"] for r in command_results]),
            "fanout_skew_ms": max(skews) if skews else None,
            "projected_timeline_spread_ms": max(spreads) if spreads else None,
            "median_clock_uncertainty_ms": statistics.median(uncertainties),
            "max_clock_uncertainty_ms": max(uncertainties),
            "received_payload_bytes": sum(client.received_bytes for client in clients),
            "received_messages": sum(client.received_messages for client in clients),
            "cohort": cohort or host.last_cohort, "cohort_complete": cohort is not None,
            "commands": command_results,
            "measurement_limits": [
                "Measures control messages using one probe process clock, not video playback or YouTube buffering.",
                "Timeline/cohort samples are synthesized from server state, not real player observations.",
                "Receive jitter is a deterministic per-client processing delay, not network jitter or packet loss.",
                "Slow readers pause recv with max_queue=1; kernel/TCP buffers may absorb this short test.",
                "Probe CPU scheduling and network load affect results; inspect send_schedule_lag_ms.",
            ],
        }
        result["passed_under_100ms"] = bool(
            not failures and len(latencies) == command_count * client_count
            and max(latencies) < 100.0 and len(skews) == command_count
            and max(skews) < 100.0 and max(spreads) < 100.0
            and cohort is not None and cohort.get("all_within_100ms") is True
        )
        return result
    finally:
        for task in pending_tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*pending_tasks, return_exceptions=True)
        await asyncio.gather(*(client.close() for client in clients), return_exceptions=True)


def add_measurement_arguments(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--commands", type=int, default=20, help="measured PLAY/SEEK commands per room")
    parser.add_argument("--command-interval-ms", type=float, default=100.0)
    parser.add_argument("--command-timeout-s", type=float, default=5.0)
    parser.add_argument("--slow-readers", type=int, default=0, help="slow viewers per room (Host stays healthy)")
    parser.add_argument("--slow-read-ms", type=float, default=250.0, help="pause before each recv after clock calibration")


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure repeated, command-correlated WebSocket delivery latency.")
    parser.add_argument("--url", default="http://127.0.0.1:3055")
    parser.add_argument("--clients", type=int, default=12)
    parser.add_argument("--receive-jitter-ms", type=float, default=0.0, help="maximum artificial processing delay; not network jitter")
    parser.add_argument("--calibration-stagger-ms", type=float, default=1000.0)
    parser.add_argument("--cohort-timeout-s", type=float, default=8.0)
    parser.add_argument("--insecure", action="store_true", help="disable TLS verification for a diagnostic tunnel")
    add_measurement_arguments(parser)
    args = parser.parse_args()
    try:
        result = asyncio.run(run_probe(
            args.url.rstrip("/"), args.clients, args.receive_jitter_ms,
            args.calibration_stagger_ms, args.cohort_timeout_s, args.insecure,
            command_count=args.commands, command_interval_ms=args.command_interval_ms,
            command_timeout_s=args.command_timeout_s, slow_readers=args.slow_readers,
            slow_read_ms=args.slow_read_ms,
        ))
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False))
    return 0 if result["passed_under_100ms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
