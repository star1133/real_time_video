from managers.sync import HostDriftFilter, PlaybackSample, Timeline


def sample(media_time_s: float, *, playing: bool = True) -> PlaybackSample:
    return PlaybackSample(
        client_id="host",
        media_time_s=media_time_s,
        observed_server_ms=2_000.0,
        is_playing=playing,
        buffering=False,
        playback_rate=1.0,
        rtt_ms=10.0,
        uncertainty_ms=5.0,
    )


def test_host_drift_below_quarter_second_never_micro_nudges_timeline():
    timeline = Timeline("video", True, 10.0, 1_000.0)
    drift_filter = HostDriftFilter()

    for _ in range(20):
        assert drift_filter.observe(timeline, sample(11.249)) is False

    assert timeline.revision == 0
    assert timeline.media_time_s == 10.0
    assert timeline.anchor_server_ms == 1_000.0


def test_sustained_quarter_second_drift_reanchors_once_after_settling():
    timeline = Timeline("video", True, 10.0, 1_000.0)
    drift_filter = HostDriftFilter()
    assert drift_filter.observe(timeline, sample(11.25)) is False
    later = sample(11.85)
    later.observed_server_ms = 2600.0
    assert drift_filter.observe(timeline, later) is True
    assert timeline.revision == 1
    assert timeline.media_time_s == 11.85
    assert timeline.anchor_server_ms == 2600.0


def test_play_pause_state_change_still_reanchors_immediately():
    timeline = Timeline("video", True, 10.0, 1_000.0)

    changed = HostDriftFilter().observe(timeline, sample(11.0, playing=False))

    assert changed is True
    assert timeline.is_playing is False
