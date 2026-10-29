from managers.room_manager import RoomManager
from managers.sync import PlaybackSample


class FakeClock:
    def __init__(self) -> None:
        self.now = 1_000.0

    def __call__(self) -> float:
        return self.now


def playing_room():
    clock = FakeClock()
    manager = RoomManager(clock)
    token = manager.create_room("123")
    host, viewer = object(), object()
    manager.identify("123", host, token)
    manager.identify("123", viewer, None)
    manager.apply_control("123", host, "SET_VIDEO", "c1", 0, clock.now, "aaaaaaaaaaa")
    manager.apply_control("123", host, "PLAY", "c2", 0, clock.now)
    return clock, manager, host, viewer


def sample(media, observed, *, buffering=False, playing=True):
    return PlaybackSample("", media, observed, playing, buffering, 1.0, 40.0, 20.0)


def test_state_carries_fresh_host_reading_for_viewers():
    clock, manager, host, viewer = playing_room()
    assert "host_sample" not in manager.state_message("123")
    clock.now += 500
    manager.record_sample("123", host, sample(0.45, clock.now - 10))
    reading = manager.state_message("123")["host_sample"]
    assert reading["media_time_s"] == 0.45
    assert reading["observed_server_ms"] == clock.now - 10
    assert reading["uncertainty_ms"] == 20.0
    # A viewer's own sample is never presented as the Host reference.
    manager.record_sample("123", viewer, sample(9.0, clock.now))
    assert manager.state_message("123")["host_sample"]["media_time_s"] == 0.45


def test_stale_or_buffering_host_reading_is_withheld():
    clock, manager, host, _viewer = playing_room()
    clock.now += 500
    manager.record_sample("123", host, sample(0.4, clock.now, buffering=True))
    assert "host_sample" not in manager.state_message("123")
    manager.record_sample("123", host, sample(0.5, clock.now + 100))
    clock.now += 3_000
    assert "host_sample" not in manager.state_message("123")
