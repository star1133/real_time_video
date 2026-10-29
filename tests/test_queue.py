from urllib.parse import parse_qs, urlsplit

import pytest
from fastapi.testclient import TestClient

import main
from managers.media_info import MediaEntry
from managers.room_manager import QUEUE_LIMIT, RoomManager
from managers.youtube import parse_youtube_link


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def host_room() -> tuple[RoomManager, object, object]:
    manager = RoomManager(FakeClock())
    token = manager.create_room("123")
    host, viewer = object(), object()
    manager.identify("123", host, token)
    manager.identify("123", viewer, None)
    return manager, host, viewer


def test_parse_links_with_playlists():
    assert parse_youtube_link("https://youtu.be/dQw4w9WgXcQ") == ("dQw4w9WgXcQ", None)
    assert parse_youtube_link(
        "https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL1234567890abc"
    ) == ("dQw4w9WgXcQ", "PL1234567890abc")
    assert parse_youtube_link(
        "https://www.youtube.com/playlist?list=PL1234567890abc"
    ) == (None, "PL1234567890abc")
    with pytest.raises(ValueError):
        parse_youtube_link("https://example.com/watch?v=dQw4w9WgXcQ")
    with pytest.raises(ValueError):
        parse_youtube_link("https://www.youtube.com/playlist?list=<bad>")


def test_queue_order_permissions_and_limit():
    manager, host, viewer = host_room()
    with pytest.raises(PermissionError):
        manager.queue_add("123", viewer, [("aaaaaaaaaaa", None, None)])
    first, second = manager.queue_add(
        "123", host, [("aaaaaaaaaaa", "A", 60), ("bbbbbbbbbbb", None, None)]
    )
    manager.queue_add("123", host, [("ccccccccccc", None, None)], play_next=True)
    assert [item.video_id for item in manager.rooms["123"].queue] == [
        "ccccccccccc", "aaaaaaaaaaa", "bbbbbbbbbbb",
    ]
    assert manager.queue_move("123", host, second.item_id, -5)
    assert manager.rooms["123"].queue[0].item_id == second.item_id
    with pytest.raises(PermissionError):
        manager.queue_remove("123", viewer, first.item_id)
    assert manager.queue_remove("123", host, first.item_id)

    manager.queue_settings("123", host, True, None)
    added = manager.queue_add("123", viewer, [("ddddddddddd", None, None)])
    assert added[0].added_by == "viewer"
    manager.queue_add("123", host, [("eeeeeeeeeee", None, None)] * QUEUE_LIMIT)
    assert len(manager.rooms["123"].queue) == QUEUE_LIMIT
    with pytest.raises(ValueError):
        manager.queue_add("123", host, [("fffffffffff", None, None)])


def test_queue_play_starts_paused_and_auto_advance_is_idempotent():
    manager, host, _viewer = host_room()
    manager.queue_add("123", host, [("aaaaaaaaaaa", "A", None), ("bbbbbbbbbbb", "B", None)])
    assert manager.queue_play("123", host)
    timeline = manager.get_state("123")
    assert timeline.video_id == "aaaaaaaaaaa"
    assert timeline.is_playing is False and timeline.media_time_s == 0
    assert manager.state_message("123")["control_action"] == "AUTOSTART"
    # Two "ended" reports for the same clip advance only once.
    assert manager.queue_play("123", host, ended_video_id="aaaaaaaaaaa")
    assert not manager.queue_play("123", host, ended_video_id="aaaaaaaaaaa")
    assert manager.get_state("123").video_id == "bbbbbbbbbbb"
    assert manager.queue_message("123")["now_playing"]["title"] == "B"
    assert not manager.queue_play("123", host)  # empty queue


def create_room(client: TestClient) -> tuple[str, str]:
    response = client.post("/rooms", follow_redirects=False)
    parsed = urlsplit(response.headers["location"])
    return parsed.path.rsplit("/", 1)[-1], parse_qs(parsed.fragment)["host"][0]


def receive_type(socket, wanted: str) -> dict:
    for _ in range(20):
        message = socket.receive_json()
        if message["type"] == wanted:
            return message
    raise AssertionError(f"no {wanted} message")


def test_queue_websocket_flow_with_playlist(monkeypatch):
    async def no_title(_video_id):
        return "Clip title"

    async def fake_playlist(playlist_id, limit):
        assert playlist_id == "PL1234567890abc"
        return "Mix", [
            MediaEntry("aaaaaaaaaaa", "A", 30),
            MediaEntry("bbbbbbbbbbb", "B", 40),
            MediaEntry("ccccccccccc", "C", 50),
        ]

    monkeypatch.setattr(main, "fetch_video_title", no_title)
    monkeypatch.setattr(main, "fetch_playlist", fake_playlist)
    with TestClient(main.app) as client:
        room_id, token = create_room(client)
        headers = {"origin": "http://testserver"}
        with client.websocket_connect(f"/ws/{room_id}", headers=headers) as host:
            host.send_json({"type": "HELLO", "host_token": token, "p2p": False})
            welcome = host.receive_json()
            assert welcome["queue"]["items"] == []

            # Starting from the second clip, like YouTube's watch?v=..&list=..
            host.send_json({
                "type": "QUEUE_ADD", "playlist": True,
                "url": "https://www.youtube.com/watch?v=bbbbbbbbbbb&list=PL1234567890abc",
            })
            notice = receive_type(host, "NOTICE")
            assert "2" in notice["message"]
            state = receive_type(host, "STATE")
            assert state["video_id"] == "bbbbbbbbbbb"  # empty room auto-starts
            queue = receive_type(host, "QUEUE")
            while [item["video_id"] for item in queue["items"]] != ["ccccccccccc"]:
                queue = receive_type(host, "QUEUE")

            with client.websocket_connect(f"/ws/{room_id}", headers=headers) as viewer:
                viewer.send_json({"type": "HELLO", "host_token": None, "p2p": False})
                assert viewer.receive_json()["queue"]["now_playing"]["video_id"] == "bbbbbbbbbbb"
                viewer.send_json({"type": "QUEUE_ADD", "url": "https://youtu.be/ddddddddddd"})
                assert "Host" in receive_type(viewer, "ERROR")["message"]
                viewer.send_json({"type": "QUEUE_NEXT"})
                assert receive_type(viewer, "ERROR")

            host.send_json({"type": "QUEUE_NEXT", "ended_video_id": "bbbbbbbbbbb"})
            state = receive_type(host, "STATE")
            assert state["video_id"] == "ccccccccccc"
            assert state["control_action"] == "AUTOSTART"
