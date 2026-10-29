// Run: PLAYWRIGHT_MODULE=/path/to/playwright node tests/test_ui_smoke.cjs
// Uses an existing server; creates one disposable empty room, never restarts it.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.WATCHPARTY_URL || 'http://127.0.0.1:3055';
(async () => {
  const browser = await chromium.launch({headless:true, executablePath:process.env.CHROMIUM_PATH,
    args:['--no-sandbox']});
  try {
    const context = await browser.newContext({viewport:{width:390,height:844}});
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(base);
    await page.locator('#room-code').fill('12');
    await page.locator('#join-form button').click();
    assert.match(await page.locator('#join-message').textContent(), /3/);
    for (const width of [320,390,1280]) {
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `home overflow ${width}`);
    }
    await page.screenshot({path:'/tmp/watchparty-home-desktop.png',fullPage:true});
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'/tmp/watchparty-home-mobile.png',fullPage:true});
    await page.locator('form[action="/rooms"] button').click();
    await page.waitForURL(/\/room\/\d{3}/);
    await page.waitForFunction(() => document.querySelector('#role-status')?.textContent.includes('Host'));
    await page.locator('#video-url').waitFor({state:'visible'});
    assert.ok(await page.locator('#follow-volume-wrap').isHidden());
    assert.equal(await page.locator('details').getAttribute('open'), null);
    await page.locator('summary').focus();
    await page.keyboard.press('Space');
    assert.notEqual(await page.locator('details').getAttribute('open'), null);
    await page.locator('summary').click();
    await page.locator('#show-qr-button').click();
    assert.ok(await page.locator('#qr-dialog').isVisible());
    const invite = await page.locator('#qr-viewer-link').getAttribute('href');
    assert.equal(new URL(invite).hash, '');
    assert.equal(new URL(invite).search, '');
    await page.keyboard.press('Escape');
    assert.ok(await page.locator('#qr-dialog').isHidden());
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async () => {throw new Error('denied');}}}));
    await page.locator('#share-button').click();
    assert.ok(await page.locator('#share-fallback').isVisible());
    assert.equal(await page.locator('#invite-url').inputValue(), invite);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text => {window.copiedInvite = text;}}}));
    await page.locator('#share-button').click();
    await page.locator('#share-button').click();
    assert.equal(await page.evaluate(() => window.copiedInvite), invite);
    await page.waitForTimeout(4200);
    assert.match(await page.locator('#share-button').textContent(), /เชิญเพื่อน/);
    for (const width of [320,390,1280]) {
      await page.setViewportSize({width,height:844});
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `host overflow ${width}`);
    }
    await page.screenshot({path:'/tmp/watchparty-host-desktop.png',fullPage:true});
    const viewerContext = await browser.newContext({viewport:{width:390,height:844}});
    const viewer = await viewerContext.newPage();
    viewer.on('pageerror', e => errors.push(e.message));
    await viewer.goto(invite);
    await viewer.waitForFunction(() => document.querySelector('#role-status')?.textContent === 'ผู้ชม');
    assert.ok(await viewer.locator('#video-form').isHidden());
    assert.ok(await viewer.locator('#follow-volume-wrap').isVisible());
    await viewer.locator('#volume-slider').fill('35');
    assert.equal(await viewer.locator('#volume-value').textContent(), '35%');
    assert.equal(await viewer.locator('#follow-volume').isChecked(), false);
    await viewer.locator('#mute-button').click();
    assert.equal(await viewer.locator('#volume-value').textContent(), '0%');
    await viewer.locator('#mute-button').click();
    assert.equal(await viewer.locator('#volume-value').textContent(), '35%');
    await viewer.locator('#follow-volume').check();
    assert.equal(await viewer.locator('#volume-value').textContent(), '100%');
    for (const width of [320,390,1280]) {
      await viewer.setViewportSize({width,height:844});
      assert.ok(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `viewer overflow ${width}`);
    }
    await viewer.setViewportSize({width:390,height:844});
    await viewer.screenshot({path:'/tmp/watchparty-viewer-mobile.png',fullPage:true});
    await viewerContext.setOffline(true);
    await viewer.locator('#connection-help').waitFor({state:'visible',timeout:20000});
    assert.ok(await viewer.locator('#reload-room').isVisible());
    await viewerContext.setOffline(false);
    await viewer.locator('#connection-help').waitFor({state:'hidden',timeout:20000});
    assert.deepEqual(errors, []);
    console.log('PASS: Thai join validation; Host/viewer UI; keyboard diagnostics; QR; copy success/fallback/repeated clicks; local mute/volume/follow; reconnect guidance; no horizontal overflow at 320/390/1280; no page errors. Screenshots: /tmp/watchparty-{home-desktop,home-mobile,host-desktop,viewer-mobile}.png');
    await viewerContext.close();
    await context.close();
  } finally { await browser.close(); }
})().catch(e => {console.error(e.message); process.exitCode=1;});
