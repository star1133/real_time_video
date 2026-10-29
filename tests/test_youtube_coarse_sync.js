'use strict';
// Deterministic API double; these tests do not model actual iframe seek latency.
// fixture(..., fine=false) models a player that refuses unlisted speeds, which
// exercises the seek fallback; fine=true models today's YouTube embed.
const assert = require('node:assert/strict');
let now = 0;
global.performance = { now: () => now };
global.window = { dispatchEvent() {} };
global.document = { visibilityState: 'visible', addEventListener() {} };
global.YT = { PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 } };
require('../static/js/youtube-player.js');
require('../static/js/sync-clock.js');
require('../static/js/peer-sync.js');
let count = 0;
function test(name, fn) { now = 0; document.visibilityState = 'visible'; fn(); count++; console.log(`PASS ${name}`); }
function fixture(rates = [0.75, 1, 1.25], acknowledge = true, fine = false) {
  const c = new window.YouTubeController('player');
  c.setSyncProfile('precise');
  c.fineRatesSupported = fine;
  const f = { c, time: 10, rate: 1, state: YT.PlayerState.PLAYING, seeks: [], rates: [] };
  c.ready = true; c.videoId = 'video'; c.desiredPlaying = true;
  c.player = {
    getCurrentTime: () => f.time, getPlayerState: () => f.state,
    getPlaybackRate: () => f.rate, getAvailablePlaybackRates: () => rates,
    setPlaybackRate: rate => { f.rates.push(rate); if (acknowledge) { f.rate = rate; c.handlePlaybackRateChange({ data: rate }); } },
    seekTo: time => { f.seeks.push({ at: now, time }); },
    playVideo() {}, pauseVideo() {}, cueVideoById() {},
  };
  f.tick = (t, drift, uncertainty = 0) => { now = t; return c.correctDrift(f.time + drift, now, uncertainty); };
  return f;
}
const state = { video_id: 'video', revision: 1, is_playing: true };
test('without fine speeds, ordinary YouTube rates never pulse for 0.2s drift', () => {
  const f = fixture();
  assert.equal(f.tick(0, 0.03), 'stable');
  for (let t = 100; t < 20000; t += 100) f.tick(t, 0.2);
  assert.equal(f.seeks.length, 0); assert.equal(f.rates.length, 0);
});
test('jitter and alternating large signs do not accumulate persistence', () => {
  const f = fixture();
  for (let t = 0; t < 30000; t += 100) f.tick(t, (t % 200 ? -1 : 1) * 1.1);
  assert.equal(f.seeks.length, 0);
});
test('moderate drift persists for 1.8s, then seek cooldown blocks repeats', () => {
  const f = fixture();
  for (let t = 0; t <= 7700; t += 100) f.tick(t, 0.5);
  assert.deepEqual(f.seeks.map(s => s.at), [1800]);
  f.tick(7800, 0.5); assert.deepEqual(f.seeks.map(s => s.at), [1800, 7800]);
  assert.equal(f.rates.length, 0);
});
test('large drift requires 400ms then settles; uncertainty raises thresholds', () => {
  const f = fixture();
  for (let t = 0; t <= 300; t += 100) f.tick(t, 1);
  assert.equal(f.seeks.length, 0); assert.equal(f.tick(400, 1), 'precision-seek');
  assert.equal(f.tick(500, 1), 'settling');
  const u = fixture(); for (let t = 0; t <= 5000; t += 100) u.tick(t, 0.8, 500);
  assert.equal(u.seeks.length, 0); assert.equal(u.tick(5100, 8, Infinity), 'clock-uncertain');
});
test('fine rates only: direction, crossing, timeout and cooldown', () => {
  for (const direction of [-1, 1]) {
    const f = fixture([0.98, 1, 1.02]);
    for (let t = 0; t <= 1800; t += 100) f.tick(t, direction * 0.2);
    assert.equal(f.rate, direction > 0 ? 1.02 : 0.98);
    assert.equal(f.tick(1900, -direction * 0.01), 'stable'); assert.equal(f.rate, 1);
    assert.equal(f.tick(2000, direction * 0.2), 'cooldown');
  }
  // A nudge holds while the gap persists and is released once it closes.
  const f = fixture([0.98, 1, 1.02]);
  for (let t = 0; t <= 3400; t += 100) f.tick(t, 0.3);
  assert.equal(f.rate, 1.02); assert.deepEqual(f.rates, [1.02]);
  assert.equal(f.tick(3500, 0.01), 'stable'); assert.deepEqual(f.rates, [1.02, 1]);
});
test('unconfirmed/late rate cancels and cannot remain off-normal', () => {
  const f = fixture([1, 1.02], false);
  for (let t = 0; t <= 2400; t += 100) f.tick(t, 0.2);
  assert.equal(f.c.pendingRate, null); assert.equal(f.rates.at(-1), 1);
  f.rate = 1.02; f.c.handlePlaybackRateChange({ data: 1.02 });
  assert.equal(f.rates.at(-1), 1);
});
test('buffering, hidden and missing ticks clear persistence and restore rate', () => {
  const f = fixture([1, 1.02]);
  for (let t = 0; t <= 1800; t += 100) f.tick(t, 0.2);
  document.visibilityState = 'hidden'; assert.equal(f.tick(1900, 2), 'background'); assert.equal(f.rate, 1);
  document.visibilityState = 'visible'; f.tick(50000, 2); assert.equal(f.seeks.length, 0);
  for (let t = 50100; t <= 53000; t += 100) f.tick(t, 2);
  assert.equal(f.seeks.length, 1);
  const b = fixture(); b.tick(0, 2); b.c.setBuffering(true); b.tick(500, 2);
  b.c.setBuffering(false); b.tick(600, 2); assert.equal(b.seeks.length, 0);
});
test('revision change clears evidence; old revisions ignored; Host authoritative', () => {
  const f = fixture(); f.c.lastAppliedRevision = 1;
  for (let t = 0; t <= 300; t += 100) f.tick(t, 1);
  now = 400; f.c.apply({ ...state, revision: 2 }, 11); assert.equal(f.seeks.length, 0);
  assert.equal(f.c.apply(state, 40), 'stale-state');
  now = 500; assert.equal(f.c.apply({ ...state, revision: 2 }, 40, false, null, 0, { isHost: true }), 'host-reference');
  assert.equal(f.seeks.length, 0);
  assert.equal(f.c.apply({ ...state, revision: 3 }, 40, false, 'SEEK'), 'control-seek');
  assert.equal(f.seeks.length, 1); assert.equal(f.tick(600, 5), 'settling');
});
test('without fine speeds: small drift no seek; a failing repair backs off', () => {
  const f = fixture(); f.c.setSyncProfile('balanced');
  for (let t = 0; t <= 30000; t += 100) {
    now = t;
    f.c.apply(state, 10.15, false, null, 20, { precisionSync: false });
  }
  assert.equal(f.seeks.length, 0);
  const g = fixture(); g.c.setSyncProfile('balanced');
  for (let t = 0; t <= 30000; t += 100) {
    now = t;
    g.c.apply(state, 40, false, null, 20, { precisionSync: false });
  }
  // The player never moves in this double, so each repair "fails": 8s, 16s gaps.
  assert.deepEqual(g.seeks.map(s => s.at), [1000, 9000, 25000]);
  now = 30100;
  assert.equal(
    g.c.apply({ ...state, revision: 2 }, 40, false, 'SEEK', 0, { precisionSync: false }),
    'control-seek',
  );
  assert.equal(g.seeks.length, 4);
});
test('repeated repairs back off exponentially instead of looping every few seconds', () => {
  const f = fixture();
  for (let t = 0; t <= 60000; t += 100) f.tick(t, 0.5);
  const gaps = f.seeks.map((s, i, all) => i ? s.at - all[i - 1].at : 0).slice(1);
  assert.deepEqual(gaps, [6000, 12000, 24000]);
});
test('seek lead learns YouTube re-buffer time so the next repair lands closer', () => {
  const f = fixture();
  for (let t = 0; t <= 1800; t += 100) f.tick(t, 0.5);
  assert.equal(f.seeks.length, 1);
  assert.equal(f.seeks[0].time, 10.5);
  f.tick(3400, 0.5); // still 0.5s behind after settling: learn ~0.35s lead
  assert.ok(Math.abs(f.c.seekLeadS - 0.35) < 1e-9);
  for (let t = 3500; t <= 7800; t += 100) f.tick(t, 0.5);
  assert.ok(Math.abs(f.seeks[1].time - 10.85) < 1e-9);
});
test('without fine speeds, balanced ignores 0.3s but seeks a lasting 0.6s within 2.5s', () => {
  const f = fixture(); f.c.setSyncProfile('balanced');
  for (let t = 0; t <= 30000; t += 100) f.tick(t, 0.3);
  assert.equal(f.seeks.length, 0);
  for (let t = 30100; t <= 32700; t += 100) f.tick(t, 0.6);
  assert.equal(f.seeks.length, 1);
});
test('a repair that lands clears backoff so the player stays tight', () => {
  const f = fixture(); f.c.setSyncProfile('balanced');
  for (let t = 0; t <= 1000; t += 100) f.tick(t, 2);
  assert.equal(f.seeks.length, 1);
  f.tick(2600, 0.05); // settled and on time
  assert.deepEqual(f.c.autoSeekTimes, []);
});
test('a viewer that starts late aligns once right after playback begins', () => {
  const f = fixture(); f.c.setSyncProfile('balanced');
  f.state = YT.PlayerState.PAUSED; now = 0;
  assert.equal(f.c.apply({ ...state, revision: 3 }, 10), 'awaiting-play');
  f.state = YT.PlayerState.PLAYING;
  assert.equal(f.tick(100, 0.9), 'start-align-wait');
  assert.equal(f.tick(800, 0.9), 'start-align');
  assert.equal(f.seeks.length, 1); assert.equal(f.seeks[0].time, 10.9);
  assert.deepEqual(f.c.autoSeekTimes, []);
});
test('reconnect bootstrap keeps playing when already close, seeks when far', () => {
  const f = fixture();
  now = 0;
  assert.equal(f.c.apply({ ...state, revision: 5 }, 10.3, true), 'bootstrap-kept');
  assert.equal(f.seeks.length, 0);
  now = 100;
  assert.equal(f.c.apply({ ...state, revision: 6 }, 14, true), 'bootstrap');
  assert.equal(f.seeks.length, 1);
  f.state = YT.PlayerState.PAUSED;
  now = 200;
  assert.equal(f.c.apply({ ...state, revision: 7 }, 20, true), 'bootstrap');
  assert.equal(f.seeks.length, 2);
});
test('a viewer that finishes slightly early waits instead of restarting the clip', () => {
  const f = fixture(); let plays = 0;
  f.c.player.playVideo = () => { plays += 1; };
  f.state = YT.PlayerState.ENDED;
  now = 0;
  assert.equal(f.c.apply({ ...state, revision: 2 }, 10), 'ended-wait');
  assert.equal(plays, 0);
});
test('confirmed direct Host link enables precision repair', () => {
  const f = fixture();
  for (let t = 0; t <= 400; t += 100) {
    now = t;
    f.c.apply(state, 11, false, null, 0, { precisionSync: true });
  }
  assert.equal(f.seeks.length, 1);
  const peers = new window.PeerSync();
  peers.connections.set('host', { channel: { readyState: 'open' } });
  assert.equal(peers.isConnected('host'), true);
  assert.equal(peers.isConnected('viewer'), false);
});
test('background stalls are not reported as Host user seeks', () => {
  const f = fixture(); assert.equal(f.c.detectUserSeek(), null);
  now = 30000; f.time = 11; assert.equal(f.c.detectUserSeek(), null);
  now = 30100; f.time = 20; assert.equal(f.c.detectUserSeek(), 20);
});
test('clock NTP offset, work subtraction, invalid timestamps and stale holdover', () => {
  const c = new window.SyncClock();
  now = 140; const m = c.measure(100, 1110, 1130, 140);
  assert.equal(m.offset, 1000); assert.equal(m.rtt, 20); assert.equal(m.at, 140);
  assert.equal(c.update([m]), true); assert.equal(c.serverNow(200), 1200);
  assert.equal(c.measure(10, 1, 30, 20), null);
  assert.equal(c.measure(10, 2, 1, 20), null);
  assert.equal(c.measure(10, null, 1, 20), null);
  assert.equal(c.update([{ ...m, at: 200 }]), false);
  now = 30200; assert.equal(c.uncertainty, Infinity); assert.equal(c.update([m]), false);
});
test('clock dispersion and slew residual are included in uncertainty', () => {
  const c = new window.SyncClock(); now = 1000;
  c.update([{ rtt: 20, offset: 1000, uncertainty: 10 }]);
  now = 1100; c.update([{ rtt: 10, offset: 1100, uncertainty: 5 }], 1);
  assert.equal(c.offset, 1001); assert.ok(c.uncertainty >= 104);
  c.reset(); assert.equal(c.ready, false); assert.equal(c.uncertainty, Infinity);
});
const sample = { video_id: 'video', revision: 1, observed_server_ms: 1000,
  received_server_ms: 1040, media_time_s: 10, is_playing: true, buffering: false,
  playback_rate: 1, uncertainty_ms: 10 };
test('Host projection uses observation age and both clock errors', () => {
  const p = window.projectHostSample(sample, state, 1100, 15);
  assert.equal(p.expectedTime, 10.1); assert.equal(p.uncertaintyMs, 45);
  assert.equal(window.projectHostSample({ ...sample, observed_server_ms: 1120 }, state, 1100, 15).expectedTime, 10);
});
test('reject stale/future/buffering/wrong revision/video/rate/type/receipt', () => {
  for (const change of [{ revision: 2 }, { video_id: 'other' }, { buffering: true }, { is_playing: false },
    { playback_rate: 0 }, { media_time_s: null }, { uncertainty_ms: -1 }, { revision: '1' },
    { observed_server_ms: 1300 }, { observed_server_ms: 0 }, { received_server_ms: 400 }]) {
    assert.equal(window.projectHostSample({ ...sample, ...change }, state, 1100, 15), null, JSON.stringify(change));
  }
  assert.equal(window.projectHostSample(sample, state, 1100, 15, 0, 700), null);
  assert.equal(window.projectHostSample(sample, state, 1100, Infinity), null);
});
test('future packets do not poison ordering and higher revision resets ordering', () => {
  const peers = new window.PeerConsensus();
  assert.equal(peers.update('host', { ...sample, observed_server_ms: 900000 }, 1100), false);
  assert.equal(peers.update('host', sample, 1100), true);
  assert.equal(peers.update('host', { ...sample, observed_server_ms: 999 }, 1100), false);
  assert.equal(peers.update('host', { ...sample, revision: 2, observed_server_ms: 999 }, 1100), true);
  assert.equal(peers.update('host', { ...sample, observed_server_ms: 1100 }, 1100), false);
});
// Closed-loop model: the player advances at its playback rate, the Host at 1x.
function simulate(f, startDrift, ms, uncertainty = 20) {
  let expected = f.time + startDrift; const drifts = [];
  for (let t = 0; t <= ms; t += 100) {
    if (t) { expected += 0.1; f.time += 0.1 * f.rate; }
    now = t; f.c.correctDrift(expected, now, uncertainty);
    drifts.push(expected - f.time);
  }
  return drifts;
}
test('fine speed nudge closes 0.3s with no seek and settles within 50ms', () => {
  for (const direction of [1, -1]) {
    const f = fixture([0.75, 1, 1.25], true, true); f.c.setSyncProfile('balanced');
    const drifts = simulate(f, direction * 0.3, 20000);
    assert.equal(f.seeks.length, 0);
    assert.ok(Math.abs(drifts.at(-1)) <= 0.05, String(drifts.at(-1)));
    assert.equal(f.rates[0], direction > 0 ? 1.05 : 0.95);
    assert.ok(f.rates.length <= 4, JSON.stringify(f.rates)); // one nudge, one release
    assert.equal(f.rate, 1);
  }
});
test('a 1s gap uses 1.1x rather than a seek; a 3s gap seeks once', () => {
  const f = fixture([0.75, 1, 1.25], true, true); f.c.setSyncProfile('balanced');
  const drifts = simulate(f, 1, 30000);
  assert.equal(f.seeks.length, 0); assert.equal(f.rates[0], 1.1);
  assert.ok(Math.abs(drifts.at(-1)) <= 0.05);
  const g = fixture([0.75, 1, 1.25], true, true); g.c.setSyncProfile('balanced');
  simulate(g, 3, 3000);
  assert.equal(g.seeks.length, 1);
});
test('drift inside 70ms (or the clock error) is never touched', () => {
  const f = fixture([0.75, 1, 1.25], true, true); f.c.setSyncProfile('balanced');
  for (let t = 0; t <= 30000; t += 100) f.tick(t, (t % 400 ? 0.06 : -0.06), 20);
  assert.equal(f.rates.length, 0); assert.equal(f.seeks.length, 0);
  const u = fixture([0.75, 1, 1.25], true, true); u.c.setSyncProfile('balanced');
  for (let t = 0; t <= 30000; t += 100) u.tick(t, 0.12, 100); // ±100ms clock: 150ms floor
  assert.equal(u.rates.length, 0);
});
test('a player that refuses unlisted speeds falls back to seeks', () => {
  const f = fixture([0.75, 1, 1.25], false, true); f.c.setSyncProfile('balanced');
  for (let t = 0; t <= 30000; t += 100) f.tick(t, 0.3, 20);
  assert.equal(f.c.fineRatesSupported, false);
  assert.deepEqual(f.rates.filter(r => r !== 1), [1.05, 1.05]);
  for (let t = 30100; t <= 34000; t += 100) f.tick(t, 0.6, 20);
  assert.equal(f.seeks.length, 1);
});
test('a small start gap is nudged; a large one is seeked once', () => {
  for (const [gap, seeks] of [[0.3, 0], [0.9, 1]]) {
    const f = fixture([0.75, 1, 1.25], true, true); f.c.setSyncProfile('balanced');
    f.state = YT.PlayerState.PAUSED; now = 0;
    f.c.apply({ ...state, revision: 3 }, 10);
    f.state = YT.PlayerState.PLAYING;
    for (let t = 100; t <= 900; t += 100) f.tick(t, gap, 20);
    assert.equal(f.seeks.length, seeks, `gap ${gap}`);
  }
});
console.log(`${count} deterministic sync tests passed`);
