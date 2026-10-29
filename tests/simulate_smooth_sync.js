'use strict';
// Seeded synthetic iframe/network simulation, NOT an end-to-end YouTube bound.
// Run: node tests/simulate_smooth_sync.js
const assert = require('node:assert/strict');
let now = 0;
global.performance = { now: () => now };
global.window = {};
global.document = { visibilityState: 'visible' };
global.YT = { PlayerState: { UNSTARTED: -1, PLAYING: 1, PAUSED: 2, BUFFERING: 3 } };
require('../static/js/youtube-player.js');
require('../static/js/peer-sync.js');
require('../static/js/sync-clock.js');
function simulate(seed, impaired) {
  let rng = seed >>> 0;
  const random = () => { rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0; return rng / 4294967296; };
  const c = new window.YouTubeController('player');
  c.ready = true; c.videoId = 'video'; c.desiredPlaying = true;
  const peers = new window.PeerConsensus();
  let local = 10.2, readNoise = 0, rate = 1, frozenUntil = 0, latest = null, latestLocal = null;
  let state = { video_id: 'video', revision: 1, is_playing: true, media_time_s: 10, anchor_server_ms: 0 };
  let explicit = false;
  const seeks = [], rates = [], errors = [], steadyErrors = [], queue = [], recoveredAt = {};
  c.player = {
    getCurrentTime: () => local + readNoise,
    getPlayerState: () => impaired && now >= 40000 && now < 43000 ? 3 : 1,
    getPlaybackRate: () => rate, getAvailablePlaybackRates: () => [0.75, 1, 1.25],
    setPlaybackRate: value => { rate = value; rates.push({ at: now, value }); c.handlePlaybackRateChange({ data: value }); },
    seekTo: target => {
      seeks.push({ at: now, explicit }); local = target + (random() - 0.5) * 0.16;
      frozenUntil = now + 150; // simple illustrative seek stall, not measured API latency
    },
    playVideo() {}, pauseVideo() {},
  };
  for (now = 0; now <= 120000; now += 100) {
    const buffering = impaired && now >= 40000 && now < 43000;
    const hidden = impaired && now >= 70000 && now < 75000;
    document.visibilityState = hidden ? 'hidden' : 'visible';
    if (now && !buffering && !hidden && now >= frozenUntil) local += 0.1 * 0.9995 * rate;
    if (impaired && now === 90000) {
      state = { ...state, revision: 2, media_time_s: 140, anchor_server_ms: now };
      latest = null; peers.clear(); explicit = true;
      c.apply(state, 140, false, 'SEEK'); explicit = false;
    }
    const host = window.expectedMediaTime(state, now);
    // Host observations contain +-25ms timestamp error; arrivals 20..200ms,
    // 8% packet loss and occasional extra delay cause stale/out-of-order reads.
    if (random() >= 0.08 && !(impaired && now >= 20000 && now < 25000)) {
      const sample = { video_id: 'video', revision: state.revision,
        observed_server_ms: now + (random() - 0.5) * 50,
        media_time_s: host, playback_rate: 1, uncertainty_ms: 30,
        is_playing: true, buffering: false };
      queue.push({ sample, arrives: now + 20 + random() * 180 + (random() < 0.03 ? 1400 : 0) });
    }
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i].arrives > now) continue;
      const { sample } = queue.splice(i, 1)[0];
      if (sample.revision === state.revision && peers.update('host', sample, now)) {
        latest = { ...sample, received_server_ms: now }; latestLocal = now;
      }
    }
    if (impaired && now === 75000) { latest = null; peers.clear(); }
    const ref = window.projectHostSample(latest, state, now, 30, latestLocal, now);
    readNoise = (random() - 0.5) * 0.1;
    const error = Math.abs(host - local); errors.push(error);
    const transient = impaired && ((now >= 40000 && now < 50000)
      || (now >= 70000 && now < 82000) || (now >= 90000 && now < 93000));
    if (!transient) steadyErrors.push(error);
    for (const end of [43000, 75000]) {
      if (impaired && now >= end && !recoveredAt[end] && error < 0.35) recoveredAt[end] = now;
    }
    // The production app evaluates at 100ms; transport never seeks directly.
    if (!hidden) c.correctDrift(ref?.expectedTime ?? host, now, ref?.uncertaintyMs ?? 30);
  }
  const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.floor((values.length - 1) * q)];
  const corrections = seeks.filter(s => !s.explicit);
  for (let i = 1; i < corrections.length; i++) assert.ok(corrections[i].at - corrections[i - 1].at >= 6000);
  assert.equal(rates.length, 0, 'coarse rates should never be used');
  assert.ok(corrections.length <= 6, `too many corrections: ${corrections.length}`);
  assert.ok(percentile(steadyErrors, 0.95) < 0.35);
  if (impaired) {
    assert.ok(recoveredAt[43000] - 43000 <= 6500);
    assert.ok(recoveredAt[75000] - 75000 <= 6500);
  }
  return { seed, scenario: impaired ? 'jitter-loss-buffer-background-host-seek' : 'steady-jitter-loss',
    duration_s: 120, drift_median_ms: Math.round(percentile(errors, 0.5) * 1000),
    drift_p95_ms: Math.round(percentile(errors, 0.95) * 1000),
    steady_p95_ms: Math.round(percentile(steadyErrors, 0.95) * 1000),
    maximum_drift_ms: Math.round(Math.max(...errors) * 1000),
    automatic_seeks: corrections.length, explicit_seeks: seeks.length - corrections.length,
    rate_changes: rates.length,
    buffer_recovery_ms: impaired ? recoveredAt[43000] - 43000 : null,
    visibility_recovery_ms: impaired ? recoveredAt[75000] - 75000 : null };
}
const results = [];
for (const seed of [7, 42, 2026]) for (const impaired of [false, true]) results.push(simulate(seed, impaired));
console.log(JSON.stringify({ note: 'Synthetic API double, 100ms ticks, 150ms seek stall, 80ms landing error; real embeds/devices may differ. Steady excludes 40–50s, 70–82s, 90–93s impairment windows.', results }, null, 2));
