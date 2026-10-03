'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {createGame, ROOT} = require('./harness');

// Structural invariants that must hold after every simulated step.
function checkInvariants(run) {
  const problems = run(`(() => {
    const out = [];
    const ids = new Set(G.planes.map(p => p.id));
    if (!Number.isFinite(G.money)) out.push('money is ' + G.money);
    if (!Number.isFinite(G.rep) || G.rep < 15 || G.rep > 100) out.push('rep is ' + G.rep);
    for (const [key, id] of Object.entries(G.reservations)) if (!ids.has(id)) out.push('stale reservation ' + key);
    for (const b of G.buildings) {
      if (b.gatePlane && !ids.has(b.gatePlane)) out.push('stale gatePlane on ' + b.type + ' ' + b.id);
      if (b.runwayPlane && !ids.has(b.runwayPlane)) out.push('stale runwayPlane on ' + b.id);
      for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) if (G.grid[y * W + x] !== b.id) out.push('grid mismatch at ' + x + ',' + y);
    }
    for (const p of G.planes) {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.alt)) out.push('bad position ' + p.code + ' ' + p.state);
      if (p.state === 'holding' && p.wait > holdLimit() + 3) out.push('plane holding forever ' + p.code);
    }
    const stands = G.buildings.filter(b => b.gatePlane).map(b => b.gatePlane);
    if (new Set(stands).size !== stands.length) out.push('one plane on two stands');
    return out;
  })()`);
  assert.deepEqual(Array.from(problems), []);
}

function simulate(run, minutes, step = 30) {
  for (let t = 0; t < minutes; t += step) {
    run(`advance(${step}); checkAchievements(); ensureCompletion();`);
    checkInvariants(run);
  }
}

test('every location starts with a working runway and three gates', () => {
  const {run} = createGame();
  const ids = run('LOCATIONS.map(l => l.id)');
  for (const id of ids) {
    run(`G = fresh('${id}'); topologyDirty = true;`);
    assert.equal(run('operationalRunways().length'), 1, id + ' runway');
    assert.equal(run('operationalGates().length'), 3, id + ' gates');
  }
});

test('the mountain airport uses a vertical runway', () => {
  const {run} = createGame();
  run(`G = fresh('mountain'); topologyDirty = true;`);
  assert.equal(run(`runwayAxis(G.buildings.find(b => b.type === 'runway')).vertical`), true);
  simulate(run, 1440 * 2);
  assert.ok(run('G.served') > 8, 'served ' + run('G.served'));
});

test('three days of traffic serve flights without breaking invariants', () => {
  const {run} = createGame();
  simulate(run, 1440 * 3);
  assert.ok(run('G.served') >= 25, 'served ' + run('G.served'));
  assert.equal(run('G.day'), 4);
  assert.equal(run('G.history.length'), 3);
  assert.ok(run('portfolio.xp') > 0);
  assert.ok(run('portfolio.achievements.first_flight'));
});

test('contract flights are scheduled and counted', () => {
  const {run} = createGame();
  assert.equal(run(`acceptContract('local', 1)`), true);
  assert.equal(run(`acceptContract('local', 2)`), false, 'duplicate contract');
  simulate(run, 1440 * 2);
  assert.ok(run('G.contractStats.completed') >= 6, 'completed ' + run('G.contractStats.completed'));
  assert.equal(run('portfolio.stats.contractsSigned'), 1);
});

test('aircraft divert instead of holding forever when the runway is cut off', () => {
  const {run} = createGame();
  // Remove the vertical taxi line that links the runway with the apron.
  run(`for (const b of G.buildings.filter(b => b.type === 'taxi' && b.x === 17)) demolish(b, true);`);
  assert.equal(run('operationalRunways().length'), 0);
  run(`acceptContract('local', 1)`); // still allowed? (eligibility requires a runway)
  run(`G.contracts = [{id: 'local', slot: 1, nextAt: G.minutes + 1, completed: 0, onTime: 0, late: 0}]`);
  simulate(run, 1440, 20);
  assert.ok(run('G.diverted') > 0, 'nothing diverted');
  assert.ok(run(`G.planes.filter(p => p.state === 'holding').length`) <= 5);
});

test('a stand cut off from every runway cancels its flight instead of blocking forever', () => {
  const {run} = createGame();
  simulate(run, 400, 10);
  // Wait for a plane in service, then isolate the airport by removing every taxiway.
  for (let i = 0; i < 200 && !run(`G.planes.some(p => p.state === 'service')`); i++) run('advance(2)');
  assert.ok(run(`G.planes.some(p => p.state === 'service')`), 'no plane reached service');
  // Keep removing taxiways as aircraft release them until the whole network is gone.
  for (let t = 0; t < 600; t += 10) {
    run(`for (const b of G.buildings.filter(b => b.type === 'taxi' && !G.reservations[k(b.x, b.y)])) demolish(b, true);`);
    simulate(run, 10, 10);
  }
  assert.equal(run(`G.buildings.filter(b => b.type === 'taxi').length`), 0);
  assert.equal(run(`G.planes.filter(p => ['service', 'ready'].includes(p.state)).length`), 0);
});

test('rotated runways connect and receive traffic', () => {
  const {run} = createGame();
  run('G.money = 1e6');
  // Vertical runway at x=40..41, y=5..17, linked to the existing apron taxiway at y=14 via x=39.
  assert.ok(run(`!!addBuilding('runway', 40, 3, 1, true)`));
  run(`for (let y = 14; y <= 15; y++) addBuilding('taxi', 39, y, 0, true); for (let x = 32; x <= 38; x++) addBuilding('taxi', x, 14, 0, true);`);
  assert.equal(run('operationalRunways().length'), 2);
  run(`for (const r of G.buildings.filter(b => b.type === 'runway')) r.arrivals = 0`);
  simulate(run, 1440 * 2);
  assert.ok(run(`G.buildings.find(b => b.type === 'runway' && b.rot).arrivals`) > 0, 'vertical runway unused');
});

test('cargo terminals receive cargo flights', () => {
  const {run} = createGame();
  run('G.money = 1e6; portfolio.xp = xpForRank(5);');
  assert.equal(run(`buildTool('cargo')`), true);
  // Cargo terminal 4x3 at (32,10): its bottom row touches the taxi line at y=13 that joins the apron.
  assert.ok(run(`!!addBuilding('cargo', 32, 10, 0, true)`));
  run(`for (let x = 32; x <= 35; x++) addBuilding('taxi', x, 13, 0, true); addBuilding('taxi', 31, 13, 0, true);`);
  assert.equal(run('operationalCargo().length'), 1);
  run('G.rep = 40');
  assert.equal(run(`acceptContract('polar', 0)`), false, 'reputation too low');
  run('G.rep = 70');
  assert.equal(run(`acceptContract('polar', 0)`), true);
  simulate(run, 1440 * 2);
  assert.ok(run('portfolio.stats.cargoFlights') > 0);
  assert.ok(run('G.cargo') > 0);
});

test('rank-locked buildings and perks', () => {
  const {run} = createGame();
  assert.equal(run(`buildTool('parking')`), false);
  run('gainXP(xpForRank(3))');
  assert.equal(run('rank()'), 3);
  assert.equal(run('portfolio.points'), 2);
  assert.equal(run(`buildTool('parking') && buildTool('shops')`), true);
  const cost = run(`buildCost('terminal')`);
  assert.equal(run(`buyPerk('build')`), true);
  assert.ok(run(`buildCost('terminal')`) < cost);
  assert.equal(run('portfolio.points'), 1);
  assert.equal(run(`buyPerk('build')`), false, 'second level costs 2 points');
});

test('loans, interest and fee policy', () => {
  const {run} = createGame();
  const money = run('G.money');
  assert.equal(run('takeLoan(50000)'), true);
  assert.equal(run('G.money'), money + 50000);
  assert.equal(run('takeLoan(1e6)'), true, 'clamped to the limit');
  assert.equal(run('G.loan'), run('loanLimit()'));
  assert.equal(run('takeLoan()'), false);
  run('endOfDay(1)');
  assert.equal(run('G.history[0].costs >= Math.round(loanLimit() * LOAN_RATE)'), true);
  assert.equal(run('repayLoan(1e9)'), true);
  assert.equal(run('G.loan'), 0);
  assert.equal(run('portfolio.stats.loansRepaid'), 1);
  const base = run('demandNow()');
  run(`setFeePolicy('low')`);
  assert.ok(run('demandNow()') > base);
});

test('decisions resolve on choice and on timeout', () => {
  const {run} = createGame();
  run(`G.served = 5; G.nextDecision = G.minutes; G.money = 1e6; updateDecision();`);
  assert.ok(run('!!G.decision'));
  const money = run('G.money'), cost = run('G.decision.cost');
  assert.equal(run('resolveDecision(0)'), true);
  assert.equal(run('G.decision'), null);
  assert.ok(run('G.money') <= money - cost + 1);
  assert.equal(run('portfolio.stats.decisions'), 1);
  run(`G.nextDecision = G.minutes; updateDecision(); G.minutes = G.decision.expires + 1; updateDecision();`);
  assert.equal(run('G.decision'), null);
  assert.equal(run('portfolio.stats.decisions'), 1, 'timeouts do not count');
});

test('building and demolishing keep the grid consistent', () => {
  const {run} = createGame();
  const money = run('G.money');
  assert.ok(run(`!!addBuilding('terminal', 30, 25, 1, true)`));
  assert.equal(run(`G.buildings[G.buildings.length - 1].w`), 3);
  assert.equal(run(`canPlace('gate', 30, 25)`), false);
  assert.ok(run(`demolish(G.buildings[G.buildings.length - 1], true)`) > 0);
  assert.equal(run(`canPlace('terminal', 30, 25, 1)`), true);
  assert.ok(run('G.money') < money);
  checkInvariants(run);
});

test('saves from the previous version migrate with progression', () => {
  const {run, context} = createGame();
  const raw = fs.readFileSync(path.join(ROOT, 'tests/fixtures/v2-save.json'), 'utf8');
  context.RAW = raw;
  run(`portfolio = normalizePortfolio(JSON.parse(RAW).portfolio); G = portfolio.airports[portfolio.active];`);
  assert.equal(run('portfolio.version'), 3);
  assert.equal(run('G.version'), 2);
  assert.ok(run('portfolio.xp') > 0);
  assert.equal(run('portfolio.seenVersion'), 2, 'shows the "what is new" dialog');
  assert.equal(run('G.feePolicy'), 'standard');
  assert.equal(run('G.contracts.length'), 1);
  assert.ok(run('G.planes.length') >= 1);
  checkInvariants(run);
  simulate(run, 1440);
  assert.ok(run('G.served') > 8);
});

test('corrupted saves are rejected', () => {
  const {run} = createGame();
  assert.throws(() => run(`normalizePortfolio({airports: {main: {version: 1}}})`));
  assert.throws(() => run(`(() => { const g = fresh('main'); g.buildings.push({...g.buildings[0], id: 999}); normalizeAirport(g, 'main'); })()`), /пересекаются/);
});

test('a long run across every location stays healthy', () => {
  const {run} = createGame();
  for (const id of run('LOCATIONS.map(l => l.id)')) {
    run(`G = portfolio.airports['${id}'] = fresh('${id}'); topologyDirty = true; G.money = 400000;`);
    run(`for (const a of AIRLINES) for (const s of [1, 2, 3, 0]) if (acceptContract(a.id, s)) break;`);
    simulate(run, 1440 * 4, 45);
    assert.ok(run('G.served') > 20, id + ' served ' + run('G.served'));
  }
});
