from __future__ import annotations

import asyncio
import json
import math
import secrets
from collections import deque
from dataclasses import dataclass, field
from typing import Callable

from .sync import (
    MAX_HOST_CLOCK_UNCERTAINTY_MS,
    SAMPLE_FUTURE_MS,
    SAMPLE_STALE_MS,
    HostDriftFilter,
    PlaybackSample,
    Timeline,
    monotonic_ms,
    summarize_cohort,
)


ROOM_IDLE_TTL_MS = 6 * 60 * 60 * 1_000.0
HOST_DISCONNECT_GRACE_MS = 5_000.0
CONTROL_STALE_MS = 5_000.0
CONTROL_FUTURE_MS = 1_000.0
CLOCK_CALIBRATION_QUIET_MS = 750.0
SEND_TIMEOUT_S = 1.0
OUTBOUND_QUEUE_LIMIT = 32
OUTBOUND_QUEUE_BYTES_LIMIT = 256 * 1_024
# Short mobile stalls should not force a reconnect (and its re-seek); states
# are coalesced, so a slow writer still only delivers the newest timeline.
OUTBOUND_MAX_DELAY_S = 2.5
QUEUE_LIMIT = 300
PLAYLIST_IMPORT_LIMIT = 200


@dataclass(slots=True)
class QueueItem:
    item_id: str
    video_id: str
    title: str | None = None
    duration_s: int | None = None
    added_by: str = "host"

    def as_dict(self) -> dict[str, object]:
        return {
            "id": self.item_id,
            "video_id": self.video_id,
            "title": self.title,
            "duration_s": self.duration_s,
            "added_by": self.added_by,
        }


@dataclass(slots=True)
class PendingMessage:
    payload: dict[str, object]
    delivered: asyncio.Future[bool] | None = None
    encoded: str = ""
    size_bytes: int = 0
    queued_at: float = 0.0


@dataclass(slots=True)
class Outbox:
    room_id: str
    messages: deque[PendingMessage] = field(default_factory=deque)
    task: asyncio.Task[None] | None = None
    queued_bytes: int = 0


@dataclass(slots=True)
class Room:
    timeline: Timeline
    host_token: str
    created_at_ms: float
    last_active_ms: float
    host_socket: object | None = None
    host_disconnected_at_ms: float | None = None
    roles: dict[object, str] = field(default_factory=dict)
    peer_ids: dict[object, str] = field(default_factory=dict)
    sockets_by_peer_id: dict[str, object] = field(default_factory=dict)
    samples: dict[object, PlaybackSample] = field(default_factory=dict)
    processed_commands: set[str] = field(default_factory=set)
    command_history: deque[str] = field(default_factory=deque)
    host_filter: HostDriftFilter = field(default_factory=HostDriftFilter)
    control_action: str | None = None
    command_id: str | None = None
    volume: int = 100
    volume_revision: int = 0
    peak_connections: int = 0
    queue: list[QueueItem] = field(default_factory=list)
    queue_revision: int = 0
    now_playing: QueueItem | None = None
    allow_viewer_queue: bool = False
    autoplay_next: bool = True
    importing_playlist: bool = False


class RoomManager:
    def __init__(
        self,
        clock_ms: Callable[[], float] = monotonic_ms,
        *,
        send_timeout_s: float = SEND_TIMEOUT_S,
        outbound_queue_limit: int = OUTBOUND_QUEUE_LIMIT,
        outbound_queue_bytes_limit: int = OUTBOUND_QUEUE_BYTES_LIMIT,
        outbound_max_delay_s: float = OUTBOUND_MAX_DELAY_S,
    ) -> None:
        if not math.isfinite(send_timeout_s) or send_timeout_s <= 0:
            raise ValueError("send_timeout_s must be finite and positive")
        if outbound_queue_limit < 1:
            raise ValueError("outbound_queue_limit must be positive")
        if outbound_queue_bytes_limit < 1:
            raise ValueError("outbound_queue_bytes_limit must be positive")
        if not math.isfinite(outbound_max_delay_s) or outbound_max_delay_s <= 0:
            raise ValueError("outbound_max_delay_s must be finite and positive")
        self.clock_ms = clock_ms
        self.send_timeout_s = send_timeout_s
        self.outbound_queue_limit = outbound_queue_limit
        self.outbound_queue_bytes_limit = outbound_queue_bytes_limit
        self.outbound_max_delay_s = outbound_max_delay_s
        self.rooms: dict[str, Room] = {}
        self.connections: dict[str, set[object]] = {}
        self._clock_quiet_until: dict[object, float] = {}
        self._not_ready: set[object] = set()
        self._outboxes: dict[object, Outbox] = {}
        self._tasks: set[asyncio.Task[None]] = set()
        self._next_heartbeat_ms: dict[str, float] = {}
        self._delivery_stats = {
            "messages_sent": 0,
            "heartbeats_coalesced": 0,
            "slow_clients_disconnected": 0,
            "send_failures": 0,
            "json_encodes": 0,
            "expired_queues": 0,
            "max_queue_delay_ms": 0,
        }

    def create_room(self, room_id: str) -> str:
        if room_id in self.rooms:
            return self.rooms[room_id].host_token
        now = self.clock_ms()
        token = secrets.token_urlsafe(32)
        self.rooms[room_id] = Room(
            timeline=Timeline(None, False, 0.0, now, 0),
            host_token=token,
            created_at_ms=now,
            last_active_ms=now,
        )
        self.connections.setdefault(room_id, set())
        return token

    def get_state(self, room_id: str) -> Timeline:
        try:
            return self.rooms[room_id].timeline
        except KeyError as exc:
            raise KeyError("ไม่พบห้องนี้") from exc

    def identify(
        self,
        room_id: str,
        socket: object,
        host_token: str | None,
        *,
        ready: bool = True,
    ) -> str:
        if room_id not in self.rooms:
            raise KeyError("ไม่พบห้องนี้")
        room = self.rooms[room_id]
        if (
            isinstance(host_token, str)
            and host_token
            and secrets.compare_digest(host_token, room.host_token)
        ):
            if room.host_socket is not None and room.host_socket is not socket:
                room.roles[room.host_socket] = "viewer"
            if room.host_socket is not socket:
                room.host_filter.reset()
            room.host_socket = socket
            room.host_disconnected_at_ms = None
            role = "host"
        else:
            role = "viewer"
        room.roles[socket] = role
        if socket not in room.peer_ids:
            peer_id = self._new_peer_id(room)
            room.peer_ids[socket] = peer_id
            room.sockets_by_peer_id[peer_id] = socket
        if not ready:
            self._not_ready.add(socket)
        room.last_active_ms = self.clock_ms()
        self.connections.setdefault(room_id, set()).add(socket)
        room.peak_connections = max(
            room.peak_connections, len(self.connections[room_id])
        )
        return role

    @staticmethod
    def _new_peer_id(room: Room) -> str:
        while True:
            peer_id = secrets.token_urlsafe(9)
            if peer_id not in room.sockets_by_peer_id:
                return peer_id

    def activate(self, socket: object) -> None:
        """Allow room traffic only after the WELCOME frame has been delivered."""
        self._not_ready.discard(socket)

    def peer_id(self, room_id: str, socket: object) -> str:
        try:
            return self.rooms[room_id].peer_ids[socket]
        except KeyError as exc:
            raise KeyError("ไม่พบ peer ในห้องนี้") from exc

    def peer_ids(self, room_id: str, *, exclude: object | None = None) -> list[str]:
        room = self.rooms.get(room_id)
        if room is None:
            raise KeyError("ไม่พบห้องนี้")
        return [
            peer_id
            for socket, peer_id in room.peer_ids.items()
            if socket is not exclude
            and socket not in self._not_ready
            and socket in self.connections.get(room_id, ())
        ]

    async def send_to_peer(
        self, room_id: str, peer_id: str, message: dict[str, object]
    ) -> bool:
        room = self.rooms.get(room_id)
        if room is None:
            raise KeyError("ไม่พบห้องนี้")
        target = room.sockets_by_peer_id.get(peer_id)
        if target is None or target in self._not_ready:
            return False
        return await self.send(room_id, target, message)

    def disconnect(self, room_id: str, socket: object) -> None:
        self.connections.get(room_id, set()).discard(socket)
        self._not_ready.discard(socket)
        self._clock_quiet_until.pop(socket, None)
        outbox = self._outboxes.pop(socket, None)
        if outbox is not None:
            for pending in outbox.messages:
                self._resolve(pending, False)
            outbox.messages.clear()
            outbox.queued_bytes = 0
            if outbox.task is not None and outbox.task is not asyncio.current_task():
                outbox.task.cancel()
        room = self.rooms.get(room_id)
        if room is None:
            return
        role = room.roles.pop(socket, None)
        peer_id = room.peer_ids.pop(socket, None)
        if peer_id is not None:
            room.sockets_by_peer_id.pop(peer_id, None)
        room.samples.pop(socket, None)
        if role == "host" and room.host_socket is socket:
            room.host_socket = None
            room.host_disconnected_at_ms = self.clock_ms()
        room.last_active_ms = self.clock_ms()

    def prune_inactive_rooms(self) -> list[str]:
        now = self.clock_ms()
        expired = [
            room_id
            for room_id, room in self.rooms.items()
            if not self.connections.get(room_id)
            and now - room.last_active_ms >= ROOM_IDLE_TTL_MS
        ]
        for room_id in expired:
            self.rooms.pop(room_id, None)
            self.connections.pop(room_id, None)
            self._next_heartbeat_ms.pop(room_id, None)
        return expired

    def freeze_expired_hosts(self) -> list[str]:
        now = self.clock_ms()
        frozen: list[str] = []
        for room_id, room in self.rooms.items():
            disconnected_at = room.host_disconnected_at_ms
            if (
                disconnected_at is None
                or now - disconnected_at < HOST_DISCONNECT_GRACE_MS
            ):
                continue
            room.host_disconnected_at_ms = None
            if room.timeline.is_playing:
                room.timeline.reanchor(
                    room.timeline.expected_time(now), now, playing=False
                )
                room.control_action = "PAUSE"
                room.command_id = None
                frozen.append(room_id)
        return frozen

    def _require_host(self, room_id: str, socket: object) -> Room:
        room = self.rooms.get(room_id)
        if room is None:
            raise KeyError("ไม่พบห้องนี้")
        if room.roles.get(socket) != "host" or room.host_socket is not socket:
            raise PermissionError("เฉพาะ Host เท่านั้นที่ควบคุมวิดีโอได้")
        return room

    def apply_control(
        self,
        room_id: str,
        socket: object,
        action: str,
        command_id: str,
        media_time_s: float,
        observed_server_ms: float,
        video_id: str | None = None,
    ) -> tuple[Timeline, bool]:
        room = self._require_host(room_id, socket)
        now = self.clock_ms()
        observed = float(observed_server_ms)
        if not math.isfinite(observed):
            raise ValueError("observed_server_ms ต้องเป็นตัวเลขที่มีค่าจำกัด")
        if (
            now - observed > CONTROL_STALE_MS
            or observed - now > CONTROL_FUTURE_MS
        ):
            raise ValueError("observed_server_ms อยู่นอกช่วงเวลาที่อนุญาต")
        if not command_id:
            raise ValueError("command_id จำเป็นต้องมีค่า")
        if command_id in room.processed_commands:
            return room.timeline, False

        normalized_action = str(action).upper()
        if normalized_action not in {"SET_VIDEO", "PLAY", "PAUSE", "SEEK"}:
            raise ValueError("คำสั่งควบคุมไม่ถูกต้อง")
        if normalized_action != "SET_VIDEO" and room.timeline.video_id is None:
            raise ValueError("กรุณาเลือกวิดีโอก่อน")

        media_time = float(media_time_s)
        if not math.isfinite(media_time):
            raise ValueError("media_time_s ต้องเป็นตัวเลขที่มีค่าจำกัด")
        media_time = max(0.0, media_time)
        if normalized_action == "SET_VIDEO":
            if not video_id:
                raise ValueError("กรุณาเลือกวิดีโอ YouTube")
            room.timeline.video_id = video_id
            room.timeline.reanchor(0.0, observed, playing=False)
            room.host_filter.reset()
            room.now_playing = QueueItem(secrets.token_urlsafe(6), video_id)
            room.queue_revision += 1
        elif normalized_action == "PLAY":
            room.timeline.reanchor(media_time, observed, playing=True)
            room.host_filter.reset()
        elif normalized_action == "PAUSE":
            room.timeline.reanchor(media_time, observed, playing=False)
            room.host_filter.reset()
        else:
            room.timeline.reanchor(media_time, observed)
            room.host_filter.reset()

        room.processed_commands.add(command_id)
        room.command_history.append(command_id)
        if len(room.command_history) > 1_000:
            room.processed_commands.discard(room.command_history.popleft())
        room.samples.clear()
        room.control_action = normalized_action
        room.command_id = command_id
        room.last_active_ms = now
        return room.timeline, True

    def apply_volume(
        self,
        room_id: str,
        socket: object,
        volume: object,
        command_id: str,
    ) -> bool:
        """Set the room-wide volume preference without changing playback time."""
        room = self._require_host(room_id, socket)
        if not command_id:
            raise ValueError("command_id จำเป็นต้องมีค่า")
        if command_id in room.processed_commands:
            return False
        if isinstance(volume, bool):
            raise ValueError("ระดับเสียงไม่ถูกต้อง")
        numeric_volume = float(volume)
        if not math.isfinite(numeric_volume) or not numeric_volume.is_integer():
            raise ValueError("ระดับเสียงต้องเป็นจำนวนเต็ม 0–100")
        normalized_volume = int(numeric_volume)
        if not 0 <= normalized_volume <= 100:
            raise ValueError("ระดับเสียงต้องอยู่ระหว่าง 0–100")

        room.processed_commands.add(command_id)
        room.command_history.append(command_id)
        if len(room.command_history) > 1_000:
            room.processed_commands.discard(room.command_history.popleft())
        if room.volume == normalized_volume:
            return False
        room.volume = normalized_volume
        room.volume_revision += 1
        room.last_active_ms = self.clock_ms()
        return True

    def _room(self, room_id: str) -> Room:
        room = self.rooms.get(room_id)
        if room is None:
            raise KeyError("ไม่พบห้องนี้")
        return room

    def _queue_changed(self, room: Room) -> None:
        room.queue_revision += 1
        room.last_active_ms = self.clock_ms()

    def can_add_to_queue(self, room_id: str, socket: object) -> bool:
        room = self._room(room_id)
        return self.is_host(room_id, socket) or (
            room.allow_viewer_queue and socket in self.connections.get(room_id, ())
        )

    def queue_add(
        self,
        room_id: str,
        socket: object,
        entries: list[tuple[str, str | None, int | None]],
        *,
        play_next: bool = False,
        added_by: str | None = None,
    ) -> list[QueueItem]:
        """Append (or insert at the front) validated ``(video_id, title, duration)``.

        ``added_by`` carries a permission already checked when a slow
        playlist import was requested, so a reconnect cannot lose the import.
        """
        room = self._room(room_id)
        if added_by is None:
            if not self.can_add_to_queue(room_id, socket):
                raise PermissionError("Host ปิดการเพิ่มคิวของผู้ชมไว้")
            added_by = "host" if self.is_host(room_id, socket) else "viewer"
        space = QUEUE_LIMIT - len(room.queue)
        if space <= 0:
            raise ValueError(f"คิวเต็มแล้ว (สูงสุด {QUEUE_LIMIT} คลิป)")
        items = [
            QueueItem(secrets.token_urlsafe(6), video_id, title, duration, added_by)
            for video_id, title, duration in entries[:space]
        ]
        if not items:
            return []
        if play_next:
            room.queue[0:0] = items
        else:
            room.queue.extend(items)
        self._queue_changed(room)
        return items

    def _queue_index(self, room: Room, item_id: object) -> int:
        for index, item in enumerate(room.queue):
            if item.item_id == item_id:
                return index
        raise ValueError("ไม่พบคลิปนี้ในคิวแล้ว")

    def queue_remove(self, room_id: str, socket: object, item_id: object) -> bool:
        room = self._require_host(room_id, socket)
        room.queue.pop(self._queue_index(room, item_id))
        self._queue_changed(room)
        return True

    def queue_move(self, room_id: str, socket: object, item_id: object, delta: object) -> bool:
        room = self._require_host(room_id, socket)
        if isinstance(delta, bool) or not isinstance(delta, int) or delta == 0:
            raise ValueError("ทิศทางการย้ายไม่ถูกต้อง")
        index = self._queue_index(room, item_id)
        target = max(0, min(len(room.queue) - 1, index + delta))
        if target == index:
            return False
        room.queue.insert(target, room.queue.pop(index))
        self._queue_changed(room)
        return True

    def queue_clear(self, room_id: str, socket: object) -> bool:
        room = self._require_host(room_id, socket)
        if not room.queue:
            return False
        room.queue.clear()
        self._queue_changed(room)
        return True

    def queue_shuffle(self, room_id: str, socket: object) -> bool:
        room = self._require_host(room_id, socket)
        if len(room.queue) < 2:
            return False
        secrets.SystemRandom().shuffle(room.queue)
        self._queue_changed(room)
        return True

    def queue_settings(
        self, room_id: str, socket: object, allow_viewers: object, autoplay: object
    ) -> bool:
        room = self._require_host(room_id, socket)
        changed = False
        if isinstance(allow_viewers, bool) and allow_viewers != room.allow_viewer_queue:
            room.allow_viewer_queue = allow_viewers
            changed = True
        if isinstance(autoplay, bool) and autoplay != room.autoplay_next:
            room.autoplay_next = autoplay
            changed = True
        if changed:
            self._queue_changed(room)
        return changed

    def queue_play(
        self,
        room_id: str,
        socket: object | None,
        item_id: object = None,
        *,
        ended_video_id: object = None,
    ) -> bool:
        """Start a queued clip; the Host's player begins it and reports PLAY.

        ``ended_video_id`` makes auto-advance idempotent: a duplicate "ended"
        report for a clip that was already replaced is ignored.
        """
        room = self._room(room_id) if socket is None else self._require_host(room_id, socket)
        if ended_video_id is not None and ended_video_id != room.timeline.video_id:
            return False
        if not room.queue:
            if item_id is None:
                return False
            raise ValueError("ไม่พบคลิปนี้ในคิวแล้ว")
        index = 0 if item_id is None else self._queue_index(room, item_id)
        item = room.queue.pop(index)
        now = self.clock_ms()
        room.timeline.video_id = item.video_id
        # Start paused at 0: the Host's player reports PLAY from its real
        # start point once YouTube has buffered, so viewers never race ahead.
        room.timeline.reanchor(0.0, now, playing=False)
        room.host_filter.reset()
        room.samples.clear()
        room.control_action = "AUTOSTART"
        room.command_id = None
        room.now_playing = item
        self._queue_changed(room)
        return True

    def set_title(self, room_id: str, video_id: str, title: str | None) -> bool:
        room = self.rooms.get(room_id)
        if room is None or not title:
            return False
        changed = False
        for item in (*room.queue, room.now_playing):
            if item is not None and item.video_id == video_id and item.title != title:
                item.title = title
                changed = True
        if changed:
            room.queue_revision += 1
        return changed

    def queue_message(self, room_id: str) -> dict[str, object]:
        room = self._room(room_id)
        return {
            "type": "QUEUE",
            "revision": room.queue_revision,
            "items": [item.as_dict() for item in room.queue],
            "now_playing": room.now_playing.as_dict() if room.now_playing else None,
            "allow_viewers": room.allow_viewer_queue,
            "autoplay": room.autoplay_next,
            "importing": room.importing_playlist,
            "limit": QUEUE_LIMIT,
        }

    def record_sample(
        self, room_id: str, socket: object, sample: PlaybackSample
    ) -> bool:
        room = self.rooms.get(room_id)
        if room is None:
            raise KeyError("ไม่พบห้องนี้")
        if socket not in self.connections.get(room_id, ()):
            raise PermissionError("ยังไม่ได้เข้าร่วมห้องนี้")
        rate = float(sample.playback_rate)
        if not math.isfinite(rate) or rate <= 0.0 or rate > 4.0:
            raise ValueError("playback_rate ไม่ถูกต้อง")
        for name in ("media_time_s", "observed_server_ms", "rtt_ms", "uncertainty_ms"):
            value = float(getattr(sample, name))
            if not math.isfinite(value) or (name != "observed_server_ms" and value < 0):
                raise ValueError(f"{name} ไม่ถูกต้อง")

        now = self.clock_ms()
        previous = room.samples.get(socket)
        if (
            previous is not None
            and previous.observed_server_ms <= now + SAMPLE_FUTURE_MS
            and sample.observed_server_ms <= previous.observed_server_ms
        ):
            return False
        if sample.observed_server_ms < room.timeline.anchor_server_ms:
            return False
        sample.client_id = str(id(socket))
        expected = room.timeline.expected_time(sample.observed_server_ms)
        sample.error_s = float(sample.media_time_s) - expected
        room.samples[socket] = sample
        room.last_active_ms = now

        if room.host_socket is not socket or room.timeline.video_id is None:
            return False
        age = now - sample.observed_server_ms
        if (
            age > SAMPLE_STALE_MS
            or age < -SAMPLE_FUTURE_MS
            or sample.uncertainty_ms > MAX_HOST_CLOCK_UNCERTAINTY_MS
        ):
            room.host_filter.reset()
            return False
        changed = room.host_filter.observe(room.timeline, sample)
        if changed:
            room.control_action = None
            room.command_id = None
        return changed

    def state_message(
        self, room_id: str, *, message_type: str = "STATE", now_ms: float | None = None
    ) -> dict[str, object]:
        now = self.clock_ms() if now_ms is None else float(now_ms)
        room = self.rooms[room_id]
        timeline = room.timeline
        cohort = summarize_cohort(room.samples.values(), now)
        cohort["buffering_count"] = sum(
            1 for sample in room.samples.values()
            if sample.buffering
            and -SAMPLE_FUTURE_MS <= now - sample.observed_server_ms <= SAMPLE_STALE_MS
        )
        message = {
            "type": message_type,
            "video_id": timeline.video_id,
            "is_playing": timeline.is_playing,
            "media_time_s": timeline.media_time_s,
            "anchor_server_ms": timeline.anchor_server_ms,
            "revision": timeline.revision,
            "control_action": room.control_action,
            "command_id": room.command_id,
            "volume": room.volume,
            "volume_revision": room.volume_revision,
            "server_send_ms": now,
            "cohort": cohort,
        }
        # The Host's own latest reading lets every viewer follow the Host's
        # real position (not just the coarser shared timeline) to tens of ms.
        host_sample = room.samples.get(room.host_socket)
        if (
            host_sample is not None
            and timeline.video_id is not None
            and not host_sample.buffering
            and host_sample.is_playing == timeline.is_playing
            and host_sample.observed_server_ms >= timeline.anchor_server_ms
            and -SAMPLE_FUTURE_MS <= now - host_sample.observed_server_ms <= SAMPLE_STALE_MS
        ):
            message["host_sample"] = {
                "media_time_s": host_sample.media_time_s,
                "observed_server_ms": host_sample.observed_server_ms,
                "is_playing": host_sample.is_playing,
                "playback_rate": host_sample.playback_rate,
                "uncertainty_ms": host_sample.uncertainty_ms,
            }
        return message

    def heartbeat_message(
        self, room_id: str, now_ms: float | None = None
    ) -> dict[str, object]:
        return self.state_message(room_id, message_type="TIMELINE", now_ms=now_ms)

    def is_host(self, room_id: str, socket: object) -> bool:
        room = self.rooms.get(room_id)
        return bool(
            room
            and room.host_socket is socket
            and room.roles.get(socket) == "host"
        )

    def note_clock_ping(self, room_id: str, socket: object) -> None:
        if room_id in self.rooms:
            self._clock_quiet_until[socket] = (
                self.clock_ms() + CLOCK_CALIBRATION_QUIET_MS
            )

    @staticmethod
    def _resolve(pending: PendingMessage, delivered: bool) -> None:
        if pending.delivered is not None and not pending.delivered.done():
            pending.delivered.set_result(delivered)

    def _track_task(self, task: asyncio.Task[None]) -> None:
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    def _drop_connection(self, room_id: str, socket: object) -> None:
        self.disconnect(room_id, socket)
        if not hasattr(socket, "close"):
            return

        async def close_socket() -> None:
            try:
                async with asyncio.timeout(self.send_timeout_s):
                    await socket.close(code=1013)  # type: ignore[attr-defined]
            except (Exception, asyncio.CancelledError):
                pass

        self._track_task(asyncio.create_task(close_socket()))

    def _enqueue(
        self,
        room_id: str,
        socket: object,
        message: dict[str, object],
        delivered: asyncio.Future[bool] | None = None,
        *,
        wire: tuple[str, int] | None = None,
    ) -> bool:
        if socket not in self.connections.get(room_id, ()):
            if delivered is not None:
                delivered.set_result(False)
            return False
        encoded, size_bytes = self._encode(message) if wire is None else wire
        outbox = self._outboxes.setdefault(socket, Outbox(room_id))
        message_type = message.get("type")
        # A newer canonical state makes every queued heartbeat redundant. Never
        # replace reliable control/signalling frames or a send already in flight.
        if message_type in {"TIMELINE", "STATE"}:
            retained = deque()
            for pending in outbox.messages:
                if pending.payload.get("type") == "TIMELINE":
                    self._resolve(pending, False)
                    outbox.queued_bytes -= pending.size_bytes
                    self._delivery_stats["heartbeats_coalesced"] += 1
                else:
                    retained.append(pending)
            outbox.messages = retained

        def over_capacity() -> bool:
            return (
                len(outbox.messages) >= self.outbound_queue_limit
                or outbox.queued_bytes + size_bytes > self.outbound_queue_bytes_limit
            )

        if over_capacity():
            if message_type == "TIMELINE":
                self._delivery_stats["heartbeats_coalesced"] += 1
                if delivered is not None:
                    delivered.set_result(False)
                return False
            # Discard expendable telemetry to leave space for a reliable frame.
            for pending in tuple(outbox.messages):
                if pending.payload.get("type") == "TIMELINE":
                    outbox.messages.remove(pending)
                    outbox.queued_bytes -= pending.size_bytes
                    self._resolve(pending, False)
                    self._delivery_stats["heartbeats_coalesced"] += 1
                    break
            if over_capacity():
                self._delivery_stats["slow_clients_disconnected"] += 1
                if delivered is not None:
                    delivered.set_result(False)
                self._drop_connection(room_id, socket)
                return False

        pending = PendingMessage(
            message.copy(), delivered, encoded, size_bytes,
            asyncio.get_running_loop().time(),
        )
        outbox.queued_bytes += size_bytes
        # Clock replies must measure transport delay without sitting behind
        # unsent room telemetry. All writes still run through the same writer.
        if message_type == "CLOCK_PONG":
            outbox.messages.appendleft(pending)
        else:
            outbox.messages.append(pending)
        if outbox.task is None:
            outbox.task = asyncio.create_task(self._write_outbox(socket, outbox))
            self._track_task(outbox.task)
        return True

    def _encode(self, message: dict[str, object]) -> tuple[str, int]:
        # Broadcasts share one immutable wire representation across recipients.
        # Each writer still owns its WebSocket and enforces independent limits.
        encoded = json.dumps(
            message, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        )
        self._delivery_stats["json_encodes"] += 1
        return encoded, len(encoded.encode("utf-8"))

    async def _write_outbox(self, socket: object, outbox: Outbox) -> None:
        pending: PendingMessage | None = None
        try:
            batch_size = 0
            while outbox.messages:
                pending = outbox.messages.popleft()
                outbox.queued_bytes -= pending.size_bytes
                queue_delay_s = asyncio.get_running_loop().time() - pending.queued_at
                self._delivery_stats["max_queue_delay_ms"] = max(
                    self._delivery_stats["max_queue_delay_ms"], int(queue_delay_s * 1_000)
                )
                if queue_delay_s > self.outbound_max_delay_s:
                    # A stream of individually successful but slow writes can
                    # otherwise replay many seconds of obsolete controls. Close
                    # this client so reconnect starts from the current snapshot.
                    self._delivery_stats["expired_queues"] += 1
                    self._delivery_stats["slow_clients_disconnected"] += 1
                    self._drop_connection(outbox.room_id, socket)
                    return
                if pending.payload.get("type") == "CLOCK_PONG":
                    pending.payload["server_send_ms"] = self.clock_ms()
                    pending.encoded, _ = self._encode(pending.payload)
                async with asyncio.timeout(self.send_timeout_s):
                    if hasattr(socket, "send_text"):
                        await socket.send_text(pending.encoded)  # type: ignore[attr-defined]
                    else:
                        await socket.send_json(pending.payload)  # type: ignore[attr-defined]
                self._delivery_stats["messages_sent"] += 1
                self._resolve(pending, True)
                pending = None
                batch_size += 1
                if batch_size >= 16 and outbox.messages:
                    batch_size = 0
                    await asyncio.sleep(0)
        except TimeoutError:
            self._delivery_stats["slow_clients_disconnected"] += 1
            self._drop_connection(outbox.room_id, socket)
        except asyncio.CancelledError:
            raise
        except Exception:
            self._delivery_stats["send_failures"] += 1
            self._drop_connection(outbox.room_id, socket)
        finally:
            if pending is not None:
                self._resolve(pending, False)
            outbox.task = None

    async def send(
        self,
        room_id: str,
        socket: object,
        message: dict[str, object],
        *,
        wait: bool = False,
    ) -> bool:
        """Queue a bounded, serialized write; optionally await its delivery."""
        delivered = asyncio.get_running_loop().create_future() if wait else None
        queued = self._enqueue(room_id, socket, message, delivered)
        if delivered is not None:
            return await delivered
        return queued

    def delivery_stats(self) -> dict[str, int]:
        return self._delivery_stats | {
            "pending_messages": sum(len(outbox.messages) for outbox in self._outboxes.values()),
            "pending_bytes": sum(outbox.queued_bytes for outbox in self._outboxes.values()),
            "active_writers": sum(outbox.task is not None for outbox in self._outboxes.values()),
        }

    async def close(self) -> None:
        """Release every writer and pending delivery during application shutdown."""
        for room_id, sockets in tuple(self.connections.items()):
            for socket in tuple(sockets):
                self.disconnect(room_id, socket)
        tasks = tuple(self._tasks)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def broadcast(
        self,
        room_id: str,
        message: dict[str, object],
        *,
        exclude: object | None = None,
    ) -> None:
        sockets = tuple(
            socket
            for socket in self.connections.get(room_id, ())
            if socket is not exclude and socket not in self._not_ready
        )
        wire = self._encode(message) if sockets else None
        for index, socket in enumerate(sockets, 1):
            self._enqueue(room_id, socket, message, wire=wire)
            if index % 256 == 0:
                await asyncio.sleep(0)
        if sockets:
            await asyncio.sleep(0)

    async def broadcast_heartbeats(self) -> None:
        now = self.clock_ms()
        queued = 0
        for room_id in tuple(self.rooms):
            sockets = self.connections.get(room_id, ())
            if not sockets or now < self._next_heartbeat_ms.get(room_id, -1.0):
                continue
            self._next_heartbeat_ms[room_id] = now + self.heartbeat_interval_ms(len(sockets))
            message = self.heartbeat_message(room_id, now)
            wire = self._encode(message)
            for socket in tuple(sockets):
                if (
                    socket in self._not_ready
                    or self._clock_quiet_until.get(socket, -1.0) >= now
                ):
                    continue
                self._enqueue(room_id, socket, message, wire=wire)
                queued += 1
                if queued % 256 == 0:
                    await asyncio.sleep(0)
        if queued:
            await asyncio.sleep(0)

    @staticmethod
    def heartbeat_interval_ms(connection_count: int) -> float:
        # Timeline changes are pushed immediately as STATE; heartbeats only
        # refresh room statistics and liveness, so they need not be rapid.
        # They also carry the Host reference, so small rooms keep them brisk.
        if connection_count <= 32:
            return 250.0
        if connection_count <= 128:
            return 1_000.0
        return 2_000.0
