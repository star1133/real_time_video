(() => {
  const roomId = document.body.dataset.roomId;
  const statusText = document.getElementById('connection-status');
  const statusDot = document.getElementById('connection-dot');
  const errorMessage = document.getElementById('error-message');
  const videoForm = document.getElementById('video-form');
  const videoUrl = document.getElementById('video-url');
  const shareButton = document.getElementById('share-button');
  const showQrButton = document.getElementById('show-qr-button');
  const qrDialog = document.getElementById('qr-dialog');
  const qrImage = document.getElementById('qr-image');
  const qrViewerLink = document.getElementById('qr-viewer-link');
  const closeQrButton = document.getElementById('close-qr-button');
  const roleStatus = document.getElementById('role-status');
  const peerStatus = document.getElementById('peer-status');
  const networkStatus = document.getElementById('network-status');
  const syncStatus = document.getElementById('sync-status');
  const cohortStatus = document.getElementById('cohort-status');
  const resumePlayback = document.getElementById('resume-playback');
  const mutedPlayback = document.getElementById('muted-playback');
  const volumeSlider = document.getElementById('volume-slider');
  const volumeValue = document.getElementById('volume-value');
  const volumeLabel = document.getElementById('volume-label');
  const volumeHelp = document.getElementById('volume-help');
  const muteButton = document.getElementById('mute-button');
  const followVolumeWrap = document.getElementById('follow-volume-wrap');
  const followVolume = document.getElementById('follow-volume');
  const playerCover = document.getElementById('player-cover');
  const playerPoster = document.getElementById('player-poster');
  const playerCoverMessage = document.getElementById('player-cover-message');
  const playerCoverPlay = document.getElementById('player-cover-play');
  const playerDirectLink = document.getElementById('player-direct-link');
  const playNowButton = document.getElementById('play-now-button');
  const queueAddButton = document.getElementById('queue-add-button');
  const playlistOption = document.getElementById('playlist-option');
  const playlistImport = document.getElementById('playlist-import');
  const nowPlaying = document.getElementById('now-playing');
  const nowPlayingTitle = document.getElementById('now-playing-title');
  const queueCount = document.getElementById('queue-count');
  const queueHostActions = document.getElementById('queue-host-actions');
  const queueSettings = document.getElementById('queue-settings');
  const queueAutoplay = document.getElementById('queue-autoplay');
  const queueAllowViewers = document.getElementById('queue-allow-viewers');
  const queueImporting = document.getElementById('queue-importing');
  const queueList = document.getElementById('queue-list');
  const queueEmpty = document.getElementById('queue-empty');
  const syncModeRow = document.getElementById('sync-mode-row');
  const syncModeSelect = document.getElementById('sync-mode');

  const tokenKey = `watchparty-host-${roomId}`;
  const fragmentToken = new URLSearchParams(location.hash.slice(1)).get('host');
  let hostToken = fragmentToken;
  let tokenPersisted = false;
  if (fragmentToken) {
    try {
      sessionStorage.setItem(tokenKey, fragmentToken);
      tokenPersisted = true;
    } catch (_) {
      // Keep the token in the fragment when browser storage is unavailable.
    }
    if (tokenPersisted) {
      try {
        history.replaceState(history.state, '', `${location.pathname}${location.search}`);
      } catch (_) {
        // The in-memory token still preserves Host authority for this tab.
      }
    }
  } else {
    try {
      hostToken = sessionStorage.getItem(tokenKey);
    } catch (_) {
      hostToken = null;
    }
  }

  const clock = new window.SyncClock();
  let socket = null;
  let reconnectAttempt = 0;
  let role = 'viewer';
  let welcomed = false;
  let latestState = null;
  let latestRevision = -1;
  let latestServerSendMs = -Infinity;
  let playerReady = false;
  let playerCreated = false;
  let playerCreateAttempts = 0;
  let playerStartupTimer = null;
  let localPlayTimer = null;
  let localPlayStartedAt = null;
  let youtubeApiAttempts = 0;
  let clockSyncPromise = null;
  let clockSyncGeneration = 0;
  let pingSequence = 0;
  let telemetryTick = 0;
  let lastTelemetryAt = -Infinity;
  let hostPeerId = null;
  let p2pEnabled = true;
  let pendingPeerControl = null;
  let lastPeerControlAt = -Infinity;
  let autoplayTimer = null;
  let pendingBootstrap = false;
  let pendingControl = null;
  let playerFailure = '';
  let autoplayBlocked = false;
  let localPlayInProgress = false;
  let autoMutedVideoId = null;
  let autoMutedPlayback = false;
  let roomVolume = 100;
  let roomVolumeRevision = -1;
  let localVolume = 100;
  let lastAudibleVolume = 100;
  let followRoomVolume = true;
  let volumeSendTimer = null;
  let latestHostSample = null;
  let serverHostSample = null;
  let queueState = { revision: -1, items: [], now_playing: null, allow_viewers: false, autoplay: true, importing: false };
  let autostartHandledRevision = -1;
  let errorSkipTimer = null;
  let pendingHostSeek = null;
  const syncModeKey = 'watchparty-sync-mode';
  let syncMode = 'auto';
  try {
    syncMode = localStorage.getItem(syncModeKey) || 'auto';
  } catch (_) {
    // A private window keeps the default for this visit.
  }
  if (!['auto', 'smooth', 'precise'].includes(syncMode)) syncMode = 'auto';
  syncModeSelect.value = syncMode;
  const pendingHostCommands = [];
  const pendingPings = new Map();
  const CONNECTION_STALE_MS = 10000;
  const HANDSHAKE_TIMEOUT_MS = 10000;
  const HEALTH_CHECK_INTERVAL_MS = 1000;
  const PLAY_START_TIMEOUT_MS = 3000;
  const BUFFERING_START_TIMEOUT_MS = 8000;
  let lastServerMessageAt = -Infinity;

  const controller = new window.YouTubeController('player', handlePlaybackEvent);
  const peerConsensus = new window.PeerConsensus();
  const autoRecovery = new window.AutoSyncRecovery();
  const peerSync = new window.PeerSync({
    sendSignal: (target, data) => send({ type: 'SIGNAL', target, data }, true),
    onPeerSample: (peerId, sample) => {
      if (!clock.ready) return;
      const receivedLocalMs = performance.now();
      const receivedServerMs = clock.serverNow();
      peerConsensus.update(peerId, sample, receivedServerMs);
      if (role !== 'host' && peerId === hostPeerId
          && sample?.video_id === latestState?.video_id
          && Number(sample?.revision) === latestRevision
          && Number.isFinite(Number(sample?.media_time_s))
          && Number.isFinite(Number(sample?.observed_server_ms))) {
        latestHostSample = {
          ...sample,
          received_server_ms: receivedServerMs,
          received_local_ms: receivedLocalMs,
        };
      }
    },
    onPeerControl: (peerId, control) => applyPeerControl(peerId, control),
    onStatus: showPeerStatus,
  });

  function showError(message = '') {
    errorMessage.textContent = message;
  }

  function updatePlayerCover() {
    const videoId = latestState?.video_id;
    if (!videoId) {
      playerPoster.hidden = true;
      playerPoster.removeAttribute('src');
      playerCoverMessage.textContent = role === 'host'
        ? 'วางลิงก์ YouTube ด้านล่างเพื่อเริ่มดูพร้อมกัน'
        : 'กำลังรอ Host เลือกวิดีโอ';
      playerCoverPlay.hidden = true;
      playerDirectLink.hidden = true;
      playerCover.hidden = false;
      return;
    }

    const youtubeUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    const posterUrl = `https://i.ytimg.com/vi/${encodeURIComponent(videoId)}/hqdefault.jpg`;
    playerPoster.hidden = false;
    if (playerPoster.getAttribute('src') !== posterUrl) playerPoster.src = posterUrl;
    playerDirectLink.href = youtubeUrl;

    if (playerFailure) {
      playerCoverMessage.textContent = playerFailure;
      playerCoverPlay.hidden = true;
      playerDirectLink.hidden = false;
      playerCover.hidden = false;
      return;
    }
    if (localPlayInProgress) {
      playerCover.hidden = true;
      return;
    }
    if (!playerReady) {
      playerCoverMessage.textContent = 'กำลังโหลดตัวเล่น YouTube…';
      playerCoverPlay.hidden = true;
      playerDirectLink.hidden = true;
      playerCover.hidden = false;
      return;
    }
    if (autoplayBlocked) {
      playerCoverMessage.textContent = 'เบราว์เซอร์หยุดการเล่นอัตโนมัติ แตะเพื่อเล่นต่อ';
      playerCoverPlay.textContent = 'แตะเพื่อเล่น';
      playerCoverPlay.hidden = false;
      playerDirectLink.hidden = true;
      playerCover.hidden = false;
      return;
    }
    if (!latestState.is_playing) {
      playerCoverMessage.textContent = role === 'host'
        ? 'วิดีโอพร้อมแล้ว'
        : 'รอ Host เริ่มเล่น';
      playerCoverPlay.textContent = 'เล่นวิดีโอ';
      playerCoverPlay.hidden = role !== 'host';
      playerDirectLink.hidden = true;
      playerCover.hidden = false;
      return;
    }
    playerCover.hidden = true;
  }

  function setConnectionStatus(label, stateClass) {
    statusText.textContent = label;
    statusDot.className = `dot ${stateClass}`;
    document.getElementById('connection-help').hidden = stateClass !== 'disconnected';
  }

  function showPeerStatus(status = peerSync?.status?.() || {}) {
    if (!p2pEnabled || !status.supported) {
      peerStatus.textContent = role === 'host'
        ? 'ซิงก์ผ่าน Server'
        : 'โหมดลื่นไหล · ไม่ปรับเวลาจุกจิก';
    } else if (role !== 'host' && hostPeerId && peerSync.isConnected(hostPeerId)) {
      const ping = Number.isFinite(status.pingMs) ? ` · ping ${Math.round(status.pingMs)}ms` : '';
      peerStatus.textContent = `Wi-Fi/LAN เดียวกับ Host · ซิงก์ละเอียด${ping}`;
    } else if (!status.known) {
      peerStatus.textContent = role === 'host'
        ? 'P2P · รอเครื่องอื่น'
        : 'กำลังหาทางตรง · ใช้โหมดลื่นไหล';
    } else if (status.connected === status.known) {
      const ping = Number.isFinite(status.pingMs) ? ` · ping ${Math.round(status.pingMs)}ms` : '';
      peerStatus.textContent = role === 'host'
        ? `P2P โดยตรง ${status.connected}/${status.known}${ping}`
        : 'โหมดลื่นไหล · Host ไม่ได้เชื่อมทางตรง';
    } else if (status.connected > 0) {
      const ping = Number.isFinite(status.pingMs) ? ` · ping ${Math.round(status.pingMs)}ms` : '';
      peerStatus.textContent = role === 'host'
        ? `P2P ${status.connected}/${status.known}${ping} · มีทางสำรอง`
        : 'โหมดลื่นไหล · Host ไม่ได้เชื่อมทางตรง';
    } else {
      peerStatus.textContent = role === 'host'
        ? 'P2P กำลังเชื่อม · ใช้ Server สำรอง'
        : 'ต่างเครือข่าย/ไม่มีทางตรง · โหมดลื่นไหล';
    }
    if (welcomed && playerReady && latestState) applyLatestState(false);
  }

  function applyPeerControl(peerId, control) {
    if (!welcomed || !p2pEnabled || !hostPeerId || peerId !== hostPeerId
        || role === 'host' || !clock.ready || !latestState?.video_id
        || control?.video_id !== latestState.video_id) return;
    const action = String(control.action || '').toUpperCase();
    const mediaTime = Number(control.media_time_s);
    const observedServerMs = Number(control.observed_server_ms);
    const ageMs = clock.serverNow() - observedServerMs;
    if (!['PLAY', 'PAUSE', 'SEEK'].includes(action)
        || !Number.isFinite(mediaTime) || !Number.isFinite(observedServerMs)
        || typeof control.command_id !== 'string'
        || Number(control.base_revision) !== latestRevision
        || ageMs < -250 || ageMs > 2000 || observedServerMs <= lastPeerControlAt) return;
    const playing = action === 'PLAY' || (action === 'SEEK' && latestState.is_playing);
    const expectedTime = Math.max(0, mediaTime + (
      playing ? Math.max(0, ageMs) / 1000 : 0
    ));
    if (controller.applyDirectControl(action, expectedTime)) {
      lastPeerControlAt = observedServerMs;
      pendingPeerControl = {
        commandId: control.command_id,
        baseRevision: latestRevision,
        expiresAt: performance.now() + Math.min(2000, Math.max(500, clock.rtt * 2)),
      };
    }
  }

  function updateControlAvailability() {
    const isHost = role === 'host';
    const canQueue = isHost || queueState.allow_viewers;
    const enabled = welcomed && (isHost ? clock.ready : canQueue);
    videoForm.hidden = !canQueue;
    videoUrl.disabled = !enabled;
    playNowButton.hidden = !isHost;
    playNowButton.disabled = !enabled;
    queueAddButton.disabled = !enabled || queueState.importing;
    queueAddButton.className = isHost ? 'quiet-button' : 'primary';
    updatePlaylistOption();
  }

  function linkHasPlaylist(value) {
    try {
      const url = new URL(value.trim());
      return /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname)
        && /^[A-Za-z0-9_-]{2,64}$/.test(url.searchParams.get('list') || '');
    } catch (_) {
      return false;
    }
  }

  function updatePlaylistOption() {
    playlistOption.hidden = !linkHasPlaylist(videoUrl.value);
  }

  function formatDuration(seconds) {
    const total = Math.round(Number(seconds));
    if (!Number.isFinite(total) || total <= 0) return '';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function sendQueue(type, fields = {}) {
    return send({ type, ...fields });
  }

  function queueButton(label, title, onClick, disabled = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'quiet-button queue-item-button';
    button.textContent = label;
    button.title = title;
    button.setAttribute('aria-label', title);
    button.disabled = disabled;
    button.addEventListener('click', onClick);
    return button;
  }

  function renderQueue() {
    const isHost = role === 'host';
    const items = Array.isArray(queueState.items) ? queueState.items : [];
    queueCount.textContent = String(items.length);
    queueHostActions.hidden = !isHost;
    queueSettings.hidden = !isHost;
    queueAutoplay.checked = queueState.autoplay !== false;
    queueAllowViewers.checked = Boolean(queueState.allow_viewers);
    document.getElementById('queue-next').disabled = !items.length;
    document.getElementById('queue-shuffle').disabled = items.length < 2;
    document.getElementById('queue-clear').disabled = !items.length;
    queueImporting.hidden = !queueState.importing;
    queueEmpty.hidden = items.length > 0;
    queueEmpty.textContent = isHost || queueState.allow_viewers
      ? 'ยังไม่มีคลิปในคิว · วางลิงก์แล้วกด “เพิ่มเข้าคิว” หรือวางลิงก์ playlist'
      : 'ยังไม่มีคลิปในคิว · Host เป็นคนเลือกคลิปถัดไป';

    const fragment = document.createDocumentFragment();
    items.forEach((item, index) => {
      const row = document.createElement('li');
      row.className = 'queue-item';
      const thumb = document.createElement('img');
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.referrerPolicy = 'no-referrer';
      thumb.src = `https://i.ytimg.com/vi/${encodeURIComponent(item.video_id)}/mqdefault.jpg`;
      const text = document.createElement('div');
      text.className = 'queue-item-text';
      const title = document.createElement('strong');
      title.textContent = item.title || `วิดีโอ ${item.video_id}`;
      const meta = document.createElement('span');
      meta.textContent = [
        `#${index + 1}`,
        formatDuration(item.duration_s),
        item.added_by === 'viewer' ? 'ผู้ชมเพิ่ม' : '',
      ].filter(Boolean).join(' · ');
      text.append(title, meta);
      row.append(thumb, text);
      if (isHost) {
        const actions = document.createElement('div');
        actions.className = 'queue-item-actions';
        actions.append(
          queueButton('▶', 'เล่นคลิปนี้เลย', () => sendQueue('QUEUE_PLAY', { item_id: item.id })),
          queueButton('↑', 'เลื่อนขึ้น', () => sendQueue('QUEUE_MOVE', { item_id: item.id, delta: -1 }), index === 0),
          queueButton('↓', 'เลื่อนลง', () => sendQueue('QUEUE_MOVE', { item_id: item.id, delta: 1 }), index === items.length - 1),
          queueButton('✕', 'ลบออกจากคิว', () => sendQueue('QUEUE_REMOVE', { item_id: item.id })),
        );
        row.append(actions);
      }
      fragment.append(row);
    });
    queueList.replaceChildren(fragment);
    updateNowPlaying();
    updateControlAvailability();
  }

  function updateNowPlaying() {
    const current = queueState.now_playing;
    const videoId = latestState?.video_id;
    nowPlaying.hidden = !videoId;
    nowPlayingTitle.textContent = current?.video_id === videoId && current?.title
      ? current.title
      : (videoId ? `วิดีโอ ${videoId}` : '');
  }

  function receiveQueue(message) {
    const revision = Number(message?.revision);
    if (!Number.isFinite(revision) || revision < queueState.revision) return;
    queueState = { ...message, revision };
    renderQueue();
  }

  function submitVideo(playNow) {
    const url = videoUrl.value.trim();
    if (!url) {
      videoUrl.reportValidity?.();
      return;
    }
    showError();
    const playlist = linkHasPlaylist(url) && playlistImport.checked;
    if (playNow && !playlist) {
      // A single "play now" clip replaces the current one without touching the queue.
      if (sendControl('SET_VIDEO', 0, { url })) videoUrl.value = '';
    } else if (send({ type: 'QUEUE_ADD', url, playlist, play_now: playNow })) {
      videoUrl.value = '';
    }
    updatePlaylistOption();
  }

  function preferredSyncProfile() {
    if (syncMode === 'smooth' || syncMode === 'precise') return syncMode;
    return 'balanced';
  }

  function applyLocalVolume(volume) {
    localVolume = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    if (localVolume > 0) lastAudibleVolume = localVolume;
    volumeSlider.value = String(localVolume);
    volumeValue.textContent = `${localVolume}%`;
    muteButton.textContent = localVolume === 0 ? 'เปิดเสียง' : 'ปิดเสียง';
    muteButton.setAttribute('aria-label', muteButton.textContent);
    if (playerReady) controller.setVolume(localVolume);
  }

  function updateVolumeUi() {
    const isHost = role === 'host';
    volumeLabel.textContent = isHost ? 'เสียงเริ่มต้นของห้อง' : 'เสียงเครื่องนี้';
    volumeHelp.textContent = isHost
      ? 'ปรับแล้วส่งให้สมาชิกที่ตั้งค่าตาม Host'
      : (autoMutedPlayback && localVolume === 0
        ? 'ระบบเริ่มวิดีโอให้อัตโนมัติแบบปิดเสียง · แตะเปิดเสียงเมื่อพร้อม'
        : (followRoomVolume ? `กำลังตาม Host · ${roomVolume}%` : 'กำลังใช้ระดับเสียงส่วนตัว'));
    followVolumeWrap.hidden = isHost;
    followVolume.checked = followRoomVolume;
  }

  function receiveRoomVolume(state) {
    const volume = Number(state?.volume);
    const revision = Number(state?.volume_revision);
    if (!Number.isInteger(volume) || volume < 0 || volume > 100
        || !Number.isInteger(revision) || revision < roomVolumeRevision) return;
    if (revision > roomVolumeRevision) {
      roomVolume = volume;
      roomVolumeRevision = revision;
      if (role === 'host' || followRoomVolume) applyLocalVolume(roomVolume);
    }
    updateVolumeUi();
  }

  function sendRoomVolume(volume) {
    if (role !== 'host' || !welcomed) return false;
    return send({
      type: 'ROOM_VOLUME',
      command_id: newCommandId(),
      volume,
    });
  }

  function scheduleRoomVolume(volume, immediate = false) {
    window.clearTimeout(volumeSendTimer);
    volumeSendTimer = null;
    if (immediate) {
      sendRoomVolume(volume);
      return;
    }
    volumeSendTimer = window.setTimeout(() => {
      volumeSendTimer = null;
      sendRoomVolume(volume);
    }, 120);
  }

  function showRole() {
    roleStatus.textContent = !welcomed ? 'กำลังเข้าห้อง' : (role === 'host' ? 'เจ้าของห้อง · Host' : 'ผู้ชม');
    document.getElementById('role-help').textContent = !welcomed
      ? 'กำลังตรวจสอบสิทธิ์ในห้อง…'
      : (role === 'host'
        ? 'คุณเลือกวิดีโอ เล่น หยุด และเลื่อนเวลาให้ทุกคนได้'
        : 'ดูตามเจ้าของห้อง · คุณปรับเสียงของเครื่องนี้ได้เอง');
    roleStatus.className = `status-badge ${role}`;
    // The Host is the reference clock and never corrects itself.
    syncModeRow.hidden = role === 'host';
    updateControlAvailability();
    updateVolumeUi();
    updatePlayerCover();
    renderQueue();
  }

  function showCohort(cohort = {}) {
    const healthy = Number(cohort.healthy_count || 0);
    const withinTarget = Number(cohort.within_100ms_count || 0);
    const buffering = Number(cohort.buffering_count || 0);
    const outliers = Number(cohort.outlier_count || 0);
    const rawP95 = cohort.p95_abs_error_ms;
    const p95 = typeof rawP95 === 'number' ? rawP95 : NaN;
    const precision = Number.isFinite(p95) ? ` · p95 ${Math.round(p95)}ms` : '';
    const rawSpread = cohort.phase_spread_ms;
    const spread = typeof rawSpread === 'number' ? rawSpread : NaN;
    const pairwise = Number.isFinite(spread)
      ? ` · spread ${Math.round(spread)}ms${cohort.all_within_100ms ? ' ✓' : ''}`
      : '';
    cohortStatus.textContent = role === 'host'
      ? `≤100ms ${withinTarget}/${healthy}${precision}${pairwise} · buffering ${buffering} · outlier ${outliers}`
      : `≤100ms ${withinTarget}/${healthy}${precision}${pairwise}`;
  }

  function showSyncDecision(decision, drift = controller.lastDrift) {
    if (clock.ready && clock.uncertainty > 250) {
      syncStatus.textContent = 'กำลังรอค่าประมาณเวลาที่น่าเชื่อถือ';
      syncStatus.dataset.state = 'uncertain';
      return;
    }
    if (decision === 'buffering') {
      syncStatus.textContent = 'กำลัง buffering';
    } else if (['stable', 'idle'].includes(decision)) {
      syncStatus.textContent = `ตรงกัน · ${Math.round(Math.abs(drift) * 1000)}ms`;
    } else if (decision === 'rate-requested' || decision === 'rate-correcting') {
      const rate = controller.ownedRate ?? controller.pendingRate ?? 1;
      syncStatus.textContent = `คลาด ${Math.round(Math.abs(drift) * 1000)}ms · ปรับความเร็ว ${rate}x อย่างนุ่มนวล`;
    } else if (decision === 'hard-wait') {
      syncStatus.textContent = `คลาด ${Math.abs(drift).toFixed(1)}s กำลังตรวจซ้ำ`;
    } else if (decision === 'soft-wait') {
      syncStatus.textContent = `คลาด ${Math.round(Math.abs(drift) * 1000)}ms กำลังยืนยัน`;
    } else if (decision === 'soft-seek') {
      syncStatus.textContent = 'ปรับละเอียดจาก buffer แล้ว';
    } else if (decision === 'rate-fallback-seek') {
      syncStatus.textContent = 'ความเร็วไม่ตอบสนอง · จัดเวลาให้ใหม่แล้ว';
    } else if (decision === 'precision-seek') {
      syncStatus.textContent = 'จัดเวลาให้ใกล้กันแล้ว';
    } else if (decision === 'precision-wait' || decision === 'rate-pending') {
      syncStatus.textContent = `คลาด ${Math.round(Math.abs(drift) * 1000)}ms · กำลังปรับละเอียด`;
    } else if (decision === 'force-align-peer') {
      syncStatus.textContent = 'P2P พบว่าคลาด · จัดเวลาอัตโนมัติแล้ว';
    } else if (decision === 'force-align') {
      syncStatus.textContent = 'ตรวจพบดีเลย์ · จัดเวลาอัตโนมัติแล้ว';
    } else if (decision === 'settling') {
      syncStatus.textContent = 'กำลังรอวิดีโอนิ่ง';
    } else if (decision === 'start-align') {
      syncStatus.textContent = 'เริ่มเล่นแล้ว · จัดเวลาให้ตรงกับ Host';
    } else if (decision === 'start-align-wait') {
      syncStatus.textContent = 'เริ่มเล่น · กำลังเทียบเวลา';
    } else if (decision === 'host-reference') {
      syncStatus.textContent = 'คุณคือเวลาอ้างอิงของห้อง';
    } else if (decision === 'bootstrap-kept') {
      syncStatus.textContent = 'ยังตรงกันอยู่ · เล่นต่อโดยไม่กระโดดเวลา';
    } else if (decision === 'cooldown' || decision === 'drift-watch') {
      syncStatus.textContent = `คลาด ${Math.abs(drift).toFixed(1)}s · ${controller.profileName === 'smooth'
        ? 'โหมดลื่นไหล ปล่อยไว้ก่อน' : 'รอดูก่อนปรับ'}`;
    } else if (decision === 'ended-wait') {
      syncStatus.textContent = 'คลิปจบแล้ว · รอ Host';
    } else {
      syncStatus.textContent = `คลาด ${Math.abs(drift).toFixed(1)}s`;
    }
    syncStatus.dataset.state = decision;
  }

  function send(message, silent = false) {
    if (socket?.readyState === WebSocket.OPEN) {
      if (!window.canSendRealtimeMessage(socket.bufferedAmount, message.type)) {
        if (!silent) showError('เครือข่ายติดขัด กรุณาลองส่งคำสั่งอีกครั้ง');
        return false;
      }
      try {
        socket.send(JSON.stringify(message));
        return true;
      } catch (_) {
        if (!silent) showError('ส่งคำสั่งไม่สำเร็จ กรุณาลองอีกครั้ง');
        return false;
      }
    }
    if (!silent) showError('ยังไม่เชื่อมต่อกับห้อง กรุณารอสักครู่');
    return false;
  }

  function newCommandId() {
    return window.crypto?.randomUUID?.()
      || `${performance.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function clearLocalPlayAttempt() {
    window.clearTimeout(localPlayTimer);
    localPlayTimer = null;
    localPlayStartedAt = null;
    localPlayInProgress = false;
  }

  function verifyLocalPlayAttempt() {
    const state = controller.player?.getPlayerState?.();
    if (state === YT.PlayerState.PLAYING) {
      clearLocalPlayAttempt();
      return;
    }
    const elapsed = performance.now() - (localPlayStartedAt || performance.now());
    if (elapsed < PLAY_START_TIMEOUT_MS
        || (controller.isBuffering && elapsed < BUFFERING_START_TIMEOUT_MS)) {
      localPlayTimer = window.setTimeout(
        verifyLocalPlayAttempt,
        HEALTH_CHECK_INTERVAL_MS,
      );
      return;
    }
    clearLocalPlayAttempt();
    autoplayBlocked = true;
    resumePlayback.hidden = false;
    updatePlayerCover();
  }

  function sendControl(action, mediaTime, extras = {}, observedLocalMs = performance.now()) {
    if (role !== 'host') return false;
    if (!clock.ready) {
      showError('กำลังเทียบนาฬิกากับห้อง กรุณารอสักครู่');
      return false;
    }
    // PLAY/PAUSE/SET_VIDEO carry their own position, superseding a held scrub.
    if (action !== 'SEEK') pendingHostSeek = null;
    const commandId = newCommandId();
    const sent = send({
      type: 'CONTROL',
      action,
      command_id: commandId,
      media_time_s: Number.isFinite(mediaTime) ? mediaTime : controller.currentTime(),
      observed_server_ms: clock.serverNow(observedLocalMs),
      ...extras,
    });
    if (sent) {
      if (['PLAY', 'PAUSE', 'SEEK'].includes(action)) {
        peerSync.broadcastControl({
          action,
          command_id: commandId,
          base_revision: latestRevision,
          video_id: latestState?.video_id,
          media_time_s: mediaTime,
          observed_server_ms: clock.serverNow(observedLocalMs),
        });
      }
      pendingHostCommands.push({
        id: commandId,
        action,
        expiresAt: performance.now() + 2000,
      });
      syncStatus.textContent = 'กำลังส่งคำสั่ง…';
      syncStatus.dataset.state = 'command-pending';
    }
    return sent;
  }

  function handlePlaybackEvent(event) {
    if (event.type === 'RATE_OVERRIDE') {
      showError('ห้องนี้ใช้ความเร็ว 1x เท่านั้น ระบบกำลังคืนความเร็ว');
      return;
    }
    if (role !== 'host') return;
    if (event.type === 'PLAY' || event.type === 'PAUSE') {
      sendControl(event.type, event.time, {}, event.observed_local_ms);
    } else if (event.type === 'ENDED') {
      sendControl('PAUSE', event.time, {}, event.observed_local_ms);
      if (queueState.autoplay !== false && queueState.items?.length && event.videoId) {
        send({ type: 'QUEUE_NEXT', ended_video_id: event.videoId }, true);
      }
    }
  }

  function pingServer() {
    return new Promise((resolve, reject) => {
      const id = ++pingSequence;
      const t0 = performance.now();
      const timeout = window.setTimeout(() => {
        pendingPings.delete(id);
        reject(new Error('clock ping timeout'));
      }, 3000);
      pendingPings.set(id, { t0, resolve, reject, timeout });
      if (!send({ type: 'CLOCK_PING', id, client_send_ms: t0 }, true)) {
        window.clearTimeout(timeout);
        pendingPings.delete(id);
        reject(new Error('socket closed'));
      }
    });
  }

  function handleClockPong(message) {
    const pending = pendingPings.get(message.id);
    if (!pending) return;
    pendingPings.delete(message.id);
    window.clearTimeout(pending.timeout);
    const t3 = performance.now();
    pending.resolve(clock.measure(
      pending.t0,
      Number(message.server_receive_ms),
      Number(message.server_send_ms),
      t3,
    ));
  }

  async function syncClock(sampleCount = 8, keepCount = 4) {
    if (clockSyncPromise) return clockSyncPromise;
    const generation = ++clockSyncGeneration;
    const targetSocket = socket;
    const run = (async () => {
      const pendingMeasurements = [];
      for (let index = 0; index < sampleCount; index += 1) {
        if (generation !== clockSyncGeneration || socket !== targetSocket || !welcomed) break;
        pendingMeasurements.push(pingServer().then((measurement) => {
          if (!measurement || generation !== clockSyncGeneration
              || socket !== targetSocket || !welcomed) return;
          // Start from the first usable reply; a lost final probe must not stall playback.
          if (clock.update([measurement], keepCount)) {
            updateControlAvailability();
            applyLatestState(false);
          }
        }).catch(() => null));
        if (index + 1 < sampleCount) {
          await new Promise((resolve) => window.setTimeout(resolve, 75 + Math.random() * 50));
        }
      }
      await Promise.all(pendingMeasurements);
    })();
    clockSyncPromise = run.finally(() => {
      if (generation === clockSyncGeneration) clockSyncPromise = null;
    });
    return clockSyncPromise;
  }

  function acceptedState(state) {
    const revision = Number(state.revision);
    const serverSendMs = Number(state.server_send_ms);
    if (!window.isStateNewer(latestRevision, latestServerSendMs, state)) return false;
    latestRevision = revision;
    latestServerSendMs = serverSendMs;
    return true;
  }

  function receiveState(state, reconnectBootstrap = false) {
    if (!acceptedState(state)) return;
    const previousVideo = latestState?.video_id;
    if (pendingPeerControl && (state.command_id === pendingPeerControl.commandId
        || Number(state.revision) > pendingPeerControl.baseRevision)) {
      if (state.command_id === pendingPeerControl.commandId) {
        controller.lastControlRevision = Number(state.revision);
      }
      pendingPeerControl = null;
    }
    window.acknowledgeHostCommand(pendingHostCommands, state.command_id);
    if (pendingControl !== null
        && Number(pendingControl.revision) < Number(state.revision)) {
      pendingControl = null;
    }
    if (typeof state.control_action === 'string'
        && controller.lastControlRevision !== state.revision) {
      pendingControl = { revision: state.revision, action: state.control_action };
    }
    latestState = state;
    serverHostSample = state.host_sample && typeof state.host_sample === 'object'
      ? {
        ...state.host_sample,
        video_id: state.video_id,
        revision: Number(state.revision),
        buffering: false,
        received_server_ms: clock.ready ? clock.serverNow() : Number.NaN,
        received_local_ms: performance.now(),
      }
      : null;
    receiveRoomVolume(state);
    if (previousVideo !== state.video_id) {
      window.clearTimeout(errorSkipTimer);
      errorSkipTimer = null;
      updateNowPlaying();
      playerFailure = '';
      autoplayBlocked = false;
      localPlayInProgress = false;
      autoMutedVideoId = null;
      autoMutedPlayback = false;
    }
    if (!state.is_playing
        && !window.hasPendingHostCommand(pendingHostCommands, performance.now())) {
      clearLocalPlayAttempt();
    }
    pendingBootstrap = pendingBootstrap
      || reconnectBootstrap
      || previousVideo !== state.video_id;
    showCohort(state.cohort);
    updatePlayerCover();
    applyLatestState();
  }

  function applyLatestState(bootstrap = false) {
    if (!playerReady || !latestState || !clock.ready) return;
    const now = performance.now();
    if (pendingPeerControl) {
      if (now < pendingPeerControl.expiresAt) return;
      pendingPeerControl = null;
    }
    if (role === 'host'
        && window.hasPendingHostCommand(pendingHostCommands, now)) return;

    const serverNowMs = clock.serverNow();
    let expected = window.expectedMediaTime(latestState, serverNowMs);
    let referenceUncertaintyMs = clock.uncertainty;
    const precisionSync = role === 'host'
      || (p2pEnabled && Boolean(hostPeerId) && peerSync.isConnected(hostPeerId));
    controller.setSyncProfile(preferredSyncProfile());
    // Follow the Host's real position: the direct P2P reading when there is
    // one, otherwise the same reading relayed by the server.
    let hostReference = null;
    if (role !== 'host') {
      for (const sample of precisionSync ? [latestHostSample, serverHostSample] : [serverHostSample]) {
        hostReference = window.projectHostSample(
          sample, latestState, serverNowMs, clock.uncertainty,
          Number(sample?.received_local_ms), now,
        );
        if (hostReference) break;
      }
    }
    if (hostReference) {
      expected = Math.max(0, hostReference.expectedTime);
      referenceUncertaintyMs = hostReference.uncertaintyMs;
    }

    const shouldBootstrap = bootstrap || pendingBootstrap;
    const controlAction = pendingControl?.revision === latestState.revision
      ? pendingControl.action
      : null;
    // Host is the reference clock. Never pull it toward its own delayed echo.
    if (role === 'host' && !shouldBootstrap && controlAction === null) {
      expected = controller.currentTime();
    }
    const decision = controller.apply(
      latestState,
      expected,
      shouldBootstrap,
      controlAction,
      referenceUncertaintyMs,
      { isHost: role === 'host', precisionSync },
    );
    pendingBootstrap = false;
    if (controlAction !== null
        && controller.lastControlRevision === latestState.revision) {
      pendingControl = null;
    }
    // A clip started from the queue arrives paused at 0; the Host's player
    // starts it and its normal PLAY report brings everyone in together.
    if (role === 'host' && latestState.control_action === 'AUTOSTART'
        && !latestState.is_playing && controller.videoId === latestState.video_id
        && autostartHandledRevision !== latestState.revision) {
      autostartHandledRevision = latestState.revision;
      controller.player?.playVideo?.();
    }
    showSyncDecision(decision);
    watchAutoplay();
  }

  function watchAutoplay() {
    if (!latestState?.is_playing) {
      window.clearTimeout(autoplayTimer);
      autoplayTimer = null;
      resumePlayback.hidden = true;
      mutedPlayback.hidden = true;
      return;
    }
    if (localPlayInProgress) {
      window.clearTimeout(autoplayTimer);
      autoplayTimer = null;
      resumePlayback.hidden = true;
      mutedPlayback.hidden = true;
      return;
    }
    if (controller.player?.getPlayerState?.() === YT.PlayerState.PLAYING) {
      window.clearTimeout(autoplayTimer);
      autoplayTimer = null;
      resumePlayback.hidden = true;
      mutedPlayback.hidden = true;
      return;
    }
    if (autoplayTimer !== null) return;
    autoplayTimer = window.setTimeout(() => {
      autoplayTimer = null;
      if (latestState?.is_playing
          && controller.player?.getPlayerState?.() !== YT.PlayerState.PLAYING) {
        // Browsers often block autoplay with sound but permit muted playback.
        // Try that once per video before asking the viewer to intervene.
        if (role !== 'host' && autoMutedVideoId !== latestState.video_id) {
          autoMutedVideoId = latestState.video_id;
          syncStatus.textContent = 'กำลังเริ่มวิดีโอให้อัตโนมัติแบบปิดเสียง…';
          syncStatus.dataset.state = 'auto-muted-playback';
          startPlaybackFromGesture(true, true);
          return;
        }
        resumePlayback.hidden = false;
        mutedPlayback.hidden = false;
        syncStatus.textContent = 'ต้องแตะเพื่อเล่น';
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${location.host}/ws/${roomId}`);
    socket = ws;
    const handshakeTimeout = window.setTimeout(() => {
      if (socket !== ws || welcomed) return;
      if (ws.readyState === WebSocket.CONNECTING) ws.close();
      if (ws.readyState === WebSocket.OPEN) ws.close(4001, 'welcome timeout');
    }, HANDSHAKE_TIMEOUT_MS);

    ws.addEventListener('open', () => {
      welcomed = false;
      lastServerMessageAt = performance.now();
      clock.reset();
      clockSyncGeneration += 1;
      clockSyncPromise = null;
      updateControlAvailability();
      showError();
      setConnectionStatus('กำลังยืนยันตัวตน…', 'connected');
      send({ type: 'HELLO', host_token: hostToken || null, p2p: true }, true);
    });

    ws.addEventListener('message', (event) => {
      if (socket !== ws) return;
      lastServerMessageAt = performance.now();
      let message;
      try {
        message = JSON.parse(event.data);
      } catch (_) {
        return;
      }

      if (message.type === 'WELCOME') {
        window.clearTimeout(handshakeTimeout);
        welcomed = true;
        reconnectAttempt = 0;
        role = message.role === 'host' ? 'host' : 'viewer';
        showRole();
        setConnectionStatus('เชื่อมต่อแล้ว', 'connected');
        latestRevision = -1;
        latestServerSendMs = -Infinity;
        roomVolumeRevision = -1;
        peerConsensus.clear();
        autoRecovery.reset();
        pendingPeerControl = null;
        lastPeerControlAt = -Infinity;
        latestHostSample = null;
        hostPeerId = message.host_peer_id || null;
        p2pEnabled = message.p2p_enabled !== false;
        peerSync.start(message.peer_id, p2pEnabled && Array.isArray(message.peers) ? message.peers : []);
        queueState.revision = -1;
        if (message.queue) receiveQueue(message.queue);
        receiveState({ ...message.state, server_send_ms: message.server_send_ms }, true);
        const calibrationDelayMs = role === 'host' ? 0 : Math.random() * 100;
        window.setTimeout(() => {
          if (socket === ws && welcomed) syncClock(8, 4);
        }, calibrationDelayMs);
      } else if (message.type === 'CLOCK_PONG') {
        handleClockPong(message);
      } else if (message.type === 'STATE' || message.type === 'TIMELINE') {
        receiveState(message, false);
      } else if (message.type === 'QUEUE') {
        receiveQueue(message);
      } else if (message.type === 'NOTICE') {
        const feedback = document.getElementById('share-status');
        feedback.textContent = message.message || '';
        window.setTimeout(() => {
          if (feedback.textContent === message.message) feedback.textContent = '';
        }, 5000);
      } else if (message.type === 'PEER_JOINED') {
        if (p2pEnabled) peerSync.addPeer(message.peer_id);
      } else if (message.type === 'PEER_MODE') {
        p2pEnabled = Boolean(message.enabled);
        hostPeerId = message.host_peer_id || null;
        if (message.role === 'viewer' && role === 'host') {
          role = 'viewer';
          pendingHostCommands.length = 0;
          showRole();
        }
        pendingPeerControl = null;
        latestHostSample = null;
        peerConsensus.clear();
        peerSync.start(peerSync.selfId, p2pEnabled && Array.isArray(message.peers) ? message.peers : []);
      } else if (message.type === 'HOST_CHANGED') {
        hostPeerId = message.host_peer_id || null;
        if (message.role === 'viewer' && role === 'host') {
          role = 'viewer';
          pendingHostCommands.length = 0;
          showRole();
        }
        pendingPeerControl = null;
        lastPeerControlAt = -Infinity;
        latestHostSample = null;
      } else if (message.type === 'PEER_LEFT') {
        if (message.peer_id === hostPeerId) latestHostSample = null;
        peerSync.removePeer(message.peer_id);
        peerConsensus.remove(message.peer_id);
      } else if (message.type === 'SIGNAL') {
        if (p2pEnabled) peerSync.handleSignal(message.from, message.data);
      } else if (message.type === 'SIGNAL_ERROR') {
        peerSync.removePeer(message.target);
        peerConsensus.remove(message.target);
      } else if (message.type === 'PLAYER_ERROR') {
        if (message.video_id && message.video_id !== latestState?.video_id) return;
        playerFailure = message.message || window.youtubeErrorMessage(message.code);
        clearLocalPlayAttempt();
        showError(playerFailure);
        updatePlayerCover();
      } else if (message.type === 'ERROR') {
        pendingHostCommands.length = 0;
        clearLocalPlayAttempt();
        showError(message.message || 'เกิดข้อผิดพลาด');
        updatePlayerCover();
        applyLatestState(false);
      }
    });

    ws.addEventListener('close', (event) => {
      if (socket !== ws) return;
      window.clearTimeout(handshakeTimeout);
      welcomed = false;
      lastServerMessageAt = -Infinity;
      clock.reset();
      clockSyncGeneration += 1;
      clockSyncPromise = null;
      pendingHostCommands.length = 0;
      pendingPeerControl = null;
      latestHostSample = null;
      hostPeerId = null;
      peerSync.stop();
      peerConsensus.clear();
      autoRecovery.reset();
      updateControlAvailability();
      for (const pending of pendingPings.values()) {
        window.clearTimeout(pending.timeout);
        pending.reject(new Error('socket closed'));
      }
      pendingPings.clear();
      if (event.code === 1008) {
        setConnectionStatus('ห้องนี้ไม่สามารถใช้งานได้', 'disconnected');
        location.replace('/?room=unavailable');
        return;
      }
      setConnectionStatus('การเชื่อมต่อขาด กำลังลองใหม่…', 'disconnected');
      const delay = window.reconnectDelayMs(reconnectAttempt);
      reconnectAttempt += 1;
      window.setTimeout(connect, delay);
    });

    ws.addEventListener('error', () => ws.close());
  }

  function createPlayer() {
    if (playerCreated) return;
    playerCreated = true;
    playerCreateAttempts += 1;
    try {
      controller.create(() => {
        playerReady = true;
        playerFailure = '';
        window.clearTimeout(playerStartupTimer);
        applyLocalVolume(localVolume);
        updatePlayerCover();
        applyLatestState(true);
      });
    } catch (_) {
      playerCreated = false;
      playerFailure = 'สร้างตัวเล่น YouTube ไม่สำเร็จ';
      updatePlayerCover();
      if (playerCreateAttempts < 3) window.setTimeout(createPlayer, 1000);
    }
  }

  function loadYouTubeApi() {
    if (window.YT?.Player) {
      createPlayer();
      return;
    }
    youtubeApiAttempts += 1;
    document.getElementById('youtube-iframe-api')?.remove();
    const script = document.createElement('script');
    script.id = 'youtube-iframe-api';
    script.src = 'https://www.youtube.com/iframe_api';
    script.referrerPolicy = 'strict-origin-when-cross-origin';
    script.async = true;
    script.onerror = () => {
      if (youtubeApiAttempts < 3) {
        window.setTimeout(loadYouTubeApi, youtubeApiAttempts * 1000);
        return;
      }
      playerFailure = 'โหลด YouTube API ไม่สำเร็จ';
      updatePlayerCover();
    };
    document.head.appendChild(script);
  }

  window.onYouTubeIframeAPIReady = createPlayer;
  loadYouTubeApi();
  playerStartupTimer = window.setTimeout(() => {
    if (playerReady) return;
    playerFailure = 'โหลดตัวเล่น YouTube ไม่สำเร็จ';
    updatePlayerCover();
  }, 8000);

  videoForm.addEventListener('submit', (event) => {
    event.preventDefault();
    // Enter from a viewer's field queues; only the Host can replace the clip.
    submitVideo(role === 'host');
  });
  queueAddButton.addEventListener('click', () => submitVideo(false));
  videoUrl.addEventListener('input', updatePlaylistOption);
  document.getElementById('queue-next').addEventListener('click', () => sendQueue('QUEUE_NEXT'));
  document.getElementById('queue-shuffle').addEventListener('click', () => sendQueue('QUEUE_SHUFFLE'));
  document.getElementById('queue-clear').addEventListener('click', () => {
    if (window.confirm('ล้างคลิปทั้งหมดในคิว?')) sendQueue('QUEUE_CLEAR');
  });
  queueAutoplay.addEventListener('change', () => sendQueue('QUEUE_SETTINGS', { autoplay: queueAutoplay.checked }));
  queueAllowViewers.addEventListener('change', () => sendQueue('QUEUE_SETTINGS', { allow_viewers: queueAllowViewers.checked }));
  syncModeSelect.addEventListener('change', () => {
    syncMode = syncModeSelect.value;
    try {
      localStorage.setItem(syncModeKey, syncMode);
    } catch (_) {
      // The choice still applies for this visit.
    }
    applyLatestState(false);
  });

  let shareResetTimer = null;
  document.getElementById('reload-room').addEventListener('click', () => location.reload());
  shareButton.addEventListener('click', async () => {
    const viewerUrl = `${location.origin}/room/${roomId}`;
    const feedback = document.getElementById('share-status');
    const fallback = document.getElementById('share-fallback');
    const inviteInput = document.getElementById('invite-url');
    window.clearTimeout(shareResetTimer);
    try {
      await navigator.clipboard.writeText(viewerUrl);
      fallback.hidden = true;
      shareButton.textContent = 'คัดลอกแล้ว ✓';
      feedback.textContent = 'ส่งลิงก์ให้เพื่อนได้เลย · ลิงก์นี้ให้สิทธิ์ผู้ชมเท่านั้น';
      shareResetTimer = window.setTimeout(() => {
        shareButton.textContent = 'เชิญเพื่อน · คัดลอกลิงก์';
        feedback.textContent = '';
      }, 4000);
    } catch (_) {
      feedback.textContent = 'คัดลอกอัตโนมัติไม่ได้ แตะค้างหรือกด Ctrl/Cmd+C ที่ลิงก์ด้านล่าง';
      fallback.hidden = false;
      inviteInput.value = viewerUrl;
      inviteInput.focus();
      inviteInput.select();
    }
  });

  showQrButton.addEventListener('click', () => {
    const viewerUrl = `${location.origin}/room/${roomId}`;
    qrViewerLink.href = viewerUrl;
    qrViewerLink.textContent = viewerUrl;
    if (!qrImage.getAttribute('src')) {
      qrImage.src = `/room/${encodeURIComponent(roomId)}/share-qr.svg`;
    }
    if (typeof qrDialog.showModal === 'function') {
      qrDialog.showModal();
    } else {
      qrDialog.setAttribute('open', '');
    }
  });

  function closeQrDialog() {
    if (typeof qrDialog.close === 'function') qrDialog.close();
    else qrDialog.removeAttribute('open');
  }

  closeQrButton.addEventListener('click', closeQrDialog);
  qrDialog.addEventListener('click', (event) => {
    if (event.target === qrDialog) closeQrDialog();
  });

  function startPlaybackFromGesture(startMuted = false, automatic = false) {
    if (!playerReady || !latestState?.video_id) {
      playerFailure = 'ตัวเล่น YouTube ยังโหลดไม่สำเร็จ';
      updatePlayerCover();
      return;
    }
    if (role === 'host'
        && !latestState.is_playing
        && (!welcomed || !clock.ready)) {
      showError('กำลังเชื่อมต่อกับห้อง กรุณารอสักครู่');
      return;
    }

    const observedLocalMs = performance.now();
    const mediaTime = controller.currentTime();
    const expectedTime = clock.ready
      ? window.expectedMediaTime(latestState, clock.serverNow(observedLocalMs))
      : mediaTime;

    playerFailure = '';
    autoplayBlocked = false;
    if (!startMuted && autoMutedPlayback) {
      autoMutedPlayback = false;
      applyLocalVolume(lastAudibleVolume);
      updateVolumeUi();
    }
    if (startMuted) {
      followRoomVolume = false;
      followVolume.checked = false;
      applyLocalVolume(0);
      controller.mute();
      autoMutedPlayback = automatic;
      updateVolumeUi();
    }
    localPlayInProgress = true;
    localPlayStartedAt = observedLocalMs;
    window.clearTimeout(autoplayTimer);
    autoplayTimer = null;
    window.clearTimeout(localPlayTimer);
    localPlayTimer = window.setTimeout(
      verifyLocalPlayAttempt,
      HEALTH_CHECK_INTERVAL_MS,
    );
    resumePlayback.hidden = true;
    mutedPlayback.hidden = true;
    playerCover.hidden = true;

    if (!controller.playFromGesture(expectedTime)) {
      clearLocalPlayAttempt();
      playerFailure = 'ไม่สามารถสั่งเล่นวิดีโอได้';
      updatePlayerCover();
      return;
    }

    if (role === 'host' && !latestState.is_playing) {
      const sent = sendControl('PLAY', mediaTime, {}, observedLocalMs);
      if (!sent) controller.desiredPlaying = false;
    }
  }

  resumePlayback.addEventListener('click', () => startPlaybackFromGesture(false));
  mutedPlayback.addEventListener('click', () => startPlaybackFromGesture(true));

  document.addEventListener('keydown', (event) => {
    if (event.code !== 'Space'
        || event.target.closest?.('input, textarea, select, button, a, summary, dialog, [contenteditable="true"]')) {
      return;
    }
    event.preventDefault();
    startPlaybackFromGesture();
  });

  window.addEventListener('watchparty-player-playing', () => {
    clearLocalPlayAttempt();
    // A transient start-up error is moot once the clip actually plays.
    if (playerFailure && errorMessage.textContent.startsWith(playerFailure)) showError();
    playerFailure = '';
    autoplayBlocked = false;
    resumePlayback.hidden = true;
    mutedPlayback.hidden = true;
    playerCover.hidden = true;
    watchAutoplay();
  });

  window.addEventListener('watchparty-player-error', (event) => {
    const code = Number(event.detail);
    playerFailure = window.youtubeErrorMessage(code);
    clearLocalPlayAttempt();
    showError(playerFailure);
    updatePlayerCover();
    if (role === 'host' && Number.isInteger(code)) {
      send({
        type: 'PLAYER_ERROR',
        code,
        video_id: latestState?.video_id || null,
      }, true);
      // Playlists often contain clips that refuse embedding: skip them.
      const failedVideoId = latestState?.video_id;
      if ([5, 100, 101, 150].includes(code) && failedVideoId
          && queueState.autoplay !== false && queueState.items?.length) {
        window.clearTimeout(errorSkipTimer);
        showError(`${playerFailure} · ข้ามไปคลิปถัดไปใน 3 วินาที`);
        errorSkipTimer = window.setTimeout(() => {
          errorSkipTimer = null;
          send({ type: 'QUEUE_NEXT', ended_video_id: failedVideoId }, true);
        }, 3000);
      }
    }
  });

  window.addEventListener('watchparty-autoplay-blocked', () => {
    if (localPlayInProgress) return;
    autoplayBlocked = true;
    clearLocalPlayAttempt();
    resumePlayback.hidden = false;
    mutedPlayback.hidden = false;
    updatePlayerCover();
  });

  playerCoverPlay.addEventListener('click', () => startPlaybackFromGesture(false));

  volumeSlider.addEventListener('input', () => {
    const volume = Number(volumeSlider.value);
    autoMutedPlayback = false;
    if (role === 'host') {
      followRoomVolume = true;
      roomVolume = volume;
      applyLocalVolume(volume);
      scheduleRoomVolume(volume);
    } else {
      followRoomVolume = false;
      followVolume.checked = false;
      applyLocalVolume(volume);
    }
    updateVolumeUi();
  });

  volumeSlider.addEventListener('change', () => {
    if (role === 'host') scheduleRoomVolume(Number(volumeSlider.value), true);
  });

  muteButton.addEventListener('click', () => {
    const nextVolume = localVolume === 0 ? lastAudibleVolume : 0;
    autoMutedPlayback = false;
    if (role === 'host') {
      followRoomVolume = true;
      roomVolume = nextVolume;
      applyLocalVolume(nextVolume);
      scheduleRoomVolume(nextVolume, true);
    } else {
      followRoomVolume = false;
      followVolume.checked = false;
      applyLocalVolume(nextVolume);
    }
    updateVolumeUi();
  });

  followVolume.addEventListener('change', () => {
    followRoomVolume = followVolume.checked;
    autoMutedPlayback = false;
    if (followRoomVolume) applyLocalVolume(roomVolume);
    updateVolumeUi();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible'
        || !welcomed
        || socket?.readyState !== WebSocket.OPEN) return;
    pendingBootstrap = true;
    clock.reset();
    clockSyncGeneration += 1;
    clockSyncPromise = null;
    updateControlAvailability();
    syncStatus.textContent = 'กำลังเทียบนาฬิกาหลังกลับมาหน้านี้…';
    syncClock(8, 4);
  });

  // Dragging the YouTube timeline produces a burst of jumps. Send only where
  // the Host settles, so viewers re-buffer once instead of once per jump.
  const HOST_SEEK_SETTLE_MS = 400;
  window.setInterval(() => {
    if (role !== 'host' || !playerReady || !latestState) {
      pendingHostSeek = null;
      return;
    }
    const seekTime = controller.detectUserSeek();
    const nowMs = performance.now();
    if (seekTime !== null) {
      pendingHostSeek = { at: nowMs };
    }
    if (pendingHostSeek && nowMs - pendingHostSeek.at >= HOST_SEEK_SETTLE_MS) {
      pendingHostSeek = null;
      // Report the settled position now; it is already relative to "now".
      sendControl('SEEK', controller.currentTime(), {}, nowMs);
    }
  }, 100);

  window.setInterval(() => {
    if (!welcomed || !clock.ready || !playerReady || !latestState) return;
    if (document.visibilityState === 'hidden') return;
    applyLatestState(false);
  }, 100);

  window.setInterval(() => {
    if (!welcomed || !clock.ready || !playerReady) return;
    const sampleStartMs = performance.now();
    const intervalMs = document.visibilityState === 'hidden' || !latestState?.is_playing
      ? 2000 : (role === 'host' ? 100 : 500);
    if (sampleStartMs - lastTelemetryAt < intervalMs) return;
    lastTelemetryAt = sampleStartMs;
    const mediaTime = controller.currentTime();
    const sampleEndMs = performance.now();
    const observedLocalMs = (sampleStartMs + sampleEndMs) / 2;
    const telemetry = controller.telemetry(
      clock.serverNow(observedLocalMs),
      clock.rtt,
      clock.uncertainty,
      mediaTime,
    );
    send({ type: 'CLIENT_SAMPLE', ...telemetry }, true);
    if (latestState?.video_id) {
      peerSync.broadcast({
        video_id: latestState.video_id,
        revision: Number(latestState.revision),
        ...telemetry,
      });
    }
  }, 100);

  function runAutoRecovery() {
    if (document.visibilityState === 'hidden') return;
    const localNowMs = performance.now();
    if (pendingPeerControl && localNowMs < pendingPeerControl.expiresAt) return;
    const serverNowMs = clock.ready ? clock.serverNow(localNowMs) : Number.NaN;
    const canonicalTimeS = latestState && clock.ready
      ? window.expectedMediaTime(latestState, serverNowMs)
      : Number.NaN;
    const localTimeS = controller.currentTime();
    const peers = peerConsensus.summarize({
      serverNowMs,
      localTimeS,
      canonicalTimeS,
      videoId: latestState?.video_id,
      revision: Number(latestState?.revision),
      intendedPlaying: Boolean(latestState?.is_playing),
    });
    const playerState = controller.playerState();
    const decision = autoRecovery.evaluate({
      connected: welcomed && socket?.readyState === WebSocket.OPEN,
      playerReady,
      hasVideo: Boolean(latestState?.video_id),
      clockReady: clock.ready,
      clockUncertaintyMs: clock.uncertainty,
      buffering: controller.isBuffering || playerState === YT.PlayerState.BUFFERING,
      intendedPlaying: Boolean(latestState?.is_playing),
      actuallyPlaying: playerState === YT.PlayerState.PLAYING,
      driftS: canonicalTimeS - localTimeS,
      peerDriftS: peers.peerDriftS,
      peerHealthyCount: peers.healthyCount,
      peerSupportsCanonical: peers.supportsCanonical,
    }, localNowMs);

    if (decision === 'resync-clock') {
      syncStatus.textContent = 'ตรวจพบนาฬิกาไม่นิ่ง · กำลังเทียบใหม่…';
      syncClock(8, 4);
      return;
    }
    // P2P carries explicit Host commands and diagnostics only. The server
    // timeline is the sole repair authority, preventing two sync loops fighting.
  }

  window.setInterval(() => {
    const targetSocket = socket;
    window.setTimeout(() => {
      if (welcomed
          && socket === targetSocket
          && socket?.readyState === WebSocket.OPEN) {
        syncClock(3, 4);
      }
    }, Math.random() * 750);
  }, 15000);

  window.setInterval(() => {
    if (networkStatus) {
      networkStatus.textContent = clock.ready
        ? `Server RTT ${Math.round(clock.rtt)}ms · ±${Math.round(clock.uncertainty)}ms`
        : 'กำลังวัดเครือข่าย…';
    }
    if (welcomed && playerReady && latestState) watchAutoplay();
    runAutoRecovery();
    if (!welcomed || socket?.readyState !== WebSocket.OPEN) return;
    if (!window.isConnectionStale(
      lastServerMessageAt,
      performance.now(),
      CONNECTION_STALE_MS,
    )) return;
    setConnectionStatus('การเชื่อมต่อไม่ตอบสนอง กำลังลองใหม่…', 'disconnected');
    socket.close(4000, 'heartbeat timeout');
  }, HEALTH_CHECK_INTERVAL_MS);

  showRole();
  connect();
})();
