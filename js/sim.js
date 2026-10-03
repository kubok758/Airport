'use strict';
/* Simulation: construction, taxi network, routing, traffic, economy, weather, decisions and progression. */

const APPROACH_TIME = 4.5, APPROACH_LEAD = 12, TAKEOFF_TIME = 5, TAKEOFF_TAIL = 10;
const LOAN_RATE = .015, LOAN_STEP = 25000;

// ---------- construction ----------

const typeAvailable = type => !!TYPES[type] && (!TYPES[type].locale || TYPES[type].locale === G.location);
const typeUnlocked = type => !TYPES[type]?.rank || rank() >= TYPES[type].rank;
const buildTool = type => typeAvailable(type) && typeUnlocked(type);
const buildDiscount = () => 1 - .06 * perk('build');
const buildCost = type => Math.round(TYPES[type].cost * buildDiscount());
const upgradeCost = (b, level = b.level) => Math.round(TYPES[b.type].cost * (.65 + .35 * level) * buildDiscount());
const refundValue = b => Math.floor(TYPES[b.type].cost * (perk('salvage') ? .55 : .35) * b.level);

function canPlace(type, x, y, rot = 0) {
  if (!typeAvailable(type)) return false;
  const {w, h} = dims(type, rot);
  if (x < 0 || y < 0 || x + w > W || y + h > H) return false;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) if (G.grid[yy * W + xx] !== null) return false;
  return true;
}

function addBuilding(type, x, y, rot = 0, quiet = false) {
  if (!canPlace(type, x, y, rot)) { if (!quiet) hooks.toast('Место занято или за пределами карты', 'warn'); return null; }
  const cost = buildCost(type);
  if (G.money < cost) { if (!quiet) hooks.toast('Недостаточно средств: ' + cash(cost), 'warn'); return null; }
  const b = placeBuilding(G, type, x, y, TYPES[type].rotate ? rot : 0);
  spend(cost, 'build');
  markStructure();
  if (!quiet) log('Построено: ' + TYPES[type].name + ' (' + cash(cost) + ')');
  return b;
}

// Returns a reason string when the building cannot be removed right now.
function demolishBlocker(b) {
  if (!b) return 'Здесь нечего сносить';
  if (b.gatePlane || b.runwayPlane) return 'Объект зарезервирован или занят самолётом';
  if (b.type === 'taxi' && G.reservations[k(b.x, b.y)]) return 'Самолёт использует эту дорожку';
  return '';
}

function demolish(b, quiet = false) {
  const blocker = demolishBlocker(b);
  if (blocker) { if (!quiet) hooks.toast(blocker, 'warn'); return 0; }
  const refund = refundValue(b);
  earn(refund, 'refund');
  for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) G.grid[yy * W + xx] = null;
  G.buildings = G.buildings.filter(q => q !== b);
  for (const p of G.planes) if (p.runwayId === b.id) p.runwayId = null;
  markStructure();
  if (!quiet) log('Снесено: ' + TYPES[b.type].name + ', возврат ' + cash(refund));
  return refund;
}

function upgrade(b) {
  if (!b || b.level >= 3) return false;
  const price = upgradeCost(b);
  if (G.money < price) { hooks.toast('Для улучшения нужно ' + cash(price), 'warn'); return false; }
  spend(price, 'build');
  b.level++;
  markVisual();
  log(TYPES[b.type].name + ' улучшен до уровня ' + b.level);
  return true;
}

function bulkPreview(group) {
  const types = GROUPS.find(g => g.id === group)?.types || [];
  const items = G.buildings.filter(b => types.includes(b.type) && b.level < 3).map(b => ({b, level: b.level}));
  let money = Math.max(0, G.money);
  const purchases = [];
  for (let level = 1; level < 3; level++)
    for (const item of items.filter(v => v.level === level).sort((a, b) => a.b.id - b.b.id)) {
      const price = upgradeCost(item.b, item.level);
      if (price <= money) { money -= price; purchases.push({id: item.b.id, price}); item.level++; }
    }
  return {purchases, cost: purchases.reduce((s, p) => s + p.price, 0), eligible: items.length};
}

function bulkUpgrade(group) {
  const label = GROUPS.find(g => g.id === group)?.label, preview = bulkPreview(group);
  if (!label || !preview.purchases.length) return false;
  let paid = 0;
  for (const row of preview.purchases) {
    const b = building(row.id);
    if (!b || b.level >= 3 || G.money < row.price) continue;
    spend(row.price, 'build');
    paid += row.price;
    b.level++;
  }
  markVisual();
  log('Массовое улучшение: ' + label + ' · ' + cash(paid));
  return true;
}

// ---------- taxi network ----------

function terminalsNear(b, radius = 10) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return G.buildings.some(t => t.type === 'terminal' && Math.abs(t.x + t.w / 2 - cx) + Math.abs(t.y + t.h / 2 - cy) < radius);
}
const activeShopLevels = () => G.buildings.reduce((n, b) => n + (b.type === 'shops' && terminalsNear(b, 9) ? b.level : 0), 0);
const shopsMultiplier = () => 1 + Math.min(.32, .04 * activeShopLevels());

// Perimeter tiles of a stand that hold taxiway.
function standPorts(b) {
  const r = [];
  for (let y = b.y; y < b.y + b.h; y++) r.push([b.x - 1, y], [b.x + b.w, y]);
  for (let x = b.x; x < b.x + b.w; x++) r.push([x, b.y - 1], [x, b.y + b.h]);
  return r.filter(([x, y]) => isTaxi(x, y));
}

function runwayAxis(r) {
  const vertical = r.h > r.w;
  return {vertical, a0: vertical ? r.y : r.x, len: vertical ? r.h : r.w, c: vertical ? r.x + r.w / 2 : r.y + r.h / 2};
}
function runwayPoint(r, along) { const a = runwayAxis(r); return a.vertical ? {x: a.c, y: along} : {x: along, y: a.c}; }
function runwayHeading(r, dir) { return runwayAxis(r).vertical ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (dir > 0 ? 0 : Math.PI); }

// Runway exits: the four corners along the long sides plus the tiles right behind each threshold.
function runwayExits(r) {
  const {x, y, w, h} = r;
  if (h > w) return [[x - 1, y], [x - 1, y + h - 1], [x + w, y], [x + w, y + h - 1], ...Array.from({length: w}, (_, i) => [[x + i, y - 1], [x + i, y + h]]).flat()];
  return [[x, y - 1], [x + w - 1, y - 1], [x, y + h], [x + w - 1, y + h], ...Array.from({length: h}, (_, i) => [[x - 1, y + i], [x + w, y + i]]).flat()];
}
const runwayPorts = r => runwayExits(r).filter(([x, y]) => isTaxi(x, y));

function isStand(b) { return b.type === 'gate' ? terminalsNear(b) : b.type === 'cargo'; }

function networkStatus() {
  if (!topologyDirty && topologyCache && topologyFor === G) return topologyCache;
  const comp = new Map();
  let next = 0;
  for (const b of G.buildings) {
    if (b.type !== 'taxi' || comp.has(k(b.x, b.y))) continue;
    const id = next++, q = [[b.x, b.y]];
    comp.set(k(b.x, b.y), id);
    for (let i = 0; i < q.length; i++) {
      const [x, y] = q[i];
      for (const [a, c] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]])
        if (isTaxi(a, c) && !comp.has(k(a, c))) { comp.set(k(a, c), id); q.push([a, c]); }
    }
  }
  const comps = ports => new Set(ports.map(([x, y]) => comp.get(k(x, y))));
  const stands = G.buildings.filter(b => (b.type === 'gate' || b.type === 'cargo') && isStand(b) && standPorts(b).length);
  const runways = G.buildings.filter(b => b.type === 'runway' && runwayPorts(b).length);
  const standComps = comps(stands.flatMap(standPorts)), runwayComps = comps(runways.flatMap(runwayPorts));
  const linked = (ports, set) => ports.some(([x, y]) => set.has(comp.get(k(x, y))));
  topologyCache = {
    runways: runways.filter(r => linked(runwayPorts(r), standComps)),
    gates: stands.filter(s => s.type === 'gate' && linked(standPorts(s), runwayComps)),
    cargo: stands.filter(s => s.type === 'cargo' && linked(standPorts(s), runwayComps))
  };
  topologyFor = G;
  topologyDirty = false;
  return topologyCache;
}
const operationalRunways = () => networkStatus().runways;
const operationalGates = () => networkStatus().gates;
const operationalCargo = () => networkStatus().cargo;

function standLabel(b) {
  if (!b) return '—';
  const list = G.buildings.filter(q => q.type === b.type).sort((a, c) => a.id - c.id);
  return (b.type === 'cargo' ? 'C' : b.type === 'runway' ? 'ВПП ' : 'G') + (list.indexOf(b) + 1);
}
// Nearest terminal to a gate, measured to the closest point of its footprint.
function rectPoint(t, x, y) { return {x: clamp(x, t.x, t.x + t.w), y: clamp(y, t.y, t.y + t.h)}; }
function gateTerminal(b) {
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  let best = null, bestD = Infinity;
  for (const t of G.buildings) if (t.type === 'terminal') {
    const q = rectPoint(t, cx, cy), d = Math.hypot(q.x - cx, q.y - cy);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}
// Aircraft park nose-in towards the nearest facade, like at real contact stands.
function gateHeading(b) {
  const t = gateTerminal(b), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  if (!t) return -Math.PI / 2;
  const q = rectPoint(t, cx, cy), dx = q.x - cx, dy = q.y - cy;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 0 : Math.PI) : (dy > 0 ? Math.PI / 2 : -Math.PI / 2);
}
function facadeDistance(b) {
  const t = gateTerminal(b), h = gateHeading(b), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  if (!t) return 3;
  const fx = Math.round(Math.cos(h)), fy = Math.round(Math.sin(h));
  return fx > 0 ? t.x - cx : fx < 0 ? cx - (t.x + t.w) : fy > 0 ? t.y - cy : cy - (t.y + t.h);
}
// Long aircraft back off from a close facade so the nose never pokes into the terminal.
function standPoint(b, p = null) {
  if (b.type === 'cargo') return localToWorld(b, 2, 1.95);
  const c = {x: b.x + b.w / 2, y: b.y + b.h / 2};
  if (!p) return c;
  const h = gateHeading(b), shift = clamp(CLASS[p.class].len * .7 - (facadeDistance(b) - .15), 0, 1.2);
  return {x: c.x - Math.cos(h) * shift, y: c.y - Math.sin(h) * shift};
}
function standHeading(b) { return b.type === 'cargo' ? (b.rot ? Math.PI / 2 : 0) : gateHeading(b); }

// Breadth-first search over taxiways that skips tiles reserved by other aircraft; the whole path is claimed at once.
function route(starts, ends, planeId, ignoreReservations = false) {
  const targets = new Set(ends.map(([x, y]) => y * W + x)), prev = new Map(), q = [];
  const free = (x, y) => {
    if (!isTaxi(x, y)) return false;
    if (ignoreReservations) return true;
    const owner = G.reservations[k(x, y)];
    return !owner || owner === planeId;
  };
  for (const [x, y] of starts) {
    const i = y * W + x;
    if (!prev.has(i) && free(x, y)) { prev.set(i, -1); q.push(i); }
  }
  for (let head = 0; head < q.length; head++) {
    const i = q[head];
    if (targets.has(i)) {
      const path = [];
      for (let j = i; j !== -1; j = prev.get(j)) path.push({x: j % W, y: Math.floor(j / W)});
      return path.reverse();
    }
    const x = i % W, y = Math.floor(i / W);
    for (const [a, c] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]) {
      if (a < 0 || c < 0 || a >= W || c >= H) continue;
      const j = c * W + a;
      if (!prev.has(j) && free(a, c)) { prev.set(j, i); q.push(j); }
    }
  }
  return null;
}

function reserve(p, path) {
  for (const c of path) { const owner = G.reservations[k(c.x, c.y)]; if (owner && owner !== p.id) return false; }
  for (const c of path) G.reservations[k(c.x, c.y)] = p.id;
  p.path = path;
  p.pathIndex = 0;
  return true;
}

function release(p) {
  for (const c of p.path || []) if (G.reservations[k(c.x, c.y)] === p.id) delete G.reservations[k(c.x, c.y)];
  p.path = [];
  p.pathIndex = 0;
}

function cruise(p, dt) {
  let remaining = dt;
  while (remaining > 0 && p.pathIndex < p.path.length) {
    const c = p.path[p.pathIndex], dx = c.x + .5 - p.x, dy = c.y + .5 - p.y, d = Math.hypot(dx, dy);
    if (d < 1e-5) { p.x = c.x + .5; p.y = c.y + .5; p.pathIndex++; continue; }
    const velocity = CLASS[p.class].speed * (p.delay ? .7 : 1) * (1 + .12 * ((at(c.x, c.y)?.level || 1) - 1));
    p.angle = Math.atan2(dy, dx);
    const step = Math.min(d, remaining * velocity);
    p.x += dx / d * step;
    p.y += dy / d * step;
    remaining -= step / velocity;
    if (step >= d - 1e-5) { p.x = c.x + .5; p.y = c.y + .5; p.pathIndex++; }
  }
  return p.pathIndex >= p.path.length;
}

// ---------- contracts ----------

function nextContractTime(after, slot, perDay) {
  const start = slot * 360;
  for (let day = Math.floor(after / 1440); day <= Math.floor(after / 1440) + 2; day++)
    for (let n = 0; n < perDay; n++) {
      const time = day * 1440 + start + n * 360 / perDay;
      if (time > after + .01) return time;
    }
  return after + 1440;
}

function contractRequirements(a) {
  const rows = [{label: 'Рабочая ВПП', ok: operationalRunways().length > 0}, {label: 'Репутация ' + a.min + '%', ok: G.rep >= a.min}];
  if (a.cargo) rows.push({label: 'Грузовой терминал ' + a.gate + ' ур. в сети', ok: operationalCargo().some(b => b.level >= a.gate)});
  else {
    rows.push({label: 'Гейт ' + a.gate + ' ур. у терминала', ok: G.buildings.some(b => b.type === 'gate' && b.level >= a.gate && terminalsNear(b))});
    rows.push({label: 'Терминал ' + a.terminal + ' ур.', ok: G.buildings.some(b => b.type === 'terminal' && b.level >= a.terminal)});
  }
  return rows;
}
const contractEligible = a => contractRequirements(a).every(r => r.ok);

function acceptContract(id, slot) {
  const a = airlineById(id);
  slot = +slot;
  if (!a || G.contracts.some(c => c.id === id) || !SLOTS.some(s => s.id === slot)) return false;
  if (!contractEligible(a)) { hooks.toast('Сначала выполните требования авиакомпании', 'warn'); return false; }
  if (G.contracts.filter(c => c.slot === slot).length >= 2) { hooks.toast('Это окно расписания заполнено: выберите другое', 'warn'); return false; }
  G.contracts.push({id, slot, nextAt: nextContractTime(G.minutes - 1, slot, a.perDay), completed: 0, onTime: 0, late: 0});
  portfolio.stats.contractsSigned++;
  log('Контракт ' + a.name + ' · ' + SLOTS[slot].label + ' · ' + a.perDay + ' рейсов в день');
  return true;
}

function moveContract(id, slot) {
  const c = G.contracts.find(q => q.id === id), a = airlineById(id);
  slot = +slot;
  if (!c || !a || !SLOTS.some(s => s.id === slot) || c.slot === slot) return false;
  if (G.contracts.filter(q => q.id !== id && q.slot === slot).length >= 2) { hooks.toast('Это окно расписания уже занято', 'warn'); return false; }
  c.slot = slot;
  c.nextAt = nextContractTime(G.minutes - 1, slot, a.perDay);
  log('Расписание ' + a.name + ' перенесено: ' + SLOTS[slot].label);
  return true;
}

const contractPenalty = c => c && c.completed ? 5000 : 0;
function cancelContract(id) {
  const c = G.contracts.find(q => q.id === id), a = airlineById(id);
  if (!c || !a) return false;
  const penalty = contractPenalty(c);
  G.contracts = G.contracts.filter(q => q !== c);
  if (penalty) spend(penalty, 'penalty');
  log('Контракт ' + a.name + ' расторгнут' + (penalty ? ' · штраф ' + cash(penalty) : ''));
  return true;
}

// ---------- goals ----------

function goalRows() {
  const r = place(G.location), runways = operationalRunways().length, gates = operationalGates().length, stats = G.contractStats;
  return [
    {label: 'Выполненные рейсы', value: G.served, target: r.flights, ratio: Math.min(1, G.served / r.flights),
      hint: 'Любые рейсы, включая грузовые, засчитываются после вылета. Свободные подключённые ВПП и гейты ускоряют поток.'},
    {label: 'Контрактные рейсы', value: stats.completed, target: r.contractFlights, ratio: Math.min(1, stats.completed / r.contractFlights), action: 'contracts',
      hint: 'Заключите контракты во вкладке «Рейсы». Каждый рейс авиакомпании засчитывается после вылета.'},
    {label: 'Вылеты без опозданий', value: stats.onTime, target: r.onTime, ratio: Math.min(1, stats.onTime / r.onTime), action: 'contracts',
      hint: 'Учитываются только контрактные рейсы, отправленные вовремя. Добавляйте полосы, гейты и службы, чтобы избежать очередей.'},
    {label: 'Репутация', value: Math.floor(G.rep), target: r.reputation, ratio: Math.min(1, G.rep / r.reputation),
      hint: 'Растёт за рейсы по расписанию, магазины и низкие сборы; задержки, уходы на запасной и минус на счёте снижают её.'},
    {label: 'Авиакомпании', value: G.contracts.length, target: r.contracts, ratio: Math.min(1, G.contracts.length / r.contracts), action: 'contracts',
      hint: 'Столько действующих контрактов нужно иметь одновременно.'},
    {label: 'ВПП и гейты', value: runways + ' / ' + gates, target: r.runways + ' / ' + r.gates, ratio: Math.min(1, runways / r.runways, gates / r.gates),
      display: 'ВПП ' + runways + '/' + r.runways + ' · гейты ' + gates + '/' + r.gates,
      hint: 'Первая цифра — рабочие ВПП с маршрутом к стоянкам; вторая — гейты у терминала, соединённые рулёжной сетью с полосой.'},
    {label: 'Особое здание: ' + TYPES[r.special].name, value: levelSum(r.special), target: 2, ratio: Math.min(1, levelSum(r.special) / 2),
      hint: 'Постройте «' + TYPES[r.special].name + '» и улучшите до 2 уровня либо постройте два таких здания.'}
  ];
}

function progress() {
  if (G.completed) return 100;
  const rows = goalRows();
  return rows.every(r => r.ratio >= 1) ? 100 : Math.min(99, Math.floor(rows.reduce((s, r) => s + r.ratio, 0) / rows.length * 100));
}

function ensureCompletion() {
  if (G.completed || progress() !== 100) return false;
  G.completed = true;
  const next = LOCATIONS[LOCATIONS.findIndex(l => l.id === G.location) + 1];
  if (next && !portfolio.unlocked.includes(next.id)) portfolio.unlocked.push(next.id);
  portfolio.points += 2;
  log('Аэропорт ' + place(G.location).name + ' развит на 100%' + (next ? ' · открыт ' + next.name : '') + ' · +2 очка развития');
  gainXP(150);
  hooks.completed(next);
  return true;
}

// ---------- traffic ----------

const holdLimit = () => 170 + 30 * perk('atc');

function seasonFactor() {
  const s = place(G.location).season;
  return s ? 1 + s.amp * Math.sin(G.minutes / 1440 * 2 * Math.PI / s.period + (s.phase || 0)) : 1;
}
function buff(kind, mult, minutes) { G.buffs[kind] = {mult, until: G.minutes + minutes}; }
function buffMult(kind) { const b = G.buffs[kind]; return b && b.until > G.minutes ? b.mult : 1; }
const surgeMult = () => G.surgeUntil > G.minutes ? G.surge : 1;
const demandNow = () => place(G.location).demand * seasonFactor() * (1 + .07 * perk('marketing')) * FEES[G.feePolicy].demand * surgeMult() * buffMult('demand');

const weatherNow = () => WEATHER[G.wx.kind] || WEATHER.clear;
const deicingRelief = () => Math.max(0, 1 - .2 * levelSum('deicing'));
function weatherApproach() {
  const extra = weatherNow().approach - 1;
  return 1 + (G.wx.kind === 'snow' ? extra * deicingRelief() : extra);
}
function weatherService() {
  const loss = 1 - (weatherNow().service || 1);
  return 1 - (G.wx.kind === 'snow' ? loss * deicingRelief() : loss);
}

const flightCode = (a, cls, charter) => (a ? a.code : charter ? 'CH' : CLASS[cls].cargo ? pick(['CG', 'FX', 'UP']) : pick(['SK', 'AZ', 'NL', 'BA', 'VN', 'AR', 'GO'])) + ' ' + Math.floor(rand(102, 987));

function randomClass() {
  if (operationalCargo().length && Math.random() < .2) return 'cargo';
  const canWide = G.served > 6 && G.buildings.some(b => b.type === 'gate' && b.level >= 2);
  if (canWide && Math.random() < .16) return 'wide';
  return Math.random() < .43 ? 'regional' : 'narrow';
}

function makeFlight(a = null, due = null, opts = {}) {
  if (G.planes.length >= MAX_PLANES) return null;
  const cls = opts.cls || (a ? a.cls : randomClass()), c = CLASS[cls];
  const p = {id: G.nextId++, code: flightCode(a, cls, opts.charter), class: cls, pax: 0, tons: 0, state: 'holding', x: -3, y: -3, alt: 0, angle: 0,
    progress: 0, service: 0, gateId: null, runwayId: null, path: [], pathIndex: 0, delay: 0, delayNotified: false, wait: 0,
    airlineId: a?.id || null, due, charter: !!opts.charter, dir: 1, retryAt: 0};
  if (c.cargo) p.tons = Math.round(rand(c.tons[0], c.tons[1]) * Math.min(1.3, .85 + .15 * demandNow()));
  else p.pax = Math.min(c.pax[1], Math.floor(rand(c.pax[0], c.pax[1]) * Math.min(1.5, demandNow() + .10 * levelSum('ferry'))));
  G.planes.push(p);
  log(p.code + ' запрашивает посадку · ' + (a ? a.name + ' · ' : p.charter ? 'чартер · ' : '') + c.label + ' · ' + (c.cargo ? p.tons + ' т' : p.pax + ' пасс.'));
  return p;
}

function scheduledFlights() {
  for (const contract of G.contracts) {
    const a = airlineById(contract.id);
    if (!a) continue;
    let guard = 0;
    while (G.minutes >= contract.nextAt && guard++ < 5) {
      const due = contract.nextAt;
      contract.nextAt = nextContractTime(due, contract.slot, a.perDay);
      if (!makeFlight(a, due)) {
        contract.late++;
        G.contractStats.late++;
        portfolio.stats.streak = 0;
        G.rep = clamp(G.rep - 1.5, 15, 100);
        spend(2200, 'penalty');
        log('Отменён рейс ' + a.name + ': аэропорт переполнен · штраф ' + cash(2200));
      }
    }
  }
}

function spawn() {
  const runways = operationalRunways(), capacity = Math.min(3, runways.reduce((s, r) => s + 1 + .18 * (r.level - 1), 0));
  G.nextFlight = G.minutes + (capacity ? rand(110, 145) / (Math.max(.85, demandNow()) * capacity) : 18);
  if (!capacity || G.planes.length >= MAX_RANDOM_PLANES) return;
  // Airlines avoid sending extra traffic into an already long holding stack.
  const holding = G.planes.filter(p => p.state === 'holding').length;
  if (holding >= Math.max(3, Math.ceil(operationalGates().length / 2) + 1)) return;
  makeFlight();
}

function availableStands(p) {
  const pool = CLASS[p.class].cargo ? operationalCargo() : operationalGates();
  return pool.filter(b => !b.gatePlane && b.level >= CLASS[p.class].required);
}

// Pick a free runway and a free stand that are connected right now, preferring the least used runway.
function entry(p) {
  const stands = availableStands(p);
  if (!stands.length) return false;
  const runways = operationalRunways().filter(r => !r.runwayPlane);
  if (!runways.length) return false;
  const owner = new Map();
  for (const s of stands) for (const [x, y] of standPorts(s)) if (!owner.has(k(x, y))) owner.set(k(x, y), s);
  const ends = [...owner.keys()].map(key => key.split(',').map(Number));
  let best = null;
  for (const r of runways) {
    const path = route(runwayPorts(r), ends, p.id);
    if (!path) continue;
    const last = path[path.length - 1], score = (r.arrivals || 0) * 1000 + path.length;
    if (!best || score < best.score) best = {r, s: owner.get(k(last.x, last.y)), path, score};
  }
  if (!best || !reserve(p, best.path)) return false;
  const {r, s, path} = best;
  r.arrivals = (r.arrivals || 0) + 1;
  r.runwayPlane = p.id;
  s.gatePlane = p.id;
  p.gateId = s.id;
  p.runwayId = r.id;
  p.state = 'approach';
  p.progress = 0;
  // Land towards the exit so the aircraft rolls out next to its taxiway instead of turning back.
  const a = runwayAxis(r), port = a.vertical ? path[0].y + .5 : path[0].x + .5;
  p.dir = port < a.a0 + a.len / 2 ? -1 : 1;
  approachPose(p, r);
  return true;
}

function approachPose(p, r) {
  const a = runwayAxis(r);
  const start = p.dir > 0 ? a.a0 - APPROACH_LEAD : a.a0 + a.len + APPROACH_LEAD;
  const end = p.dir > 0 ? a.a0 + a.len - 1 : a.a0 + 1;
  const touchdown = p.dir > 0 ? a.a0 + 2 : a.a0 + a.len - 2;
  const t = Math.min(p.progress, 1), along = start + (end - start) * (1 - Math.pow(1 - t, 1.7));
  const flown = (along - start) / (touchdown - start);
  p.alt = flown < 1 ? 3.4 * Math.pow(1 - flown, 1.15) : 0;
  const pt = runwayPoint(r, along);
  p.x = pt.x;
  p.y = pt.y;
  p.angle = runwayHeading(r, p.dir);
}

function exitGate(p) {
  const g = building(p.gateId);
  if (!g) return false;
  const owner = new Map();
  for (const r of G.buildings) if (r.type === 'runway' && !r.runwayPlane) for (const [x, y] of runwayPorts(r)) if (!owner.has(k(x, y))) owner.set(k(x, y), r);
  if (!owner.size) return false;
  const path = route(standPorts(g), [...owner.keys()].map(key => key.split(',').map(Number)), p.id);
  if (!path || !reserve(p, path)) return false;
  const r = owner.get(k(path[path.length - 1].x, path[path.length - 1].y));
  r.runwayPlane = p.id;
  p.runwayId = r.id;
  p.state = 'taxi_out';
  p.wait = 0;
  return true;
}

// True when some runway can be reached from the stand once traffic clears.
function canEverLeave(p) {
  const g = building(p.gateId);
  if (!g) return false;
  const ends = G.buildings.filter(b => b.type === 'runway').flatMap(runwayPorts);
  return ends.length > 0 && !!route(standPorts(g), ends, p.id, true);
}

function freePlane(p) {
  release(p);
  const r = building(p.runwayId), g = building(p.gateId);
  if (r && r.runwayPlane === p.id) r.runwayPlane = null;
  if (g && g.gatePlane === p.id) g.gatePlane = null;
}

// Diverted or cancelled flights earn nothing; contract flights also count as late and cost a penalty.
function failFlight(p, text, repLoss) {
  freePlane(p);
  const a = airlineById(p.airlineId);
  if (a) {
    const c = G.contracts.find(q => q.id === a.id);
    if (c) c.late++;
    G.contractStats.late++;
    portfolio.stats.streak = 0;
    spend(2200, 'penalty');
  }
  G.rep = clamp(G.rep - repLoss, 15, 100);
  G.diverted++;
  p.state = 'done';
  log(text + (a ? ' · штраф ' + cash(2200) : ''));
}

function flightEconomics(p) {
  const airline = airlineById(p.airlineId), cls = CLASS[p.class], fee = FEES[G.feePolicy];
  const late = !!airline && (p.delayNotified || G.minutes - (p.due ?? G.minutes) > airline.deadline);
  const onTime = !!airline && !late;
  const fuel = Math.min(.30, levelSum('fuel') * .09);
  const costMult = (1 - fuel) * (1 - .05 * perk('fuel')) * buffMult('fuel');
  const deal = airline ? airline.pay * (1 + .06 * perk('airline')) * (onTime ? 1.08 : .68) : p.charter ? 1.65 : .72;
  let revenue, expense, parking = 0;
  if (cls.cargo) {
    revenue = Math.round(p.tons * cls.fee * (.75 + G.rep / 400) * deal * fee.revenue);
    expense = Math.round(p.tons * cls.expense * costMult);
  } else {
    const terminal = levelSum('terminal');
    revenue = Math.round(p.pax * cls.fee * (1 + .12 * Math.max(0, terminal - 1)) * (.55 + G.rep / 170) * deal * (1 + .06 * levelSum('metro')) * shopsMultiplier() * fee.revenue);
    expense = Math.round(p.pax * cls.expense * costMult);
    parking = Math.round(p.pax * 3 * Math.min(6, levelSum('parking')));
  }
  return {airline, onTime, late, revenue, expense, parking, net: revenue + parking - expense};
}

function settleFlight(p) {
  const e = flightEconomics(p), stats = portfolio.stats, cls = CLASS[p.class];
  earn(e.revenue, 'flights');
  if (e.parking) earn(e.parking, 'parking');
  spend(e.expense, 'ops');
  G.served++;
  G.pax += p.pax;
  G.cargo += p.tons;
  stats.flights++;
  stats.pax += p.pax;
  if (cls.cargo) { stats.cargoFlights++; stats.cargoTons += p.tons; }
  if (Math.floor(G.minutes) % 1440 < 360) stats.nightFlights++;
  let rep = FEES[G.feePolicy].rep + (cls.cargo ? 0 : .03 * Math.min(6, activeShopLevels()));
  let xp = 2 + (cls.cargo ? 1 : 0) + (p.charter ? 2 : 0);
  if (e.airline) {
    const c = G.contracts.find(q => q.id === e.airline.id);
    G.contractStats.completed++;
    if (c) c.completed++;
    if (e.onTime) {
      G.contractStats.onTime++;
      if (c) c.onTime++;
      stats.streak++;
      stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
      xp += 2;
    } else {
      G.contractStats.late++;
      if (c) c.late++;
      stats.streak = 0;
    }
    rep += e.onTime ? 1 : -.9;
  } else rep += p.delayNotified ? -.5 : p.charter ? .5 : .15;
  G.rep = clamp(G.rep + rep, 15, 100);
  log(p.code + ' вылетел: ' + signedCash(e.net) + ' · ' + (cls.cargo ? p.tons + ' т груза' : p.pax + ' пассажиров') + (e.airline ? (e.onTime ? ' · вовремя' : ' · опоздал') : ''));
  gainXP(xp);
}

function finish(p) {
  freePlane(p);
  settleFlight(p);
  p.state = 'done';
}

function stepPlane(p, dt) {
  p.wait += dt;
  const r = building(p.runwayId), g = building(p.gateId);
  switch (p.state) {
    case 'holding':
      if (G.minutes >= (p.retryAt || 0)) {
        if (entry(p)) { p.wait = 0; break; }
        p.retryAt = G.minutes + 1.5;
      }
      if (p.wait > 90 && !p.delayNotified) { p.delayNotified = true; G.rep = clamp(G.rep - 1, 15, 100); log(p.code + ' ожидает свободную полосу и гейт'); }
      if (p.wait > holdLimit()) {
        failFlight(p, p.code + ' ушёл на запасной аэродром: не дождался посадки', p.airlineId ? 2.5 : .8);
        hooks.toast(p.code + ' ушёл на запасной аэродром', 'warn');
      }
      break;
    case 'approach':
      if (!r || !g) { failFlight(p, p.code + ' ушёл на второй круг и улетел', 1); break; }
      p.progress += dt / (APPROACH_TIME * weatherApproach() / (1 + .15 * (r.level - 1)));
      approachPose(p, r);
      if (p.progress >= 1) {
        p.state = 'exit_runway';
        p.progress = 0;
        p.alt = 0;
        p.startX = p.x; p.startY = p.y;
        p.targetX = p.path[0].x + .5; p.targetY = p.path[0].y + .5;
        p.angle = Math.atan2(p.targetY - p.y, p.targetX - p.x);
        if (weatherNow().bad) portfolio.stats.badWeatherLandings++;
      }
      break;
    case 'exit_runway':
      p.progress = Math.min(1, p.progress + dt * (1 + .15 * ((r?.level || 1) - 1)) / 2);
      p.x = p.startX + (p.targetX - p.startX) * p.progress;
      p.y = p.startY + (p.targetY - p.startY) * p.progress;
      if (p.progress >= 1) {
        p.state = 'taxi_in';
        p.pathIndex = 1;
        if (r && r.runwayPlane === p.id) r.runwayPlane = null;
        log(p.code + ' приземлился, рулит к ' + (g?.type === 'cargo' ? 'грузовой стоянке ' : 'гейту ') + standLabel(g));
      }
      break;
    case 'taxi_in':
      if (!g) { failFlight(p, p.code + ': стоянка исчезла, рейс отменён', 2); break; }
      if (cruise(p, dt)) { const s = standPoint(g, p); p.state = 'dock'; p.angle = Math.atan2(s.y - p.y, s.x - p.x); }
      break;
    case 'dock': {
      if (!g) { failFlight(p, p.code + ': стоянка исчезла, рейс отменён', 2); break; }
      const s = standPoint(g, p), dx = s.x - p.x, dy = s.y - p.y, d = Math.hypot(dx, dy), step = Math.min(d, dt * .65);
      if (d > 0) { p.x += dx / d * step; p.y += dy / d * step; }
      if (d < .015 || step >= d) {
        p.x = s.x; p.y = s.y;
        release(p);
        p.state = 'service';
        p.service = 0;
        p.angle = standHeading(g);
        log(p.code + ' на стоянке ' + standLabel(g) + ' · обслуживание');
      }
      break;
    }
    case 'service': {
      const power = levelSum('service');
      if (p.delay > 0) { p.delay -= dt * (1 + power * .25); break; }
      const crew = (1 + .1 * perk('ground')) * buffMult('service') * weatherService() * (CLASS[p.class].cargo ? 1 + .2 * ((g?.level || 1) - 1) : 1);
      p.service += dt * crew / (CLASS[p.class].service * Math.max(.52, 1 - power * .08));
      if (p.service >= 1) { p.service = 1; p.state = 'ready'; p.wait = 0; p.retryAt = 0; }
      break;
    }
    case 'ready':
      if (G.minutes >= (p.retryAt || 0)) {
        if (exitGate(p)) {
          if (g && g.gatePlane === p.id) g.gatePlane = null;
          log(p.code + ' выруливает на взлёт');
          break;
        }
        p.retryAt = G.minutes + 1;
      }
      if (p.wait > 75 && !p.delayNotified) { p.delayNotified = true; G.rep = clamp(G.rep - 1, 15, 100); log(p.code + ' задержан: маршрут или ВПП заняты'); }
      if (p.wait > 120 && G.minutes >= (p.routeCheckAt || 0)) {
        p.routeCheckAt = G.minutes + 30;
        if (!canEverLeave(p)) {
          failFlight(p, 'Рейс ' + p.code + ' отменён: от стоянки нет пути к ВПП', 3);
          hooks.toast('Рейс ' + p.code + ' отменён: стоянка отрезана от ВПП', 'warn');
        }
      }
      break;
    case 'taxi_out':
      if (!r) { failFlight(p, 'Рейс ' + p.code + ' отменён: полоса недоступна', 2); break; }
      if (cruise(p, dt)) {
        const a = runwayAxis(r), pos = a.vertical ? p.y : p.x;
        p.state = 'lineup';
        p.progress = 0;
        p.startX = p.x; p.startY = p.y;
        p.dir = pos > a.a0 + a.len / 2 ? -1 : 1;
        const t = runwayPoint(r, p.dir > 0 ? a.a0 + .3 : a.a0 + a.len - .3);
        p.targetX = t.x; p.targetY = t.y;
      }
      break;
    case 'lineup': {
      if (!r) { failFlight(p, 'Рейс ' + p.code + ' отменён: полоса недоступна', 2); break; }
      p.progress = Math.min(1, p.progress + dt / 2.5);
      p.x = p.startX + (p.targetX - p.startX) * p.progress;
      p.y = p.startY + (p.targetY - p.startY) * p.progress;
      const target = runwayHeading(r, p.dir), delta = Math.atan2(Math.sin(target - p.angle), Math.cos(target - p.angle));
      p.angle += delta * Math.min(1, dt * .85);
      if (p.progress >= 1) { release(p); p.state = 'takeoff'; p.progress = 0; p.angle = target; p.runwayFree = false; }
      break;
    }
    case 'takeoff': {
      if (!r) { finish(p); break; }
      const a = runwayAxis(r);
      p.progress += dt * (1 + .15 * (r.level - 1)) / TAKEOFF_TIME;
      const dist = Math.min(p.progress, 1) * (a.len + TAKEOFF_TAIL), rotateAt = a.len * .62;
      const pt = runwayPoint(r, p.dir > 0 ? a.a0 + .3 + dist : a.a0 + a.len - .3 - dist);
      p.x = pt.x; p.y = pt.y;
      p.angle = runwayHeading(r, p.dir);
      p.alt = dist > rotateAt ? Math.pow((dist - rotateAt) / (a.len + TAKEOFF_TAIL - rotateAt), 1.25) * 4.2 : 0;
      if (!p.runwayFree && dist >= a.len - .3) { p.runwayFree = true; if (r.runwayPlane === p.id) r.runwayPlane = null; }
      if (p.progress >= 1) finish(p);
      break;
    }
  }
}

// ---------- incidents, weather and decisions ----------

const incidentChance = () => .55 / (1 + .45 * levelSum('tower')) * (1 - .1 * perk('atc')) * weatherNow().incident;

function incident() {
  const roll = Math.random();
  if (roll < .13 && G.location === 'city') {
    G.surge = 1.8; G.surgeUntil = G.minutes + rand(90, 140);
    log('Деловой форум: вырос спрос на перелёты');
    hooks.toast('Деловой форум в городе: спрос ×1.8', 'info');
  } else if (roll < .34) {
    G.surge = rand(1.45, 1.85); G.surgeUntil = G.minutes + rand(75, 115);
    log('Наплыв пассажиров! Спрос вырос до ×' + G.surge.toFixed(1));
    hooks.toast('Наплыв пассажиров: больше рейсов и доходов', 'info');
  } else if (roll < .72) {
    const p = pick(G.planes.filter(q => ['service', 'holding', 'taxi_in'].includes(q.state)));
    if (p) {
      p.delay += rand(12, 28);
      p.delayNotified = true;
      G.rep = clamp(G.rep - 1, 15, 100);
      log('Техническая задержка ' + p.code + ' · службы ускорят ремонт');
      hooks.toast('Задержка ' + p.code, 'warn');
    } else log('Нагрузка на службы повышена');
  } else {
    const p = G.planes.find(q => q.state === 'service' && !q.delay);
    if (p) {
      p.delay += rand(25, 46);
      p.delayNotified = true;
      G.rep = clamp(G.rep - 2, 15, 100);
      log('Поломка оборудования у ' + p.code);
      hooks.toast('Поломка у ' + p.code, 'warn');
    } else log('Плановая проверка оборудования прошла без замечаний');
  }
}

function updateWeather() {
  if (G.minutes < G.wx.until) return;
  const previous = G.wx.kind, kind = WEATHER[G.wx.next] ? G.wx.next : pickWeather(G.location, previous), w = WEATHER[kind];
  G.wx = {kind, until: G.minutes + (w.bad ? rand(90, 240) : rand(200, 480)), next: pickWeather(G.location, kind)};
  if (kind === previous) return;
  log('Погода: ' + w.name.toLowerCase() + (w.bad ? ' · посадки займут больше времени' : ''));
  if (w.bad) hooks.toast(w.icon + ' ' + w.name + ': посадки медленнее', 'warn');
}

const DECISIONS = [
  {id: 'charter', icon: '✈', title: 'Чартер для спортивной команды',
    text: () => 'Клуб просит срочный рейс и платит в 1,65 раза больше обычного. Нужны свободные ВПП и гейт.',
    when: () => operationalRunways().length > 0 && operationalGates().length > 0,
    options: [
      {label: 'Принять рейс', apply: () => makeFlight(null, G.minutes, {charter: true, cls: G.buildings.some(b => b.type === 'gate' && b.level >= 2) ? 'wide' : 'narrow'}) ? 'чартер уже в пути' : 'мест нет, рейс ушёл в другой аэропорт'},
      {label: 'Отказать', apply: () => 'клуб выбрал другой аэропорт'}]},
  {id: 'union', icon: '✚', title: 'Наземные службы просят премию',
    text: d => 'Бригады готовы работать на 25% быстрее целые сутки за ' + cash(d.cost) + '. Отказ замедлит обслуживание на полдня.',
    cost: () => 4000 + 900 * count('gate'),
    options: [
      {label: 'Выплатить премию', paid: true, apply: () => { buff('service', 1.25, 1440); return 'обслуживание +25% на сутки'; }},
      {label: 'Отказать', apply: () => { buff('service', .85, 720); G.rep = clamp(G.rep - 2, 15, 100); return 'обслуживание −15%, репутация −2'; }}]},
  {id: 'inspection', icon: '♜', title: 'Проверка безопасности',
    text: d => 'Инспекция предлагает добровольный аудит за ' + cash(d.cost) + '. Если отложить, возможен штраф $15 000.',
    cost: () => 9000,
    options: [
      {label: 'Пройти аудит', paid: true, apply: () => { G.rep = clamp(G.rep + 3, 15, 100); return 'репутация +3'; }},
      {label: 'Отложить', apply: () => {
        if (Math.random() < .5) { spend(15000, 'penalty'); G.rep = clamp(G.rep - 3, 15, 100); return 'штраф ' + cash(15000) + ', репутация −3'; }
        return 'обошлось без штрафа';
      }}]},
  {id: 'marketing', icon: '☺', title: 'Рекламная кампания',
    text: d => 'Агентство предлагает кампанию за ' + cash(d.cost) + ': пассажирский спрос вырастет на 35% на сутки.',
    cost: () => 8000 + 1500 * operationalRunways().length + 500 * count('gate'),
    options: [
      {label: 'Запустить', paid: true, apply: () => { buff('demand', 1.35, 1440); return 'спрос +35% на сутки'; }},
      {label: 'Не сейчас', apply: () => ''}]},
  {id: 'fuel', icon: '◈', title: 'Скачок цен на топливо',
    text: d => 'Поставщик предлагает зафиксировать цену за ' + cash(d.cost) + '. Иначе расходы на рейсы вырастут на 15% на сутки.',
    cost: () => 5000 + 700 * count('gate'),
    options: [
      {label: 'Зафиксировать', paid: true, apply: () => 'расходы под контролем'},
      {label: 'Рискнуть', apply: () => { buff('fuel', 1.15, 1440); return 'расходы на рейсы +15% на сутки'; }}]},
  {id: 'festival', icon: '★', title: 'Городской фестиваль',
    text: d => 'Организаторы ищут партнёра за ' + cash(d.cost) + ': +2 репутации и +20% спроса на полдня.',
    cost: () => 8000,
    options: [
      {label: 'Стать партнёром', paid: true, apply: () => { G.rep = clamp(G.rep + 2, 15, 100); buff('demand', 1.2, 720); return 'репутация +2, спрос +20%'; }},
      {label: 'Пропустить', apply: () => ''}]}
];
const decisionDef = id => DECISIONS.find(d => d.id === id) || null;

function updateDecision() {
  if (G.decision) {
    if (G.minutes >= G.decision.expires) resolveDecision(decisionDef(G.decision.id)?.options.length - 1, true);
    return;
  }
  if (G.minutes < G.nextDecision || G.served < 3) return;
  const options = DECISIONS.filter(d => !d.when || d.when());
  G.nextDecision = G.minutes + rand(720, 1300);
  if (!options.length) return;
  const def = pick(options);
  G.decision = {id: def.id, cost: def.cost ? Math.round(def.cost()) : 0, expires: G.minutes + 240};
  log('Требуется решение: ' + def.title);
  hooks.decision(def);
}

function resolveDecision(index, auto = false) {
  const d = G.decision, def = d && decisionDef(d.id);
  if (!def) { G.decision = null; return false; }
  let opt = def.options[index];
  if (!opt) return false;
  if (opt.paid && G.money < d.cost) {
    if (!auto) { hooks.toast('Недостаточно средств: нужно ' + cash(d.cost), 'warn'); return false; }
    opt = def.options[def.options.length - 1];
  }
  G.decision = null;
  if (opt.paid) spend(d.cost, 'events');
  const result = opt.apply ? opt.apply(d) : '';
  if (!auto) portfolio.stats.decisions++;
  const text = def.title + ': ' + (auto ? 'время вышло, ' + opt.label.toLowerCase() : opt.label.toLowerCase()) + (result ? ' · ' + result : '');
  log(text);
  hooks.toast(def.icon + ' ' + text, auto ? 'warn' : 'info');
  return true;
}

// ---------- economy ----------

function earn(amount, category) {
  amount = Math.round(amount);
  G.money += amount; G.today += amount; G.earned += amount;
  G.ledger.income[category] = (G.ledger.income[category] || 0) + amount;
}
function spend(amount, category) {
  amount = Math.round(amount);
  G.money -= amount; G.today -= amount; G.spent += amount;
  G.ledger.costs[category] = (G.ledger.costs[category] || 0) + amount;
}
const total = obj => Object.values(obj || {}).reduce((a, b) => a + b, 0);

function dailyUpkeep() {
  const raw = G.buildings.reduce((s, b) => s + (TYPES[b.type].upkeep || 0) * b.level, 0);
  return Math.round(raw * (1 - Math.min(.35, levelSum('solar') * .07)) * (1 - .06 * perk('upkeep')));
}
const dailyInterest = () => Math.round(G.loan * LOAN_RATE);

function endOfDay(days) {
  const upkeep = dailyUpkeep(), interest = dailyInterest();
  spend(upkeep, 'upkeep');
  if (interest) spend(interest, 'interest');
  G.history.push({day: G.day, income: total(G.ledger.income), costs: total(G.ledger.costs), profit: G.today});
  if (G.history.length > 14) G.history.splice(0, G.history.length - 14);
  G.lastLedger = G.ledger;
  G.ledger = emptyLedger();
  G.lastDay = G.today;
  G.today = 0;
  G.day += days;
  log('Суточное содержание: ' + cash(upkeep) + (interest ? ' · проценты по кредиту ' + cash(interest) : ''));
  if (G.money < 0) {
    G.rep = clamp(G.rep - 2, 15, 100);
    hooks.toast('Баланс отрицательный: репутация падает. Возьмите кредит или сократите расходы', 'warn');
  }
}

const loanLimit = () => Math.min(400000, 60000 + 20000 * (rank() - 1));
function takeLoan(amount = LOAN_STEP) {
  amount = Math.min(amount, loanLimit() - G.loan);
  if (amount <= 0) { hooks.toast('Кредитный лимит исчерпан', 'warn'); return false; }
  G.loan += amount;
  G.money += amount;
  log('Получен кредит ' + cash(amount) + ' · ставка ' + (LOAN_RATE * 100).toFixed(1) + '% в сутки');
  return true;
}
function repayLoan(amount = LOAN_STEP) {
  amount = Math.min(amount, G.loan, Math.max(0, G.money));
  if (amount <= 0) { hooks.toast(G.loan ? 'Недостаточно средств для погашения' : 'Кредитов нет', 'warn'); return false; }
  G.loan -= amount;
  G.money -= amount;
  log('Погашено ' + cash(amount) + ' кредита' + (G.loan ? ' · осталось ' + cash(G.loan) : ' · долг закрыт'));
  if (!G.loan) portfolio.stats.loansRepaid++;
  return true;
}

function setFeePolicy(id) {
  if (!FEES[id] || G.feePolicy === id) return false;
  G.feePolicy = id;
  log('Аэропортовые сборы: ' + FEES[id].label.toLowerCase());
  return true;
}

// ---------- progression ----------

const xpForRank = r => r <= 1 ? 0 : Math.round(45 * Math.pow(r - 1, 1.75));
function rankFromXP(xp) { let r = 1; while (r < MAX_RANK && xp >= xpForRank(r + 1)) r++; return r; }
const rank = () => rankFromXP(portfolio?.xp || 0);
function rankTitle(r = rank()) { let title = RANK_TITLES[0][1]; for (const [n, t] of RANK_TITLES) if (r >= n) title = t; return title; }

function gainXP(n) {
  const before = rank();
  portfolio.xp += n;
  const after = rank();
  if (after > before) {
    portfolio.points += after - before;
    log('Новый ранг: ' + after + ' · ' + rankTitle(after) + ' · +' + (after - before) + ' очк. развития');
    hooks.rankUp(after);
  }
}

const perkCost = def => def.costs[perk(def.id)];
function buyPerk(id) {
  const def = PERKS.find(p => p.id === id);
  if (!def || perk(id) >= def.costs.length) return false;
  const cost = perkCost(def);
  if (portfolio.points < cost) { hooks.toast('Нужно очков развития: ' + cost, 'warn'); return false; }
  portfolio.points -= cost;
  portfolio.perks[id] = perk(id) + 1;
  log('Развитие: ' + def.title + ' · уровень ' + portfolio.perks[id]);
  return true;
}

function checkAchievements() {
  for (const a of ACHIEVEMENTS) {
    if (portfolio.achievements[a.id] || !a.test(portfolio.stats)) continue;
    portfolio.achievements[a.id] = Date.now();
    if (a.cash) earn(a.cash, 'bonus');
    log('Достижение «' + a.title + '»' + (a.cash ? ' · ' + signedCash(a.cash) : '') + ' · +' + a.xp + ' XP');
    hooks.achievement(a);
    gainXP(a.xp);
  }
}

// ---------- main tick ----------

function tick(dt) {
  const oldDay = Math.floor(G.minutes / 1440);
  G.minutes += dt;
  scheduledFlights();
  const newDay = Math.floor(G.minutes / 1440);
  if (newDay !== oldDay) endOfDay(newDay - oldDay);
  if (G.surgeUntil && G.minutes >= G.surgeUntil) { G.surgeUntil = 0; G.surge = 1; log('Пассажиропоток вернулся к обычному уровню'); }
  updateWeather();
  updateDecision();
  if (G.minutes >= G.nextFlight) spawn();
  if (G.minutes >= G.nextEvent) {
    if (Math.random() < incidentChance()) incident();
    G.nextEvent = G.minutes + rand(65, 105);
  }
  for (const p of G.planes) if (p.state !== 'done') stepPlane(p, dt);
  G.planes = G.planes.filter(p => p.state !== 'done');
}

// Advances the active airport by `minutes` of game time in stable steps.
function advance(minutes) {
  const steps = Math.ceil(minutes / 1.5);
  for (let i = 0; i < steps; i++) tick(minutes / steps);
}
