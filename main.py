from __future__ import annotations

import asyncio
import io
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import re
import secrets
from contextlib import asynccontextmanager, suppress
from pathlib import Path
from urllib.parse import urlparse

import qrcode
import qrcode.image.svg
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from managers.media_info import cached_title, fetch_playlist, fetch_video_title
from managers.room_manager import PLAYLIST_IMPORT_LIMIT, RoomManager
from managers.sync import PlaybackSample, monotonic_ms
from managers.youtube import extract_youtube_video_id, parse_youtube_link


BASE_DIR = Path(__file__).resolve().parent
ROOM_CODE = re.compile(r"^\d{3}$")
HELLO_TIMEOUT_S = 5.0
MAX_MESSAGE_BYTES = 16_384
MAX_ROOM_CONNECTIONS = int(os.getenv("WATCHPARTY_MAX_ROOM_CONNECTIONS", "2000"))
P2P_ROOM_LIMIT = 8
SHARD_ID = os.getenv("WATCHPARTY_SHARD_ID", "")
if SHARD_ID and (len(SHARD_ID) != 1 or SHARD_ID not in "0123456789"):
    raise ValueError("WATCHPARTY_SHARD_ID must be one digit (0-9)")
if MAX_ROOM_CONNECTIONS < 1:
    raise ValueError("WATCHPARTY_MAX_ROOM_CONNECTIONS must be positive")
PLAYER_ERROR_MESSAGES = {
    2: "ลิงก์วิดีโอไม่ถูกต้อง",
    5: "วิดีโอนี้เล่นผ่าน embed ไม่ได้",
    100: "ไม่พบวิดีโอนี้ อาจถูกลบหรือซ่อนไว้",
    101: "เจ้าของวิดีโอไม่อนุญาตให้เล่นผ่าน embed",
    150: "เจ้าของวิดีโอไม่อนุญาตให้เล่นผ่าน embed",
    153: "YouTube ไม่ได้รับข้อมูลต้นทางของเว็บไซต์",
}
logger = logging.getLogger("watchparty.sync")
logger.setLevel(logging.INFO)
manager = RoomManager()
peer_clients: dict[str, set[WebSocket]] = {}
peer_topologies: dict[str, tuple[bool, str | None, tuple[str, ...]]] = {}
background_tasks: set[asyncio.Task[None]] = set()


class MessageBudget:
    """Bound per-connection work while allowing clock/ICE startup bursts."""

    def __init__(self) -> None:
        self.tokens = 80.0
        self.updated_ms = monotonic_ms()

    def consume(self) -> bool:
        now = monotonic_ms()
        self.tokens = min(80.0, self.tokens + (now - self.updated_ms) * 0.04)
        self.updated_ms = now
        if self.tokens < 1:
            return False
        self.tokens -= 1
        return True


def peer_topology(room_id: str) -> tuple[bool, str | None, tuple[str, ...]]:
    room = manager.rooms[room_id]
    connected = manager.connections.get(room_id, ())
    enabled = len(connected) <= P2P_ROOM_LIMIT
    capable = peer_clients.get(room_id, set())
    host_id = room.peer_ids.get(room.host_socket) if room.host_socket in capable else None
    ids = tuple(sorted(
        room.peer_ids[socket] for socket in capable
        if socket in connected
    )) if enabled else ()
    return enabled, host_id, ids


async def announce_peer_topology(room_id: str, joined: WebSocket | None = None) -> None:
    current = peer_topology(room_id)
    previous = peer_topologies.get(room_id, (True, None, ()))
    peer_topologies[room_id] = current
    if previous == current:
        return
    enabled, host_id, ids = current
    for socket in tuple(peer_clients.get(room_id, ())):
        if socket is joined:
            continue  # WELCOME already contains this client's initial topology.
        socket_peer_id = manager.rooms[room_id].peer_ids.get(socket)
        if socket_peer_id is None:
            continue  # A writer may already have evicted this slow connection.
        if previous[0] != enabled:
            await manager.send(room_id, socket, {
                "type": "PEER_MODE", "enabled": enabled,
                "host_peer_id": host_id, "peers": list(ids),
                "role": "host" if manager.is_host(room_id, socket) else "viewer",
            })
            continue
        if previous[1] != host_id:
            await manager.send(room_id, socket, {
                "type": "HOST_CHANGED", "host_peer_id": host_id,
                "role": "host" if manager.is_host(room_id, socket) else "viewer",
            })
        for peer_id in set(previous[2]) - set(ids):
            await manager.send(room_id, socket, {"type": "PEER_LEFT", "peer_id": peer_id})
        for peer_id in set(ids) - set(previous[2]):
            if peer_id != socket_peer_id:
                await manager.send(room_id, socket, {"type": "PEER_JOINED", "peer_id": peer_id})
    await asyncio.sleep(0)


def spawn(coroutine) -> None:
    task = asyncio.create_task(coroutine)
    background_tasks.add(task)
    task.add_done_callback(background_tasks.discard)


async def broadcast_queue(room_id: str) -> None:
    if room_id in manager.rooms:
        await manager.broadcast(room_id, manager.queue_message(room_id))


async def fill_titles(room_id: str, video_ids: list[str]) -> None:
    """Resolve missing labels after the queue is already visible."""
    changed = False
    for video_id in dict.fromkeys(video_ids):
        title = cached_title(video_id) or await fetch_video_title(video_id)
        if manager.set_title(room_id, video_id, title):
            changed = True
    if changed:
        await broadcast_queue(room_id)


async def start_queued(room_id: str, socket: WebSocket | None, item_id: object = None,
                       ended_video_id: object = None) -> None:
    if manager.queue_play(room_id, socket, item_id, ended_video_id=ended_video_id):
        logger.info("room=%s action=QUEUE_PLAY", room_id)
        await manager.broadcast(room_id, manager.state_message(room_id))
        await broadcast_queue(room_id)


async def import_playlist(room_id: str, websocket: WebSocket, playlist_id: str,
                          first_video_id: str | None, play_now: bool, play_next: bool,
                          added_by: str) -> None:
    room = manager.rooms.get(room_id)
    if room is None:
        return
    try:
        title, entries = await fetch_playlist(playlist_id, PLAYLIST_IMPORT_LIMIT)
        if room_id not in manager.rooms:
            return
        if first_video_id:
            # watch?v=X&list=Y starts from X, matching YouTube's own behaviour.
            ids = [entry.video_id for entry in entries]
            if first_video_id in ids:
                entries = entries[ids.index(first_video_id):]
        if not entries:
            raise ValueError("playlist นี้ไม่มีคลิปที่เล่นได้")
        added = manager.queue_add(
            room_id, websocket,
            [(entry.video_id, entry.title, entry.duration_s) for entry in entries],
            play_next=play_now or play_next,
            added_by=added_by,
        )
        logger.info("room=%s action=QUEUE_PLAYLIST items=%d", room_id, len(added))
        await manager.send(room_id, websocket, {
            "type": "NOTICE",
            "message": f"เพิ่ม {len(added)} คลิปจาก {title or 'playlist'} เข้าคิวแล้ว",
        })
    except (KeyError, PermissionError, ValueError) as exc:
        await websocket_error(websocket, str(exc), room_id)
        return
    finally:
        if room_id in manager.rooms:
            manager.rooms[room_id].importing_playlist = False
            await broadcast_queue(room_id)
    if play_now or manager.get_state(room_id).video_id is None:
        await start_queued(room_id, None)
    missing = [item.video_id for item in added if not item.title]
    if missing:
        spawn(fill_titles(room_id, missing))


async def handle_queue_message(room_id: str, websocket: WebSocket, message: dict) -> None:
    message_type = message.get("type")
    if message_type == "QUEUE_ADD":
        if not manager.can_add_to_queue(room_id, websocket):
            raise PermissionError("Host ปิดการเพิ่มคิวของผู้ชมไว้")
        video_id, playlist_id = parse_youtube_link(str(message.get("url", ""))[:2_048])
        is_host = manager.is_host(room_id, websocket)
        play_now = message.get("play_now") is True and is_host
        play_next = message.get("play_next") is True and is_host
        if message.get("playlist") is True and playlist_id:
            room = manager.rooms[room_id]
            if room.importing_playlist:
                raise ValueError("กำลังนำเข้า playlist อื่นอยู่ กรุณารอสักครู่")
            room.importing_playlist = True
            await broadcast_queue(room_id)
            spawn(import_playlist(
                room_id, websocket, playlist_id, video_id, play_now, play_next,
                "host" if is_host else "viewer",
            ))
            return
        if video_id is None:
            raise ValueError("ลิงก์นี้เป็น playlist · เลือก “นำเข้าทั้ง playlist” เพื่อเพิ่มเข้าคิว")
        added = manager.queue_add(
            room_id, websocket, [(video_id, cached_title(video_id), None)],
            play_next=play_now or play_next,
        )
        logger.info("room=%s action=QUEUE_ADD", room_id)
        await broadcast_queue(room_id)
        if play_now or manager.get_state(room_id).video_id is None:
            await start_queued(room_id, None)
        if added and not added[0].title:
            spawn(fill_titles(room_id, [video_id]))
        return
    if message_type == "QUEUE_PLAY":
        await start_queued(room_id, websocket, message.get("item_id"))
        return
    if message_type == "QUEUE_NEXT":
        ended = message.get("ended_video_id")
        if ended is None and not manager.is_host(room_id, websocket):
            raise PermissionError("เฉพาะ Host เท่านั้นที่ข้ามคลิปได้")
        await start_queued(room_id, websocket, None, ended_video_id=ended)
        return
    if message_type == "QUEUE_REMOVE":
        changed = manager.queue_remove(room_id, websocket, message.get("item_id"))
    elif message_type == "QUEUE_MOVE":
        changed = manager.queue_move(
            room_id, websocket, message.get("item_id"), message.get("delta")
        )
    elif message_type == "QUEUE_CLEAR":
        changed = manager.queue_clear(room_id, websocket)
    elif message_type == "QUEUE_SHUFFLE":
        changed = manager.queue_shuffle(room_id, websocket)
    else:  # QUEUE_SETTINGS
        changed = manager.queue_settings(
            room_id, websocket, message.get("allow_viewers"), message.get("autoplay")
        )
    if changed:
        await broadcast_queue(room_id)


QUEUE_MESSAGES = {
    "QUEUE_ADD", "QUEUE_PLAY", "QUEUE_NEXT", "QUEUE_REMOVE", "QUEUE_MOVE",
    "QUEUE_CLEAR", "QUEUE_SHUFFLE", "QUEUE_SETTINGS",
}


def configure_file_logging() -> None:
    log_path = os.getenv("WATCHPARTY_LOG_FILE", str(BASE_DIR / "watchparty.log"))
    if not log_path or any(
        getattr(handler, "_watchparty_handler", False) for handler in logger.handlers
    ):
        return
    handler = RotatingFileHandler(
        log_path,
        maxBytes=2_000_000,
        backupCount=3,
        encoding="utf-8",
    )
    handler._watchparty_handler = True  # type: ignore[attr-defined]
    handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    )
    logger.addHandler(handler)


configure_file_logging()


async def maintenance_loop() -> None:
    try:
        while True:
            frozen = manager.freeze_expired_hosts()
            for room_id in frozen:
                logger.info("host_timeout room=%s action=PAUSE", room_id)
                await manager.broadcast(room_id, manager.state_message(room_id))
            for room_id in manager.prune_inactive_rooms():
                peer_clients.pop(room_id, None)
                peer_topologies.pop(room_id, None)
                logger.info("room_expired room=%s reason=empty_ttl", room_id)
            await manager.broadcast_heartbeats()
            # Each room schedules its own cadence; a large room must not slow small rooms.
            await asyncio.sleep(0.25)
    except asyncio.CancelledError:
        raise


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(maintenance_loop())
    try:
        yield
    finally:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
        for pending in tuple(background_tasks):
            pending.cancel()
        await asyncio.gather(*background_tasks, return_exceptions=True)
        await manager.close()
        peer_clients.clear()
        peer_topologies.clear()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
templates = Jinja2Templates(directory=BASE_DIR / "templates")


@app.middleware("http")
async def security_headers(request: Request, call_next) -> Response:
    response = await call_next(request)
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault(
        "Permissions-Policy", "camera=(), microphone=(), geolocation=()"
    )
    response.headers.setdefault(
        "Content-Security-Policy",
        "default-src 'self'; "
        "base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
        "form-action 'self'; "
        "script-src 'self' https://www.youtube.com https://s.ytimg.com; "
        "frame-src https://www.youtube.com https://www.youtube-nocookie.com; "
        "img-src 'self' data: https://i.ytimg.com; "
        "style-src 'self'; connect-src 'self' ws: wss: https://www.youtube.com https://s.ytimg.com",
    )
    return response


@app.exception_handler(404)
async def not_found(_request: Request, _exc: Exception) -> Response:
    return PlainTextResponse("Not found", status_code=404)


def new_room_code() -> str:
    capacity = 100 if SHARD_ID else 1_000
    start = secrets.randbelow(capacity)
    for offset in range(capacity):
        suffix = (start + offset) % capacity
        code = f"{SHARD_ID}{suffix:02d}" if SHARD_ID else f"{suffix:03d}"
        if code not in manager.rooms:
            return code
    raise RuntimeError("ไม่สามารถสุ่มรหัสห้องที่ว่างได้")


def http_origin_allowed(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True
    parsed = urlparse(origin)
    return (
        parsed.scheme in {"http", "https"}
        and parsed.netloc.lower() == request.headers.get("host", "").lower()
        and parsed.path in {"", "/"}
    )


def no_store(response: Response) -> Response:
    response.headers["Cache-Control"] = "no-store"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    return response


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/health/metrics")
async def health_metrics() -> dict[str, object]:
    return {
        "shard": SHARD_ID or "standalone",
        "rooms": len(manager.rooms),
        "connections": sum(map(len, manager.connections.values())),
        "delivery": manager.delivery_stats(),
    }


@app.get("/")
async def home(request: Request) -> Response:
    return no_store(templates.TemplateResponse(request, "index.html", {}))


@app.post("/rooms")
async def create_room(request: Request) -> Response:
    if not http_origin_allowed(request):
        logger.warning("room_create_rejected reason=origin")
        return PlainTextResponse("Origin ไม่ได้รับอนุญาต", status_code=403)
    manager.prune_inactive_rooms()
    try:
        room_id = new_room_code()
    except RuntimeError:
        return PlainTextResponse("ห้องเต็ม กรุณาลองใหม่ภายหลัง", status_code=503,
                                 headers={"Retry-After": "60"})
    host_token = manager.create_room(room_id)
    logger.info("room_created room=%s active_rooms=%d", room_id, len(manager.rooms))
    return RedirectResponse(
        f"/room/{room_id}#host={host_token}", status_code=303
    )


@app.get("/room/{room_id}")
async def room_page(request: Request, room_id: str) -> Response:
    room_id = room_id.upper()
    if not ROOM_CODE.fullmatch(room_id) or room_id not in manager.rooms:
        return RedirectResponse("/", status_code=303)
    return no_store(
        templates.TemplateResponse(request, "room.html", {"room_id": room_id})
    )


@app.get("/room/{room_id}/share-qr.svg")
async def room_qr(request: Request, room_id: str) -> Response:
    room_id = room_id.upper()
    if not ROOM_CODE.fullmatch(room_id) or room_id not in manager.rooms:
        return PlainTextResponse("Not found", status_code=404)
    viewer_url = str(request.url_for("room_page", room_id=room_id))
    image = qrcode.make(viewer_url, image_factory=qrcode.image.svg.SvgPathImage)
    buffer = io.BytesIO()
    image.save(buffer)
    response = Response(buffer.getvalue(), media_type="image/svg+xml")
    return no_store(response)


def websocket_origin_allowed(websocket: WebSocket) -> bool:
    origin = websocket.headers.get("origin")
    if not origin:
        return False
    parsed = urlparse(origin)
    if parsed.scheme not in {"http", "https"} or parsed.path not in {"", "/"}:
        return False
    configured = {
        value.strip().rstrip("/")
        for value in os.getenv("WATCHPARTY_ALLOWED_ORIGINS", "").split(",")
        if value.strip()
    }
    if origin.rstrip("/") in configured:
        return True
    return parsed.netloc.lower() == websocket.headers.get("host", "").lower()


async def websocket_error(websocket: WebSocket, message: str, room_id: str | None = None) -> None:
    with suppress(Exception):
        payload = {"type": "ERROR", "message": message}
        if room_id is not None:
            await manager.send(room_id, websocket, payload)
        else:
            async with asyncio.timeout(1.0):
                await websocket.send_json(payload)


@app.websocket("/ws/{room_id}")
async def room_socket(websocket: WebSocket, room_id: str) -> None:
    room_id = room_id.upper()
    if (
        not ROOM_CODE.fullmatch(room_id)
        or room_id not in manager.rooms
        or not websocket_origin_allowed(websocket)
    ):
        logger.warning("websocket_rejected room=%s reason=policy", room_id[:12])
        await websocket.close(code=1008)
        return

    await websocket.accept()
    if len(manager.connections.get(room_id, ())) >= MAX_ROOM_CONNECTIONS:
        await websocket.close(code=1013, reason="room capacity reached")
        return
    identified = False
    role = "unknown"
    peer_id: str | None = None
    disconnect_code = 1000
    try:
        try:
            raw_hello = await asyncio.wait_for(
                websocket.receive_text(), timeout=HELLO_TIMEOUT_S
            )
            if len(raw_hello.encode("utf-8")) > MAX_MESSAGE_BYTES:
                await websocket.close(code=1009)
                return
            hello = json.loads(raw_hello)
        except asyncio.TimeoutError:
            disconnect_code = 1008
            await websocket_error(websocket, "ต้องส่ง HELLO ก่อนหมดเวลา")
            await websocket.close(code=1008)
            return
        except (json.JSONDecodeError, TypeError):
            disconnect_code = 1008
            await websocket_error(websocket, "ข้อมูล JSON ไม่ถูกต้อง")
            await websocket.close(code=1008)
            return

        if not isinstance(hello, dict) or hello.get("type") != "HELLO":
            disconnect_code = 1008
            await websocket_error(websocket, "ต้องส่ง HELLO เป็นข้อความแรก")
            await websocket.close(code=1008)
            return

        # Recheck after HELLO because multiple pending handshakes can race for capacity.
        if len(manager.connections.get(room_id, ())) >= MAX_ROOM_CONNECTIONS:
            await websocket.close(code=1013, reason="room capacity reached")
            return
        role = manager.identify(room_id, websocket, hello.get("host_token"), ready=False)
        identified = True
        peer_id = manager.peer_id(room_id, websocket)
        room = manager.rooms[room_id]
        connection_count = len(manager.connections.get(room_id, ()))
        logger.info(
            "websocket_join room=%s role=%s connections=%d peak=%d",
            room_id,
            role,
            connection_count,
            room.peak_connections,
        )
        now = monotonic_ms()
        if hello.get("p2p") is True:
            peer_clients.setdefault(room_id, set()).add(websocket)
        topology = peer_topology(room_id)
        enabled, host_id, peers = topology
        delivered = await manager.send(
            room_id, websocket,
            {
                "type": "WELCOME",
                "role": role,
                "peer_id": peer_id,
                "peers": [item for item in peers if item != peer_id],
                "host_peer_id": host_id,
                "p2p_enabled": enabled and hello.get("p2p") is True,
                "state": manager.state_message(room_id, now_ms=now)
                | {"type": "STATE"},
                "queue": manager.queue_message(room_id),
                "server_send_ms": now,
            }, wait=True,
        )
        if not delivered:
            return
        manager.activate(websocket)
        if topology != peer_topology(room_id) and hello.get("p2p") is True:
            enabled, host_id, peers = peer_topology(room_id)
            await manager.send(room_id, websocket, {
                "type": "PEER_MODE", "enabled": enabled,
                "host_peer_id": host_id, "peers": list(peers),
                "role": "host" if manager.is_host(room_id, websocket) else "viewer",
            })
        await announce_peer_topology(room_id, joined=websocket)
        budget = MessageBudget()

        while True:
            raw = await websocket.receive_text()
            if len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
                await websocket.close(code=1009)
                return
            if not budget.consume():
                await websocket.close(code=1008, reason="message rate exceeded")
                return
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await websocket_error(websocket, "ข้อมูล JSON ไม่ถูกต้อง", room_id)
                continue
            if not isinstance(message, dict):
                await websocket_error(websocket, "รูปแบบข้อความไม่ถูกต้อง", room_id)
                continue

            message_type = message.get("type")
            try:
                if message_type == "CLOCK_PING":
                    server_receive_ms = monotonic_ms()
                    manager.note_clock_ping(room_id, websocket)
                    await manager.send(
                        room_id, websocket,
                        {
                            "type": "CLOCK_PONG",
                            "id": message.get("id"),
                            "client_send_ms": message.get("client_send_ms"),
                            "server_receive_ms": server_receive_ms,
                            "server_send_ms": monotonic_ms(),
                        }
                    )
                elif message_type == "CONTROL":
                    action = str(message.get("action", "")).upper()
                    video_id = None
                    if action == "SET_VIDEO":
                        video_id = extract_youtube_video_id(str(message.get("url", "")))
                    _, changed = manager.apply_control(
                        room_id,
                        websocket,
                        action,
                        str(message.get("command_id", "")),
                        float(message.get("media_time_s", 0.0)),
                        float(message.get("observed_server_ms")),
                        video_id,
                    )
                    if changed:
                        logger.info("room=%s action=%s", room_id, action)
                        await manager.broadcast(room_id, manager.state_message(room_id))
                        if video_id is not None:
                            manager.set_title(room_id, video_id, cached_title(video_id))
                            await broadcast_queue(room_id)
                            spawn(fill_titles(room_id, [video_id]))
                elif message_type == "CLIENT_SAMPLE":
                    sample = PlaybackSample(
                        "",
                        float(message.get("media_time_s")),
                        float(message.get("observed_server_ms")),
                        bool(message.get("is_playing")),
                        bool(message.get("buffering")),
                        float(message.get("playback_rate")),
                        float(message.get("rtt_ms")),
                        float(message.get("uncertainty_ms")),
                    )
                    if manager.record_sample(room_id, websocket, sample):
                        await manager.broadcast(room_id, manager.state_message(room_id))
                elif message_type == "ROOM_VOLUME":
                    changed = manager.apply_volume(
                        room_id,
                        websocket,
                        message.get("volume"),
                        str(message.get("command_id", "")),
                    )
                    if changed:
                        logger.info("room=%s action=ROOM_VOLUME", room_id)
                        await manager.broadcast(room_id, manager.state_message(room_id))
                elif message_type == "SIGNAL":
                    if websocket not in peer_clients.get(room_id, ()) or not peer_topology(room_id)[0]:
                        continue
                    target_peer_id = message.get("target")
                    signal_data = message.get("data")
                    if not isinstance(target_peer_id, str) or not target_peer_id:
                        raise ValueError("target ของ WebRTC ไม่ถูกต้อง")
                    if not isinstance(signal_data, dict):
                        raise ValueError("ข้อมูล WebRTC ไม่ถูกต้อง")
                    if target_peer_id not in peer_topology(room_id)[2]:
                        raise ValueError("ไม่พบ peer ในห้องนี้")
                    delivered = await manager.send_to_peer(
                        room_id,
                        target_peer_id,
                        {
                            "type": "SIGNAL",
                            "from": manager.peer_id(room_id, websocket),
                            "data": signal_data,
                        },
                    )
                    if not delivered:
                        await manager.send(
                            room_id, websocket,
                            {
                                "type": "SIGNAL_ERROR",
                                "target": target_peer_id,
                            }
                        )
                elif message_type in QUEUE_MESSAGES:
                    await handle_queue_message(room_id, websocket, message)
                elif message_type == "PLAYER_ERROR":
                    error_code = int(message.get("code"))
                    if error_code not in PLAYER_ERROR_MESSAGES:
                        raise ValueError("รหัสข้อผิดพลาด YouTube ไม่ถูกต้อง")
                    logger.warning(
                        "youtube_player_error room=%s role=%s code=%d video=%s",
                        room_id,
                        role,
                        error_code,
                        manager.get_state(room_id).video_id or "none",
                    )
                    if manager.is_host(room_id, websocket):
                        await manager.broadcast(
                            room_id,
                            {
                                "type": "PLAYER_ERROR",
                                "code": error_code,
                                "message": PLAYER_ERROR_MESSAGES[error_code],
                                "video_id": manager.get_state(room_id).video_id,
                            },
                        )
                else:
                    await websocket_error(websocket, "ไม่รู้จักประเภทข้อความ", room_id)
            except (KeyError, PermissionError, TypeError, ValueError) as exc:
                logger.warning(
                    "websocket_input_error room=%s role=%s type=%s error=%s",
                    room_id,
                    role,
                    str(message_type)[:24],
                    type(exc).__name__,
                )
                await websocket_error(websocket, str(exc), room_id)
    except WebSocketDisconnect as exc:
        disconnect_code = exc.code
    finally:
        if identified:
            manager.disconnect(room_id, websocket)
            peer_clients.get(room_id, set()).discard(websocket)
            await announce_peer_topology(room_id)
            logger.info(
                "websocket_leave room=%s role=%s code=%s connections=%d",
                room_id,
                role,
                disconnect_code,
                len(manager.connections.get(room_id, ())),
            )


@app.api_route("/{path:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def unknown_route(path: str) -> Response:
    if path.startswith("static/") or path.endswith("/share-qr.svg"):
        return PlainTextResponse("Not found", status_code=404)
    return RedirectResponse("/", status_code=303)
