// Real browser + public WebSocket smoke. No player mocks or printed host tokens.
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
(async () => {
  const base = process.env.WATCHPARTY_TEST_URL || 'http://127.0.0.1:8000';
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || undefined, headless: true, args: ['--no-sandbox']});
  const errors = [];
  try {
    const hc = await browser.newContext({viewport:{width:1440,height:1000}});
    const vc = await browser.newContext({viewport:{width:390,height:844}});
    const host = await hc.newPage(), viewer = await vc.newPage();
    const samples = {host:[], viewer:[]};
    for (const [name,p] of [['host',host],['viewer',viewer]]) {
      p.on('pageerror', e => errors.push(e.message));
      p.on('websocket', ws => ws.on('framesent', ({payload}) => {
        try { const m = JSON.parse(String(payload)); if(m.type === 'CLIENT_SAMPLE') samples[name].push(m); } catch {}
      }));
    }
    const created = await hc.request.post(`${base}/rooms`, {maxRedirects:0});
    assert.equal(created.status(),303);
    const privateLocation = created.headers().location;
    const roomPath = privateLocation.split('#')[0];
    await host.goto(base + privateLocation);
    await viewer.goto(base + roomPath);
    await host.waitForFunction(() => /Host|เจ้าของ|หัวห้อง/.test(document.querySelector('#role-status').textContent));
    await viewer.waitForFunction(() => /Viewer|ผู้ชม|สมาชิก/.test(document.querySelector('#role-status').textContent));
    for (const [name,p] of [['host',host],['viewer',viewer]]) {
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1),false, name+' horizontal overflow');
      await p.locator('#show-qr-button').click();
      await p.locator('#qr-dialog').waitFor({state:'visible'});
      assert.ok(!(await p.locator('#qr-viewer-link').getAttribute('href')).includes('host='));
      await p.locator('#close-qr-button').click();
    }
    await host.locator('#volume-slider').fill('37');
    await host.locator('#volume-slider').dispatchEvent('change');
    await viewer.waitForFunction(() => document.querySelector('#volume-slider').value === '37');
    await viewer.locator('#volume-slider').fill('19');
    await viewer.locator('#volume-slider').dispatchEvent('change');
    assert.equal(await host.locator('#volume-slider').inputValue(),'37');
    await host.locator('#video-url').fill('https://www.youtube.com/watch?v=' + (process.env.TEST_VIDEO_ID || 'aqz-KE-bpKQ'));
    await host.locator('#video-form').evaluate(f=>f.requestSubmit());
    await viewer.waitForFunction(() => !!document.querySelector('#player-poster').getAttribute('src'));
    await host.waitForTimeout(12000);
    for (const p of [host,viewer]) {
      for (const selector of ['#muted-playback','#player-cover-play']) {
        if (await p.locator(selector).isVisible()) { await p.locator(selector).click(); break; }
      }
    }
    await host.waitForTimeout(20000);
    const playbackEvidence = Object.fromEntries(Object.entries(samples).map(([name,items]) => [name,{samples:items.length,playing:items.filter(s=>s.is_playing && !s.buffering).length,last:items.slice(-1)}]));
    const phaseErrors = samples.viewer.filter(v=>v.is_playing && !v.buffering).flatMap(v=>{
      const h = samples.host.filter(h=>h.is_playing && !h.buffering && Math.abs(h.observed_server_ms-v.observed_server_ms)<500).sort((a,b)=>Math.abs(a.observed_server_ms-v.observed_server_ms)-Math.abs(b.observed_server_ms-v.observed_server_ms))[0];
      return h ? [Math.abs(v.media_time_s-(h.media_time_s+(v.observed_server_ms-h.observed_server_ms)/1000))] : [];
    }).sort((a,b)=>a-b);
    playbackEvidence.observedPhase = {pairs:phaseErrors.length,medianMs:phaseErrors.length?Math.round(1000*phaseErrors[Math.floor(phaseErrors.length*.5)]):null,p95Ms:phaseErrors.length?Math.round(1000*phaseErrors[Math.floor(phaseErrors.length*.95)]):null,note:'Short same-machine browser probe; includes startup, clock uncertainty and iframe buffering. Not an across-device guarantee.'};
    const snapshots = [];
    for (const [name,p] of [['host',host],['viewer',viewer]]) {
      const ready = p.locator('#muted-playback');
      if (await ready.isVisible()) await ready.click();
      snapshots.push({name, ...await p.evaluate(() => ({connection: document.querySelector('#connection-status').textContent, role:document.querySelector('#role-status').textContent, sync:document.querySelector('#sync-status').textContent, error:document.querySelector('#error-message').textContent, cover:document.querySelector('#player-cover-message').textContent, iframe:!!document.querySelector('iframe'), overflow:document.documentElement.scrollWidth>innerWidth+1}))});
    }
    assert.deepEqual(errors,[]);
    if (process.env.REQUIRE_PLAYBACK === '1') {
      assert.ok(playbackEvidence.host.playing >= 5, 'real Host playback samples missing');
      assert.ok(playbackEvidence.viewer.playing >= 5, 'real viewer playback samples missing');
      assert.ok(phaseErrors.length >= 5, 'not enough aligned real playback samples');
    }
    const result = {passed:'public room creation, real host/viewer WebSockets, room volume + local override, QR safe invite, desktop/mobile overflow, video propagation, no page exceptions',snapshots,playbackEvidence};
    if (process.env.SMOKE_REPORT) require('node:fs').writeFileSync(process.env.SMOKE_REPORT,JSON.stringify(result,null,2));
    console.log(JSON.stringify(result,null,2));
  } finally { await browser.close(); }
})().catch(e=>{ console.error(e.message.replace(/#host=[^\s]+/g,'#host=[REDACTED]')); process.exit(1); });
