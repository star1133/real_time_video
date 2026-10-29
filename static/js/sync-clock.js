(() => {
  function median(values) {
    if (!values.length) return Number.NaN;
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  class SyncClock {
    constructor() {
      this.reset();
    }

    reset() {
      this.ready = false;
      this.offset = 0;
      this.rtt = Number.POSITIVE_INFINITY;
      this._uncertainty = Number.POSITIVE_INFINITY;
      this.lastMeasurementAt = null;
      this.lastUpdateAt = null;
      this.measurements = [];
    }

    measure(clientSendMs, serverReceiveMs, serverSendMs, clientReceiveMs) {
      if (![clientSendMs, serverReceiveMs, serverSendMs, clientReceiveMs]
        .every(Number.isFinite) || clientReceiveMs < clientSendMs
        || serverSendMs < serverReceiveMs
        || serverSendMs - serverReceiveMs > clientReceiveMs - clientSendMs) {
        return null;
      }
      const serverWorkMs = Math.max(0, serverSendMs - serverReceiveMs);
      const rtt = Math.max(0, clientReceiveMs - clientSendMs - serverWorkMs);
      return {
        rtt,
        offset: ((serverReceiveMs - clientSendMs)
          + (serverSendMs - clientReceiveMs)) / 2,
        uncertainty: rtt / 2,
        at: clientReceiveMs,
      };
    }

    update(measurements, keepCount = 6) {
      const nowMs = performance.now();
      const incoming = measurements
        .filter((item) => Number.isFinite(item?.rtt)
          && Number.isFinite(item?.offset)
          && Number.isFinite(item?.uncertainty)
          && item.rtt >= 0 && item.rtt <= 5000 && item.uncertainty >= 0
          && (!('at' in item) || (Number.isFinite(item.at)
            && item.at <= nowMs && nowMs - item.at <= 30000)));
      if (!incoming.length) return false;
      this.measurements = this.measurements
        .filter((item) => nowMs - item.at <= 30000)
        .concat(incoming.map((item) => ({ ...item, at: item.at ?? nowMs })))
        .slice(-32);
      const usable = [...this.measurements]
        .sort((a, b) => a.rtt - b.rtt)
        .slice(0, Math.max(1, keepCount));
      if (!usable.length) return false;
      this.rtt = median(usable.map((item) => item.rtt));
      const targetOffset = median(usable.map((item) => item.offset));
      // Slow routine changes rather than turning network jitter into media drift.
      // Residual slew and sample dispersion remain part of the error budget.
      const maxStep = Math.max(1, Math.min(20, (nowMs - (this.lastUpdateAt ?? nowMs)) * 0.01));
      this.offset = this.ready
        ? this.offset + Math.max(-maxStep, Math.min(maxStep, targetOffset - this.offset))
        : targetOffset;
      this._uncertainty = Math.max(...usable.map((item) =>
        Math.max(item.uncertainty, item.rtt / 2) + Math.abs(item.offset - this.offset)));
      this.lastMeasurementAt = Math.max(...usable.map((item) => item.at));
      this.lastUpdateAt = nowMs;
      this.ready = true;
      return true;
    }

    get uncertainty() {
      const ageMs = performance.now() - this.lastMeasurementAt;
      if (this.lastMeasurementAt === null || ageMs < 0 || ageMs > 30000) return Infinity;
      return this._uncertainty + ageMs * 0.00005; // 50 ppm holdover budget
    }

    serverNow(localMs = performance.now()) {
      return localMs + this.offset;
    }
  }

  class AutoSyncRecovery {
    constructor(options = {}) {
      this.maxClockUncertaintyMs = options.maxClockUncertaintyMs ?? 1000;
      this.clockRetryMs = options.clockRetryMs ?? 4000;
      this.driftThresholdS = options.driftThresholdS ?? 0.75;
      this.driftSamplesRequired = options.driftSamplesRequired ?? 3;
      this.peerDriftThresholdS = options.peerDriftThresholdS ?? 0.35;
      this.peerSamplesRequired = options.peerSamplesRequired ?? 2;
      this.alignCooldownMs = options.alignCooldownMs ?? 4000;
      this.reset();
    }

    reset() {
      this.largeDriftSamples = 0;
      this.peerLargeDriftSamples = 0;
      this.nextClockRetryAt = 0;
      this.nextAlignAt = 0;
      this.repairCount = 0;
    }

    evaluate(snapshot, nowMs = performance.now()) {
      if (!snapshot?.connected || !snapshot?.playerReady || !snapshot?.hasVideo) {
        this.largeDriftSamples = 0;
        this.peerLargeDriftSamples = 0;
        return 'idle';
      }

      if (!snapshot.clockReady
          || !Number.isFinite(snapshot.clockUncertaintyMs)
          || snapshot.clockUncertaintyMs > this.maxClockUncertaintyMs) {
        this.largeDriftSamples = 0;
        this.peerLargeDriftSamples = 0;
        if (nowMs >= this.nextClockRetryAt) {
          this.nextClockRetryAt = nowMs + this.clockRetryMs;
          return 'resync-clock';
        }
        return 'clock-wait';
      }

      if (snapshot.buffering
          || !snapshot.intendedPlaying
          || !snapshot.actuallyPlaying) {
        this.largeDriftSamples = 0;
        this.peerLargeDriftSamples = 0;
        return snapshot.buffering ? 'buffering' : 'playback-wait';
      }

      const uncertaintyS = Math.max(0, snapshot.clockUncertaintyMs) / 1000;
      const peerDrift = Math.abs(Number(snapshot.peerDriftS));
      if (snapshot.clockUncertaintyMs <= 25 && snapshot.peerSupportsCanonical
          && Number(snapshot.peerHealthyCount) > 0
          && Number.isFinite(peerDrift)
          && peerDrift >= this.peerDriftThresholdS) {
        this.peerLargeDriftSamples += 1;
        this.largeDriftSamples = 0;
        if (this.peerLargeDriftSamples < this.peerSamplesRequired
            || nowMs < this.nextAlignAt) {
          return 'peer-drift-watch';
        }
        this.peerLargeDriftSamples = 0;
        this.nextAlignAt = nowMs + this.alignCooldownMs;
        this.repairCount += 1;
        return 'force-align-peer';
      }
      this.peerLargeDriftSamples = 0;

      const drift = Math.abs(Number(snapshot.driftS));
      if (!Number.isFinite(drift)
          || drift < Math.max(this.driftThresholdS, uncertaintyS * 4)) {
        this.largeDriftSamples = 0;
        return 'healthy';
      }

      this.largeDriftSamples += 1;
      if (this.largeDriftSamples < this.driftSamplesRequired
          || nowMs < this.nextAlignAt) {
        return 'drift-watch';
      }

      this.largeDriftSamples = 0;
      this.nextAlignAt = nowMs + this.alignCooldownMs;
      this.repairCount += 1;
      return 'force-align';
    }
  }

  function expectedMediaTime(state, serverNowMs) {
    const base = Math.max(0, Number(state?.media_time_s) || 0);
    if (!state?.is_playing) return base;
    const elapsed = Math.max(
      0,
      Number(serverNowMs) - (Number(state?.anchor_server_ms) || 0),
    ) / 1000;
    return base + elapsed;
  }

  function isStateNewer(currentRevision, currentServerSendMs, incoming) {
    const revision = Number(incoming?.revision);
    const sentAt = Number(incoming?.server_send_ms);
    if (!Number.isFinite(revision) || !Number.isFinite(sentAt)) return false;
    return revision > currentRevision
      || (revision === currentRevision && sentAt > currentServerSendMs);
  }

  function reconnectDelayMs(attempt, randomValue = Math.random()) {
    const base = Math.min(24000, 1000 * (2 ** Math.max(0, Number(attempt) || 0)));
    const jitter = 0.75 + Math.min(1, Math.max(0, randomValue)) * 0.5;
    return Math.round(base * jitter);
  }

  function canSendRealtimeMessage(bufferedAmount, type) {
    const queued = Math.max(0, Number(bufferedAmount) || 0);
    // Samples expire quickly; never let them queue ahead of user controls.
    return ['CLIENT_SAMPLE', 'CLOCK_PING'].includes(type)
      ? queued === 0 : queued < 65536;
  }

  function isConnectionStale(lastMessageAt, nowMs, thresholdMs) {
    return nowMs - lastMessageAt >= thresholdMs;
  }

  function acknowledgeHostCommand(commands, commandId) {
    const index = commands.findIndex((command) => command.id === commandId);
    if (index < 0) return false;
    commands.splice(index, 1);
    return true;
  }

  function hasPendingHostCommand(commands, nowMs) {
    for (let index = commands.length - 1; index >= 0; index -= 1) {
      if (commands[index].expiresAt <= nowMs) commands.splice(index, 1);
    }
    return commands.length > 0;
  }

  window.SyncClock = SyncClock;
  window.AutoSyncRecovery = AutoSyncRecovery;
  window.expectedMediaTime = expectedMediaTime;
  window.isStateNewer = isStateNewer;
  window.reconnectDelayMs = reconnectDelayMs;
  window.isConnectionStale = isConnectionStale;
  window.acknowledgeHostCommand = acknowledgeHostCommand;
  window.hasPendingHostCommand = hasPendingHostCommand;
  window.canSendRealtimeMessage = canSendRealtimeMessage;
})();
