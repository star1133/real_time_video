from __future__ import annotations

import math
import statistics
import time
from dataclasses import dataclass
from typing import Iterable


HOST_HARD_DRIFT_S = 0.25
SAMPLE_STALE_MS = 2_000.0
SAMPLE_FUTURE_MS = 500.0
MAX_CLOCK_UNCERTAINTY_MS = 25.0  # Strict precision statistics, not host availability.
MAX_HOST_CLOCK_UNCERTAINTY_MS = 250.0
HOST_DRIFT_PERSIST_MS = 600.0
OUTLIER_ERROR_S = 2.0


def monotonic_ms() -> float:
    return time.perf_counter_ns() / 1_000_000.0


@dataclass(slots=True)
class Timeline:
    video_id: str | None
    is_playing: bool
    media_time_s: float
    anchor_server_ms: float
    revision: int = 0

    def expected_time(self, server_ms: float) -> float:
        elapsed = max(0.0, server_ms - self.anchor_server_ms) / 1_000.0
        return max(0.0, self.media_time_s + (elapsed if self.is_playing else 0.0))

    def reanchor(
        self,
        media_time_s: float,
        server_ms: float,
        *,
        playing: bool | None = None,
    ) -> None:
        media_time, anchor = float(media_time_s), float(server_ms)
        if not math.isfinite(media_time) or not math.isfinite(anchor):
            raise ValueError("timeline values must be finite")
        self.media_time_s = max(0.0, media_time)
        self.anchor_server_ms = anchor
        if playing is not None:
            self.is_playing = bool(playing)
        self.revision += 1


@dataclass(slots=True)
class PlaybackSample:
    client_id: str
    media_time_s: float
    observed_server_ms: float
    is_playing: bool
    buffering: bool
    playback_rate: float
    rtt_ms: float
    uncertainty_ms: float
    error_s: float = 0.0


class HostDriftFilter:
    """Follow sustained Host drift without turning clock noise into revisions."""

    def __init__(self) -> None:
        self.reset()

    def reset(self) -> None:
        self.drift_since_ms: float | None = None
        self.last_observed_ms: float | None = None
        self.drift_sign = 0

    def observe(self, timeline: Timeline, sample: PlaybackSample) -> bool:
        if (
            sample.buffering
            or not math.isfinite(sample.media_time_s)
            or not math.isfinite(sample.observed_server_ms)
            or not math.isfinite(sample.uncertainty_ms)
            or not 0 <= sample.uncertainty_ms <= MAX_HOST_CLOCK_UNCERTAINTY_MS
        ):
            self.reset()
            return False

        expected = timeline.expected_time(sample.observed_server_ms)
        drift = float(sample.media_time_s) - expected
        threshold = max(HOST_HARD_DRIFT_S, sample.uncertainty_ms * 3 / 1000)
        immediate = abs(drift) >= 1.5 or sample.is_playing != timeline.is_playing
        if not immediate and abs(drift) >= threshold:
            sign = 1 if drift > 0 else -1
            observed = sample.observed_server_ms
            if (self.drift_since_ms is None or sign != self.drift_sign
                    or self.last_observed_ms is None
                    or observed <= self.last_observed_ms
                    or observed - self.last_observed_ms > SAMPLE_STALE_MS):
                self.drift_since_ms = observed
            self.drift_sign = sign
            self.last_observed_ms = observed
            if observed - self.drift_since_ms < HOST_DRIFT_PERSIST_MS:
                return False
        elif not immediate:
            self.reset()
            return False
        if immediate or abs(drift) >= threshold:
            timeline.reanchor(
                sample.media_time_s,
                sample.observed_server_ms,
                playing=sample.is_playing,
            )
            self.reset()
            return True

        self.reset()
        return False


def _percentile_nearest_rank(values: list[float], percentile: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return ordered[index]


def summarize_cohort(
    samples: Iterable[PlaybackSample], now_server_ms: float
) -> dict[str, int | float | bool | None]:
    healthy: list[PlaybackSample] = []
    outlier_count = 0
    stale_count = 0
    future_count = 0
    buffering_count = 0
    uncertain_count = 0

    for sample in samples:
        age_ms = now_server_ms - sample.observed_server_ms
        if age_ms > SAMPLE_STALE_MS:
            stale_count += 1
            continue
        if age_ms < -SAMPLE_FUTURE_MS:
            future_count += 1
            continue
        if sample.buffering:
            buffering_count += 1
            continue
        if sample.uncertainty_ms > MAX_CLOCK_UNCERTAINTY_MS:
            uncertain_count += 1
            continue
        if abs(sample.error_s) > OUTLIER_ERROR_S:
            outlier_count += 1
            continue
        healthy.append(sample)

    errors = [float(sample.error_s) for sample in healthy]
    absolute_ms = [abs(error) * 1_000.0 for error in errors]
    within_count = sum(value <= 100.0 + 1e-9 for value in absolute_ms)
    spread_ms = (max(errors) - min(errors)) * 1_000.0 if errors else None
    return {
        "healthy_count": len(healthy),
        "outlier_count": outlier_count,
        "excluded_count": stale_count
        + future_count
        + buffering_count
        + uncertain_count,
        "stale_count": stale_count,
        "future_count": future_count,
        "buffering_excluded_count": buffering_count,
        "clock_uncertain_count": uncertain_count,
        "within_100ms_count": within_count,
        "within_100ms_ratio": within_count / len(healthy) if healthy else 0.0,
        "all_within_100ms": bool(errors) and spread_ms <= 100.0 + 1e-9,
        "phase_spread_ms": spread_ms,
        "median_error_ms": statistics.median(absolute_ms) if absolute_ms else None,
        "p95_abs_error_ms": _percentile_nearest_rank(absolute_ms, 0.95)
        if absolute_ms
        else None,
    }
