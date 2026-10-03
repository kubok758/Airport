'use strict';
/* Airport state: creation, grid helpers, the building index and save normalisation/migration. */

let G = null;          // the airport currently on screen
let portfolio = null;  // every airport plus global progression (rank, perks, achievements)

// The simulation reports to the renderer and UI through hooks, so it also runs headless in tests.
const hooks = {log() {}, toast() {}, structure() {}, achievement() {}, rankUp() {}, decision() {}, completed() {}};

const place = id => LOCATIONS.find(p => p.id === id) || LOCATIONS[0];
const airlineById = id => AIRLINES.find(a => a.id === id) || null;
const perk = id => portfolio?.perks?.[id] || 0;
const dims = (type, rot) => rot ? {w: TYPES[type].h, h: TYPES[type].w} : {w: TYPES[type].w, h: TYPES[type].h};

// Building geometry is described in local coordinates: u runs along the unrotated width, v along the depth.
// A rotated building is turned 90° clockwise (a true rotation, not a mirror, so triangle winding survives).
function localToWorld(b, u, v) { return b.rot ? {x: b.x + TYPES[b.type].h - v, y: b.y + u} : {x: b.x + u, y: b.y + v}; }

let bIndex = new Map(), bIndexFor = null, bIndexDirty = true;
let topologyCache = null, topologyFor = null, topologyDirty = true;

function markStructure() { bIndexDirty = true; topologyDirty = true; hooks.structure(); }
function markVisual() { hooks.structure(); }

function building(id) {
  if (id === null || id === undefined) return null;
  if (bIndexDirty || bIndexFor !== G) {
    bIndex = new Map(G.buildings.map(b => [b.id, b]));
    bIndexFor = G;
    bIndexDirty = false;
  }
  return bIndex.get(id) || null;
}
const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H ? building(G.grid[y * W + x]) : null;
const isTaxi = (x, y) => at(x, y)?.type === 'taxi';
const count = type => G.buildings.reduce((n, b) => n + (b.type === type ? 1 : 0), 0);
const levelSum = type => G.buildings.reduce((n, b) => n + (b.type === type ? b.level : 0), 0);
const inside = c => !!c && c.x >= 0 && c.y >= 0 && c.x < W && c.y < H;

function airportTime(minutes = G.minutes) {
  const m = Math.floor(minutes) % 1440;
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}

function log(text) {
  G.logs.unshift({t: airportTime(), text});
  G.logs.length = Math.min(G.logs.length, 40);
  hooks.log(text);
}

const emptyLedger = () => ({income: {}, costs: {}});
const emptyStats = () => ({flights: 0, pax: 0, cargoFlights: 0, cargoTons: 0, contractsSigned: 0, nightFlights: 0, badWeatherLandings: 0,
  decisions: 0, loansRepaid: 0, streak: 0, bestStreak: 0});

function placeBuilding(g, type, x, y, rot = 0) {
  const {w, h} = dims(type, rot);
  const b = {id: g.nextId++, type, x, y, w, h, rot: rot ? 1 : 0, level: 1, gatePlane: null, runwayPlane: null};
  g.buildings.push(b);
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) g.grid[yy * W + xx] = b.id;
  return b;
}

function pickWeather(location, previous) {
  const table = Object.entries(place(location).weather);
  const weights = table.map(([id, w]) => id === previous ? w * .5 : w);
  let roll = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < table.length; i++) { roll -= weights[i]; if (roll <= 0) return table[i][0]; }
  return table[0][0];
}

function fresh(location = 'main', capitalBonus = 0) {
  const loc = place(location);
  const g = {version: AIRPORT_VERSION, location: loc.id, completed: false, progress: 0,
    contracts: [], contractStats: {completed: 0, onTime: 0, late: 0},
    grid: Array(W * H).fill(null), buildings: [], planes: [], reservations: {}, nextId: 1,
    money: 110000 + loc.boost + capitalBonus, pax: 0, cargo: 0, served: 0, diverted: 0, earned: 0, spent: 0, rep: 74,
    minutes: 480, day: 1, today: 0, lastDay: 0, ledger: emptyLedger(), lastLedger: null, history: [],
    nextFlight: 490, nextEvent: 565, nextDecision: 480 + rand(520, 820), surge: 1, surgeUntil: 0, buffs: {},
    feePolicy: 'standard', loan: 0, decision: null,
    wx: {kind: 'clear', until: 480 + rand(220, 420), next: pickWeather(loc.id, 'clear')}, logs: []};
  for (const [kind, a, b, c, d] of loc.layout) {
    if (kind === 'taxiV') for (let y = b; y <= c; y++) placeBuilding(g, 'taxi', a, y);
    else if (kind === 'taxiH') for (let x = b; x <= c; x++) placeBuilding(g, 'taxi', x, a);
    else placeBuilding(g, kind, a, b, c || 0);
  }
  g.logs.unshift({t: '08:00', text: 'Аэропорт открыт. Соедините новые объекты рулёжными дорожками.'});
  return g;
}

function freshPortfolio() {
  const main = fresh('main');
  return {version: SAVE_VERSION, active: 'main', unlocked: ['main'], airports: {main}, views: {},
    xp: 0, points: 0, perks: {}, achievements: {}, stats: emptyStats(), seenIntro: false, seenVersion: SAVE_VERSION};
}

const num = (v, fallback) => Number.isFinite(v) ? v : fallback;
const PLANE_STATES = ['holding', 'approach', 'exit_runway', 'taxi_in', 'dock', 'service', 'ready', 'taxi_out', 'lineup', 'takeoff'];

// Validates an airport from any save version and brings it to the current format in place.
function normalizeAirport(g, id) {
  if (!g || typeof g !== 'object' || ![1, 2].includes(g.version) || !Array.isArray(g.grid) || g.grid.length !== W * H ||
      !Array.isArray(g.buildings) || !Array.isArray(g.planes) || !g.reservations || typeof g.reservations !== 'object' || !Number.isFinite(g.money))
    throw Error('Некорректное сохранение');
  const loc = place(id);
  g.version = AIRPORT_VERSION;
  g.location = loc.id;

  // Buildings are the source of truth: the grid is rebuilt from them and overlaps reject the save.
  const grid = Array(W * H).fill(null), seen = new Set();
  g.buildings = g.buildings.filter(b => b && TYPES[b.type] && Number.isInteger(b.id) && !seen.has(b.id) && Number.isInteger(b.x) && Number.isInteger(b.y));
  for (const b of g.buildings) {
    seen.add(b.id);
    const t = TYPES[b.type];
    b.rot = b.rot || (b.w === t.h && b.h === t.w && t.w !== t.h) ? 1 : 0;
    const d = dims(b.type, b.rot);
    b.w = d.w; b.h = d.h;
    b.level = clamp(Math.round(num(b.level, 1)), 1, 3);
    if (b.x < 0 || b.y < 0 || b.x + b.w > W || b.y + b.h > H) throw Error('Постройка за пределами карты');
    for (let yy = b.y; yy < b.y + b.h; yy++) for (let xx = b.x; xx < b.x + b.w; xx++) {
      if (grid[yy * W + xx] !== null) throw Error('Постройки пересекаются');
      grid[yy * W + xx] = b.id;
    }
  }
  g.grid = grid;
  const byId = new Map(g.buildings.map(b => [b.id, b]));

  g.planes = g.planes.filter(p => p && CLASS[p.class] && PLANE_STATES.includes(p.state) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isInteger(p.id));
  for (const p of g.planes) {
    p.path = Array.isArray(p.path) ? p.path.filter(c => c && Number.isInteger(c.x) && Number.isInteger(c.y)) : [];
    p.pathIndex = clamp(num(p.pathIndex, 0), 0, p.path.length);
    p.pax = num(p.pax, 0); p.tons = num(p.tons, 0); p.alt = num(p.alt, 0);
    p.progress = num(p.progress, 0); p.service = num(p.service, 0); p.delay = num(p.delay, 0); p.wait = num(p.wait, 0);
    p.dir = p.dir === -1 || p.departDir === -1 ? -1 : 1;
    p.code = String(p.code || 'XX 100').slice(0, 12);
    if (p.airlineId && !airlineById(p.airlineId)) p.airlineId = null;
  }
  // Drop aircraft whose stand or runway vanished; they would freeze in place.
  const needsStand = ['approach', 'exit_runway', 'taxi_in', 'dock', 'service', 'ready'], needsRunway = ['approach', 'exit_runway', 'taxi_out', 'lineup'];
  g.planes = g.planes.filter(p => (!needsStand.includes(p.state) || byId.has(p.gateId)) && (!needsRunway.includes(p.state) || byId.has(p.runwayId)) &&
    (!['exit_runway', 'taxi_in', 'taxi_out'].includes(p.state) || p.path.length));
  const planeIds = new Set(g.planes.map(p => p.id));
  for (const b of g.buildings) {
    b.gatePlane = planeIds.has(b.gatePlane) ? b.gatePlane : null;
    b.runwayPlane = planeIds.has(b.runwayPlane) ? b.runwayPlane : null;
  }
  for (const key of Object.keys(g.reservations)) if (!planeIds.has(g.reservations[key])) delete g.reservations[key];
  const maxId = Math.max(0, ...g.buildings.map(b => b.id), ...g.planes.map(p => p.id));
  g.nextId = Math.max(num(g.nextId, 1), maxId + 1);

  g.completed = !!g.completed;
  g.progress = num(g.progress, 0);
  for (const key of ['pax', 'cargo', 'served', 'diverted', 'earned', 'spent', 'today', 'lastDay']) g[key] = num(g[key], 0);
  g.rep = clamp(num(g.rep, 74), 15, 100);
  g.minutes = Math.max(0, num(g.minutes, 480));
  g.day = Math.max(1, Math.round(num(g.day, 1)));
  g.nextFlight = num(g.nextFlight, g.minutes + 10);
  g.nextEvent = num(g.nextEvent, g.minutes + 60);
  g.nextDecision = num(g.nextDecision, g.minutes + rand(400, 800));
  g.loan = Math.max(0, num(g.loan, 0));
  g.feePolicy = FEES[g.feePolicy] ? g.feePolicy : 'standard';
  g.buffs = g.buffs && typeof g.buffs === 'object' ? g.buffs : {};
  g.ledger = g.ledger && g.ledger.income && g.ledger.costs ? g.ledger : emptyLedger();
  g.history = Array.isArray(g.history) ? g.history.filter(h => h && Number.isFinite(h.profit)).slice(-14) : [];
  g.logs = Array.isArray(g.logs) ? g.logs.filter(e => e && typeof e.text === 'string').slice(0, 40) : [];
  if (g.decision && !(g.decision.id && Number.isFinite(g.decision.expires))) g.decision = null;

  // Version 1 kept a raw demand multiplier and a "bad weather until" timestamp.
  if (!Number.isFinite(g.surge)) {
    const boosted = Number.isFinite(g.boostUntil) && g.boostUntil > g.minutes && Number.isFinite(g.demand);
    g.surge = boosted ? Math.max(1, g.demand / loc.demand) : 1;
    g.surgeUntil = boosted ? g.boostUntil : 0;
  }
  if (!g.wx || !WEATHER[g.wx.kind]) {
    const stormy = Number.isFinite(g.weather) && g.weather > g.minutes;
    const kind = stormy ? ({island: 'storm', desert: 'sand'}[loc.id] || 'fog') : 'clear';
    g.wx = {kind, until: stormy ? g.weather : g.minutes + rand(200, 400), next: pickWeather(loc.id, kind)};
  }
  if (!WEATHER[g.wx.next]) g.wx.next = pickWeather(loc.id, g.wx.kind);
  delete g.demand; delete g.boostUntil; delete g.weather;

  g.contracts = Array.isArray(g.contracts) ? g.contracts.filter(c => c && airlineById(c.id) && SLOTS.some(s => s.id === c.slot)) : [];
  const stats = g.contractStats;
  g.contractStats = stats && Number.isFinite(stats.completed) ? {completed: stats.completed, onTime: num(stats.onTime, 0), late: num(stats.late, 0)} : {completed: 0, onTime: 0, late: 0};
  for (const c of g.contracts) {
    c.completed = num(c.completed, 0); c.onTime = num(c.onTime, 0); c.late = num(c.late, 0);
    if (!Number.isFinite(c.nextAt)) c.nextAt = nextContractTime(g.minutes - 1, c.slot, airlineById(c.id).perDay);
  }
  return g;
}

// Validates the whole collection; older saves get progression derived from what the player already achieved.
function normalizePortfolio(p) {
  if (!p || typeof p !== 'object' || !p.airports || typeof p.airports !== 'object') throw Error('Некорректная коллекция');
  for (const [id, g] of Object.entries(p.airports)) {
    if (LOCATIONS.some(l => l.id === id)) normalizeAirport(g, id);
    else delete p.airports[id];
  }
  if (!p.airports.main) p.airports.main = fresh('main');
  p.unlocked = Array.isArray(p.unlocked) ? p.unlocked.filter(id => LOCATIONS.some(l => l.id === id)) : ['main'];
  if (!p.unlocked.includes('main')) p.unlocked.unshift('main');
  for (let i = 1; i < LOCATIONS.length; i++)
    if (p.airports[LOCATIONS[i - 1].id]?.completed && !p.unlocked.includes(LOCATIONS[i].id)) p.unlocked.push(LOCATIONS[i].id);
  if (!LOCATIONS.some(l => l.id === p.active) || !p.airports[p.active] || !p.unlocked.includes(p.active)) p.active = 'main';
  p.views = p.views && typeof p.views === 'object' ? p.views : {};

  const airports = Object.values(p.airports);
  const completedCount = airports.filter(g => g.completed).length;
  if (!Number.isFinite(p.xp)) {
    p.xp = airports.reduce((s, g) => s + g.served * 2 + g.contractStats.onTime * 2 + (g.completed ? 150 : 0), 0);
    p.points = rankFromXP(p.xp) - 1 + completedCount * 2;
    p.migrated = true;
  }
  p.points = Math.max(0, Math.round(num(p.points, 0)));
  p.perks = p.perks && typeof p.perks === 'object' ? p.perks : {};
  for (const id of Object.keys(p.perks)) {
    const def = PERKS.find(q => q.id === id);
    if (!def) delete p.perks[id];
    else p.perks[id] = clamp(Math.round(num(p.perks[id], 0)), 0, def.costs.length);
  }
  p.achievements = p.achievements && typeof p.achievements === 'object' ? p.achievements : {};
  const base = emptyStats();
  if (!p.stats || typeof p.stats !== 'object') {
    p.stats = base;
    p.stats.flights = airports.reduce((s, g) => s + g.served, 0);
    p.stats.pax = airports.reduce((s, g) => s + g.pax, 0);
    p.stats.contractsSigned = airports.reduce((s, g) => s + g.contracts.length, 0);
  }
  for (const key of Object.keys(base)) p.stats[key] = num(p.stats[key], 0);
  p.seenIntro = p.seenIntro !== false;
  p.seenVersion = num(p.seenVersion, 2);
  p.version = SAVE_VERSION;
  return p;
}
