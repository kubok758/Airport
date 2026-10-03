'use strict';
/* DOM interface: HUD, panels, dialogs and notifications. Sections re-render only when their content changes,
   so buttons are never replaced under the pointer between mousedown and click. */

const $ = id => document.getElementById(id);
let tool = 'inspect', selected = null, hover = null, draft = null, buildRot = 0, speed = 1, cameraTouched = false;
let activeSection = 'overview', contractChoices = {}, flashTimer = 0;
let settings = loadSettings();
const renderKeys = {};

const isCompact = () => innerWidth <= 1050;
const resetRenderKeys = () => { for (const key of Object.keys(renderKeys)) delete renderKeys[key]; };

// Writes innerHTML only when the signature changed. `html` may be a function so unchanged sections cost nothing.
// `children` lists nested containers whose cached signatures become stale when this one is rebuilt.
function setHTML(id, key, html, children = []) {
  const sig = typeof key === 'string' ? key : JSON.stringify(key);
  if (renderKeys[id] === sig) return false;
  renderKeys[id] = sig;
  $(id).innerHTML = typeof html === 'function' ? html() : html;
  for (const child of children) delete renderKeys[child];
  return true;
}
const setText = (el, text) => { if (el && el.textContent !== String(text)) el.textContent = text; };
const setDisabled = (el, off) => { if (el && el.disabled !== !!off) el.disabled = !!off; };

const compactCash = n => {
  const a = Math.abs(n), s = n < 0 ? '−' : '';
  return a >= 1e6 ? s + '$' + (a / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + 'M' : a >= 1e4 ? s + '$' + Math.round(a / 1e3) + 'K' : cash(n);
};
const duration = minutes => { const m = Math.max(0, Math.round(minutes)); return m >= 60 ? Math.floor(m / 60) + ' ч ' + String(m % 60).padStart(2, '0') + ' мин' : m + ' мин'; };
const kv = (label, value, cls = '') => '<div class="kv"><span>' + label + '</span><strong class="' + cls + '">' + value + '</strong></div>';

// ---------- notifications ----------

function toast(text, kind = 'info') {
  const box = $('toasts'), el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = text;
  box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 250); }, kind === 'gold' ? 4600 : 3400);
}

// Haptics only on touch screens and only after the player interacted (browsers block it otherwise).
function vibrate(ms = 12) {
  try { if (navigator.userActivation?.hasBeenActive && matchMedia('(pointer: coarse)').matches) navigator.vibrate?.(ms); } catch (e) {}
}

// ---------- modal dialogs ----------

let modalResolve = null, modalReturnFocus = null;

function showModal({title, html, buttons = [{label: 'Закрыть', value: false}], wide = false, onClick = null}) {
  if (modalResolve) closeModal(false);
  modalReturnFocus = document.activeElement;
  $('modalTitle').textContent = title;
  $('modalBody').innerHTML = html;
  $('modalButtons').innerHTML = buttons.map((b, i) => '<button type="button" class="action ' + (b.kind || '') + '" data-modal-index="' + i + '">' + b.label + '</button>').join('');
  $('modal').querySelector('.modalCard').classList.toggle('wide', wide);
  $('modal').hidden = false;
  document.body.classList.add('modalOpen');
  $('modalBody').onclick = onClick;
  $('modalButtons').onclick = e => { const b = e.target.closest('[data-modal-index]'); if (b) closeModal(buttons[+b.dataset.modalIndex].value); };
  const focusTarget = $('modalButtons').querySelector('.accent') || $('modalButtons').querySelector('button');
  setTimeout(() => focusTarget?.focus(), 30);
  return new Promise(resolve => { modalResolve = resolve; });
}

function closeModal(value) {
  if ($('modal').hidden) return;
  $('modal').hidden = true;
  document.body.classList.remove('modalOpen');
  $('modalBody').onclick = null;
  const resolve = modalResolve;
  modalResolve = null;
  if (modalReturnFocus && document.contains(modalReturnFocus)) modalReturnFocus.focus?.();
  resolve?.(value);
}

function ask({title, text, ok = 'Подтвердить', cancel = 'Отмена', danger = false}) {
  return showModal({title, html: '<p>' + text + '</p>', buttons: [{label: cancel, value: false}, {label: ok, value: true, kind: danger ? 'danger' : 'accent'}]});
}

// ---------- panels ----------

function setSection(id) {
  activeSection = id;
  for (const key of ['overview', 'contracts', 'finance', 'growth', 'collection']) $('section' + key[0].toUpperCase() + key.slice(1)).hidden = key !== id;
  document.querySelectorAll('#rightNav button').forEach(b => b.classList.toggle('on', b.dataset.section === id));
  $('right').scrollTop = 0;
  renderUI();
}

function syncTabs() {
  const left = $('left').classList.contains('open'), right = $('right').classList.contains('open');
  $('tabBuild').classList.toggle('on', left);
  $('tabInfo').classList.toggle('on', right);
  $('tabMap').classList.toggle('on', !left && !right);
  document.body.classList.toggle('sheetOpen', isCompact() && (left || right));
}
function openPanel(side) {
  $(side === 'left' ? 'right' : 'left').classList.remove('open');
  $(side).classList.add('open');
  syncTabs();
}
function closePanels() { $('left').classList.remove('open'); $('right').classList.remove('open'); syncTabs(); }
function togglePanel(side) { if ($(side).classList.contains('open')) closePanels(); else openPanel(side); }

function showSection(id) {
  setSection(id);
  if (isCompact()) openPanel('right');
}

function showSelectedDetails() {
  if (activeSection !== 'overview') setSection('overview');
  $('right').scrollTop = 0;
  if (isCompact()) openPanel('right');
}

// ---------- HUD ----------

function syncSpeed() {
  document.querySelectorAll('[data-speed]').forEach(b => b.classList.toggle('on', +b.dataset.speed === speed));
}

function renderTop() {
  $('money').textContent = cash(G.money);
  $('money').className = G.money < 0 ? 'negative' : '';
  $('profit').textContent = signedCash(G.today);
  $('profit').className = G.today >= 0 ? 'positive' : 'negative';
  $('pax').textContent = fmt(G.pax);
  $('rep').textContent = Math.round(G.rep) + '%';
  const r = rank(), from = xpForRank(r), to = xpForRank(r + 1);
  $('rankTitle').textContent = 'Ранг ' + r;
  $('rankLevel').textContent = rankTitle(r);
  $('xpFill').style.width = (r >= MAX_RANK ? 100 : clamp((portfolio.xp - from) / (to - from) * 100, 0, 100)) + '%';
  $('rankDot').hidden = !portfolio.points;
  $('growthDot').hidden = !portfolio.points;
  $('time').textContent = 'День ' + G.day + ' · ' + airportTime();
  const w = weatherNow();
  $('weatherLabel').textContent = w.icon + ' ' + w.name + ' · ' + (speed ? 'скорость ×' + speed : 'пауза');
  const runways = operationalRunways().length, compact = isCompact();
  $('status').textContent = compact ? '✈ ' + G.planes.length + ' · Гейты ' + operationalGates().length + '/' + count('gate') + ' · ВПП ' + runways + '/' + count('runway')
    : '✈ ' + G.planes.length + ' в работе · гейты ' + operationalGates().length + '/' + count('gate') + ' · ВПП ' + runways + '/' + count('runway');
  const holding = G.planes.filter(p => p.state === 'holding').length;
  $('demand').textContent = 'Спрос ×' + demandNow().toFixed(2) + (holding ? ' · в ожидании ' + holding : ' · рейсов ' + G.served);
  $('demand').classList.toggle('alert', holding >= 4);
}

// ---------- build palette ----------

function renderTools() {
  const types = Object.keys(TYPES).filter(typeAvailable);
  // Structure depends only on the location; lock state and prices change in place so a rank-up never swaps buttons.
  setHTML('tools', G.location, () => CATEGORIES.map(cat => {
    const list = types.filter(t => TYPES[t].cat === cat.id);
    if (!list.length) return '';
    return '<div class="sectionTitle">' + cat.label + '</div><div class="toolGrid">' + list.map(id =>
      '<button class="tool" type="button" data-tool="' + id + '" aria-pressed="false"><span class="ico">' + TYPES[id].icon + '</span>' +
      '<span class="desc"><b>' + TYPES[id].name + '</b><small>' + TYPES[id].description + '</small></span><span class="cost"></span></button>').join('') + '</div>';
  }).join(''));
  document.querySelectorAll('.tool,.modeBtn').forEach(el => {
    const on = el.dataset.tool === tool;
    el.classList.toggle('active', on);
    if (!el.classList.contains('tool')) return;
    const id = el.dataset.tool, locked = !typeUnlocked(id);
    el.setAttribute('aria-pressed', on);
    el.classList.toggle('locked', locked);
    el.classList.toggle('poor', !locked && G.money < buildCost(id));
    setText(el.querySelector('.cost'), locked ? '🔒 Ранг ' + TYPES[id].rank : cash(buildCost(id)));
  });
}

function renderBulk() {
  const groups = GROUPS.filter(group => G.buildings.some(b => group.types.includes(b.type))), root = $('bulkUpgrades');
  setHTML('bulkUpgrades', groups.map(g => g.id), () => groups.map(group =>
    '<div class="bulkCard"><div><strong>' + group.label + '</strong><small data-bulk-text="' + group.id + '"></small></div>' +
    '<button class="action" type="button" data-bulk="' + group.id + '">Улучшить</button></div>').join(''));
  for (const group of groups) {
    const p = bulkPreview(group.id);
    setText(root.querySelector('[data-bulk-text="' + group.id + '"]'), p.eligible ? p.purchases.length + ' ур. · ' + cash(p.cost) + ' · ' + p.eligible + ' объектов' : 'Всё улучшено');
    setDisabled(root.querySelector('[data-bulk="' + group.id + '"]'), !p.purchases.length);
  }
}

// ---------- goals ----------

function renderGoals() {
  const rows = goalRows(), pct = progress(), next = LOCATIONS[LOCATIONS.findIndex(l => l.id === G.location) + 1];
  const done = rows.filter(r => r.ratio >= 1).length, focus = rows.filter(r => r.ratio < 1).sort((a, b) => b.ratio - a.ratio)[0];
  const mission = next ? 'Открыть «' + next.name + '»' : 'Завершить «' + place(G.location).name + '»';
  const shown = r => r.display || r.value + ' / ' + r.target;
  G.progress = pct;
  setText($('airportName'), place(G.location).name);
  setText($('progressChip'), pct + '%');
  $('progressChip').title = mission + ' · ' + done + ' из ' + rows.length + ' целей выполнено';
  $('progressChip').style.setProperty('--progress', pct + '%');
  const peek = $('goalPeek');
  setText(peek.querySelector('strong'), G.completed ? '✓ ' + place(G.location).name + ' · 100%' : mission + ' · ' + done + '/' + rows.length);
  setText(peek.querySelector('span'), G.completed ? (next ? 'Нажмите, чтобы выбрать новый аэропорт' : 'Вся коллекция аэропортов открыта') : 'Ближайшая: ' + focus.label + ' · ' + shown(focus));
  if (activeSection !== 'overview') return;
  setHTML('goals', [G.location, G.completed, rows.map(r => r.ratio >= 1), focus?.label, !!next], () =>
    '<div class="card goalsCard"><div class="goalHead"><h3>' + place(G.location).name + '</h3><span class="pctBadge" data-goal-pct></span></div>' +
    '<p class="goalMission">' + mission + ' · выполнено ' + done + ' из ' + rows.length + '</p>' +
    rows.map((r, i) => '<div class="goal' + (r.ratio >= 1 ? ' done' : '') + (r === focus ? ' focus' : '') + '">' +
      '<div class="kv"><span class="goalTitle">' + (r.ratio >= 1 ? '✓ ' : '○ ') + r.label + '</span><strong data-goal-value="' + i + '"></strong></div>' +
      '<div class="goalTrack"><i data-goal-bar="' + i + '"></i></div>' +
      (r === focus ? '<p class="goalHint">' + r.hint + '</p>' + (r.action ? '<button class="action" type="button" data-goal-action="' + r.action + '">Открыть рейсы и контракты</button>' : '') : '') + '</div>').join('') +
    '<p class="notice">' + (G.completed ? (next ? 'Следующий аэропорт доступен во вкладке «Сеть».' : 'Все локации коллекции открыты.') :
      'Каждая цель даёт равную долю прогресса, частичное выполнение учитывается. Для 100% все условия должны выполняться одновременно.') + '</p>' +
    (G.completed && next ? '<button class="action accent wide" type="button" data-goal-action="collection">Выбрать следующий аэропорт</button>' : '') + '</div>');
  const root = $('goals');
  setText(root.querySelector('[data-goal-pct]'), pct + '%');
  rows.forEach((r, i) => {
    setText(root.querySelector('[data-goal-value="' + i + '"]'), shown(r));
    const bar = root.querySelector('[data-goal-bar="' + i + '"]'), width = Math.round(r.ratio * 100) + '%';
    if (bar && bar.style.width !== width) bar.style.width = width;
  });
}

// ---------- decisions ----------

function renderDecision() {
  const d = G.decision, def = d && decisionDef(d.id), left = d ? Math.max(0, d.expires - G.minutes) : 0;
  $('decisionPeek').hidden = !def;
  $('infoDot').hidden = !def;
  if (def) setText($('decisionPeekText'), def.title);
  if (activeSection !== 'overview') return;
  setHTML('decision', def ? [d.id, d.cost] : 'none', () => !def ? '' :
    '<div class="card decisionCard"><div class="decisionHead"><span class="decisionIcon">' + def.icon + '</span><div><h3>' + def.title + '</h3><small data-decision-left></small></div></div>' +
    '<p>' + def.text(d) + '</p><div class="decisionButtons">' + def.options.map((o, i) =>
      '<button class="action' + (i === 0 ? ' accent' : '') + '" type="button" data-decision="' + i + '"' + (o.paid ? ' data-paid' : '') + '>' +
      o.label + (o.paid ? ' · ' + cash(d.cost) : '') + '</button>').join('') + '</div>' +
    '<p class="notice">Если не ответить, будет выбран вариант «' + def.options[def.options.length - 1].label + '».</p></div>');
  if (!def) return;
  setText($('decision').querySelector('[data-decision-left]'), 'Решение нужно за ' + duration(Math.ceil(left / 5) * 5));
  $('decision').querySelectorAll('[data-paid]').forEach(b => setDisabled(b, G.money < d.cost));
}

// ---------- selected building ----------

function buildingFacts(b) {
  const rows = [];
  const net = networkStatus();
  if (b.type === 'runway') {
    const working = net.runways.includes(b);
    rows.push(kv('Ориентация', runwayAxis(b).vertical ? 'север — юг' : 'запад — восток'), kv('Подключённые выходы', runwayPorts(b).length), kv('Рейсов принято', b.arrivals || 0));
    rows.push(kv('Статус', b.runwayPlane ? 'Используется' : working ? 'Работает' : runwayPorts(b).length ? 'Нет пути к стоянке' : 'Нет соединения', working || b.runwayPlane ? 'em' : 'warn'));
  } else if (b.type === 'gate' || b.type === 'cargo') {
    const working = (b.type === 'gate' ? net.gates : net.cargo).includes(b), plane = G.planes.find(p => p.id === b.gatePlane);
    rows.push(kv('Номер', standLabel(b)), kv('Соединения с рулёжкой', standPorts(b).length));
    if (b.type === 'gate') rows.push(kv('Принимает', b.level >= 2 ? 'все пассажирские' : 'региональные и средние'));
    rows.push(kv('Статус', plane ? esc(plane.code) + ' · ' + (STATE_LABELS[plane.state] || '').toLowerCase() : b.type === 'gate' && !terminalsNear(b) ? 'Нужен терминал рядом' : !standPorts(b).length ? 'Нет соединения' : working ? 'Свободен' : 'Нет пути к ВПП', plane || working ? 'em' : 'warn'));
  } else if (b.type === 'terminal') rows.push(kv('Бонус к выручке', '+' + Math.round(12 * Math.max(0, levelSum('terminal') - 1)) + '% всего'));
  else if (b.type === 'shops') rows.push(kv('Статус', terminalsNear(b, 9) ? 'Работают' : 'Слишком далеко от терминала', terminalsNear(b, 9) ? 'em' : 'warn'), kv('Бонус к выручке', '+' + Math.round((shopsMultiplier() - 1) * 100) + '% всего'));
  else if (b.type === 'parking') rows.push(kv('Доход с пассажира', '$' + 3 * Math.min(6, levelSum('parking')) + ' всего'));
  else if (b.type === 'taxi') rows.push(kv('Скорость руления', '×' + (1 + .12 * (b.level - 1)).toFixed(2)), kv('Занята самолётом', G.reservations[k(b.x, b.y)] ? 'да' : 'нет'));
  else if (b.type === 'service') rows.push(kv('Ускорение обслуживания', Math.round((1 - Math.max(.52, 1 - levelSum('service') * .08)) * 100) + '% всего'));
  else if (b.type === 'fuel') rows.push(kv('Экономия на рейсах', Math.round(Math.min(.3, levelSum('fuel') * .09) * 100) + '% всего'));
  else if (b.type === 'solar') rows.push(kv('Экономия содержания', Math.round(Math.min(.35, levelSum('solar') * .07) * 100) + '% всего'));
  else if (b.type === 'deicing') rows.push(kv('Снижение потерь в снег', Math.round((1 - deicingRelief()) * 100) + '% всего'));
  return rows.join('');
}

function renderDetails() {
  if (activeSection !== 'overview') return;
  const b = building(selected);
  if (!b) {
    const tips = [];
    if (!G.contracts.length) tips.push('Заключите первый контракт во вкладке <b>«Рейсы»</b> — авиакомпании платят больше обычных рейсов.');
    if (G.money < 0) tips.push('Баланс отрицательный: возьмите кредит во вкладке <b>«Финансы»</b> или поднимите сборы.');
    if (portfolio.points) tips.push('Есть очки развития: потратьте их во вкладке <b>«Развитие»</b>.');
    if (G.planes.filter(p => p.state === 'holding').length >= 3) tips.push('Самолёты копятся в зоне ожидания: нужны свободные ВПП и гейты, иначе рейсы уйдут на запасной аэродром.');
    const effects = [];
    if (G.surgeUntil > G.minutes) effects.push('Наплыв пассажиров ×' + G.surge.toFixed(1) + ' · ещё ' + duration(G.surgeUntil - G.minutes));
    for (const [kind, v] of Object.entries(G.buffs)) if (v.until > G.minutes) effects.push({service: 'Обслуживание', demand: 'Спрос', fuel: 'Расходы на рейсы'}[kind] + ' ×' + v.mult.toFixed(2) + ' · ещё ' + duration(v.until - G.minutes));
    const w = weatherNow(), next = WEATHER[G.wx.next];
    setHTML('details', [tips, effects.map(e => e.replace(/\d+ мин$/, '')), G.wx.kind, G.wx.next, Math.ceil((G.wx.until - G.minutes) / 30)], () =>
      '<div class="card"><h3>' + w.icon + ' Погода: ' + w.name.toLowerCase() + '</h3><p>' +
      (w.approach > 1.01 ? 'Посадки медленнее на ' + Math.round((weatherApproach() - 1) * 100) + '%. ' : 'Полёты по расписанию. ') +
      (G.wx.next === G.wx.kind ? 'Погода устойчивая ещё минимум ' + duration(G.wx.until - G.minutes) + '.' : 'Через ' + duration(G.wx.until - G.minutes) + ': ' + next.icon + ' ' + next.name.toLowerCase() + '.') + '</p>' +
      (effects.length ? '<div class="effects">' + effects.map(e => '<span>' + e + '</span>').join('') + '</div>' : '') +
      (tips.length ? '<ul class="tips">' + tips.map(t => '<li>' + t + '</li>').join('') + '</ul>' : '<p class="notice">Нажмите на объект на карте, чтобы увидеть подробности и улучшить его.</p>') + '</div>');
    return;
  }
  const z = TYPES[b.type], canUp = b.level < 3, price = canUp ? upgradeCost(b) : 0;
  setHTML('details', [b.id, b.level, perk('build'), perk('salvage')], () =>
    '<div class="card detailCard"><div class="detailHead"><span class="ico">' + z.icon + '</span><div><h3>' + z.name + '</h3><small>Уровень ' + b.level + ' из 3 · содержание ' + cash(z.upkeep * b.level) + '/сутки</small></div>' +
    '<button class="closeBtn" type="button" data-deselect aria-label="Снять выделение">✕</button></div>' +
    '<div class="levelDots">' + [1, 2, 3].map(i => '<i class="' + (i <= b.level ? 'on' : '') + '"></i>').join('') + '</div><div data-facts></div><p>' + z.detail + '</p>' +
    '<div class="detailButtons">' + (canUp ? '<button class="action accent" type="button" data-upgrade="' + b.id + '">Улучшить · ' + cash(price) + '</button>' : '<span class="maxed">Максимальный уровень</span>') +
    '<button class="action danger" type="button" data-demolish="' + b.id + '">Снести · +' + cash(refundValue(b)) + '</button></div></div>', ['detailFacts']);
  const facts = buildingFacts(b), box = $('details').querySelector('[data-facts]');
  if (renderKeys.detailFacts !== facts) { renderKeys.detailFacts = facts; box.innerHTML = facts; }
  setDisabled($('details').querySelector('[data-upgrade]'), G.money < price);
}

// ---------- flights & log ----------

function renderFlights() {
  if (activeSection !== 'overview') return;
  const order = {takeoff: 0, lineup: 1, taxi_out: 2, ready: 3, service: 4, dock: 5, taxi_in: 6, exit_runway: 7, approach: 8, holding: 9};
  const planes = [...G.planes].sort((a, b) => order[a.state] - order[b.state]).slice(0, 12);
  const row = p => {
    const a = airlineById(p.airlineId), g = building(p.gateId), cls = CLASS[p.class];
    const state = p.state === 'service' ? 'Обслуживание ' + Math.round(p.service * 100) + '%' : p.state === 'holding' ? 'Ожидание · ' + Math.round(p.wait) + ' мин' : STATE_LABELS[p.state];
    const tone = p.state === 'holding' && p.wait > 90 || p.state === 'ready' && p.wait > 60 || p.delay > 0 ? 'late' : p.state === 'service' ? 'busy' : 'ok';
    return '<div class="flight"><span><b class="code">' + esc(p.code) + '</b>' + (a ? esc(a.name) : p.charter ? 'Чартер' : cls.label) + '<br><small>' +
      (cls.cargo ? p.tons + ' т груза' : p.pax + ' пасс.') + (g ? ' · ' + standLabel(g) : '') + '</small></span><em class="tone-' + tone + '">' + state + '</em></div>';
  };
  setHTML('flights', planes.map(p => [p.id, p.state, Math.round(p.service * 20), Math.round(p.wait / 10), p.gateId, p.delay > 0]), () =>
    planes.length ? planes.map(row).join('') + (G.planes.length > planes.length ? '<p class="notice">И ещё ' + (G.planes.length - planes.length) + ' рейсов…</p>' : '') : '<p class="notice">Рейсов пока нет. Первый самолёт скоро запросит посадку.</p>');
}

function renderEvents() {
  if (activeSection !== 'overview') return;
  const logs = G.logs.slice(0, 10);
  setHTML('events', logs.map(e => e.t + e.text), () => logs.map(e => '<div class="log"><time>' + esc(e.t) + '</time>' + esc(e.text) + '</div>').join(''));
}

// ---------- contracts ----------

function renderContracts() {
  if (activeSection !== 'contracts') return;
  if (document.activeElement?.tagName === 'SELECT' && document.activeElement.closest('#contracts')) return;
  const reqs = AIRLINES.map(a => contractRequirements(a).map(r => r.ok));
  setHTML('contracts', [G.location, G.contracts.map(c => [c.id, c.slot, c.completed > 0]), reqs, contractChoices], () => {
    const load = SLOTS.map(s => G.contracts.filter(c => c.slot === s.id).length);
    const rows = AIRLINES.map(a => {
      const c = G.contracts.find(x => x.id === a.id), req = contractRequirements(a), eligible = req.every(r => r.ok), slot = c ? c.slot : (contractChoices[a.id] ?? 1);
      const opts = SLOTS.map(s => '<option value="' + s.id + '"' + (s.id === slot ? ' selected' : '') + '>' + s.label + ' · ' + load[s.id] + '/2</option>').join('');
      return '<div class="contractCard' + (c ? ' signed' : '') + '"><div class="contractHead"><h3>' + (a.cargo ? '▣ ' : '✈ ') + a.name + '</h3><span class="tag">' + a.kind + '</span></div>' +
        '<p>' + a.perDay + ' рейсов в день · ' + CLASS[a.cls].label.toLowerCase() + ' · оплата ×' + a.pay.toFixed(2) + ' · срок ' + a.deadline + ' мин</p>' +
        (c ? '<div class="kv"><span>Выполнено / вовремя / сорвано</span><strong data-contract-stats="' + a.id + '"></strong></div>' +
          '<label class="field">Окно вылетов<select aria-label="Расписание ' + a.name + '" data-contract-slot="' + a.id + '">' + opts + '</select></label>' +
          '<button class="action wide" type="button" data-cancel-contract="' + a.id + '">Расторгнуть' + (contractPenalty(c) ? ' · штраф ' + cash(contractPenalty(c)) : '') + '</button>'
        : '<ul class="reqs">' + req.map(r => '<li class="' + (r.ok ? 'ok' : 'no') + '">' + (r.ok ? '✓ ' : '✗ ') + r.label + '</li>').join('') + '</ul>' +
          '<label class="field">Окно вылетов<select aria-label="Окно ' + a.name + '" data-offer-slot="' + a.id + '">' + opts + '</select></label>' +
          '<button class="action accent wide" type="button" data-accept-contract="' + a.id + '"' + (eligible ? '' : ' disabled') + '>' + (eligible ? 'Заключить контракт' : 'Требования не выполнены') + '</button>') + '</div>';
    }).join('');
    return '<p class="notice">В каждом шестичасовом окне помещаются две авиакомпании. Рейсы прибывают по расписанию; опоздание снижает оплату и репутацию, а отмена стоит ' + cash(2200) + '.</p>' + rows;
  });
  for (const c of G.contracts) setText($('contracts').querySelector('[data-contract-stats="' + c.id + '"]'), c.completed + ' / ' + c.onTime + ' / ' + c.late);
}

// ---------- finance ----------

function niceStep(v) { const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, v)))), n = v / p; return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * p; }

// Diverging single-series column chart: blue above zero for profit, red below for loss, 4px rounded data ends.
function profitChart(history) {
  if (!history.length) return '<p class="notice">График появится после первого завершённого дня.</p>';
  const Wd = 292, Hd = 132, pl = 40, pr = 6, pt = 10, pb = 22, slots = 14, iw = Wd - pl - pr, ih = Hd - pt - pb;
  const hi = Math.max(0, ...history.map(h => h.profit)), lo = Math.min(0, ...history.map(h => h.profit));
  const step = niceStep(Math.max(hi - lo, 1000) / 2), top = Math.max(step, Math.ceil(hi / step) * step), bottom = lo < 0 ? Math.floor(lo / step) * step : 0;
  const y = v => pt + (top - v) / (top - bottom) * ih, slot = iw / slots, bw = Math.min(16, slot - 4);
  const ticks = [];
  for (let v = bottom; v <= top + 1; v += step) ticks.push(v);
  const bar = (h, i) => {
    const sx = pl + (slots - history.length + i) * slot, x = sx + (slot - bw) / 2, y0 = y(0), y1 = y(h.profit), up = h.profit >= 0, hgt = Math.abs(y1 - y0), r = Math.min(4, hgt, bw / 2);
    const d = up ? 'M' + x + ',' + y0 + 'V' + (y1 + r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + y1 + ' ' + (x + bw) + ',' + (y1 + r) + 'V' + y0 + 'Z'
      : 'M' + x + ',' + y0 + 'V' + (y1 - r) + 'Q' + x + ',' + y1 + ' ' + (x + r) + ',' + y1 + 'H' + (x + bw - r) + 'Q' + (x + bw) + ',' + y1 + ' ' + (x + bw) + ',' + (y1 - r) + 'V' + y0 + 'Z';
    const label = 'День ' + h.day + ': доход ' + cash(h.income) + ', расходы ' + cash(h.costs) + ', итог ' + signedCash(h.profit);
    return '<g class="barGroup" data-readout="' + esc(label) + '" tabindex="0"><rect class="hit" x="' + sx + '" y="' + pt + '" width="' + slot + '" height="' + ih + '"></rect>' +
      (hgt > .5 ? '<path class="' + (up ? 'pos' : 'neg') + '" d="' + d + '"></path>' : '') + '<title>' + esc(label) + '</title></g>';
  };
  const first = history[0], last = history[history.length - 1];
  return '<svg class="chart" viewBox="0 0 ' + Wd + ' ' + Hd + '" role="img" aria-label="Прибыль по дням за ' + history.length + ' дн.">' +
    ticks.map(v => '<line class="' + (v === 0 ? 'zero' : 'grid') + '" x1="' + pl + '" x2="' + (Wd - pr) + '" y1="' + y(v) + '" y2="' + y(v) + '"></line><text class="tick" x="' + (pl - 5) + '" y="' + (y(v) + 3) + '">' + compactCash(v) + '</text>').join('') +
    history.map(bar).join('') +
    '<text class="tick mid" x="' + (pl + (slots - history.length + .5) * slot) + '" y="' + (Hd - 6) + '">д. ' + first.day + '</text>' +
    (history.length > 1 ? '<text class="tick mid" x="' + (pl + (slots - .5) * slot) + '" y="' + (Hd - 6) + '">д. ' + last.day + '</text>' : '') + '</svg>' +
    '<p class="readout" id="chartReadout">Наведите или коснитесь столбца, чтобы увидеть итоги дня.</p>' +
    '<details class="tableView"><summary>Таблица по дням</summary><table class="ledger"><thead><tr><th>День</th><th>Доход</th><th>Расход</th><th>Итог</th></tr></thead><tbody>' +
    history.slice().reverse().map(h => '<tr><td>' + h.day + '</td><td>' + compactCash(h.income) + '</td><td>' + compactCash(h.costs) + '</td><td class="' + (h.profit >= 0 ? 'pos' : 'neg') + '">' + signedCash(h.profit) + '</td></tr>').join('') +
    '</tbody></table></details>';
}

const LEDGER_LABELS = {flights: 'Рейсы', parking: 'Парковки', bonus: 'Награды', refund: 'Возврат за снос', ops: 'Расходы на рейсы', upkeep: 'Содержание', build: 'Строительство', penalty: 'Штрафы', interest: 'Проценты по кредиту', events: 'Решения'};

function ledgerTable(ledger) {
  const rows = [...Object.entries(ledger.income), ...Object.entries(ledger.costs).map(([key, v]) => [key, -v])].filter(([, v]) => v);
  if (!rows.length) return '<p class="notice">Пока без движения средств.</p>';
  return '<table class="ledger"><tbody>' + rows.map(([key, v]) => '<tr><td>' + (LEDGER_LABELS[key] || key) + '</td><td class="' + (v >= 0 ? 'pos' : 'neg') + '">' + signedCash(v) + '</td></tr>').join('') + '</tbody></table>';
}

// Finance is split into blocks: read-only blocks refresh freely, blocks with buttons only when their options change.
function renderFinance() {
  if (activeSection !== 'finance') return;
  const parts = ['finKpis', 'finChart', 'finToday', 'finFees', 'finBank', 'finTotals'];
  setHTML('finance', 'layout', () => '<div class="kpis" id="finKpis"></div><div class="card"><h3>Прибыль по дням</h3><div id="finChart"></div></div>' +
    '<div class="card" id="finToday"></div><div class="card" id="finFees"></div><div class="card" id="finBank"></div><div class="card" id="finTotals"></div>', parts);
  const limit = loanLimit(), upkeep = dailyUpkeep();
  setHTML('finKpis', [Math.round(G.money), G.lastDay, upkeep, G.loan], () =>
    '<div class="kpi"><small>Баланс</small><b class="' + (G.money < 0 ? 'neg' : '') + '">' + cash(G.money) + '</b></div>' +
    '<div class="kpi"><small>Вчера</small><b>' + signedCash(G.lastDay) + '</b></div>' +
    '<div class="kpi"><small>Содержание</small><b>' + cash(upkeep) + '/сут.</b></div>' +
    '<div class="kpi"><small>Кредит</small><b>' + (G.loan ? cash(G.loan) : 'нет') + '</b></div>');
  setHTML('finChart', G.history, () => profitChart(G.history));
  setHTML('finToday', [G.today, G.ledger], () => '<h3>Сегодня · ' + signedCash(G.today) + '</h3>' + ledgerTable(G.ledger));
  setHTML('finFees', G.feePolicy, () => '<h3>Аэропортовые сборы</h3><div class="segmented">' + Object.entries(FEES).map(([id, f]) =>
    '<button type="button" data-fee="' + id + '" class="' + (G.feePolicy === id ? 'on' : '') + '" aria-pressed="' + (G.feePolicy === id) + '">' + f.label + '</button>').join('') + '</div>' +
    '<p>' + FEES[G.feePolicy].text + '.</p>');
  const canRepay = G.loan > 0 && G.money > 0, canRepayAll = G.loan > 0 && G.money >= G.loan;
  setHTML('finBank', [G.loan, limit, canRepay, canRepayAll], () => '<h3>Банк</h3>' + kv('Долг', cash(G.loan)) + kv('Лимит на ранге ' + rank(), cash(limit)) +
    kv('Проценты', (LOAN_RATE * 100).toFixed(1) + '% в сутки · ' + cash(dailyInterest())) +
    '<div class="detailButtons"><button class="action" type="button" data-loan="take"' + (G.loan >= limit ? ' disabled' : '') + '>Взять ' + cash(Math.min(LOAN_STEP, limit - G.loan) || LOAN_STEP) + '</button>' +
    '<button class="action" type="button" data-loan="repay"' + (canRepay ? '' : ' disabled') + '>Погасить ' + cash(Math.min(LOAN_STEP, G.loan) || LOAN_STEP) + '</button>' +
    (G.loan > LOAN_STEP ? '<button class="action" type="button" data-loan="all"' + (canRepayAll ? '' : ' disabled') + '>Погасить всё</button>' : '') + '</div>' +
    '<p class="notice">Проценты списываются в полночь вместе с содержанием. Лимит растёт с рангом директора.</p>');
  setHTML('finTotals', [G.earned, G.spent, G.pax, G.cargo, G.diverted], () => '<h3>За всё время</h3>' + kv('Доходы', cash(G.earned)) + kv('Расходы и стройка', cash(G.spent)) +
    kv('Пассажиры', fmt(G.pax)) + kv('Груз', fmt(G.cargo) + ' т') + kv('Уходы на запасной и отмены', G.diverted));
}

// ---------- progression ----------

function renderGrowth() {
  if (activeSection !== 'growth') return;
  const parts = ['growthRank', 'growthPerks', 'growthUnlocks', 'growthAch'];
  setHTML('growth', 'layout', () => '<div id="growthRank"></div><div class="sectionTitle">Развитие холдинга</div><div id="growthPerks"></div>' +
    '<div class="sectionTitle">Открытие построек</div><div class="card unlockList" id="growthUnlocks"></div><div id="growthAch"></div>', parts);
  const r = rank(), from = xpForRank(r), to = xpForRank(r + 1), got = ACHIEVEMENTS.filter(a => portfolio.achievements[a.id]).length;
  setHTML('growthRank', [portfolio.xp, portfolio.points], () =>
    '<div class="card rankCard"><div class="rankHead"><span class="rankBadge">' + r + '</span><div><h3>' + rankTitle(r) + '</h3><small>' +
    (r >= MAX_RANK ? 'Максимальный ранг' : fmt(portfolio.xp - from) + ' / ' + fmt(to - from) + ' XP до ранга ' + (r + 1)) + '</small></div></div>' +
    '<div class="goalTrack"><i style="width:' + (r >= MAX_RANK ? 100 : clamp((portfolio.xp - from) / (to - from) * 100, 0, 100)) + '%"></i></div>' +
    '<p>Опыт даётся за рейсы (больше — за контракты вовремя, грузы и чартеры), достижения и завершённые аэропорты. За каждый ранг — очко развития, за аэропорт на 100% — ещё два.</p>' +
    '<div class="pointsLine">Очки развития: <b>' + portfolio.points + '</b></div></div>');
  setHTML('growthPerks', portfolio.perks, () => PERKS.map(def => {
    const lv = perk(def.id), max = def.costs.length, cost = def.costs[lv];
    return '<div class="perkCard' + (lv >= max ? ' maxed' : '') + '"><span class="ico">' + def.icon + '</span><div class="perkText"><b>' + def.title + '</b><small>' + def.text + '</small>' +
      '<div class="levelDots">' + def.costs.map((_, i) => '<i class="' + (i < lv ? 'on' : '') + '"></i>').join('') + '</div></div>' +
      (lv >= max ? '<span class="maxed">Макс.</span>' : '<button class="action accent" type="button" data-perk="' + def.id + '" data-cost="' + cost + '">' + cost + ' очк.</button>') + '</div>';
  }).join(''));
  $('growthPerks').querySelectorAll('[data-perk]').forEach(b => setDisabled(b, portfolio.points < +b.dataset.cost));
  setHTML('growthUnlocks', r, () => Object.entries(TYPES).filter(([, t]) => t.rank).sort((a, b) => a[1].rank - b[1].rank).map(([, t]) =>
    '<div class="kv"><span>' + t.icon + ' ' + t.name + '</span><strong class="' + (r >= t.rank ? 'em' : '') + '">' + (r >= t.rank ? 'открыто' : 'ранг ' + t.rank) + '</strong></div>').join(''));
  setHTML('growthAch', got, () => '<div class="sectionTitle">Достижения · ' + got + ' из ' + ACHIEVEMENTS.length + '</div><div class="achGrid">' + ACHIEVEMENTS.map(a => {
    const done = !!portfolio.achievements[a.id];
    return '<div class="ach' + (done ? ' done' : '') + '"><span class="ico">' + (done ? a.icon : '?') + '</span><div><b>' + a.title + '</b><small>' + a.text + '</small>' +
      '<em>' + [a.cash ? cash(a.cash) : '', a.xp + ' XP'].filter(Boolean).join(' · ') + '</em></div></div>';
  }).join('') + '</div>');
}

// ---------- airports ----------

function renderCollection() {
  if (activeSection !== 'collection') return;
  // Inactive airports are paused, so only the active card has changing numbers; those update in place.
  setHTML('collection', [portfolio.active, portfolio.unlocked, perk('capital'), LOCATIONS.map(l => { const g = portfolio.airports[l.id]; return !g ? null : l.id === portfolio.active ? [g.completed] : [g.completed, g.progress, Math.round(g.money), g.served]; })], () =>
    '<p class="notice">Каждый аэропорт хранит свою карту, деньги, рейсы и контракты. Ранг, очки развития и достижения общие. Пока вы в другом аэропорту, его время стоит на паузе.</p>' +
    LOCATIONS.map((l, i) => {
      const unlocked = portfolio.unlocked.includes(l.id), g = portfolio.airports[l.id], active = portfolio.active === l.id, pct = g?.completed ? 100 : g?.progress || 0;
      return '<div class="locationCard loc-' + l.id + (active ? ' active' : '') + (g?.completed ? ' completed' : '') + (unlocked ? '' : ' locked') + '">' +
        '<div class="locHead"><h3>' + (unlocked ? '◈ ' : '🔒 ') + l.name + '</h3><span class="pctBadge"' + (active ? ' data-col="pct"' : '') + '>' + (unlocked ? pct + '%' : 'закрыт') + '</span></div>' +
        '<p>' + l.detail + '</p><p class="locMeta">Особое здание: ' + TYPES[l.special].icon + ' ' + TYPES[l.special].name + ' · цель: ' + fmt(l.flights) + ' рейсов</p>' +
        (g ? '<div class="kv"><span>Рейсы</span><strong' + (active ? ' data-col="served"' : '') + '>' + fmt(g.served) + '</strong></div><div class="kv"><span>Баланс</span><strong' + (active ? ' data-col="money"' : '') + '>' + cash(g.money) + '</strong></div>'
          : unlocked ? '<p>Стартовый капитал: ' + cash(110000 + l.boost + 30000 * perk('capital')) + '</p>' : '<p>Развейте «' + LOCATIONS[i - 1].name + '» на 100%.</p>') +
        (active ? '<p class="em">Вы сейчас здесь</p>' : unlocked ? '<button class="action accent wide" type="button" data-switch-airport="' + l.id + '">' + (g ? 'Перейти' : 'Основать аэропорт') + '</button>' : '') + '</div>';
    }).join(''));
  const root = $('collection');
  setText(root.querySelector('[data-col=pct]'), (G.completed ? 100 : G.progress) + '%');
  setText(root.querySelector('[data-col=served]'), fmt(G.served));
  setText(root.querySelector('[data-col=money]'), cash(G.money));
}

// ---------- draft panel ----------

function updateDraftUI() {
  const panel = $('buildConfirm');
  panel.hidden = !draft;
  $('stage').classList.toggle('placing', !!draft);
  if (!draft) return;
  const a = draftAssessment(), demolishing = draft.mode === 'demolish';
  $('buildName').textContent = demolishing ? 'Снос' : TYPES[draft.type].name + (draft.rot ? ' · повёрнуто' : '');
  $('buildCost').textContent = demolishing ? '+' + cash(a.cost) : cash(a.cost);
  $('buildHint').textContent = draft.movePending ? 'Коснитесь клетки, куда перенести макет' : a.message;
  $('buildHint').classList.toggle('invalid', !a.valid && !draft.movePending);
  $('confirmBuild').disabled = !a.valid;
  $('confirmBuild').textContent = demolishing ? 'Снести' : 'Построить';
  $('confirmBuild').classList.toggle('danger', demolishing);
  $('rotateBuild').hidden = demolishing || !TYPES[draft.type]?.rotate;
  $('moveBuild').hidden = demolishing;
  $('moveBuild').classList.toggle('moving', !!draft.movePending);
  panel.classList.toggle('three', demolishing || !TYPES[draft.type]?.rotate);
  panel.classList.toggle('two', demolishing);
}

// ---------- dialogs with content ----------

function showHelp() {
  showModal({title: 'Справка', wide: true, html:
    '<h3>Как играть</h3><ul class="tips">' +
    '<li>Самолёт садится на ВПП, по рулёжкам едет к гейту, обслуживается и улетает. Гейту нужен терминал в радиусе 10 клеток.</li>' +
    '<li>Подключайте рулёжки к углам или торцам ВПП — там горят жёлтые огни.</li>' +
    '<li>Контракты с авиакомпаниями приносят больше денег и продвигают цели аэропорта.</li>' +
    '<li>Если самолёт слишком долго ждёт в воздухе, он уходит на запасной аэродром — это бьёт по репутации.</li>' +
    '<li>Погода замедляет посадки, а решения директора дают бонусы или экономят деньги.</li></ul>' +
    '<h3>Управление</h3><ul class="tips">' +
    '<li><b>Мышь:</b> тяните карту — вращение, правая кнопка или пробел — сдвиг, колесо — масштаб.</li>' +
    '<li><b>Телефон:</b> одним пальцем — вращение, двумя — масштаб и сдвиг, ✥ — режим сдвига.</li>' +
    '<li><b>Клавиши:</b> 1–5 — постройки, 6 — снос, R — повернуть, Enter — подтвердить, Esc — отменить, P — пауза, стрелки — сдвиг камеры, Q/E — поворот.</li></ul>' +
    '<h3>Огни гейтов</h3><p><span class="lamp free"></span> свободен · <span class="lamp res"></span> самолёт в пути · <span class="lamp busy"></span> на обслуживании</p>'});
}

function showWhatsNew() {
  return showModal({title: 'Обновление «Взлёт»', wide: true, buttons: [{label: 'К аэропорту', value: true, kind: 'accent'}], html:
    '<p>Большое обновление игры. Ваши аэропорты сохранены' + (portfolio.migrated ? ', а за уже сделанные рейсы начислены опыт и очки развития' : '') + '.</p><ul class="tips">' +
    '<li><b>Ранг директора и развитие холдинга:</b> опыт за рейсы, очки развития и девять веток перков.</li>' +
    '<li><b>21 достижение</b> с денежными наградами.</li>' +
    '<li><b>Новые постройки:</b> парковки, магазины и кафе, грузовой терминал с грузовыми рейсами и контрактом Polar Cargo.</li>' +
    '<li><b>Поворот зданий и вертикальные ВПП</b>, выходы на рулёжку теперь и с торцов полосы.</li>' +
    '<li><b>Пятый аэропорт «Горный курорт»</b> со снегопадами и станцией антиобледенения.</li>' +
    '<li><b>Погода, решения директора, сборы и кредиты</b>, вкладка «Финансы» с графиком прибыли.</li>' +
    '<li><b>Новая графика:</b> тени от солнца, которое движется по небу, рассветы и закаты, звёзды, волны у острова и облака с тенями.</li>' +
    '<li><b>Живой перрон:</b> самолёты встают носом к терминалу, телетрапы выдвигаются к двери, вокруг работают заправщики, багажные поезда и тягачи. У каждой авиакомпании своя ливрея.</li>' +
    '<li>Самолёты набирают высоту, кружат в зоне ожидания и уходят на запасной, если ждать слишком долго. Ночью горят огни ВПП, рулёжек и бортовые огни.</li>' +
    '<li>Удобнее на телефоне и планшете, подтверждение сноса, десятки исправлений.</li></ul>'});
}

function showIntro() {
  return showModal({title: 'Добро пожаловать, директор!', wide: true, buttons: [{label: 'Начать', value: true, kind: 'accent'}], html:
    '<p>Вам доверили аэропорт «' + place(G.location).name + '». Полоса, три гейта и терминал уже работают — первый рейс скоро запросит посадку.</p><ol class="steps">' +
    '<li><b>Заключите контракт</b> во вкладке «Рейсы» — это главный источник дохода.</li>' +
    '<li><b>Стройте гейты и рулёжки</b>, чтобы самолёты не ждали в воздухе.</li>' +
    '<li><b>Улучшайте постройки</b> — нажмите на объект на карте.</li>' +
    '<li><b>Выполняйте цели</b> (кружок с процентом вверху), чтобы открыть новые аэропорты.</li></ol>'});
}

function showMenu() {
  const quality = {high: 'Высокое', medium: 'Среднее', low: 'Экономия'};
  showModal({title: 'Меню', wide: true, buttons: [{label: 'Закрыть', value: false}], html:
    '<div class="menuGrid">' +
    '<button class="action" type="button" data-menu="save">Сохранить</button><button class="action" type="button" data-menu="load">Загрузить</button>' +
    '<button class="action" type="button" data-menu="export">Скачать копию</button><button class="action" type="button" data-menu="import">Загрузить файл</button>' +
    '<button class="action" type="button" data-menu="help">Справка</button><button class="action" type="button" data-menu="news">Что нового</button></div>' +
    '<p class="help" id="saveState">Автосохранение каждые 8 секунд</p>' +
    '<h3>Графика</h3><div class="segmented" id="qualityPick">' + Object.entries(quality).map(([id, label]) => '<button type="button" data-quality="' + id + '" class="' + (settings.quality === id ? 'on' : '') + '">' + label + '</button>').join('') + '</div>' +
    '<label class="toggle"><input type="checkbox" id="particlesToggle"' + (settings.particles ? ' checked' : '') + '> Дождь, снег и песок на карте</label>' +
    '<h3>Аэропорт «' + place(G.location).name + '»</h3><button class="action danger wide" type="button" data-menu="reset">Начать этот аэропорт заново</button>',
  onClick: async e => {
    const q = e.target.closest('[data-quality]');
    if (q) {
      settings.quality = q.dataset.quality;
      storeSettings();
      document.querySelectorAll('#qualityPick button').forEach(b => b.classList.toggle('on', b === q));
      resize();
      return;
    }
    if (e.target.id === 'particlesToggle') { settings.particles = e.target.checked; storeSettings(); return; }
    const b = e.target.closest('[data-menu]');
    if (!b) return;
    const action = b.dataset.menu;
    if (action === 'save') safeSave();
    else if (action === 'load') { closeModal(false); if (await restoreLatest(true)) renderUI(); }
    else if (action === 'export') exportSave();
    else if (action === 'import') { closeModal(false); $('importFile').click(); }
    else if (action === 'help') showHelp();
    else if (action === 'news') showWhatsNew();
    else if (action === 'reset') {
      if (!await ask({title: 'Начать заново?', text: 'Карта, рейсы, контракты и деньги аэропорта «' + place(G.location).name + '» будут заменены новой игрой. Остальные аэропорты, ранг и достижения сохранятся.', ok: 'Начать заново', danger: true})) return;
      G = fresh(G.location, 30000 * perk('capital'));
      portfolio.airports[portfolio.active] = G;
      delete portfolio.views[portfolio.active];
      afterAirportChange();
      center();
      safeSave(true);
      toast('Аэропорт создан заново', 'ok');
    }
  }});
}

// ---------- main render ----------

function renderUI() {
  checkAchievements();
  ensureCompletion();
  renderTop();
  renderTools();
  renderBulk();
  renderGoals();
  renderDecision();
  renderDetails();
  renderFlights();
  renderEvents();
  renderContracts();
  renderFinance();
  renderGrowth();
  renderCollection();
  updateDraftUI();
}
