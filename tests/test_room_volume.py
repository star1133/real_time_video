import math

import pytest

from managers.room_manager import RoomManager


class Clock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def room_with_host_and_viewer():
    clock = Clock()
    manager = RoomManager(clock_ms=clock)
    token = manager.create_room("123")
    host = object()
    viewer = object()
    assert manager.identify("123", host, token) == "host"
    assert manager.identify("123", viewer, None) == "viewer"
    return manager, host, viewer


def test_room_volume_defaults_to_full_volume():
    manager, _host, _viewer = room_with_host_and_viewer()

    state = manager.state_message("123")

    assert state["volume"] == 100
    assert state["volume_revision"] == 0


def test_host_can_change_volume_without_changing_playback_revision():
    manager, host, _viewer = room_with_host_and_viewer()
    playback_revision = manager.get_state("123").revision

    assert manager.apply_volume("123", host, 37, "volume-1") is True

    state = manager.state_message("123")
    assert state["volume"] == 37
    assert state["volume_revision"] == 1
    assert state["revision"] == playback_revision


def test_viewer_cannot_change_room_volume():
    manager, _host, viewer = room_with_host_and_viewer()

    with pytest.raises(PermissionError):
        manager.apply_volume("123", viewer, 10, "volume-1")


@pytest.mark.parametrize("value", [-1, 101, 1.5, True, math.nan, math.inf, "loud"])
def test_invalid_room_volumes_are_rejected(value):
    manager, host, _viewer = room_with_host_and_viewer()

    with pytest.raises((TypeError, ValueError)):
        manager.apply_volume("123", host, value, "volume-1")


def test_duplicate_and_unchanged_volume_commands_are_idempotent():
    manager, host, _viewer = room_with_host_and_viewer()

    assert manager.apply_volume("123", host, 40, "volume-1") is True
    assert manager.apply_volume("123", host, 40, "volume-1") is False
    assert manager.apply_volume("123", host, 40, "volume-2") is False

    state = manager.state_message("123")
    assert state["volume"] == 40
    assert state["volume_revision"] == 1
