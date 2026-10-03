'use strict';
/* Boot sequence, airport switching and the frame loop. */

let last = performance.now(), uiAccum = 0, saveAccum = 0, rendererReady = false;

function saveView() { portfolio.views[portfolio.active] = {camera: {...camera}, cameraTouched}; }

function restoreView(v) {
  const c = v?.camera;
  cameraTouched = !!v?.cameraTouched;
  if (cameraTouched && c && ['x', 'z', 'az', 'elev', 'dist'].every(key => Number.isFinite(c[key]))) {
    Object.assign(camera, {x: c.x, z: c.z, az: c.az, elev: clamp(c.elev, .3, 1.42), dist: clamp(c.dist, 12, 145)});
  } else center();
}

// Resets transient UI state whenever the active airport object is replaced (load, import, switch, reset).
function afterAirportChange() {
  draft = null;
  selected = null;
  hover = null;
  tool = 'inspect';
  worldDirty = true;
  topologyDirty = true;
  bIndexDirty = true;
  document.body.dataset.location = G.location;
  resetRenderKeys();
  restoreView(portfolio.views[portfolio.active]);
  syncSpeed();
  updateDraftUI();
}

function switchAirport(id) {
  if (!portfolio.unlocked.includes(id) || !LOCATIONS.some(l => l.id === id) || id === portfolio.active) return;
  saveView();
  portfolio.airports[portfolio.active] = G;
  G = portfolio.airports[id] || fresh(id, 30000 * perk('capital'));
  portfolio.airports[id] = G;
  portfolio.active = id;
  afterAirportChange();
  setSection('overview');
  if (isCompact()) closePanels();
  safeSave(true);
  toast('Открыт аэропорт: ' + place(id).name, 'ok');
}

hooks.structure = () => { worldDirty = true; };
hooks.toast = (text, kind) => toast(text, kind);
hooks.achievement = a => { toast(a.icon + ' Достижение «' + a.title + '»' + (a.cash ? ' · ' + signedCash(a.cash) : ''), 'gold'); vibrate(20); };
hooks.rankUp = r => toast('★ Ранг ' + r + ': ' + rankTitle(r) + ' · +1 очко развития', 'gold');
hooks.decision = def => toast(def.icon + ' ' + def.title + ': нужно ваше решение', 'info');
hooks.completed = next => toast(next ? 'Аэропорт развит на 100%! Открыт «' + next.name + '»' : 'Коллекция аэропортов завершена!', 'gold');

function frame(now) {
  const elapsed = Math.min((now - last) / 1000, .12);
  last = now;
  // Dialogs pause the airport so nothing happens behind them.
  const gameDt = speed && $('modal').hidden ? elapsed * MINUTES_PER_SECOND * speed : 0;
  if (gameDt) advance(gameDt);
  uiAccum += elapsed;
  saveAccum += elapsed;
  if (uiAccum > .34) { renderUI(); uiAccum = 0; }
  if (saveAccum > 8) { safeSave(true); saveAccum = 0; }
  if (rendererReady) render(now, gameDt);
  requestAnimationFrame(frame);
}

async function boot() {
  portfolio = freshPortfolio();
  G = portfolio.airports.main;
  try { rendererReady = initRenderer(); } catch (e) { console.error(e); rendererReady = false; }
  if (!rendererReady) { $('glError').hidden = false; $('status').textContent = 'Для 3D нужен браузер с WebGL'; }
  initInput();
  document.body.dataset.location = G.location;
  resize();
  center();
  const loaded = await restoreLatest(false);
  syncSpeed();
  renderUI();
  last = performance.now();
  requestAnimationFrame(frame);

  if ('ResizeObserver' in window) new ResizeObserver(() => resize()).observe($('stage'));
  window.addEventListener('resize', () => { resize(); if (!isCompact()) { document.body.classList.remove('sheetOpen'); } renderTop(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) safeSave(true); last = performance.now(); });
  window.addEventListener('pagehide', () => safeSave(true));

  if (!loaded && !portfolio.seenIntro) {
    await showIntro();
    portfolio.seenIntro = true;
    safeSave(true);
  } else if (portfolio.seenVersion < SAVE_VERSION) {
    await showWhatsNew();
    portfolio.seenVersion = SAVE_VERSION;
    safeSave(true);
  }
}

boot();
