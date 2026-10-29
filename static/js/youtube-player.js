(() => {
  const DEADBAND_S = 0.05;
  const HARD_DRIFT_S = 0.9;
  // Two tools, very different costs:
  // - A small speed change (0.9-1.1x) is invisible and keeps viewers within
  //   tens of ms. The YouTube embed accepts 0.05 steps although it does not
  //   list them (verified: 1.05/0.95/1.1 play exactly; 1.02 rounds to 1).
  // - A seek always re-buffers: a visible stutter, kept for large gaps only.
  const SYNC_PROFILES = {
    precise: {
      rateStartS: 0.04, rateStopS: 0.015, ratePersistMs: 600, maxRateDelta: 0.1,
      softDriftS: 0.35, hardDriftS: 0.8,
      softPersistMs: 1800, hardPersistMs: 400, seekCooldownMs: 6000,
    },
    balanced: {
      rateStartS: 0.07, rateStopS: 0.025, ratePersistMs: 1000, maxRateDelta: 0.1,
      softDriftS: 0.4, hardDriftS: 1.5,
      softPersistMs: 2500, hardPersistMs: 1000, seekCooldownMs: 8000,
    },
    smooth: {
      rateStartS: 0.15, rateStopS: 0.05, ratePersistMs: 2000, maxRateDelta: 0.05,
      softDriftS: 0.8, hardDriftS: 3,
      softPersistMs: 4000, hardPersistMs: 1500, seekCooldownMs: 15000,
    },
  };
  // Beyond this a 10% nudge would take too long; below it 5% is gentler.
  const STRONG_RATE_FROM_S = 0.4;
  // Seeks that fail to hold double the cooldown, so a player that cannot
  // keep up (slow network, weak phone) is not looped. A seek that lands
  // clears the history, keeping healthy players tight.
  const SEEK_BACKOFF_WINDOW_MS = 120000;
  const MAX_SEEK_COOLDOWN_MS = 60000;
  const MAX_SEEK_LEAD_S = 1.5;
  // Starting playback always costs a YouTube buffer, so a viewer begins
  // behind the Host. Shortly after it really plays, one seek closes a large
  // start gap; a small one is left to the speed nudge.
  const START_ALIGN_DELAY_MS = 700;
  const START_ALIGN_SEEK_S = 0.5;
  const SEEK_SETTLE_MS = 1500;
  const CORRECTION_INTERVAL_MS = 100;
  const RATE_CONFIRM_TIMEOUT_MS = 600;
  const MAX_RATE_PULSE_MS = 20000;
  const RATE_COOLDOWN_MS = 1500;
  const RATE_RETRY_COOLDOWN_MS = 10000;
  const RATE_FAILURES_BEFORE_FALLBACK = 2;
  const PLAYER_ERROR_MESSAGES = {
    2: 'ลิงก์วิดีโอไม่ถูกต้อง',
    5: 'วิดีโอนี้เล่นผ่าน embed ไม่ได้',
    100: 'ไม่พบวิดีโอนี้ อาจถูกลบหรือซ่อนไว้',
    101: 'เจ้าของวิดีโอไม่อนุญาตให้เล่นผ่าน embed',
    150: 'เจ้าของวิดีโอไม่อนุญาตให้เล่นผ่าน embed',
    153: 'YouTube ไม่ได้รับข้อมูลต้นทางของเว็บไซต์',
  };

  function youtubeErrorMessage(code) {
    return PLAYER_ERROR_MESSAGES[Number(code)]
      || 'YouTube ไม่สามารถเล่นวิดีโอนี้ในหน้าเว็บได้';
  }

  function safeCall(object, method, fallback, ...args) {
    try {
      if (typeof object?.[method] !== 'function') return fallback;
      const value = object[method](...args);
      return value === undefined ? fallback : value;
    } catch (_) {
      return fallback;
    }
  }

  class YouTubeController {
    constructor(elementId, onPlaybackEvent) {
      this.elementId = elementId;
      this.onPlaybackEvent = onPlaybackEvent;
      this.player = null;
      this.ready = false;
      this.videoId = null;
      this.desiredPlaying = false;
      this.playAttempted = false;
      this.isBuffering = false;
      this.remoteDepth = 0;
      this.lastDrift = 0;
      this.pendingRate = null;
      this.pendingRateRequestedAt = 0;
      this.ownedRate = null;
      this.rateUnavailableUntil = 0;
      this.rateCorrectionEndsAt = 0;
      this.rateCooldownUntil = 0;
      this.correctionCooldownUntil = 0;
      this.seekSettlingUntil = 0;
      this.hardDriftSince = null;
      this.softDriftSince = null;
      this.softSeekAttempts = 0;
      this.postBufferPlayingSamples = 0;
      this.lastControlRevision = -1;
      this.lastAppliedRevision = -1;
      this.lastSample = null;
      this.pendingUserSeek = null;
      this.lastSeekObservedLocalMs = 0;
      this.suppressSeekDetectionUntil = 0;
      this.nextCorrectionAt = 0;
      this.lastCorrectionAt = null;
      this.driftDirection = 0;
      this.profileName = 'balanced';
      this.profile = SYNC_PROFILES.balanced;
      this.autoSeekTimes = [];
      this.seekLeadS = 0;
      this.leadProbePending = false;
      this.startAlignPending = false;
      this.startAlignSince = null;
      this.rateCooldownUntil = 0;
      this.rateFailures = 0;
      this.fineRatesSupported = true;
    }

    setSyncProfile(name) {
      const next = SYNC_PROFILES[name] ? name : 'balanced';
      if (next === this.profileName) return;
      this.profileName = next;
      this.profile = SYNC_PROFILES[next];
      this.clearDriftWatch();
    }

    // Seek a little ahead to cover YouTube's own re-buffer time; the lead is
    // learned from the residual drift observed once the player has settled.
    autoSeek(expectedTime, allowAhead, nowMs, countsTowardBackoff = true) {
      this.autoSeekTimes = this.autoSeekTimes
        .filter((at) => nowMs - at < SEEK_BACKOFF_WINDOW_MS)
        .concat(countsTowardBackoff ? [nowMs] : []);
      this.seekTo(expectedTime + this.seekLeadS, allowAhead);
      this.leadProbePending = true;
      this.seekSettlingUntil = nowMs + SEEK_SETTLE_MS;
      this.correctionCooldownUntil = nowMs + Math.min(
        MAX_SEEK_COOLDOWN_MS,
        this.profile.seekCooldownMs * (2 ** Math.max(0, this.autoSeekTimes.length - 1)),
      );
    }

    create(onReady) {
      const placeholder = document.getElementById(this.elementId);
      if (!placeholder) throw new Error('ไม่พบตำแหน่งตัวเล่น YouTube');

      const iframe = document.createElement('iframe');
      const pageHref = window.location.href || window.location.origin;
      const widgetReferrer = pageHref.split('#')[0];
      const params = new URLSearchParams({
        enablejsapi: '1',
        controls: '1',
        fs: '1',
        rel: '0',
        playsinline: '1',
        origin: window.location.origin,
        widget_referrer: widgetReferrer,
      });
      iframe.id = this.elementId;
      iframe.src = `https://www.youtube.com/embed/?${params.toString()}`;
      iframe.title = 'YouTube video player';
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share';
      iframe.allowFullscreen = true;
      iframe.referrerPolicy = 'strict-origin-when-cross-origin';
      iframe.loading = 'eager';
      placeholder.replaceWith(iframe);

      this.player = new YT.Player(iframe, {
        events: {
          onReady: () => {
            this.ready = true;
            onReady?.();
          },
          onStateChange: (event) => this.handleStateChange(event),
          onPlaybackRateChange: (event) => this.handlePlaybackRateChange(event),
          onError: (event) => window.dispatchEvent(
            new CustomEvent('watchparty-player-error', { detail: event.data }),
          ),
        },
      });
      // Background timers are throttled; a short correction pulse must not
      // remain at 1.25x until the tab becomes active again.
      document.addEventListener?.('visibilitychange', () => {
        this.restoreNormalRate(performance.now(), true);
        this.clearDriftWatch();
        this.lastCorrectionAt = null;
        this.lastSample = null;
        this.pendingUserSeek = null;
      });
      return this.player;
    }

    currentTime() {
      const value = Number(safeCall(this.player, 'getCurrentTime', 0));
      return Number.isFinite(value) ? Math.max(0, value) : 0;
    }

    playerState() {
      return safeCall(this.player, 'getPlayerState', YT.PlayerState.UNSTARTED);
    }

    playbackRate() {
      const value = Number(safeCall(this.player, 'getPlaybackRate', 1));
      return Number.isFinite(value) && value > 0 ? value : 1;
    }

    setVolume(volume) {
      const normalized = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
      safeCall(this.player, 'setVolume', null, normalized);
      if (normalized > 0) safeCall(this.player, 'unMute', null);
      else safeCall(this.player, 'mute', null);
      return normalized;
    }

    mute() {
      safeCall(this.player, 'mute', null);
      safeCall(this.player, 'setVolume', null, 0);
    }

    setBuffering(buffering) {
      const next = Boolean(buffering);
      if (this.isBuffering && !next) this.postBufferPlayingSamples = 2;
      this.isBuffering = next;
      if (next) {
        this.restoreNormalRate(performance.now());
        this.clearDriftWatch();
      }
    }

    seekTo(time, allowAhead) {
      const nowMs = performance.now();
      this.suppressSeekDetectionUntil = nowMs + SEEK_SETTLE_MS;
      this.seekSettlingUntil = nowMs + SEEK_SETTLE_MS;
      this.correctionCooldownUntil = nowMs + this.profile.seekCooldownMs;
      safeCall(
        this.player,
        'seekTo',
        null,
        Math.max(0, Number(time) || 0),
        allowAhead,
      );
    }

    playFromGesture(expectedTime) {
      if (!this.ready || !this.player || !this.videoId) return false;
      this.desiredPlaying = true;
      this.playAttempted = true;
      safeCall(this.player, 'playVideo', null);
      if (Number.isFinite(expectedTime)) {
        this.seekTo(expectedTime, true);
      }
      return true;
    }

    availableCorrectionRate(drift, nowMs = performance.now()) {
      if (nowMs < this.rateUnavailableUntil || this.profile.maxRateDelta <= 0) return null;
      const direction = drift > 0 ? 1 : -1;
      if (this.fineRatesSupported) {
        const delta = Math.abs(drift) >= STRONG_RATE_FROM_S
          ? this.profile.maxRateDelta : Math.min(0.05, this.profile.maxRateDelta);
        return Math.round((1 + direction * delta) * 100) / 100;
      }
      // Fallback for players that rejected unlisted speeds: listed fine rates only.
      const rates = safeCall(this.player, 'getAvailablePlaybackRates', [1]);
      if (!Array.isArray(rates)) return null;
      const valid = rates.map(Number).filter(
        (rate) => Number.isFinite(rate) && rate >= 0.97 && rate <= 1.03,
      );
      if (direction > 0) {
        return valid.filter((rate) => rate > 1).sort((a, b) => a - b)[0] ?? null;
      }
      return valid.filter((rate) => rate < 1).sort((a, b) => b - a)[0] ?? null;
    }

    requestRate(rate, drift, nowMs, stopS) {
      const speedDelta = Math.abs(rate - 1);
      if (speedDelta <= 0) return false;
      const correctionS = Math.max(0, Math.abs(drift) - stopS);
      this.pendingRate = rate;
      this.pendingRateRequestedAt = nowMs;
      // Generous upper bound only; the pulse normally ends when drift is gone.
      this.rateCorrectionEndsAt = nowMs + RATE_CONFIRM_TIMEOUT_MS + Math.min(
        MAX_RATE_PULSE_MS,
        Math.max(CORRECTION_INTERVAL_MS, correctionS / speedDelta * 1000 * 1.5),
      );
      safeCall(this.player, 'setPlaybackRate', null, rate);
      return true;
    }


    restoreNormalRate(nowMs, withCooldown = false) {
      const hadCorrection = this.pendingRate !== null || this.ownedRate !== null;
      this.pendingRate = null;
      this.pendingRateRequestedAt = 0;
      this.ownedRate = null;
      this.rateCorrectionEndsAt = 0;
      if (withCooldown) {
        this.rateCooldownUntil = nowMs + RATE_COOLDOWN_MS;
        this.correctionCooldownUntil = Math.max(
          this.correctionCooldownUntil, nowMs + RATE_COOLDOWN_MS,
        );
      }
      // Cancel even an unconfirmed request: iframe acknowledgements can lag.
      if (hadCorrection || Math.abs(this.playbackRate() - 1) > 0.001) {
        safeCall(this.player, 'setPlaybackRate', null, 1);
      }
    }

    handlePlaybackRateChange(event) {
      const rate = Number(event?.data);
      const nowMs = performance.now();
      if (this.pendingRate !== null && Math.abs(rate - this.pendingRate) < 0.001) {
        this.ownedRate = rate;
        this.pendingRate = null;
        this.pendingRateRequestedAt = 0;
        this.rateFailures = 0;
        return;
      }
      if (Math.abs(rate - 1) < 0.001 && this.ownedRate === null) return;
      if (this.ownedRate !== null && Math.abs(rate - this.ownedRate) < 0.001) return;

      this.pendingRate = null;
      this.pendingRateRequestedAt = 0;
      this.ownedRate = null;
      this.rateCorrectionEndsAt = 0;
      this.rateUnavailableUntil = nowMs + RATE_RETRY_COOLDOWN_MS;
      this.correctionCooldownUntil = nowMs + RATE_COOLDOWN_MS;
      this.onPlaybackEvent?.({ type: 'RATE_OVERRIDE', rate });
      safeCall(this.player, 'setPlaybackRate', null, 1);
    }

    clearDriftWatch() {
      this.hardDriftSince = null;
      this.softDriftSince = null;
      this.driftDirection = 0;
      this.fineDriftSince = null;
    }

    correctDrift(expectedTime, suppliedNowMs = performance.now(), uncertaintyMs = 0) {
      const nowMs = Number(suppliedNowMs);
      if (!Number.isFinite(expectedTime) || !Number.isFinite(nowMs)) {
        this.restoreNormalRate(performance.now(), true);
        this.clearDriftWatch();
        return 'not-ready';
      }
      // Suspension and missed ticks are not evidence of persistent drift.
      if (this.lastCorrectionAt !== null
          && (nowMs - this.lastCorrectionAt > 1000 || nowMs < this.lastCorrectionAt)) {
        this.restoreNormalRate(nowMs, true);
        this.clearDriftWatch();
      }
      this.lastCorrectionAt = nowMs;
      if (this.isBuffering || this.playerState() === YT.PlayerState.BUFFERING) {
        this.restoreNormalRate(nowMs);
        this.clearDriftWatch();
        return 'buffering';
      }
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        this.restoreNormalRate(nowMs);
        this.clearDriftWatch();
        return 'background';
      }
      if (!Number.isFinite(uncertaintyMs) || uncertaintyMs < 0 || uncertaintyMs > 1000) {
        this.restoreNormalRate(nowMs, true);
        this.clearDriftWatch();
        return 'clock-uncertain';
      }
      this.lastDrift = expectedTime - this.currentTime();
      const magnitude = Math.abs(this.lastDrift);
      const profile = this.profile;
      // Never chase errors smaller than the reference can actually resolve.
      const rateStartS = Math.max(profile.rateStartS, uncertaintyMs * 1.5 / 1000);
      const rateStopS = Math.max(profile.rateStopS, uncertaintyMs * 0.5 / 1000);
      const softDriftS = Math.max(profile.softDriftS, rateStartS + 0.15);
      const hardDriftS = Math.max(profile.hardDriftS, uncertaintyMs * 4 / 1000);
      const activeRate = this.ownedRate ?? this.pendingRate;
      if (activeRate !== null) {
        if (magnitude <= rateStopS
            || Math.sign(this.lastDrift) !== Math.sign(activeRate - 1)
            || nowMs >= this.rateCorrectionEndsAt) {
          this.restoreNormalRate(nowMs, true);
          this.clearDriftWatch();
          return 'stable';
        }
        if (this.pendingRate !== null) {
          if (nowMs - this.pendingRateRequestedAt < RATE_CONFIRM_TIMEOUT_MS) return 'rate-pending';
          this.restoreNormalRate(nowMs, true);
          this.rateUnavailableUntil = nowMs + RATE_RETRY_COOLDOWN_MS;
          this.rateFailures += 1;
          if (this.rateFailures >= RATE_FAILURES_BEFORE_FALLBACK) this.fineRatesSupported = false;
          this.clearDriftWatch();
          return 'rate-unavailable';
        }
        // A nudge cannot close a gap that keeps growing; hand over to a seek.
        if (magnitude < hardDriftS) return 'rate-correcting';
        this.restoreNormalRate(nowMs);
      }
      if (nowMs < this.seekSettlingUntil) return 'settling';
      if (this.leadProbePending) {
        this.leadProbePending = false;
        if (magnitude < 3) {
          this.seekLeadS = Math.max(0, Math.min(
            MAX_SEEK_LEAD_S, this.seekLeadS + this.lastDrift * 0.7,
          ));
        }
        if (magnitude <= softDriftS) this.autoSeekTimes = [];
      }
      const rateAvailable = this.availableCorrectionRate(this.lastDrift || 1, nowMs) !== null;
      if (this.startAlignPending) {
        this.startAlignSince ??= nowMs;
        if (nowMs - this.startAlignSince < START_ALIGN_DELAY_MS) return 'start-align-wait';
        this.startAlignPending = false;
        this.startAlignSince = null;
        const seekFrom = rateAvailable ? Math.max(START_ALIGN_SEEK_S, rateStartS) : rateStartS;
        if (magnitude > seekFrom && magnitude < 30) {
          this.restoreNormalRate(nowMs);
          this.autoSeek(expectedTime, true, nowMs, false);
          this.clearDriftWatch();
          return 'start-align';
        }
      }
      if (nowMs < this.nextCorrectionAt) return 'precision-wait';
      this.nextCorrectionAt = nowMs + CORRECTION_INTERVAL_MS;
      if (magnitude <= rateStartS) {
        this.clearDriftWatch();
        return 'stable';
      }
      const direction = Math.sign(this.lastDrift);
      if (direction !== this.driftDirection) this.clearDriftWatch();
      this.driftDirection = direction;
      if (magnitude >= hardDriftS) this.hardDriftSince ??= nowMs;
      else this.hardDriftSince = null;
      if (magnitude >= softDriftS) this.softDriftSince ??= nowMs;
      else this.softDriftSince = null;
      // Even gross errors must survive several observations; a single noisy
      // iframe read is never a reason to seek. Explicit Host seeks bypass this.
      const hardReady = this.hardDriftSince !== null
        && nowMs - this.hardDriftSince >= profile.hardPersistMs;
      // With speed nudges available, medium drift never needs a seek.
      const softReady = !rateAvailable && this.softDriftSince !== null
        && nowMs - this.softDriftSince >= profile.softPersistMs;
      if ((hardReady || softReady) && nowMs >= this.correctionCooldownUntil) {
        this.restoreNormalRate(nowMs);
        this.autoSeek(expectedTime, hardReady, nowMs);
        this.clearDriftWatch();
        return 'precision-seek';
      }
      if (magnitude < hardDriftS && rateAvailable) {
        this.fineDriftSince ??= nowMs;
        if (nowMs - this.fineDriftSince >= profile.ratePersistMs
            && nowMs >= this.rateCooldownUntil) {
          this.requestRate(
            this.availableCorrectionRate(this.lastDrift, nowMs), this.lastDrift, nowMs, rateStopS,
          );
          this.fineDriftSince = null;
          return 'rate-requested';
        }
      } else this.fineDriftSince = null;
      return nowMs < this.correctionCooldownUntil ? 'cooldown' : 'drift-watch';
    }


    forceAlign(state, expectedTime, suppliedNowMs = performance.now()) {
      if (!this.ready || !this.player || !state?.video_id || this.isBuffering
          || this.playerState() === YT.PlayerState.BUFFERING) return false;
      const nowMs = Number(suppliedNowMs);
      if (!Number.isFinite(expectedTime) || !Number.isFinite(nowMs)
          || nowMs < this.seekSettlingUntil || nowMs < this.correctionCooldownUntil) {
        return false;
      }
      this.resetCorrectionState();
      this.lastDrift = Number(expectedTime) - this.currentTime();
      this.seekTo(expectedTime, true);
      this.seekSettlingUntil = nowMs + 2000;
      this.desiredPlaying = Boolean(state.is_playing);
      if (state.is_playing && this.playerState() !== YT.PlayerState.PLAYING) {
        this.playAttempted = true;
        safeCall(this.player, 'playVideo', null);
      } else if (!state.is_playing) {
        this.playAttempted = false;
        safeCall(this.player, 'pauseVideo', null);
      }
      return true;
    }

    applyDirectControl(action, expectedTime) {
      if (!this.ready || !this.player || !Number.isFinite(expectedTime)
          || !['PLAY', 'PAUSE', 'SEEK'].includes(action)) return false;
      this.resetCorrectionState();
      if (action === 'PLAY') {
        this.desiredPlaying = true;
        this.playAttempted = true;
        if (Math.abs(expectedTime - this.currentTime()) >= HARD_DRIFT_S) {
          this.seekTo(expectedTime, true);
        }
        safeCall(this.player, 'playVideo', null);
      } else if (action === 'PAUSE') {
        this.desiredPlaying = false;
        this.playAttempted = false;
        safeCall(this.player, 'pauseVideo', null);
        if (Math.abs(expectedTime - this.currentTime()) > DEADBAND_S) {
          this.seekTo(expectedTime, false);
        }
      } else {
        this.seekTo(expectedTime, true);
      }
      return true;
    }

    apply(state, expectedTime, bootstrap = false, controlAction = null, clockPrecise = true, options = {}) {
      if (!this.ready || !this.player || !state) return 'not-ready';
      const revision = Number(state.revision);
      if (Number.isFinite(revision) && revision < this.lastAppliedRevision) return 'stale-state';
      if (options.isHost && !bootstrap && !controlAction && state.video_id === this.videoId) {
        this.restoreNormalRate(performance.now());
        this.clearDriftWatch();
        if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
        return 'host-reference';
      }
      const newRevision = Number.isFinite(revision) && revision !== this.lastAppliedRevision;
      const newControl = controlAction
        && Number.isFinite(revision)
        && revision !== this.lastControlRevision;

      if (newRevision) {
        this.restoreNormalRate(performance.now());
        this.clearDriftWatch();
      }
      if (state.video_id && state.video_id !== this.videoId) {
        this.videoId = state.video_id;
        this.desiredPlaying = Boolean(state.is_playing);
        this.playAttempted = false;
        this.resetCorrectionState();
        // The jump to the new clip's start is not a Host scrub.
        this.autoSeekTimes = [];
        this.lastSample = null;
        this.pendingUserSeek = null;
        this.suppressSeekDetectionUntil = performance.now() + SEEK_SETTLE_MS;
        safeCall(this.player, 'cueVideoById', null, {
          videoId: state.video_id,
          startSeconds: Math.max(0, Number(expectedTime) || 0),
        });
        if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
        if (newControl) this.lastControlRevision = revision;
        return 'bootstrap-video';
      }
      if (!state.video_id) return 'idle';

      if (bootstrap) {
        // Reconnects and returning to the tab used to always seek. When this
        // player is still in the right state and close enough, keep playing.
        const current = this.playerState();
        const stateMatches = state.is_playing
          ? current === YT.PlayerState.PLAYING
          : [YT.PlayerState.PAUSED, YT.PlayerState.CUED ?? 5].includes(current);
        const keepWithinS = Math.max(0.5, this.profile.softDriftS);
        this.lastDrift = Number(expectedTime) - this.currentTime();
        if (stateMatches && Math.abs(this.lastDrift) < keepWithinS) {
          this.desiredPlaying = Boolean(state.is_playing);
          this.clearDriftWatch();
          if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
          if (newControl) this.lastControlRevision = revision;
          return 'bootstrap-kept';
        }
        this.resetCorrectionState();
        this.seekTo(Number(expectedTime) + (state.is_playing ? this.seekLeadS : 0), true);
        this.desiredPlaying = Boolean(state.is_playing);
        if (state.is_playing) {
          this.playAttempted = true;
          safeCall(this.player, 'playVideo', null);
        } else {
          this.playAttempted = false;
          safeCall(this.player, 'pauseVideo', null);
        }
        if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
        return 'bootstrap';
      }

      if (newControl && controlAction === 'SEEK') {
        this.resetCorrectionState();
        this.seekTo(expectedTime, true);
        this.lastControlRevision = revision;
        this.lastAppliedRevision = revision;
        this.postBufferPlayingSamples = 1;
        return 'control-seek';
      }

      const actualState = this.playerState();
      if (!state.is_playing) {
        const wasPlaying = this.desiredPlaying
          || actualState === YT.PlayerState.PLAYING
          || actualState === YT.PlayerState.BUFFERING;
        this.desiredPlaying = false;
        this.playAttempted = false;
        this.restoreNormalRate(performance.now());
        if (wasPlaying) safeCall(this.player, 'pauseVideo', null);
        const drift = Number(expectedTime) - this.currentTime();
        this.lastDrift = drift;
        if (newRevision && Math.abs(drift) > DEADBAND_S) {
          this.seekTo(expectedTime, false);
          if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
          if (newControl) this.lastControlRevision = revision;
          return 'paused-align';
        }
        if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
        if (newControl) this.lastControlRevision = revision;
        return 'stable';
      }

      this.desiredPlaying = true;
      if (actualState === YT.PlayerState.ENDED) {
        // Finishing a moment before the Host must not restart the clip at 0.
        if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
        if (newControl) this.lastControlRevision = revision;
        return 'ended-wait';
      }
      if (actualState !== YT.PlayerState.PLAYING) {
        // A real start (not a mid-play re-buffer) earns one quick alignment.
        if (actualState !== YT.PlayerState.BUFFERING) {
          this.startAlignPending = true;
          this.startAlignSince = null;
        }
        if (!this.playAttempted) {
          this.playAttempted = true;
          safeCall(this.player, 'playVideo', null);
        }
        if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
        if (newControl) this.lastControlRevision = revision;
        return 'awaiting-play';
      }

      this.playAttempted = false;
      if (Number.isFinite(revision)) this.lastAppliedRevision = revision;
      if (newControl) this.lastControlRevision = revision;
      const uncertaintyMs = typeof clockPrecise === 'number' ? clockPrecise : 0;

      // Internet paths need no separate mode: thresholds below already widen
      // with the measured clock uncertainty.
      if (clockPrecise === false || !Number.isFinite(uncertaintyMs)
          || uncertaintyMs > 1000) {
        this.restoreNormalRate(performance.now());
        this.clearDriftWatch();
        return 'clock-uncertain';
      }
      return this.correctDrift(expectedTime, performance.now(), uncertaintyMs);
    }

    resetCorrectionState() {
      this.restoreNormalRate(performance.now());
      this.pendingRate = null;
      this.pendingRateRequestedAt = 0;
      this.ownedRate = null;
      this.rateUnavailableUntil = 0;
      this.rateCorrectionEndsAt = 0;
      this.correctionCooldownUntil = 0;
      this.seekSettlingUntil = 0;
      this.hardDriftSince = null;
      this.softDriftSince = null;
      this.softSeekAttempts = 0;
      this.postBufferPlayingSamples = 0;
      this.nextCorrectionAt = 0;
      this.lastCorrectionAt = null;
      this.startAlignPending = false;
      this.startAlignSince = null;
      this.clearDriftWatch();
    }

    handleStateChange(event) {
      const state = event?.data;
      const observedLocalMs = performance.now();
      if (state === YT.PlayerState.BUFFERING) {
        const current = this.currentTime();
        if (this.lastSample) {
          const elapsed = Math.max(0, observedLocalMs - this.lastSample.at) / 1000;
          const predicted = this.lastSample.time
            + (this.lastSample.state === YT.PlayerState.PLAYING
              ? elapsed * this.lastSample.rate
              : 0);
          if (elapsed <= 1 && observedLocalMs >= this.suppressSeekDetectionUntil
              && Math.abs(current - predicted) > 1) {
            this.pendingUserSeek = current;
            this.lastSeekObservedLocalMs = observedLocalMs;
          }
        }
        this.setBuffering(true);
      } else if (state === YT.PlayerState.PLAYING) {
        const shouldReport = !this.desiredPlaying;
        this.setBuffering(false);
        this.postBufferPlayingSamples = Math.max(this.postBufferPlayingSamples, 4);
        this.desiredPlaying = true;
        this.playAttempted = false;
        window.dispatchEvent(new CustomEvent('watchparty-player-playing'));
        if (shouldReport) {
          this.onPlaybackEvent?.({
            type: 'PLAY',
            time: this.currentTime(),
            observed_local_ms: observedLocalMs,
          });
        }
      } else if (state === YT.PlayerState.PAUSED) {
        this.restoreNormalRate(observedLocalMs, true);
        this.clearDriftWatch();
        this.setBuffering(false);
        if (!(this.desiredPlaying && this.playAttempted) && this.desiredPlaying) {
          this.desiredPlaying = false;
          this.playAttempted = false;
          this.onPlaybackEvent?.({
            type: 'PAUSE',
            time: this.currentTime(),
            observed_local_ms: observedLocalMs,
          });
        }
      } else if (state === YT.PlayerState.ENDED) {
        this.restoreNormalRate(observedLocalMs, true);
        this.clearDriftWatch();
        this.setBuffering(false);
        this.desiredPlaying = false;
        this.playAttempted = false;
        this.onPlaybackEvent?.({
          type: 'ENDED',
          videoId: this.videoId,
          time: this.currentTime(),
          observed_local_ms: observedLocalMs,
        });
      }

      this.lastSample = {
        time: this.currentTime(),
        at: observedLocalMs,
        state,
        rate: this.playbackRate(),
      };
    }

    detectUserSeek() {
      if (this.pendingUserSeek !== null) {
        const value = this.pendingUserSeek;
        this.pendingUserSeek = null;
        return value;
      }
      const at = performance.now();
      const time = this.currentTime();
      const state = this.playerState();
      const rate = this.playbackRate();
      if (!this.lastSample) {
        this.lastSample = { time, at, state, rate };
        return null;
      }
      const elapsed = Math.max(0, at - this.lastSample.at) / 1000;
      const predicted = this.lastSample.time
        + (this.lastSample.state === YT.PlayerState.PLAYING
          ? elapsed * this.lastSample.rate
          : 0);
      const moved = Math.abs(time - predicted) > 1;
      this.lastSample = { time, at, state, rate };
      // A throttled/background interval or stalled iframe is not a user seek.
      if (!moved || elapsed > 1 || at < this.suppressSeekDetectionUntil
          || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return null;
      this.lastSeekObservedLocalMs = at;
      return time;
    }

    telemetry(observedServerMs, rttMs, uncertaintyMs, sampledMediaTime = null) {
      const state = this.playerState();
      const isPlaying = state === YT.PlayerState.PLAYING;
      const buffering = this.isBuffering
        || state === YT.PlayerState.BUFFERING
        || (this.desiredPlaying && !isPlaying);
      return {
        media_time_s: sampledMediaTime === null
          ? this.currentTime()
          : Number(sampledMediaTime),
        observed_server_ms: Number(observedServerMs),
        is_playing: isPlaying,
        buffering,
        playback_rate: this.playbackRate(),
        rtt_ms: Number(rttMs),
        uncertainty_ms: Number(uncertaintyMs),
      };
    }
  }

  window.YouTubeController = YouTubeController;
  window.youtubeErrorMessage = youtubeErrorMessage;
})();
