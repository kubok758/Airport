'use strict';
/* Pointer, touch and keyboard input plus the build/demolish drafts they edit. */

// ---------- drafts ----------

function draftFootprint(d = draft) {
  const s = dims(d.type, d.rot);
  return {x: d.x, y: d.y, w: s.w, h: s.h};
}

function placementHint(d) {
  const f = draftFootprint(d);
  if (d.type === 'gate' && !terminalsNear(f)) return 'Рядом нет терминала: гейт не будет работать';
  if (d.type === 'shops' && !terminalsNear(f, 9)) return 'Магазины работают только рядом с терминалом';
  const touchesTaxi = [...Array(f.w).keys()].some(i => isTaxi(f.x + i, f.y - 1) || isTaxi(f.x + i, f.y + f.h)) || [...Array(f.h).keys()].some(i => isTaxi(f.x - 1, f.y + i) || isTaxi(f.x + f.w, f.y + i));
  if (['gate', 'cargo'].includes(d.type) && !touchesTaxi) return 'Не забудьте подвести рулёжку к стоянке';
  if (d.type === 'runway' && !touchesTaxi) return 'Подведите рулёжку к углу или торцу полосы';
  return 'Перетащите макет, поверните или подтвердите';
}

function draftAssessment() {
  if (!draft) return null;
  if (draft.mode === 'demolish') {
    const list = draft.ids.map(building).filter(Boolean), refund = list.reduce((s, b) => s + refundValue(b), 0);
    if (!list.length) return {valid: false, cost: 0, message: 'Коснитесь построек, которые нужно снести'};
    const blocked = list.find(b => demolishBlocker(b));
    if (blocked) return {valid: false, cost: refund, message: TYPES[blocked.type].name + ': ' + demolishBlocker(blocked).toLowerCase()};
    return {valid: true, cost: refund, message: list.length === 1 ? TYPES[list[0].type].name + ' · касание по другим постройкам добавит их' : 'Объектов: ' + list.length + ' · проведите по рулёжкам, чтобы добавить'};
  }
  const type = draft.type, tiles = type === 'taxi' ? draft.tiles : [{x: draft.x, y: draft.y}], cost = buildCost(type) * tiles.length;
  if (!buildTool(type)) return {valid: false, cost, message: 'Постройка пока недоступна'};
  if (!tiles.length) return {valid: false, cost, message: 'Проведите по свободным клеткам, чтобы проложить дорожку'};
  if (tiles.some(c => !canPlace(type, c.x, c.y, draft.rot))) return {valid: false, cost, message: 'Место занято или выходит за пределы карты'};
  if (G.money < cost) return {valid: false, cost, message: 'Недостаточно средств: нужно ' + cash(cost)};
  return {valid: true, cost, message: type === 'taxi' ? 'Участков: ' + tiles.length + ' · рисуйте ещё или подтвердите' : placementHint(draft)};
}

function clearDraft() {
  draft = null;
  updateDraftUI();
}

function startDraft(type, c) {
  if (!inside(c)) return false;
  const rot = TYPES[type].rotate ? buildRot : 0;
  if (type === 'taxi') draft = {mode: 'build', type, tiles: [], rot: 0, movePending: false};
  else {
    const s = dims(type, rot);
    draft = {mode: 'build', type, x: clamp(c.x, 0, W - s.w), y: clamp(c.y, 0, H - s.h), rot, movePending: false};
  }
  selected = null;
  if (type === 'taxi') addDraftTaxi(c);
  updateDraftUI();
  return true;
}

function addDraftTaxi(c) {
  if (!draft || draft.type !== 'taxi' || !inside(c) || at(c.x, c.y)) return;
  if (draft.tiles.some(t => t.x === c.x && t.y === c.y)) return;
  draft.tiles.push({x: c.x, y: c.y});
  updateDraftUI();
}

function shiftTiles(base, dx, dy) {
  const minX = Math.min(...base.map(t => t.x)), maxX = Math.max(...base.map(t => t.x)), minY = Math.min(...base.map(t => t.y)), maxY = Math.max(...base.map(t => t.y));
  dx = clamp(dx, -minX, W - 1 - maxX);
  dy = clamp(dy, -minY, H - 1 - maxY);
  return base.map(t => ({x: t.x + dx, y: t.y + dy}));
}

function placeDraft(c) {
  if (!draft || !inside(c) || draft.mode !== 'build') return;
  if (draft.type === 'taxi') {
    if (draft.tiles.length) draft.tiles = shiftTiles(draft.tiles, c.x - draft.tiles[0].x, c.y - draft.tiles[0].y);
  } else {
    const s = dims(draft.type, draft.rot);
    draft.x = clamp(c.x, 0, W - s.w);
    draft.y = clamp(c.y, 0, H - s.h);
  }
  draft.movePending = false;
  updateDraftUI();
}

function draftContains(c) {
  if (!draft || !inside(c)) return false;
  if (draft.mode === 'demolish') return draft.ids.includes(at(c.x, c.y)?.id);
  if (draft.type === 'taxi') return draft.tiles.some(t => t.x === c.x && t.y === c.y);
  const f = draftFootprint();
  return c.x >= f.x && c.x < f.x + f.w && c.y >= f.y && c.y < f.y + f.h;
}

function rotateDraft() {
  if (draft && draft.mode === 'build' && TYPES[draft.type].rotate) {
    const before = draftFootprint();
    draft.rot = draft.rot ? 0 : 1;
    buildRot = draft.rot;
    // Rotate around the footprint centre and keep it on the map.
    const s = dims(draft.type, draft.rot);
    draft.x = clamp(Math.round(before.x + before.w / 2 - s.w / 2), 0, W - s.w);
    draft.y = clamp(Math.round(before.y + before.h / 2 - s.h / 2), 0, H - s.h);
    updateDraftUI();
  } else if (buildTool(tool) && TYPES[tool].rotate) {
    buildRot = buildRot ? 0 : 1;
    toast('Поворот: ' + (buildRot ? '90°' : '0°'));
  }
}

function confirmDraft() {
  const a = draftAssessment();
  if (!a) return;
  if (!a.valid) { toast(a.message, 'warn'); return; }
  const placed = draft;
  if (placed.mode === 'demolish') {
    let refund = 0, removed = 0;
    for (const id of placed.ids) { const b = building(id); if (b) { const r = demolish(b, placed.ids.length > 1); if (r) { refund += r; removed++; } } }
    if (placed.ids.length > 1) log('Снесено объектов: ' + removed + ', возврат ' + cash(refund));
    if (placed.ids.includes(selected)) selected = null;
    toast('Снесено · ' + signedCash(refund), 'ok');
  } else if (placed.type === 'taxi') {
    for (const c of placed.tiles) if (!addBuilding('taxi', c.x, c.y, 0, true)) { toast('Не удалось завершить строительство', 'warn'); break; }
    log('Проложено ' + placed.tiles.length + ' участков рулёжной дорожки (' + cash(a.cost) + ')');
    toast('Рулёжка проложена', 'ok');
  } else {
    const b = addBuilding(placed.type, placed.x, placed.y, placed.rot);
    if (!b) return;
    selected = b.id;
    toast(TYPES[b.type].name + ' построен' + (['parking', 'shops'].includes(b.type) ? 'ы' : ''), 'ok');
  }
  vibrate(15);
  clearDraft();
  renderUI();
  safeSave(true);
}

function startDemolish(b) {
  if (!b) return;
  if (tool !== 'bulldoze') setTool('bulldoze');
  draft = {mode: 'demolish', ids: [b.id]};
  updateDraftUI();
  if (isCompact()) closePanels();
}

function toggleDemolish(b) {
  if (!b) return;
  if (!draft || draft.mode !== 'demolish') { draft = {mode: 'demolish', ids: [b.id]}; updateDraftUI(); return; }
  draft.ids = draft.ids.includes(b.id) ? draft.ids.filter(id => id !== b.id) : [...draft.ids, b.id];
  if (!draft.ids.length) clearDraft();
  else updateDraftUI();
}

function setTool(t) {
  if (TYPES[t] && !typeUnlocked(t)) { toast(TYPES[t].name + ' откроется на ранге ' + TYPES[t].rank, 'warn'); return; }
  if (TYPES[t] && !typeAvailable(t)) return;
  if (t !== tool || draft) clearDraft();
  tool = t;
  hover = null;
  renderTools();
  if (isCompact()) closePanels();
  if (buildTool(t)) {
    if (isCompact()) toast(t === 'taxi' ? 'Проведите по карте, чтобы проложить дорожку' : 'Коснитесь места на карте' + (TYPES[t].rotate ? ' · ⟳ — поворот' : ''));
  } else if (t === 'bulldoze') toast('Коснитесь постройки, чтобы выбрать её для сноса');
}

// ---------- map actions ----------

function actionCell(c) {
  if (!inside(c)) return;
  if (tool === 'inspect') {
    selected = at(c.x, c.y)?.id || null;
    renderUI();
    if (selected) showSelectedDetails();
  }
}

// ---------- camera ----------

function moveCamera(dx, dy) {
  cameraTouched = true;
  view();
  const amount = camera.dist * .0019;
  camera.x = clamp(camera.x - dx * amount * right[0] + dy * amount * up[0], -5, W + 5);
  camera.z = clamp(camera.z - dx * amount * right[2] + dy * amount * up[2], -5, H + 5);
}
function zoom(factor) { cameraTouched = true; camera.dist = clamp(camera.dist * factor, 12, 145); }

const pointers = new Map();
let gesture = null, drag = null, spaceDown = false;

function onPointerDown(e) {
  e.preventDefault();
  // Focus the map so Enter/Space/R act on the scene instead of the last clicked button.
  canvas.focus({preventScroll: true});
  canvas.setPointerCapture?.(e.pointerId);
  pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (pointers.size === 2) {
    // A second finger turns the gesture into pinch/pan and cancels a draft the first finger just created.
    if (drag?.createdDraft) clearDraft();
    const v = [...pointers.values()];
    gesture = {distance: Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y), zoom: camera.dist, mx: (v[0].x + v[1].x) / 2, my: (v[0].y + v[1].y) / 2};
    drag = null;
    return;
  }
  if (pointers.size !== 1) return;
  const c = screenCell(e);
  let mode = tool === 'pan' || e.button === 2 || e.button === 1 || spaceDown ? 'pan' : 'orbit', origin = null, createdDraft = false, target = null;
  if (mode !== 'pan' && inside(c)) {
    if (buildTool(tool)) {
      if (!draft) { startDraft(tool, c); createdDraft = true; mode = tool === 'taxi' ? 'taxi_draw' : 'draft_move'; }
      else if (draft.mode === 'build' && draft.type === 'taxi' && !draft.movePending && !draftContains(c)) { addDraftTaxi(c); mode = 'taxi_draw'; }
      else { if (draft.movePending || !draftContains(c)) placeDraft(c); mode = 'draft_move'; }
      if (draft) origin = draft.type === 'taxi' ? draft.tiles.map(t => ({...t})) : {x: draft.x, y: draft.y};
    } else if (tool === 'bulldoze' && at(c.x, c.y)) {
      mode = 'demolish_paint';
      target = at(c.x, c.y);
    }
  }
  drag = {id: e.pointerId, x: e.clientX, y: e.clientY, lastX: e.clientX, lastY: e.clientY, mode, moved: false, lastCell: c, anchor: c, origin, createdDraft, target};
}

function onPointerMove(e) {
  if (!pointers.has(e.pointerId)) { if (e.pointerType === 'mouse') hover = screenCell(e); return; }
  pointers.set(e.pointerId, {x: e.clientX, y: e.clientY});
  if (gesture && pointers.size >= 2) {
    const v = [...pointers.values()], distance = Math.hypot(v[0].x - v[1].x, v[0].y - v[1].y), mx = (v[0].x + v[1].x) / 2, my = (v[0].y + v[1].y) / 2;
    cameraTouched = true;
    camera.dist = clamp(gesture.zoom * gesture.distance / Math.max(10, distance), 12, 145);
    moveCamera(mx - gesture.mx, my - gesture.my);
    gesture.mx = mx; gesture.my = my;
    return;
  }
  if (!drag || drag.id !== e.pointerId) return;
  const dx = e.clientX - drag.lastX, dy = e.clientY - drag.lastY;
  if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 6) drag.moved = true;
  if (drag.mode === 'pan') moveCamera(dx, dy);
  else if (drag.mode === 'orbit' && drag.moved) { cameraTouched = true; camera.az -= dx * .008; camera.elev = clamp(camera.elev + dy * .006, .30, 1.42); }
  else if (drag.mode === 'taxi_draw' && drag.moved && draft) {
    const c = screenCell(e), a = drag.lastCell;
    if (inside(c) && inside(a)) {
      let x = a.x, y = a.y;
      while (x !== c.x || y !== c.y) {
        if (Math.abs(c.x - x) >= Math.abs(c.y - y)) x += Math.sign(c.x - x); else y += Math.sign(c.y - y);
        addDraftTaxi({x, y});
      }
      drag.lastCell = c;
    } else if (inside(c)) drag.lastCell = c;
  } else if (drag.mode === 'draft_move' && drag.moved && draft) {
    const c = screenCell(e);
    if (inside(c)) {
      const ddx = c.x - drag.anchor.x, ddy = c.y - drag.anchor.y;
      if (draft.type === 'taxi') { if (drag.origin.length) draft.tiles = shiftTiles(drag.origin, ddx, ddy); }
      else { const s = dims(draft.type, draft.rot); draft.x = clamp(drag.origin.x + ddx, 0, W - s.w); draft.y = clamp(drag.origin.y + ddy, 0, H - s.h); }
      draft.movePending = false;
      updateDraftUI();
    }
  } else if (drag.mode === 'demolish_paint' && drag.moved) {
    // Dragging selects taxiways only, so a swipe can never sweep away terminals or runways.
    if (!draft || draft.mode !== 'demolish') draft = {mode: 'demolish', ids: []};
    const add = b => { if (b && !draft.ids.includes(b.id)) draft.ids.push(b.id); };
    add(drag.target);
    const c = screenCell(e), b = at(c.x, c.y);
    if (b && b.type === 'taxi') add(b);
    updateDraftUI();
  }
  drag.lastX = e.clientX;
  drag.lastY = e.clientY;
  if (e.pointerType === 'mouse') hover = screenCell(e);
}

function onPointerUp(e) {
  pointers.delete(e.pointerId);
  if (gesture) { if (pointers.size < 2) { gesture = null; drag = null; } return; }
  if (!drag || drag.id !== e.pointerId) return;
  if (!drag.moved && drag.mode === 'orbit') actionCell(screenCell(e));
  if (!drag.moved && drag.mode === 'demolish_paint') toggleDemolish(drag.target);
  if (draft && drag.mode === 'draft_move') { draft.movePending = false; updateDraftUI(); }
  drag = null;
}

// ---------- sheets ----------

// Matches the CSS layout where panels are bottom sheets (narrow portrait screens).
const BOTTOM_SHEET_QUERY = '(max-width: 699px) and (min-height: 521px)';

// Swipe a bottom sheet down by its handle or header to close it.
function bindSheetSwipe(panel) {
  let start = null;
  const handles = panel.querySelectorAll('.sheetHandle,.panelHead');
  for (const h of handles) {
    h.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || !matchMedia(BOTTOM_SHEET_QUERY).matches) return;
      start = {y: e.clientY, id: e.pointerId};
      h.setPointerCapture?.(e.pointerId);
    });
    h.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      const dy = Math.max(0, e.clientY - start.y);
      panel.style.transform = dy ? 'translateY(' + dy + 'px)' : '';
    });
    const end = e => {
      if (!start || e.pointerId !== start.id) return;
      const dy = e.clientY - start.y;
      panel.style.transform = '';
      start = null;
      if (dy > 70) closePanels();
    };
    h.addEventListener('pointerup', end);
    h.addEventListener('pointercancel', end);
  }
}

// ---------- keyboard ----------

function onKeyDown(e) {
  if (!$('modal').hidden) { if (e.key === 'Escape') closeModal(false); return; }
  const target = e.target, typing = target.closest?.('input,select,textarea'), onButton = target.closest?.('button,summary,a');
  if (typing) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === 'Space' && !onButton) { spaceDown = true; e.preventDefault(); return; }
  if (e.key === 'Escape') { if (draft) clearDraft(); else if (isCompact() && document.body.classList.contains('sheetOpen')) closePanels(); else setTool('inspect'); renderUI(); return; }
  if (e.key === 'Enter' && draft && !onButton) { e.preventDefault(); confirmDraft(); return; }
  if (e.key === 'r' || e.key === 'R' || e.key === 'к' || e.key === 'К') { rotateDraft(); return; }
  if (e.key === 'p' || e.key === 'P' || e.key === 'з' || e.key === 'З') { setSpeed(speed ? 0 : lastSpeed || 1); return; }
  const keys = ['taxi', 'runway', 'terminal', 'gate', 'service', 'bulldoze'];
  if (/^[1-6]$/.test(e.key)) { setTool(keys[+e.key - 1]); renderUI(); return; }
  const pan = {ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40]}[e.key];
  if (pan) { e.preventDefault(); moveCamera(...pan); return; }
  if (e.key === 'q' || e.key === 'Q' || e.key === 'й' || e.key === 'Й') { cameraTouched = true; camera.az += .12; }
  if (e.key === 'e' || e.key === 'E' || e.key === 'у' || e.key === 'У') { cameraTouched = true; camera.az -= .12; }
  if (e.key === '+' || e.key === '=') zoom(.88);
  if (e.key === '-' || e.key === '_') zoom(1.14);
}

let lastSpeed = 1;
function setSpeed(v) {
  if (!SPEEDS.includes(v)) return;
  if (speed) lastSpeed = speed;
  speed = v;
  syncSpeed();
  renderTop();
}

// ---------- wiring ----------

function initInput() {
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('pointerleave', () => { if (!drag) hover = null; });
  canvas.addEventListener('wheel', e => { e.preventDefault(); zoom(Math.exp(e.deltaY * .0011)); }, {passive: false});
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', e => { if (e.code === 'Space') spaceDown = false; });
  window.addEventListener('blur', () => { spaceDown = false; });

  $('tools').onclick = e => { const b = e.target.closest('[data-tool]'); if (b) { setTool(b.dataset.tool); renderUI(); } };
  $('modeControls').onclick = e => { const b = e.target.closest('[data-tool]'); if (b) { setTool(b.dataset.tool); renderUI(); } };
  $('bulkUpgrades').onclick = async e => {
    const b = e.target.closest('[data-bulk]');
    if (!b) return;
    const group = GROUPS.find(g => g.id === b.dataset.bulk), preview = bulkPreview(group.id);
    if (!preview.purchases.length) return;
    if (!await ask({title: 'Улучшить: ' + group.label.toLowerCase(), text: preview.purchases.length + ' ур. улучшений за ' + cash(preview.cost) + '.', ok: 'Улучшить'})) return;
    if (bulkUpgrade(group.id)) { toast('Улучшения построены', 'ok'); safeSave(true); }
    renderUI();
  };
  $('speeds').onclick = e => { const b = e.target.closest('[data-speed]'); if (b) setSpeed(+b.dataset.speed); };
  $('rightNav').onclick = e => { const b = e.target.closest('[data-section]'); if (b) setSection(b.dataset.section); };
  $('progressChip').onclick = () => showSection(G.completed ? 'collection' : 'overview');
  $('goalPeek').onclick = () => showSection(G.completed ? 'collection' : 'overview');
  $('decisionPeek').onclick = () => showSection('overview');
  $('rankStat').onclick = () => showSection('growth');
  $('menuBtn').onclick = showMenu;

  $('decision').onclick = e => { const b = e.target.closest('[data-decision]'); if (b && resolveDecision(+b.dataset.decision)) { renderUI(); safeSave(true); } };
  $('details').onclick = e => {
    const up = e.target.closest('[data-upgrade]'), del = e.target.closest('[data-demolish]');
    if (e.target.closest('[data-deselect]')) { selected = null; renderUI(); }
    else if (up) { if (upgrade(building(+up.dataset.upgrade))) { toast('Улучшение построено', 'ok'); vibrate(); safeSave(true); } renderUI(); }
    else if (del) startDemolish(building(+del.dataset.demolish));
  };
  $('goals').onclick = e => { const b = e.target.closest('[data-goal-action]'); if (b) setSection(b.dataset.goalAction); };
  $('contracts').onchange = e => {
    const s = e.target.closest('[data-offer-slot],[data-contract-slot]');
    if (!s) return;
    if (s.dataset.contractSlot) { if (moveContract(s.dataset.contractSlot, +s.value)) safeSave(true); renderKeys.contracts = ''; renderUI(); }
    else contractChoices[s.dataset.offerSlot] = +s.value;
  };
  $('contracts').onclick = async e => {
    const accept = e.target.closest('[data-accept-contract]'), cancel = e.target.closest('[data-cancel-contract]');
    if (accept) {
      const id = accept.dataset.acceptContract;
      if (acceptContract(id, contractChoices[id] ?? 1)) { toast('Контракт с ' + airlineById(id).name + ' подписан', 'ok'); vibrate(); safeSave(true); }
      renderUI();
    } else if (cancel) {
      const id = cancel.dataset.cancelContract, c = G.contracts.find(q => q.id === id), penalty = contractPenalty(c);
      if (!await ask({title: 'Расторгнуть контракт?', text: 'Контракт с ' + airlineById(id).name + ' будет расторгнут' + (penalty ? ', штраф ' + cash(penalty) : '') + '.', ok: 'Расторгнуть', danger: true})) return;
      if (cancelContract(id)) safeSave(true);
      renderUI();
    }
  };
  $('finance').onclick = e => {
    const fee = e.target.closest('[data-fee]'), loan = e.target.closest('[data-loan]');
    if (fee && setFeePolicy(fee.dataset.fee)) { toast('Сборы: ' + FEES[fee.dataset.fee].label.toLowerCase(), 'ok'); safeSave(true); }
    if (loan) {
      const ok = loan.dataset.loan === 'take' ? takeLoan() : repayLoan(loan.dataset.loan === 'all' ? G.loan : LOAN_STEP);
      if (ok) { toast(loan.dataset.loan === 'take' ? 'Кредит получен' : 'Платёж по кредиту внесён', 'ok'); safeSave(true); }
    }
    renderUI();
  };
  const readout = e => { const g = e.target.closest?.('[data-readout]'); if (g && $('chartReadout')) $('chartReadout').textContent = g.dataset.readout; };
  $('finance').addEventListener('pointerover', readout);
  $('finance').addEventListener('focusin', readout);
  $('finance').addEventListener('pointerdown', readout);
  $('growth').onclick = e => { const b = e.target.closest('[data-perk]'); if (b && buyPerk(b.dataset.perk)) { toast('Развитие улучшено', 'ok'); vibrate(); safeSave(true); renderUI(); } };
  $('collection').onclick = e => { const b = e.target.closest('[data-switch-airport]'); if (b) switchAirport(b.dataset.switchAirport); };

  $('cancelBuild').onclick = () => { clearDraft(); renderUI(); };
  $('confirmBuild').onclick = confirmDraft;
  $('rotateBuild').onclick = rotateDraft;
  $('moveBuild').onclick = () => { if (draft) { draft.movePending = !draft.movePending; updateDraftUI(); } };
  $('zoomIn').onclick = () => zoom(.82);
  $('zoomOut').onclick = () => zoom(1.22);
  $('cameraHome').onclick = center;
  $('importFile').onchange = e => importSave(e.target.files?.[0]);

  $('tabBuild').onclick = () => togglePanel('left');
  $('tabInfo').onclick = () => togglePanel('right');
  $('tabMap').onclick = closePanels;
  document.querySelectorAll('[data-close]').forEach(b => { b.onclick = closePanels; });
  bindSheetSwipe($('left'));
  bindSheetSwipe($('right'));
  $('modal').addEventListener('pointerdown', e => { if (e.target === $('modal')) closeModal(false); });
}
