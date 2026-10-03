'use strict';
// Browser smoke test: drives the real page with Playwright and fails on any console error.
// Usage: node tests/e2e.js [--shots <dir>]
const path = require('path');
const assert = require('assert/strict');

function loadPlaywright() {
  for (const id of ['playwright', '/opt/node22/lib/node_modules/playwright']) { try { return require(id); } catch (e) {} }
  throw Error('Playwright не найден: npm i -D playwright');
}
const {chromium} = loadPlaywright();
const URL = 'file://' + path.join(__dirname, '..', 'index.html');
const shotsDir = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
const ARGS = ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];

async function openGame(browser, viewport, mobile) {
  const ctx = await browser.newContext({viewport, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile});
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => typeof G !== 'undefined' && G && !document.getElementById('modal').hidden);
  await page.click('#modalButtons .accent');
  return {ctx, page, errors};
}

// Screen position of the centre of a map cell, found by sampling the canvas through the game's own picking.
async function cellPoint(page, x, y) {
  const p = await page.evaluate(([cx, cy]) => {
    const r = canvas.getBoundingClientRect();
    let best = null;
    for (let sy = r.top + 4; sy < r.bottom - 4; sy += 3) for (let sx = r.left + 4; sx < r.right - 4; sx += 3) {
      const c = screenCell({clientX: sx, clientY: sy});
      if (c.x === cx && c.y === cy) {
        const el = document.elementFromPoint(sx, sy);
        if (el !== canvas) continue;
        if (!best) best = {sx, sy, n: 0, tx: 0, ty: 0};
        best.tx += sx; best.ty += sy; best.n++;
      }
    }
    return best && {x: best.tx / best.n, y: best.ty / best.n};
  }, [x, y]);
  assert.ok(p, 'cell ' + x + ',' + y + ' is not visible');
  return p;
}

async function tapCell(page, x, y) {
  const p = await cellPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}

async function desktopFlow(browser) {
  const {ctx, page, errors} = await openGame(browser, {width: 1440, height: 900}, false);
  const state = expr => page.evaluate(expr);

  // Contracts tab: sign the regional airline.
  await page.click('#rightNav [data-section=contracts]');
  await page.click('[data-accept-contract=local]');
  assert.equal(await state('G.contracts.length'), 1);
  assert.equal(await state('!!portfolio.achievements.first_contract'), true);

  // Build a rotated terminal: pick tool, tap the map, rotate, confirm.
  await page.click('#tools [data-tool=terminal]');
  await tapCell(page, 40, 20);
  await page.waitForSelector('#buildConfirm:not([hidden])');
  await page.click('#rotateBuild');
  assert.equal(await state('draft.rot'), 1);
  const before = await state('G.buildings.length');
  await page.click('#confirmBuild');
  assert.equal(await state('G.buildings.length'), before + 1);
  assert.equal(await state(`G.buildings[G.buildings.length - 1].type + ':' + G.buildings[G.buildings.length - 1].w`), 'terminal:3');

  // Draw a taxiway in two strokes: both strokes extend the same draft.
  await page.click('#tools [data-tool=taxi]');
  const a = await cellPoint(page, 36, 8), b = await cellPoint(page, 40, 8);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, {steps: 12}); await page.mouse.up();
  const firstStroke = await state('draft.tiles.length');
  assert.ok(firstStroke >= 4, 'first stroke tiles ' + firstStroke);
  const c = await cellPoint(page, 40, 10), d = await cellPoint(page, 40, 12);
  await page.mouse.move(c.x, c.y); await page.mouse.down(); await page.mouse.move(d.x, d.y, {steps: 8}); await page.mouse.up();
  assert.ok(await state('draft.tiles.length') > firstStroke, 'second stroke extends the draft');
  const taxis = await state(`count('taxi')`);
  await page.keyboard.press('Enter');
  assert.ok(await state(`count('taxi')`) > taxis);

  // Demolition needs confirmation and refunds money.
  await page.click('#modeControls [data-tool=bulldoze]');
  await tapCell(page, 36, 8);
  await page.waitForSelector('#buildConfirm:not([hidden])');
  assert.equal(await state(`draft.mode`), 'demolish');
  const money = await state('G.money');
  await page.click('#confirmBuild');
  assert.ok(await state('G.money') > money, 'refund paid');
  assert.equal(await state('at(36, 8)'), null);

  // Inspect and upgrade the service building.
  await page.click('#modeControls [data-tool=inspect]');
  await tapCell(page, 35, 20);
  await page.waitForSelector('[data-upgrade]');
  await page.click('[data-upgrade]');
  assert.equal(await state(`at(35, 20).level`), 2);

  // Finance: fee policy and a loan.
  await page.click('#rightNav [data-section=finance]');
  await page.click('[data-fee=high]');
  assert.equal(await state('G.feePolicy'), 'high');
  await page.click('[data-loan=take]');
  assert.equal(await state('G.loan'), 25000);

  // Progression tab renders perks and achievements.
  await page.click('#rightNav [data-section=growth]');
  assert.ok(await page.locator('.perkCard').count() >= 9);
  assert.ok(await page.locator('.ach.done').count() >= 1);

  // Run the airport fast for a while and make sure it keeps flying.
  await page.click('[data-speed="10"]');
  await page.waitForTimeout(12000);
  assert.ok(await state('G.served') >= 3, 'served ' + await state('G.served'));
  // Regression: interactive buttons must survive UI refreshes while the airport is running,
  // otherwise a click that spans a refresh is lost (the original bug with the upgrade button).
  const stable = async (section, selectors) => {
    await page.evaluate(([sec]) => { selected = at(35, 20).id; setSection(sec); renderUI(); }, [section]);
    await page.evaluate(sels => { window.__probe = sels.map(sel => document.querySelector(sel)); }, selectors);
    assert.ok(await page.evaluate(() => window.__probe.every(Boolean)), 'probe elements exist in ' + section);
    await page.waitForTimeout(3000);
    const alive = await page.evaluate(() => window.__probe.map(el => el.isConnected));
    assert.deepEqual(alive, selectors.map(() => true), 'buttons were re-rendered in ' + section + ': ' + selectors.join(', '));
  };
  await stable('overview', ['[data-upgrade]', '[data-demolish]', '[data-bulk=taxi]', '#tools [data-tool=gate]']);
  await stable('contracts', ['[data-cancel-contract=local]', '[data-accept-contract=swift]']);
  await stable('finance', ['[data-fee=low]', '[data-loan=repay]']);
  await stable('growth', ['[data-perk=build]']);
  await page.click('#rightNav [data-section=finance]');
  if (shotsDir) await page.screenshot({path: path.join(shotsDir, 'e2e-desktop-finance.png')});
  await page.click('#rightNav [data-section=overview]');
  if (shotsDir) await page.screenshot({path: path.join(shotsDir, 'e2e-desktop.png')});

  // Menu: save, then reload the page and restore everything.
  await page.click('#menuBtn');
  await page.click('[data-menu=save]');
  await page.click('#modalButtons button');
  const served = await state('G.served');
  await page.reload();
  await page.waitForFunction(() => typeof G !== 'undefined' && G && G.served > 0);
  assert.ok(await state('G.served') >= served);
  assert.equal(await state('G.feePolicy'), 'high');
  assert.equal(await state('G.contracts.length'), 1);

  assert.deepEqual(errors, []);
  await ctx.close();
}

async function mobileFlow(browser) {
  const {ctx, page, errors} = await openGame(browser, {width: 390, height: 844}, true);
  const state = expr => page.evaluate(expr);
  await page.click('#tabBuild');
  assert.equal(await state(`document.getElementById('left').classList.contains('open')`), true);
  await page.click('#tools [data-tool=gate]');
  assert.equal(await state(`document.getElementById('left').classList.contains('open')`), false, 'sheet closes after picking a tool');
  await page.waitForFunction(() => getComputedStyle(document.getElementById('left')).visibility === 'hidden');
  const p = await cellPoint(page, 30, 20);
  await page.touchscreen.tap(p.x, p.y);
  await page.waitForSelector('#buildConfirm:not([hidden])');
  assert.match(await page.textContent('#buildHint'), /терминал|Перетащите|рулёжку/);
  await page.tap('#cancelBuild');
  assert.equal(await state('draft'), null);
  await page.tap('#tabInfo');
  await page.tap('#rightNav [data-section=growth]');
  await page.tap('[data-close]:visible');
  assert.equal(await state(`document.body.classList.contains('sheetOpen')`), false);
  if (shotsDir) await page.screenshot({path: path.join(shotsDir, 'e2e-phone.png')});
  assert.deepEqual(errors, []);
  await ctx.close();
}

async function migrationFlow(browser) {
  // A save written by the previous version must load, migrate and keep playing.
  const fs = require('fs');
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures/v2-save.json'), 'utf8');
  const ctx = await browser.newContext({viewport: {width: 1280, height: 800}});
  await ctx.addInitScript(save => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('skyline-airport-collection-v2', save); sessionStorage.setItem('seeded', '1'); } }, raw);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(URL);
  await page.waitForFunction(() => typeof G !== 'undefined' && G && G.served >= 8 && !document.getElementById('modal').hidden);
  assert.match(await page.textContent('#modalTitle'), /Обновление/);
  await page.click('#modalButtons .accent');
  assert.ok(await page.evaluate('portfolio.xp') > 0);
  assert.equal(await page.evaluate('portfolio.seenVersion'), 3);
  await page.waitForTimeout(2000);
  assert.deepEqual(errors, []);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({args: ARGS});
  try {
    await desktopFlow(browser);
    console.log('ok desktop flow');
    await mobileFlow(browser);
    console.log('ok mobile flow');
    await migrationFlow(browser);
    console.log('ok migration flow');
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exit(1); });
