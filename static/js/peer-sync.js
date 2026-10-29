(() => {
  function median(values) {
    if (!values.length) return Number.NaN;
    const ordered = [...values].sort((a, b) => a - b);
    const middle = Math.floor(ordered.length / 2);
    return ordered.length % 2
      ? ordered[middle]
      : (ordered[middle - 1] + ordered[middle]) / 2;
  }

  // Strict wire validation: null, booleans and numeric strings are not samples.
  // Validate before storage so a future packet cannot poison ordering forever.
  function validPeerSample(sample, receivedServerMs) {
    return !!sample && typeof sample === 'object'
      && ['revision', 'observed_server_ms', 'media_time_s', 'playback_rate', 'uncertainty_ms']
        .every((field) => Number.isFinite(sample[field]))
      && Number.isSafeInteger(sample.revision) && sample.revision >= 0
      && typeof sample.video_id === 'string' && sample.video_id.length > 0
      && typeof sample.is_playing === 'boolean' && typeof sample.buffering === 'boolean'
      && sample.media_time_s >= 0 && sample.playback_rate > 0 && sample.playback_rate <= 4
      && sample.uncertainty_ms >= 0 && sample.uncertainty_ms <= 1000
      && Number.isFinite(receivedServerMs)
      && receivedServerMs - sample.observed_server_ms >= -100
      && receivedServerMs - sample.observed_server_ms <= 2500;
  }

  // Caller must authenticate the current Host peer before selecting this record.
  function projectHostSample(sample, state, serverNowMs, localUncertaintyMs,
    receivedLocalMs = null, localNowMs = performance.now()) {
    if (!validPeerSample(sample, serverNowMs) || !state
        || sample.video_id !== state.video_id || sample.revision !== state.revision
        || sample.is_playing !== state.is_playing || sample.buffering
        || !Number.isFinite(localUncertaintyMs) || localUncertaintyMs < 0
        || !Number.isFinite(sample.received_server_ms)) return null;
    const ageMs = serverNowMs - sample.observed_server_ms;
    const receiptAgeMs = receivedLocalMs === null
      ? serverNowMs - sample.received_server_ms : localNowMs - receivedLocalMs;
    const combinedMs = localUncertaintyMs + sample.uncertainty_ms;
    if (!Number.isFinite(receiptAgeMs) || receiptAgeMs < 0 || receiptAgeMs > 600
        || ageMs > 1000 || ageMs < -Math.min(100, combinedMs)
        || combinedMs > 250) return null;
    return {
      expectedTime: sample.media_time_s
        + (sample.is_playing ? Math.max(0, ageMs) / 1000 * sample.playback_rate : 0),
      // Timestamp tolerance is uncertainty, not negative playback projection.
      uncertaintyMs: combinedMs + Math.max(0, -ageMs) + 20,
    };
  }

  class PeerConsensus {
    constructor(options = {}) {
      this.maxAgeMs = options.maxAgeMs ?? 2500;
      this.maxUncertaintyMs = options.maxUncertaintyMs ?? 50;
      this.canonicalToleranceS = options.canonicalToleranceS ?? 0.2;
      this.samples = new Map();
    }

    update(peerId, sample, receivedServerMs) {
      if (typeof peerId !== 'string' || !validPeerSample(sample, receivedServerMs)) {
        return false;
      }
      const numericFields = [
        'revision',
        'observed_server_ms',
        'media_time_s',
        'playback_rate',
        'uncertainty_ms',
      ];
      if (numericFields.some((field) => !Number.isFinite(Number(sample[field])))) {
        return false;
      }
      if (typeof sample.video_id !== 'string'
          || typeof sample.is_playing !== 'boolean'
          || typeof sample.buffering !== 'boolean'
          || !Number.isFinite(Number(receivedServerMs))) {
        return false;
      }
      const previous = this.samples.get(peerId)?.sample;
      if (previous && (sample.revision < previous.revision
          || (sample.revision === previous.revision
            && sample.observed_server_ms <= previous.observed_server_ms))) {
        return false;
      }
      this.samples.set(peerId, {
        sample: {
          video_id: sample.video_id,
          revision: Number(sample.revision),
          observed_server_ms: Number(sample.observed_server_ms),
          media_time_s: Math.max(0, Number(sample.media_time_s)),
          is_playing: sample.is_playing,
          buffering: sample.buffering,
          playback_rate: Number(sample.playback_rate),
          uncertainty_ms: Math.max(0, Number(sample.uncertainty_ms)),
        },
        received_server_ms: Number(receivedServerMs),
      });
      return true;
    }

    remove(peerId) {
      this.samples.delete(peerId);
    }

    clear() {
      this.samples.clear();
    }

    summarize(context) {
      const serverNowMs = Number(context?.serverNowMs);
      const localTimeS = Number(context?.localTimeS);
      const canonicalTimeS = Number(context?.canonicalTimeS);
      const revision = Number(context?.revision);
      const videoId = context?.videoId;
      const intendedPlaying = Boolean(context?.intendedPlaying);
      if (![serverNowMs, localTimeS, canonicalTimeS, revision].every(Number.isFinite)
          || typeof videoId !== 'string') {
        return {
          healthyCount: 0,
          medianTimeS: Number.NaN,
          peerDriftS: Number.NaN,
          canonicalErrorS: Number.NaN,
          supportsCanonical: false,
        };
      }

      const projected = [];
      for (const [peerId, record] of this.samples) {
        const sample = record.sample;
        const receivedAgeMs = serverNowMs - record.received_server_ms;
        const sampleAgeMs = serverNowMs - sample.observed_server_ms;
        if (receivedAgeMs > this.maxAgeMs || receivedAgeMs < -100
            || sampleAgeMs > this.maxAgeMs || sampleAgeMs < -100
            || sample.video_id !== videoId
            || sample.revision !== revision
            || sample.buffering
            || sample.is_playing !== intendedPlaying
            || sample.uncertainty_ms > this.maxUncertaintyMs
            || sample.playback_rate <= 0
            || sample.playback_rate > 4) {
          if (receivedAgeMs > this.maxAgeMs * 2) this.samples.delete(peerId);
          continue;
        }
        const elapsedS = sample.is_playing ? Math.max(0, sampleAgeMs) / 1000 : 0;
        projected.push(sample.media_time_s + elapsedS * sample.playback_rate);
      }

      const medianTimeS = median(projected);
      const canonicalErrorS = medianTimeS - canonicalTimeS;
      return {
        healthyCount: projected.length,
        medianTimeS,
        peerDriftS: medianTimeS - localTimeS,
        canonicalErrorS,
        supportsCanonical: projected.length > 0
          && Math.abs(canonicalErrorS) <= this.canonicalToleranceS,
      };
    }
  }

  class PeerSync {
    constructor(options = {}) {
      this.sendSignal = options.sendSignal;
      this.onPeerSample = options.onPeerSample;
      this.onPeerControl = options.onPeerControl;
      this.onStatus = options.onStatus;
      this.maxPeerConnections = options.maxPeerConnections ?? 7;
      this.connections = new Map();
      this.retryAttempts = new Map();
      this.selfId = null;
      this.generation = 0;
      this.supported = typeof window.RTCPeerConnection === 'function';
    }

    start(selfId, peerIds = []) {
      this.stop(false);
      this.selfId = typeof selfId === 'string' ? selfId : null;
      this._emitStatus();
      if (!this.supported || !this.selfId) return;
      for (const peerId of peerIds) this.addPeer(peerId);
    }

    stop(emit = true) {
      this.generation += 1;
      for (const entry of this.connections.values()) this._dispose(entry);
      this.connections.clear();
      this.retryAttempts.clear();
      this.selfId = null;
      if (emit) this._emitStatus();
    }

    addPeer(peerId) {
      if (!this.supported
          || !this.selfId
          || typeof peerId !== 'string'
          || !peerId
          || peerId === this.selfId
          || this.connections.has(peerId)
          || this.connections.size >= this.maxPeerConnections) return;

      const generation = this.generation;
      let pc;
      try {
        pc = new window.RTCPeerConnection({ iceServers: [] });
      } catch (_) {
        return;
      }
      const entry = {
        peerId,
        pc,
        channel: null,
        pingTimer: null,
        pingSequence: 0,
        pingSamples: [],
        pingMs: Number.NaN,
        candidates: [],
        retryTimer: null,
        disconnectTimer: null,
        connectTimer: null,
        generation,
        disposed: false,
      };
      this.connections.set(peerId, entry);
      // Some blocked LANs never produce a failed event. Keep recovery bounded.
      entry.connectTimer = window.setTimeout(() => {
        entry.connectTimer = null;
        if (this._active(entry) && entry.channel?.readyState !== 'open') {
          this._scheduleRetry(entry);
        }
      }, 12000);

      pc.onicecandidate = (event) => {
        if (!this._active(entry) || !event.candidate) return;
        const candidate = typeof event.candidate.toJSON === 'function'
          ? event.candidate.toJSON()
          : event.candidate;
        this._signal(peerId, { candidate });
      };
      pc.ondatachannel = (event) => this._attachChannel(entry, event.channel);
      pc.onconnectionstatechange = () => this._handleConnectionState(entry);

      if (this.selfId < peerId) {
        const channel = pc.createDataChannel('watchparty-sync', {
          ordered: false,
          maxRetransmits: 0,
        });
        this._attachChannel(entry, channel);
        this._createOffer(entry);
      }
      this._emitStatus();
    }

    removePeer(peerId, forgetRetry = true) {
      const entry = this.connections.get(peerId);
      if (!entry) return;
      this._dispose(entry);
      this.connections.delete(peerId);
      if (forgetRetry) this.retryAttempts.delete(peerId);
      this._emitStatus();
    }

    async handleSignal(peerId, data) {
      if (!this.supported || !this.selfId || !data || typeof data !== 'object') return;
      const previous = this.connections.get(peerId);
      if (data.description?.type === 'offer' && peerId < this.selfId
          && previous?.pc.remoteDescription) {
        // The offering peer recreated its connection; the old SCTP association
        // cannot accept the replacement channel reliably after a network loss.
        this.removePeer(peerId);
      }
      this.addPeer(peerId);
      const entry = this.connections.get(peerId);
      if (!entry || !this._active(entry)) return;
      try {
        if (data.description) {
          const description = data.description;
          if (!['offer', 'answer'].includes(description?.type)
              || typeof description?.sdp !== 'string') return;
          await entry.pc.setRemoteDescription(description);
          if (!this._active(entry)) return;
          for (const candidate of entry.candidates.splice(0)) {
            await entry.pc.addIceCandidate(candidate);
          }
          if (description.type === 'offer') {
            const answer = await entry.pc.createAnswer();
            if (!this._active(entry)) return;
            await entry.pc.setLocalDescription(answer);
            if (!this._active(entry)) return;
            this._signal(peerId, {
              description: {
                type: entry.pc.localDescription.type,
                sdp: entry.pc.localDescription.sdp,
              },
            });
          }
        } else if (data.candidate) {
          if (entry.pc.remoteDescription) {
            await entry.pc.addIceCandidate(data.candidate);
          } else if (entry.candidates.length < 64) {
            entry.candidates.push(data.candidate);
          }
        }
      } catch (_) {
        this._scheduleRetry(entry);
      }
    }

    broadcast(sample) {
      let payload;
      try {
        payload = JSON.stringify({ type: 'SYNC_SAMPLE', sample });
      } catch (_) {
        return 0;
      }
      let sent = 0;
      for (const entry of this.connections.values()) {
        if (entry.channel?.readyState !== 'open' || entry.channel.bufferedAmount > 0) continue;
        try {
          entry.channel.send(payload);
          sent += 1;
        } catch (_) {
          // The central WebSocket path remains active while this channel recovers.
        }
      }
      return sent;
    }

    broadcastControl(control) {
      let payload;
      try {
        payload = JSON.stringify({ type: 'CONTROL_HINT', control });
      } catch (_) {
        return 0;
      }
      let sent = 0;
      for (const entry of this.connections.values()) {
        if (entry.channel?.readyState !== 'open' || entry.channel.bufferedAmount > 0) continue;
        try {
          entry.channel.send(payload);
          sent += 1;
        } catch (_) {
          // The server remains authoritative if the direct hint cannot be sent.
        }
      }
      return sent;
    }

    status() {
      let connected = 0;
      for (const entry of this.connections.values()) {
        if (entry.channel?.readyState === 'open') connected += 1;
      }
      return {
        supported: this.supported,
        known: this.connections.size,
        connected,
        pingMs: this._pingMs(),
      };
    }

    isConnected(peerId) {
      if (typeof peerId !== 'string' || !peerId) return false;
      return this.connections.get(peerId)?.channel?.readyState === 'open';
    }

    async _createOffer(entry) {
      try {
        const offer = await entry.pc.createOffer();
        if (!this._active(entry)) return;
        await entry.pc.setLocalDescription(offer);
        if (!this._active(entry)) return;
        this._signal(entry.peerId, {
          description: {
            type: entry.pc.localDescription.type,
            sdp: entry.pc.localDescription.sdp,
          },
        });
      } catch (_) {
        this._scheduleRetry(entry);
      }
    }

    _attachChannel(entry, channel) {
      if (!this._active(entry) || (entry.channel && entry.channel !== channel)) {
        try { channel.close(); } catch (_) { /* already closed */ }
        return;
      }
      entry.channel = channel;
      channel.onopen = () => {
        if (!this._active(entry)) return;
        if (entry.connectTimer !== null) window.clearTimeout(entry.connectTimer);
        entry.connectTimer = null;
        this.retryAttempts.delete(entry.peerId);
        this._startPing(entry);
        this._emitStatus();
      };
      channel.onclose = () => {
        if (!this._active(entry)) return;
        if (entry.pingTimer !== null) {
          window.clearInterval(entry.pingTimer);
          entry.pingTimer = null;
        }
        entry.lastPing = null;
        entry.pingMs = Number.NaN;
        this._scheduleRetry(entry);
        this._emitStatus();
      };
      channel.onerror = () => this._emitStatus();
      channel.onmessage = (event) => {
        if (!this._active(entry) || typeof event.data !== 'string'
            || event.data.length > 8192) return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch (_) {
          return;
        }
        if (message?.type === 'P2P_PING') {
          this._sendChannel(entry, {
            type: 'P2P_PONG',
            id: message.id,
          });
        } else if (message?.type === 'P2P_PONG') {
          this._recordPing(entry, message.id);
        } else if (message?.type === 'CONTROL_HINT' && message.control) {
          this.onPeerControl?.(entry.peerId, message.control);
        } else if (message?.type === 'SYNC_SAMPLE' && message.sample) {
          this.onPeerSample?.(entry.peerId, message.sample);
        }
      };
    }

    _startPing(entry) {
      if (entry.pingTimer !== null) window.clearInterval(entry.pingTimer);
      const ping = () => {
        if (!this._active(entry) || entry.channel?.readyState !== 'open'
            || entry.channel.bufferedAmount > 0) return;
        const nowMs = window.performance.now();
        // Preserve a slow outstanding probe instead of replacing it each second.
        if (entry.lastPing && nowMs - entry.lastPing.sentAt < 10000) return;
        const id = ++entry.pingSequence;
        entry.lastPing = { id, sentAt: nowMs };
        if (!this._sendChannel(entry, { type: 'P2P_PING', id })) entry.lastPing = null;
      };
      ping();
      entry.pingTimer = window.setInterval(ping, 4000 + Math.random() * 1000);
    }

    _recordPing(entry, id) {
      if (!entry.lastPing || entry.lastPing.id !== id) return;
      const elapsed = window.performance.now() - entry.lastPing.sentAt;
      if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 10000) return;
      entry.pingSamples.push(elapsed);
      entry.lastPing = null;
      if (entry.pingSamples.length > 5) entry.pingSamples.shift();
      entry.pingMs = median(entry.pingSamples);
      entry.pingAt = window.performance.now();
      this._emitStatus();
    }

    _pingMs() {
      const values = [...this.connections.values()]
        .filter((entry) => entry.channel?.readyState === 'open'
          && window.performance.now() - entry.pingAt <= 15000)
        .map((entry) => entry.pingMs)
        .filter((value) => Number.isFinite(value));
      return median(values);
    }

    _sendChannel(entry, message) {
      if (!this._active(entry) || entry.channel?.readyState !== 'open'
          || entry.channel.bufferedAmount > 0) return false;
      try {
        entry.channel.send(JSON.stringify(message));
        return true;
      } catch (_) {
        // The central WebSocket path remains active while this channel recovers.
        return false;
      }
    }

    _handleConnectionState(entry) {
      if (!this._active(entry)) return;
      const state = entry.pc.connectionState;
      this._emitStatus();
      if (state === 'connected') {
        if (entry.disconnectTimer !== null) window.clearTimeout(entry.disconnectTimer);
        entry.disconnectTimer = null;
      }
      if (state === 'failed' || state === 'closed') {
        this._scheduleRetry(entry);
      } else if (state === 'disconnected' && entry.disconnectTimer === null) {
        entry.disconnectTimer = window.setTimeout(() => {
          entry.disconnectTimer = null;
          if (entry.pc.connectionState === 'disconnected') this._scheduleRetry(entry);
        }, 3000);
      }
    }

    _scheduleRetry(entry) {
      if (!this._active(entry) || !this.selfId
          || this.selfId >= entry.peerId || entry.retryTimer !== null) return;
      const attempt = this.retryAttempts.get(entry.peerId) || 0;
      this.retryAttempts.set(entry.peerId, Math.min(attempt + 1, 6));
      const delayMs = Math.min(24000, 1000 * (2 ** attempt))
        * (0.75 + Math.random() * 0.5);
      entry.retryTimer = window.setTimeout(() => {
        if (!this._active(entry)) return;
        const peerId = entry.peerId;
        this.removePeer(peerId, false);
        this.addPeer(peerId);
      }, delayMs);
    }

    _signal(peerId, data) {
      this.sendSignal?.(peerId, data);
    }

    _dispose(entry) {
      entry.disposed = true;
      if (entry.retryTimer !== null) window.clearTimeout(entry.retryTimer);
      if (entry.disconnectTimer !== null) window.clearTimeout(entry.disconnectTimer);
      if (entry.connectTimer !== null) window.clearTimeout(entry.connectTimer);
      if (entry.pingTimer !== null) window.clearInterval(entry.pingTimer);
      try { entry.channel?.close(); } catch (_) { /* already closed */ }
      try { entry.pc.close(); } catch (_) { /* already closed */ }
    }

    _active(entry) {
      return !entry.disposed && entry.generation === this.generation
        && this.connections.get(entry.peerId) === entry;
    }

    _emitStatus() {
      this.onStatus?.(this.status());
    }
  }

  window.validPeerSample = validPeerSample;
  window.projectHostSample = projectHostSample;
  window.PeerConsensus = PeerConsensus;
  window.PeerSync = PeerSync;
})();
