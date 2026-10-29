from dataclasses import replace

from managers.sync import HostDriftFilter, PlaybackSample, Timeline


def point(at, drift, uncertainty=40):
    return PlaybackSample('host', 10 + at / 1000 + drift, at, True, False, 1, uncertainty * 2, uncertainty)


def test_normal_public_latency_tracks_host_after_persistent_drift():
    timeline = Timeline('video', True, 10, 0)
    f = HostDriftFilter()
    assert not f.observe(timeline, point(1000, .5))
    assert not f.observe(timeline, point(1300, .5))
    assert f.observe(timeline, point(1600, .5))
    assert timeline.expected_time(1600) == 12.1
    assert not f.observe(timeline, point(1800, .5))
    assert timeline.revision == 1


def test_alternating_jitter_does_not_reanchor():
    t = Timeline('video', True, 10, 0)
    f = HostDriftFilter()
    for i in range(100):
        assert not f.observe(t, point(i * 200, .35 if i % 2 else -.35))
    assert t.revision == 0


def test_clock_uncertainty_deadband_and_cap():
    t = Timeline('video', True, 10, 0)
    f = HostDriftFilter()
    for i in range(20):
        assert not f.observe(t, point(i * 200, .4, uncertainty=200))
        assert not f.observe(t, point(i * 200, 10, uncertainty=251))
    assert t.revision == 0


def test_large_error_recovers_immediately_but_buffering_is_ignored():
    t = Timeline('video', True, 10, 0)
    f = HostDriftFilter()
    assert not f.observe(t, replace(point(1000, 3), buffering=True))
    assert f.observe(t, point(1200, 3))
    assert t.revision == 1


def test_duplicate_or_gapped_samples_do_not_prove_persistence():
    t = Timeline('video', True, 10, 0)
    f = HostDriftFilter()
    assert not f.observe(t, point(1000, .5))
    assert not f.observe(t, point(5000, .5))
    for _ in range(10):
        assert not f.observe(t, point(5000, .5))
    assert t.revision == 0


def test_room_manager_accepts_normal_rtt_host_but_not_viewer_reference():
    from managers.room_manager import RoomManager
    now = [1000.0]
    manager = RoomManager(clock_ms=lambda: now[0])
    token = manager.create_room('123')
    host, viewer = object(), object()
    manager.identify('123', host, token)
    manager.identify('123', viewer, None)
    manager.rooms['123'].timeline = Timeline('video', True, 10, 0)
    assert not manager.record_sample('123', viewer, point(1000, 5))
    assert not manager.record_sample('123', host, point(1000, .5))
    now[0] = 1600
    assert manager.record_sample('123', host, point(1600, .5))
    assert manager.rooms['123'].timeline.revision == 1

