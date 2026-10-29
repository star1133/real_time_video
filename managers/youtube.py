from __future__ import annotations

import re
from urllib.parse import parse_qs, urlparse


_VIDEO_ID = re.compile(r"^[A-Za-z0-9_-]{11}$")
_PLAYLIST_ID = re.compile(r"^[A-Za-z0-9_-]{2,64}$")
_YOUTUBE_HOSTS = {
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
}


def parse_youtube_link(value: str) -> tuple[str | None, str | None]:
    """Return ``(video_id, playlist_id)`` from an id or common YouTube URL.

    Either part may be ``None``; a link with neither raises ``ValueError``.
    """

    candidate = (value or "").strip()
    if _VIDEO_ID.fullmatch(candidate):
        return candidate, None

    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("กรุณาใส่ลิงก์ YouTube ที่ถูกต้อง")

    host = (parsed.hostname or "").lower().rstrip(".")
    query = parse_qs(parsed.query)
    video_id: str | None = None
    playlist_id: str | None = None
    if host == "youtu.be":
        video_id = parsed.path.strip("/").split("/")[0]
    elif host in _YOUTUBE_HOSTS:
        parts = [part for part in parsed.path.split("/") if part]
        if parsed.path.rstrip("/") == "/watch":
            video_id = query.get("v", [None])[0]
        elif len(parts) >= 2 and parts[0] in {"shorts", "embed", "live"}:
            video_id = parts[1]
    else:
        raise ValueError("กรุณาใส่ลิงก์ YouTube ที่ถูกต้อง")

    if host == "youtu.be" or host in _YOUTUBE_HOSTS:
        playlist_id = query.get("list", [None])[0]
    if video_id is not None and not _VIDEO_ID.fullmatch(video_id):
        video_id = None
    if playlist_id is not None and not _PLAYLIST_ID.fullmatch(playlist_id):
        playlist_id = None
    if video_id is None and playlist_id is None:
        raise ValueError("กรุณาใส่ลิงก์ YouTube ที่ถูกต้อง")
    return video_id, playlist_id


def extract_youtube_video_id(value: str) -> str:
    """Return a validated YouTube video id from an id or common YouTube URL."""

    video_id, _ = parse_youtube_link(value)
    if video_id is None:
        raise ValueError("กรุณาใส่ลิงก์ YouTube ที่ถูกต้อง")
    return video_id
