from __future__ import annotations

import asyncio
import logging
from collections import OrderedDict
from dataclasses import dataclass

import httpx


TITLE_TIMEOUT_S = 4.0
PLAYLIST_TIMEOUT_S = 30.0
TITLE_CACHE_LIMIT = 2_000
TITLE_MAX_CHARS = 160
logger = logging.getLogger("watchparty.sync")
_title_cache: OrderedDict[str, str | None] = OrderedDict()
# YouTube is a shared upstream: never let one large room flood it.
_lookup_slots = asyncio.Semaphore(4)
_playlist_slots = asyncio.Semaphore(2)


@dataclass(slots=True)
class MediaEntry:
    video_id: str
    title: str | None = None
    duration_s: int | None = None


def clean_title(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    title = " ".join(value.split())
    return title[:TITLE_MAX_CHARS] or None


def cached_title(video_id: str) -> str | None:
    return _title_cache.get(video_id)


def remember_title(video_id: str, title: str | None) -> None:
    _title_cache[video_id] = title
    _title_cache.move_to_end(video_id)
    while len(_title_cache) > TITLE_CACHE_LIMIT:
        _title_cache.popitem(last=False)


async def fetch_video_title(video_id: str) -> str | None:
    """Look up a public title through oEmbed; failures only cost the label."""
    if video_id in _title_cache:
        return _title_cache[video_id]
    title: str | None = None
    try:
        async with _lookup_slots:
            async with httpx.AsyncClient(timeout=TITLE_TIMEOUT_S) as client:
                response = await client.get(
                    "https://www.youtube.com/oembed",
                    params={
                        "url": f"https://www.youtube.com/watch?v={video_id}",
                        "format": "json",
                    },
                )
        if response.status_code == 200:
            title = clean_title(response.json().get("title"))
    except (httpx.HTTPError, ValueError):
        return None  # Do not cache transient failures.
    remember_title(video_id, title)
    return title


def _extract_playlist(playlist_id: str, limit: int) -> tuple[str | None, list[MediaEntry]]:
    import yt_dlp  # Optional heavy dependency; imported only for playlists.

    options = {
        "extract_flat": "in_playlist",
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "playlistend": limit,
        "socket_timeout": 10,
        "logger": logging.getLogger("watchparty.ytdlp"),
    }
    with yt_dlp.YoutubeDL(options) as downloader:
        info = downloader.extract_info(
            f"https://www.youtube.com/playlist?list={playlist_id}", download=False
        )
    entries: list[MediaEntry] = []
    seen: set[str] = set()
    for entry in (info or {}).get("entries") or ():
        video_id = entry.get("id") if isinstance(entry, dict) else None
        if not isinstance(video_id, str) or len(video_id) != 11 or video_id in seen:
            continue
        seen.add(video_id)
        duration = entry.get("duration")
        title = clean_title(entry.get("title"))
        # Deleted/private entries keep their slot in YouTube but cannot embed.
        if title in {"[Deleted video]", "[Private video]"}:
            continue
        if title:
            remember_title(video_id, title)
        entries.append(MediaEntry(
            video_id,
            title,
            int(duration) if isinstance(duration, (int, float)) and duration > 0 else None,
        ))
        if len(entries) >= limit:
            break
    return clean_title((info or {}).get("title")), entries


async def fetch_playlist(playlist_id: str, limit: int) -> tuple[str | None, list[MediaEntry]]:
    try:
        async with _playlist_slots:
            return await asyncio.wait_for(
                asyncio.to_thread(_extract_playlist, playlist_id, limit),
                timeout=PLAYLIST_TIMEOUT_S,
            )
    except ImportError as exc:
        raise ValueError("เซิร์ฟเวอร์ยังไม่ได้ติดตั้งตัวอ่าน playlist (yt-dlp)") from exc
    except asyncio.TimeoutError as exc:
        raise ValueError("YouTube ตอบช้าเกินไป ลองนำเข้า playlist ใหม่อีกครั้ง") from exc
    except Exception as exc:  # yt-dlp raises many private error types.
        logger.warning("playlist_import_failed error=%s", type(exc).__name__)
        raise ValueError("นำเข้า playlist ไม่ได้ · ตรวจว่าเป็น playlist สาธารณะหรือไม่ได้ซ่อนไว้") from exc
