from __future__ import annotations

import argparse
import asyncio
import json
import math
import time

try:  # Support both `python tools/load_probe.py` and `python -m tools.load_probe`.
    from .precision_probe import add_measurement_arguments, distribution, run_probe
except ImportError:
    from precision_probe import add_measurement_arguments, distribution, run_probe


async def run_load_probe(
    base_url: str,
    room_count: int,
    clients_per_room: int,
    receive_jitter_ms: float,
    insecure: bool,
    *,
    command_count: int = 20,
    command_interval_ms: float = 100.0,
    command_timeout_s: float = 5.0,
    slow_readers: int = 0,
    slow_read_ms: float = 250.0,
    room_stagger_ms: float = 0.0,
) -> dict[str, object]:
    if room_count < 1 or clients_per_room < 2:
        raise ValueError("need >=1 room and >=2 clients per room")
    if not math.isfinite(room_stagger_ms) or room_stagger_ms < 0:
        raise ValueError("room_stagger_ms must be finite and non-negative")

    async def probe_room(index: int):
        await asyncio.sleep(index * room_stagger_ms / 1000.0)
        return await run_probe(
            base_url, clients_per_room, receive_jitter_ms=receive_jitter_ms,
            calibration_stagger_ms=250.0, cohort_timeout_s=12.0,
            insecure=insecure, command_count=command_count,
            command_interval_ms=command_interval_ms,
            command_timeout_s=command_timeout_s, slow_readers=slow_readers,
            slow_read_ms=slow_read_ms,
        )

    started_at = time.monotonic()
    outcomes = await asyncio.gather(
        *(probe_room(index) for index in range(room_count)), return_exceptions=True,
    )
    elapsed_s = time.monotonic() - started_at
    results = [result for result in outcomes if isinstance(result, dict)]
    failures = [
        {"room_index": index, "error_type": type(result).__name__, "message": str(result)}
        for index, result in enumerate(outcomes) if isinstance(result, BaseException)
    ]
    latencies, healthy_latencies, slow_latencies = [], [], []
    for result in results:
        for command in result["commands"]:
            for index, latency in enumerate(command["delivery_latency_ms_by_client"]):
                if latency is not None:
                    latencies.append(latency)
                    (slow_latencies if slow_readers and index >= clients_per_room - slow_readers
                     else healthy_latencies).append(latency)
    return {
        "room_count": room_count, "clients_per_room": clients_per_room,
        "total_clients": room_count * clients_per_room,
        "command_count_per_room": command_count,
        "command_interval_ms": command_interval_ms,
        "room_stagger_ms": room_stagger_ms,
        "injected_receive_jitter_ms": receive_jitter_ms,
        "slow_readers_per_room": slow_readers, "slow_read_ms": slow_read_ms,
        "elapsed_s": elapsed_s, "completed_rooms": len(results),
        "failed_rooms": failures,
        "expected_deliveries": room_count * clients_per_room * command_count,
        "completed_deliveries": len(latencies),
        "missing_deliveries": room_count * clients_per_room * command_count - len(latencies),
        "passed_rooms": sum(bool(result["passed_under_100ms"]) for result in results),
        "all_rooms_passed_under_100ms": len(results) == room_count and not failures and all(
            bool(result["passed_under_100ms"]) for result in results
        ),
        # Pool individual observations; a percentile of per-room percentiles is misleading.
        "delivery_latency_ms": distribution(latencies),
        "healthy_reader_delivery_latency_ms": distribution(healthy_latencies),
        "slow_reader_delivery_latency_ms": distribution(slow_latencies),
        "fanout_skew_ms": distribution([
            float(result["fanout_skew_ms"]) for result in results
            if result["fanout_skew_ms"] is not None
        ]),
        "projected_timeline_spread_ms": distribution([
            float(result["projected_timeline_spread_ms"]) for result in results
            if result["projected_timeline_spread_ms"] is not None
        ]),
        "measurement_limits": [
            "One probe process measures WebSocket control delivery, not YouTube video latency or buffering.",
            "Artificial processing delays/slow reads do not emulate Wi-Fi airtime, packet loss, or bandwidth limits.",
            "Reported latency percentiles cover successful deliveries; inspect missing_deliveries and failed_rooms.",
            "Clients are requested concurrently but setup/measurement phases can overlap; this is not a steady-state capacity certificate.",
        ],
        "rooms": results,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure command delivery across concurrent Watch Party rooms.")
    parser.add_argument("--url", default="http://127.0.0.1:3055")
    parser.add_argument("--rooms", type=int, default=10)
    parser.add_argument("--clients-per-room", type=int, default=5)
    parser.add_argument("--receive-jitter-ms", type=float, default=0.0)
    parser.add_argument("--room-stagger-ms", type=float, default=0.0, help="delay between starting rooms")
    parser.add_argument("--insecure", action="store_true")
    add_measurement_arguments(parser)
    args = parser.parse_args()
    try:
        result = asyncio.run(run_load_probe(
            args.url.rstrip("/"), args.rooms, args.clients_per_room,
            args.receive_jitter_ms, args.insecure, command_count=args.commands,
            command_interval_ms=args.command_interval_ms,
            command_timeout_s=args.command_timeout_s, slow_readers=args.slow_readers,
            slow_read_ms=args.slow_read_ms, room_stagger_ms=args.room_stagger_ms,
        ))
    except ValueError as exc:
        parser.error(str(exc))
    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True, allow_nan=False))
    return 0 if result["all_rooms_passed_under_100ms"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
