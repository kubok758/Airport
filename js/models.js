'use strict';
/* Procedural low-poly models: terrain, water, buildings, aircraft, ground vehicles, clouds and weather.
   Every vertex stores position, colour, normal and a specular weight (glass and water shine). */

const VERTEX_FLOATS = 10;
const rgb = hex => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const colorCache = new Map();
const color = c => Array.isArray(c) ? c : colorCache.get(c) || (colorCache.set(c, rgb(c)), colorCache.get(c));
const norm = v => { const d = Math.hypot(...v) || 1; return v.map(q => q / d); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add3 = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
// Cheap deterministic pseudo-random numbers keep scenery stable between rebuilds.
const hash = (i, salt = 0) => { const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return s - Math.floor(s); };
const GLASS = .9;

function meshBuilder() {
  const data = [], m = {data, spec: 0};
  m.triangle = (a, b, c, col) => {
    const n = norm(cross(sub3(b, a), sub3(c, a))), co = color(col), sp = m.spec;
    data.push(a[0], a[1], a[2], co[0], co[1], co[2], n[0], n[1], n[2], sp,
      b[0], b[1], b[2], co[0], co[1], co[2], n[0], n[1], n[2], sp,
      c[0], c[1], c[2], co[0], co[1], co[2], n[0], n[1], n[2], sp);
  };
  m.quad = (a, b, c, d, col) => { m.triangle(a, b, c, col); m.triangle(a, c, d, col); };
  // Convex polygon whose winding is fixed up so the face points along `want`.
  m.face = (pts, want, col) => {
    let list = pts;
    if (dot3(cross(sub3(pts[1], pts[0]), sub3(pts[2], pts[0])), want) < 0) list = pts.slice().reverse();
    for (let i = 1; i < list.length - 1; i++) m.triangle(list[0], list[i], list[i + 1], col);
  };
  // Extrudes a planar convex polygon by `dir`: caps plus outward-facing sides.
  m.extrude = (pts, dir, col, sideCol = col) => {
    const top = pts.map(p => add3(p, dir)), c = pts.reduce((s, p) => add3(s, p), [0, 0, 0]).map(v => v / pts.length);
    m.face(pts, dir.map(v => -v), col);
    m.face(top, dir, col);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      m.face([a, b, add3(b, dir), add3(a, dir)], sub3(mid, c), sideCol);
    }
  };
  m.box = (x, y, z, w, h, d, col, top = col, bottom = false) => {
    const x2 = x + w, y2 = y + h, z2 = z + d;
    m.quad([x, y2, z], [x, y2, z2], [x2, y2, z2], [x2, y2, z], top);
    m.quad([x, y, z2], [x2, y, z2], [x2, y2, z2], [x, y2, z2], col);
    m.quad([x2, y, z], [x, y, z], [x, y2, z], [x2, y2, z], col);
    m.quad([x, y, z], [x, y, z2], [x, y2, z2], [x, y2, z], col);
    m.quad([x2, y, z2], [x2, y, z], [x2, y2, z], [x2, y2, z2], col);
    if (bottom) m.quad([x, y, z], [x2, y, z], [x2, y, z2], [x, y, z2], col);
  };
  m.disc = (cx, y, cz, r, col, seg = 12) => {
    for (let i = 0; i < seg; i++) {
      const a = i * 2 * Math.PI / seg, b = (i + 1) * 2 * Math.PI / seg;
      m.triangle([cx, y, cz], [cx + r * Math.sin(a), y, cz + r * Math.cos(a)], [cx + r * Math.sin(b), y, cz + r * Math.cos(b)], col);
    }
  };
  m.cylinder = (cx, y, cz, r, h, col, seg = 10, top = col) => {
    for (let i = 0; i < seg; i++) {
      const a = i * 2 * Math.PI / seg, b = (i + 1) * 2 * Math.PI / seg;
      const ax = cx + r * Math.sin(a), az = cz + r * Math.cos(a), bx = cx + r * Math.sin(b), bz = cz + r * Math.cos(b);
      m.quad([ax, y, az], [bx, y, bz], [bx, y + h, bz], [ax, y + h, az], col);
      m.triangle([cx, y + h, cz], [ax, y + h, az], [bx, y + h, bz], top);
    }
  };
  m.cone = (cx, y, cz, r, h, col, seg = 8) => {
    for (let i = 0; i < seg; i++) {
      const a = i * 2 * Math.PI / seg, b = (i + 1) * 2 * Math.PI / seg;
      m.triangle([cx + r * Math.sin(a), y, cz + r * Math.cos(a)], [cx + r * Math.sin(b), y, cz + r * Math.cos(b)], [cx, y + h, cz], col);
    }
  };
  // Tube along the X axis from x1 to x2 (radii r1 → r2), capped at both ends.
  m.tube = (x1, x2, y, z, r1, r2, col, seg = 10, caps = true) => {
    for (let i = 0; i < seg; i++) {
      const a = i * 2 * Math.PI / seg, b = (i + 1) * 2 * Math.PI / seg;
      const p = (x, r, t) => [x, y + Math.cos(t) * r, z + Math.sin(t) * r];
      m.quad(p(x1, r1, a), p(x1, r1, b), p(x2, r2, b), p(x2, r2, a), col);
      if (caps) { m.triangle([x1, y, z], p(x1, r1, b), p(x1, r1, a), col); m.triangle([x2, y, z], p(x2, r2, a), p(x2, r2, b), col); }
    }
  };
  m.sphere = (cx, cy, cz, rx, ry, rz, col, seg = 8, rings = 5) => {
    const p = (t, f) => [cx + rx * Math.sin(f) * Math.cos(t), cy + ry * Math.cos(f), cz + rz * Math.sin(f) * Math.sin(t)];
    for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) {
      const t1 = i * 2 * Math.PI / seg, t2 = (i + 1) * 2 * Math.PI / seg, f1 = j * Math.PI / rings, f2 = (j + 1) * Math.PI / rings;
      if (j === 0) m.triangle(p(t1, f1), p(t2, f2), p(t1, f2), col);
      else if (j === rings - 1) m.triangle(p(t1, f1), p(t2, f1), p(t1, f2), col);
      else m.quad(p(t1, f1), p(t2, f1), p(t2, f2), p(t1, f2), col);
    }
  };
  m.glass = fn => { const old = m.spec; m.spec = GLASS; fn(); m.spec = old; };
  return m;
}

// Building models are written in local (u, y, v) coordinates: u along the unrotated width, v along the depth.
function localFrame(m, b) {
  const t = TYPES[b.type], L = t.w, D = t.h;
  const p = (u, y, v) => b.rot ? [b.x + D - v, y, b.y + u] : [b.x + u, y, b.y + v];
  const dir = (du, dy, dv) => b.rot ? [-dv, dy, du] : [du, dy, dv];
  const at2 = (u, v) => { const q = p(u, 0, v); return [q[0], q[2]]; };
  return {L, D, p, dir,
    box: (u, y, v, du, dy, dv, col, top) => b.rot ? m.box(b.x + D - v - dv, y, b.y + u, dv, dy, du, col, top) : m.box(b.x + u, y, b.y + v, du, dy, dv, col, top),
    disc: (u, y, v, r, col, seg) => { const [x, z] = at2(u, v); m.disc(x, y, z, r, col, seg); },
    cylinder: (u, y, v, r, h, col, seg, top) => { const [x, z] = at2(u, v); m.cylinder(x, y, z, r, h, col, seg, top); },
    cone: (u, y, v, r, h, col, seg) => { const [x, z] = at2(u, v); m.cone(x, y, z, r, h, col, seg); },
    sphere: (u, y, v, ru, ry, rv, col, seg, rings) => { const [x, z] = at2(u, v); b.rot ? m.sphere(x, y, z, rv, ry, ru, col, seg, rings) : m.sphere(x, y, z, ru, ry, rv, col, seg, rings); },
    face: (pts, want, col) => m.face(pts.map(q => p(...q)), dir(...want), col),
    extrude: (pts, d, col, side) => m.extrude(pts.map(q => p(...q)), dir(...d), col, side)};
}

// ---------- terrain ----------

function tree(m, x, z, s = 1, leaf = '#3b6b55', leafTop = '#528367') {
  m.box(x - .035 * s, .01, z - .035 * s, .07 * s, .26 * s, .07 * s, '#5c5345');
  m.sphere(x, .42 * s, z, .3 * s, .26 * s, .3 * s, leaf, 6, 4);
  m.sphere(x + .06 * s, .58 * s, z - .04 * s, .18 * s, .16 * s, .18 * s, leafTop, 6, 3);
}

function palm(m, x, z, i) {
  const lean = (hash(i, 9) - .5) * .25, top = [x + lean, .74, z + lean * .6];
  for (let k = 0; k < 4; k++) m.box(x + lean * k / 4 - .04, .01 + k * .18, z + lean * .6 * k / 4 - .04, .08, .19, .08, k % 2 ? '#8a7658' : '#9b8665');
  for (let k = 0; k < 6; k++) {
    const a = k * Math.PI / 3 + hash(i, k) * .4, ex = Math.cos(a) * .42, ez = Math.sin(a) * .42, sx = -Math.sin(a) * .07, sz = Math.cos(a) * .07;
    const tip = [top[0] + ex, top[1] - .16, top[2] + ez];
    m.face([[top[0] - sx, top[1] + .02, top[2] - sz], [top[0] + sx, top[1] + .02, top[2] + sz], tip], [0, 1, 0], k % 2 ? '#3e9a6f' : '#4fae7d');
  }
}

const FAR_GROUND = {main: ['#22403a', '#2b4c40'], island: ['#174f66', '#1d5f78'], city: ['#2e3b45', '#3a4955'], desert: ['#a98761', '#c2a073'], mountain: ['#c9d4da', '#dde6eb']};

function terrain(m) {
  const location = G.location, far = FAR_GROUND[location] || FAR_GROUND.main;
  // Ground (or open sea) all the way to the horizon so a low camera never sees the edge of the world.
  m.box(-260, -.5, -260, W + 520, .26, H + 520, far[0], far[1]);
  if (location === 'island') {
    m.box(-1.3, -.2, -1.3, W + 2.6, .17, H + 2.6, '#af9874', '#e8cd92');
    m.box(-1.6, -.21, -1.6, W + 3.2, .05, H + 3.2, '#f2f6f2', '#f2f6f2');
    m.box(0, -.035, 0, W, .05, H, '#597a6b', '#74a089');
    for (let i = 0; i < 54; i++) {
      const x = (i * 73 % 505) / 10, z = (i * 37 % 342) / 10;
      if (!at(Math.floor(x), Math.floor(z))) palm(m, x, z, i);
    }
    for (let i = 0; i < 26; i++) {
      const side = i % 4, t = hash(i, 3);
      const x = side < 2 ? t * (W + 2) - 1 : side === 2 ? -1.1 : W + .4, z = side >= 2 ? t * (H + 2) - 1 : side === 0 ? -1.1 : H + .4;
      if (!at(Math.floor(x), Math.floor(z))) palm(m, x, z, i + 100);
    }
  } else if (location === 'city') {
    m.box(-12, -.24, -12, W + 24, .19, H + 24, '#354450', '#516171');
    m.box(0, -.035, 0, W, .05, H, '#3e5359', '#687a7d');
    for (let x = 0; x < W; x += 5) m.box(x, .014, 0, .08, .009, H, '#a3a395');
    for (let z = 0; z < H; z += 5) m.box(0, .014, z, W, .009, .08, '#a3a395');
    m.box(-2.4, -.05, -2.4, W + 4.8, .06, .9, '#2c3740', '#3c4852');
    m.box(-2.4, -.05, H + 1.5, W + 4.8, .06, .9, '#2c3740', '#3c4852');
    for (let i = 0; i < 52; i++) {
      const x = (i * 13 % 72) - 11, z = (i * 29 % 56) - 11;
      if (x >= -3 && x < W + 3 && z >= -3 && z < H + 3) continue;
      const height = 2 + (i * 7 % 8), w = 1.3 + hash(i, 1) * .9, d = 1.2 + hash(i, 2) * .7;
      const body = i % 3 ? '#344e5d' : '#40596b', roof = i % 2 ? '#95adb7' : '#6a899c';
      m.box(x, .01, z, w, height, d, body, roof);
      m.glass(() => { for (let h = .6; h < height - .2; h += .55) { m.box(x + .1, h, z + d + .005, w - .2, .3, .02, '#7fb2c8'); m.box(x + w + .005, h, z + .1, .02, .3, d - .2, '#6f9fb4'); } });
      if (i % 4 === 0) m.box(x + w * .3, height + .01, z + d * .3, w * .4, .25, d * .4, '#55707d', '#7e98a4');
    }
  } else if (location === 'desert') {
    m.box(-18, -.22, -18, W + 36, .18, H + 36, '#9d7657', '#c9a879');
    m.box(0, -.035, 0, W, .05, H, '#b19469', '#d5b785');
    for (let i = 0; i < 90; i++) {
      const x = (i * 79 % 499) / 10, z = (i * 37 % 337) / 10;
      if (at(Math.floor(x), Math.floor(z))) continue;
      if (i % 4) m.box(x, .013, z, .5, .025, .2, '#e3ca92');
      else {
        m.box(x + .3, .012, z + .3, .09, .46, .09, '#4d7761');
        m.box(x + .12, .29, z + .3, .2, .06, .06, '#4d7761');
        m.box(x + .12, .29, z + .3, .06, .16, .06, '#4d7761');
      }
    }
    for (let i = 0; i < 14; i++) {
      const side = i % 2, x = side ? -6 - hash(i, 1) * 8 : W + 5 + hash(i, 1) * 8, z = hash(i, 2) * (H + 16) - 8;
      m.sphere(x, -.25, z, 2.5 + hash(i, 3) * 2.5, .7 + hash(i, 4) * .9, 1.6 + hash(i, 5) * 1.6, i % 3 ? '#c39d6c' : '#b48c5e', 12, 4);
    }
  } else if (location === 'mountain') {
    m.box(-30, -.26, -30, W + 60, .2, H + 60, '#cfd9df', '#e8eff3');
    m.box(0, -.035, 0, W, .05, H, '#93a6ab', '#b8c7cb');
    for (let i = 0; i < 18; i++) {
      const side = i % 4, t = hash(i, 1);
      const x = side === 0 ? -12 - hash(i, 2) * 12 : side === 1 ? W + 12 + hash(i, 2) * 12 : t * (W + 30) - 15;
      const z = side === 2 ? -12 - hash(i, 3) * 12 : side === 3 ? H + 12 + hash(i, 3) * 12 : t * (H + 30) - 15;
      // Peaks on the camera side stay low so they never hide the airfield.
      const r = 5 + hash(i, 4) * 5, h = (side === 1 || side === 3 ? 2.5 : 4.5) + hash(i, 5) * (side === 1 || side === 3 ? 3 : 6);
      m.cone(x, -.2, z, r, h, i % 2 ? '#6d7c88' : '#7d8b95', 7);
      m.cone(x, -.2 + h * .6, z, r * .43, h * .42, '#f3f7f9', 7);
    }
    for (let i = 0; i < 75; i++) {
      const x = hash(i, 6) * (W - 1) + .5, z = hash(i, 7) * (H - 1) + .5;
      if (at(Math.floor(x), Math.floor(z))) continue;
      m.box(x - .04, .01, z - .04, .08, .22, .08, '#5b4a3a');
      m.cone(x, .18, z, .34, .62, '#2f5b48', 7);
      m.cone(x, .5, z, .24, .5, '#3c6e57', 7);
      m.cone(x, .82, z, .12, .18, '#eef4f6', 7);
    }
  } else {
    m.box(-4, -.21, -4, W + 8, .18, H + 8, '#203b3b', '#315744');
    m.box(-.15, -.035, -.15, W + .3, .05, H + .3, '#24464b', '#406359');
    for (let i = 0; i < 160; i++) {
      const x = (i * 41 % 503) / 10, z = (i * 67 % 341) / 10;
      if (x < W && z < H && !at(Math.floor(x), Math.floor(z))) m.box(x, .012, z, .18, Math.max(.018, (i % 4) * .009), .33, i % 3 ? '#50745d' : '#5a805e');
    }
    for (let i = 0; i < 48; i++) {
      const x = (i * 19 + 3) % W, z = (i * 31 + 6) % H;
      if (!at(x, z) && x > 1 && z > 1) tree(m, x + .5, z + .5, .95 + hash(i, 2) * .3, i % 3 ? '#3b6b55' : '#45765a', i % 3 ? '#528367' : '#5d9070');
    }
  }
  const line = {desert: '#dfc89a', city: '#7d969a', mountain: '#a7b6ba'}[location] || '#55756a';
  for (let x = 0; x <= W; x++) m.box(x, .016, 0, .014, .005, H, line);
  for (let z = 0; z <= H; z++) m.box(0, .016, z, W, .005, .014, line);
}

// Tessellated ocean around the island; the shader animates the waves.
function waterModel() {
  const m = meshBuilder(), step = 2.5, x0 = -46, z0 = -46, x1 = W + 46, z1 = H + 46;
  m.spec = .75;
  for (let z = z0; z < z1; z += step) for (let x = x0; x < x1; x += step) {
    if (x > 0 && x + step < W && z > 0 && z + step < H) continue;
    const d = Math.max(0, Math.max(-x, x - W, -z, z - H)) / 46, c = [.13 + .12 * (1 - d), .42 + .16 * (1 - d), .52 + .08 * (1 - d)];
    m.quad([x, -.17, z], [x, -.17, z + step], [x + step, -.17, z + step], [x + step, -.17, z], c);
  }
  return m;
}

// ---------- airfield ----------

function taxiGeom(m, lights, b) {
  const x = b.x, z = b.y, dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  m.box(x, .012, z, 1, .07, 1, '#374955', '#41525b');
  m.box(x + .03, .083, z + .03, .94, .006, .94, b.level > 1 ? '#4a5f66' : '#45575f');
  const links = dirs.map(([dx, dz]) => ['taxi', 'gate', 'runway', 'cargo'].includes(at(x + dx, z + dz)?.type));
  m.box(x + .44, .092, z + .44, .12, .008, .12, '#e8b858');
  dirs.forEach(([dx, dz], i) => {
    if (links[i]) {
      if (dx) m.box(x + (dx < 0 ? 0 : .5), .092, z + .47, .5, .008, .06, '#e8b858');
      else m.box(x + .47, .092, z + (dz < 0 ? 0 : .5), .06, .008, .5, '#e8b858');
      return;
    }
    // Open edge: yellow edge line and a blue edge light.
    if (dx) m.box(x + (dx < 0 ? .06 : .91), .091, z + .06, .03, .008, .88, '#d9a94c');
    else m.box(x + .06, .091, z + (dz < 0 ? .06 : .91), .88, .008, .03, '#d9a94c');
    lights.disc(x + .5 + dx * .44, .1, z + .5 + dz * .44, .045, '#4f86ff', 6);
  });
  if ((b.x + b.y) % 2 === 0) lights.disc(x + .5, .1, z + .5, .045, '#7dffb0', 6);
}

// Seven-segment runway designators: rectangles in digit space (x right, y up).
const SEGMENTS = {a: [0, 1, 1, 1], b: [1, .5, 1, 1], c: [1, 0, 1, .5], d: [0, 0, 1, 0], e: [0, 0, 0, .5], f: [0, .5, 0, 1], g: [0, .5, 1, .5]};
const DIGITS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcfgd'];
function designator(f, text, uStart, dirSign, vCenter) {
  const w = .2, h = .36, t = .045, gap = .09, total = text.length * w + (text.length - 1) * gap;
  [...text].forEach((ch, i) => {
    for (const s of DIGITS[+ch]) {
      const [x1, y1, x2, y2] = SEGMENTS[s];
      const rx = x1 === x2 ? [x1 * (w - t), x1 * (w - t) + t] : [0, w], ry = y1 === y2 ? [y1 * (h - t), y1 * (h - t) + t] : [y1 * h, y2 * h];
      const dx0 = i * (w + gap) + rx[0], dx1 = i * (w + gap) + rx[1];
      // Digits read correctly for a pilot on final: "up" points along the landing direction.
      const u0 = uStart + dirSign * ry[0], u1 = uStart + dirSign * ry[1];
      const v0 = vCenter + dirSign * (dx0 - total / 2), v1 = vCenter + dirSign * (dx1 - total / 2);
      f.box(Math.min(u0, u1), .128, Math.min(v0, v1), Math.abs(u1 - u0), .006, Math.abs(v1 - v0), '#f3f4ef');
    }
  });
}

function runwayGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D, vertical = !!b.rot;
  f.box(0, .025, 0, L, .10, D, '#323c46', '#353f49');
  f.box(0, .1255, 0, L, .002, .1, '#2c353d');
  f.box(0, .1255, D - .1, L, .002, .1, '#2c353d');
  f.box(.09, .127, .13, L - .18, .006, .035, '#d2e4e7');
  f.box(.09, .127, D - .165, L - .18, .006, .035, '#d2e4e7');
  for (let i = 2; i < L - 2.2; i += 1.1) f.box(i, .128, D / 2 - .03, .6, .006, .06, '#f7f4dc');
  for (const u of [.2, L - .7]) for (let j = 0; j < 6; j++) f.box(u, .128, .3 + j * .25, .5, .006, .09, '#f0f2ee');
  for (const u of [2.5, L - 3.3]) for (const v of [.42, D - .62]) f.box(u, .128, v, .8, .006, .2, '#f0f2ee');
  for (const u of [3.8, 4.5, L - 4.8, L - 5.5]) for (const v of [.5, D - .62]) f.box(u, .128, v, .35, .006, .12, '#e8ebe5');
  designator(f, vertical ? '18' : '09', .95, 1, D / 2);
  designator(f, vertical ? '36' : '27', L - .95, -1, D / 2);
  for (let i = 1; i < b.level; i++) for (const u of [1.6, L - 1.9]) f.box(u + i * .14 - .14, .129, D / 2 - .32, .07, .006, .64, '#7fd9ff');
  for (const u of [.48, L - .48]) for (const v of [-.18, D + .1]) f.box(u - .14, .015, v, .28, .16, .08, '#b98636', '#ffe49b');
  for (const u of [-.2, L + .12]) f.box(u, .015, D / 2 - .14, .08, .16, .28, '#b98636', '#ffe49b');
  for (let i = 1; i < L * 2; i++) for (const v of [.06, D - .06]) f.disc(i * .5, .132, v, .035, i % 2 ? '#ffde89' : '#b4f0e2', 6);
  const fl = localFrame(lights, b);
  for (let i = 1; i < L * 2; i += 2) for (const v of [.06, D - .06]) fl.disc(i * .5, .14, v, .07, '#fff1b8', 6);
  for (let j = 0; j < 5; j++) { fl.disc(.05, .14, .2 + j * .4, .065, '#7dff9a', 6); fl.disc(L - .05, .14, .2 + j * .4, .065, '#ff7d7d', 6); }
  for (let i = 0; i < 6; i++) { fl.disc(i * .55 + 1.2, .14, D / 2, .04, '#bfe6ff', 5); fl.disc(L - 1.2 - i * .55, .14, D / 2, .04, '#bfe6ff', 5); }
}

// Contact-stand rig shared by the static model and the animated jet bridge.
function gateRig(b) {
  const h = gateHeading(b), fx = Math.round(Math.cos(h)), fz = Math.round(Math.sin(h)), rx = -fz, rz = fx;
  const cx = b.x + b.w / 2, cz = b.y + b.h / 2, facade = facadeDistance(b), a = clamp(facade - .55, .75, 1.6);
  return {h, fx, fz, rx, rz, cx, cz, facade, a, rot: {x: cx + fx * a - rx * 1.12, z: cz + fz * a - rz * 1.12}};
}

function gateGeom(m, b) {
  const x = b.x, z = b.y, w = b.w, d = b.h, g = gateRig(b);
  m.box(x, .03, z, w, .055, d, '#56646d', '#6a7d7c');
  // Lead-in line towards the terminal, stop bar and the stand safety outline.
  const along = (from, to, side, width, col) => {
    const ax = g.cx + g.fx * from + g.rx * side, az = g.cz + g.fz * from + g.rz * side, bx = g.cx + g.fx * to + g.rx * side, bz = g.cz + g.fz * to + g.rz * side;
    m.box(Math.min(ax, bx) - (g.fx ? 0 : width / 2), .088, Math.min(az, bz) - (g.fz ? 0 : width / 2), Math.abs(bx - ax) || width, .006, Math.abs(bz - az) || width, col);
  };
  along(-1, .55, 0, .05, '#f2c24f');
  along(.55, .62, -.25, .02, '#f4f6f0');
  along(.55, .62, .25, .02, '#f4f6f0');
  m.box(x + .08, .088, z + .08, w - .16, .006, .03, '#d9574f');
  m.box(x + .08, .088, z + d - .11, w - .16, .006, .03, '#d9574f');
  m.box(x + .08, .088, z + .08, .03, .006, d - .16, '#d9574f');
  m.box(x + w - .11, .088, z + .08, .03, .006, d - .16, '#d9574f');
  if (b.level >= 2) m.box(x + .14, .09, z + .14, .2, .08, .2, '#7764a7', '#c6b7ea');
  if (b.level >= 3) m.box(x + w - .34, .09, z + .14, .2, .08, .2, '#a88a3f', '#ffd27a');
  // Jet bridge rotunda and the fixed corridor back to the terminal facade.
  if (!gateTerminal(b)) return;
  m.cylinder(g.rot.x, .02, g.rot.z, .07, .44, '#69767e', 8);
  m.cylinder(g.rot.x, .44, g.rot.z, .16, .22, '#b8c2c8', 10, '#dfe6e9');
  const reach = Math.min(g.facade, 3.4) - g.a;
  if (reach > .05) {
    const sx = g.rot.x + g.fx * .1, sz = g.rot.z + g.fz * .1, ex = g.rot.x + g.fx * (reach + .05), ez = g.rot.z + g.fz * (reach + .05);
    const bx = Math.min(sx, ex) - (g.fx ? 0 : .11), bz = Math.min(sz, ez) - (g.fz ? 0 : .11), bw = Math.abs(ex - sx) || .22, bd = Math.abs(ez - sz) || .22;
    m.box(bx, .46, bz, bw, .18, bd, '#c3ccd1', '#e3e9ec');
    m.glass(() => m.box(bx - (g.fx ? 0 : .005), .52, bz - (g.fz ? 0 : .005), bw + (g.fx ? 0 : .01), .06, bd + (g.fz ? 0 : .01), '#6fa9bf'));
    for (let t = .6; t < reach; t += .9) m.box(g.rot.x + g.fx * t - .03, .02, g.rot.z + g.fz * t - .03, .06, .44, .06, '#69767e');
  }
}

function terminalGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D, lv = b.level;
  f.box(0, .02, 0, L, .08, D, '#5f6e78', '#7a8a92');
  f.box(.22, .1, .3, L - .44, 1.02, D - .6, '#41697b', '#5b8494');
  // Curtain walls with mullions on both long sides.
  m.glass(() => { f.box(.26, .14, .24, L - .52, .92, .06, '#7cc3d3'); f.box(.26, .14, D - .3, L - .52, .92, .06, '#7cc3d3'); });
  for (let u = .26; u <= L - .25; u += .42) for (const v of [.2, D - .25]) f.box(u, .14, v, .03, .92, .05, '#dfe7e9');
  for (const v of [.2, D - .25]) { f.box(.26, .58, v, L - .52, .03, .05, '#dfe7e9'); f.box(.26, 1.04, v, L - .52, .04, .05, '#dfe7e9'); }
  for (const u of [.22, L - .26]) m.glass(() => { for (let v = .5; v < D - .7; v += .55) f.box(u - .005, .4, v, .05, .5, .32, '#6aaebf'); });
  // Floating metal roof with sawtooth skylights.
  f.box(-.02, 1.12, .08, L + .04, .07, D - .16, '#2d4b5c', '#7d9099');
  for (let i = 0; i < 5; i++) {
    f.extrude([[.55 + i * 1.05, 1.19, .7], [.95 + i * 1.05, 1.19, .7], [.95 + i * 1.05, 1.3, .7]], [0, 0, D - 1.4], '#8b9ea6');
    m.glass(() => f.face([[.55 + i * 1.05, 1.192, .72], [.95 + i * 1.05, 1.302, .72], [.95 + i * 1.05, 1.302, D - .72], [.55 + i * 1.05, 1.192, D - .72]], [-.3, 1, 0], '#4f8ea3'));
  }
  // Landside drop-off canopy on columns.
  f.box(.4, .62, D - .2, L - .8, .04, .2, '#d8e1e3', '#eef3f4');
  for (let u = .5; u < L - .4; u += 1.2) f.box(u, .1, D - .08, .04, .52, .04, '#c5ced1');
  for (let i = 0; i < 3; i++) f.box(.7 + i * 1.7, 1.19, D / 2 + .55, .3, .12, .22, '#7e8b91', '#a9b5ba');
  if (lv >= 2) {
    m.glass(() => f.box(L / 2 - .8, 1.19, .65, 1.6, .5, D - 1.3, '#8fd3e2'));
    f.box(L / 2 - .85, 1.69, .6, 1.7, .05, D - 1.2, '#2d4b5c', '#8a9ca4');
    f.box(L / 2 - .45, .88, .17, .9, .14, .04, '#e9b64a');
  }
  if (lv >= 3) {
    f.cylinder(L - .9, 1.19, D / 2, .22, .55, '#5e7f8d', 10, '#a8c2c9');
    m.glass(() => f.cylinder(L - .9, 1.74, D / 2, .3, .2, '#9fdcea', 10, '#d5edf2'));
    for (let i = 0; i < 3; i++) { f.box(.45 + i * .25, 1.19, D / 2 - .4, .02, .55, .02, '#d9dfe2'); f.box(.47 + i * .25, 1.6, D / 2 - .4, .1, .07, .01, ['#d84b4b', '#3c74d8', '#f2c24f'][i]); }
  }
  const fl = localFrame(lights, b);
  fl.box(.3, .2, .19, L - .6, .8, .02, '#ffe3a1');
  fl.box(.3, .2, D - .21, L - .6, .8, .02, '#ffe3a1');
  if (lv >= 2) fl.box(L / 2 - .78, 1.22, .63, 1.56, .44, .02, '#ffe9b8');
}

function towerGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D, lv = b.level, top = 2.15 + .3 * (lv - 1);
  f.box(.15, .02, .15, L - .3, .45, D - .3, '#5d727e', '#7f97a2');
  m.glass(() => f.box(.2, .12, .13, L - .4, .26, .03, '#7cc3d3'));
  f.cylinder(L / 2, .47, D / 2, .2, top - .47, '#c9d1d5', 10, '#c9d1d5');
  f.cylinder(L / 2, top - .12, D / 2, .38, .12, '#8e9ba2', 10);
  m.glass(() => f.cylinder(L / 2, top, D / 2, .5, .36, '#6fb6c9', 8, '#6fb6c9'));
  for (let i = 0; i < 8; i++) { const a = i * Math.PI / 4 + Math.PI / 8; f.box(L / 2 + Math.sin(a) * .47 - .02, top, D / 2 + Math.cos(a) * .47 - .02, .04, .36, .04, '#e1e7ea'); }
  f.cylinder(L / 2, top + .36, D / 2, .55, .05, '#3b4c58', 8, '#d5dcdf');
  f.cone(L / 2, top + .41, D / 2, .45, .14, '#9aa8b0', 8);
  f.box(L / 2 - .02, top + .5, D / 2 - .02, .04, .5, .04, '#d6d8cc');
  f.box(L / 2 - .2, top + .55, D / 2 - .02, .4, .03, .04, '#d6d8cc');
  const fl = localFrame(lights, b);
  fl.cylinder(L / 2, top + .04, D / 2, .51, .26, '#bdf3ff', 8, '#bdf3ff');
  fl.disc(L / 2, top + 1.01, D / 2, .07, '#ff5f5f', 8);
}

function serviceGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D, lv = b.level, R = D / 2 - .12, base = .45, segs = 8;
  f.box(0, .02, 0, L, .05, D, '#5a666d', '#6c7a80');
  f.box(.12, .07, .12, L - .24, base - .07, D - .24, '#6b7f88', '#6b7f88');
  // Barrel-vault hangar roof along u.
  for (let i = 0; i < segs; i++) {
    const a1 = i * Math.PI / segs, a2 = (i + 1) * Math.PI / segs;
    const q = (u, a) => [u, base + Math.sin(a) * R * .75, D / 2 + Math.cos(a) * R];
    const mid = (a1 + a2) / 2;
    f.face([q(.12, a1), q(L - .12, a1), q(L - .12, a2), q(.12, a2)], [0, Math.sin(mid), Math.cos(mid)], i % 2 ? '#a9b8bf' : '#b5c3c9');
    for (const [u, s] of [[.12, -1], [L - .12, 1]]) f.face([[u, base, D / 2], q(u, a1), q(u, a2)], [s, 0, 0], '#8798a0');
  }
  f.box(L - .14, .07, .35, .04, .62, D - .7, '#4e5c64');
  for (let i = 0; i < 4; i++) f.box(L - .1, .1 + i * .15, .4, .01, .02, D - .8, '#9aa7ad');
  m.glass(() => f.box(.4, .3, .1, 1.2, .12, .03, '#7cc3d3'));
  for (let i = 1; i < lv; i++) f.box(.2 + (i - 1) * .55, .07, D - .1 - .02, .45, .3, .1, '#d9b85a', '#f2d17a');
  f.box(.25, .07, -.0, .35, .16, .1, '#e6c54f');
  localFrame(lights, b).box(L - .09, .55, .45, .02, .05, D - .9, '#ffe3a1');
}

function fuelGeom(m, b) {
  const f = localFrame(m, b), L = f.L, D = f.D, lv = b.level;
  f.box(0, .02, 0, L, .05, D, '#596259', '#6c7462');
  for (const [u, v, du, dv] of [[0, 0, L, .06], [0, D - .06, L, .06], [0, 0, .06, D], [L - .06, 0, .06, D]]) f.box(u, .07, v, du, .12, dv, '#8b9186', '#a3a99c');
  for (const [u, r, c] of [[.85, .62, '#c3ccc0'], [2.1, .58, '#aeb9b6']]) {
    f.cylinder(u, .07, D / 2, r, .85, c, 14, c);
    f.cone(u, .92, D / 2, r, .14, '#d8ddd5', 14);
    for (let k = 0; k < 5; k++) f.box(u + r - .02, .1 + k * .16, D / 2 - .05, .05, .02, .1, '#6b6e66');
  }
  f.box(.85, .98, D / 2 - .03, 1.25, .04, .06, '#c7a855');
  f.box(.2, .07, .12, L - .4, .06, .06, '#c7a855');
  for (let j = 0; j < lv; j++) f.box(.3 + j * .5, .07, D - .3, .14, .34, .14, '#e0b966', '#ffc76e');
}

function solarGeom(m, b) {
  const f = localFrame(m, b), L = f.L, D = f.D;
  f.box(0, .02, 0, L, .05, D, '#b5966a', '#d8b983');
  for (let r = 0; r < 3; r++) for (let c = 0; c < 2; c++) {
    const u = .12 + c * 1.45, v = .15 + r * .6;
    for (const uu of [u + .1, u + 1.15]) f.box(uu, .07, v + .2, .04, .16 + .08 * b.level, .04, '#6c6a60');
    m.spec = .55;
    f.extrude([[u, .2, v + .42], [u + 1.3, .2, v + .42], [u + 1.3, .38, v], [u, .38, v]], [0, .025, 0], '#2f5f80', '#244b66');
    m.spec = 0;
  }
}

function utilityGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D, lv = b.level;
  switch (b.type) {
    case 'service': serviceGeom(m, lights, b); break;
    case 'fuel': fuelGeom(m, b); break;
    case 'solar': solarGeom(m, b); break;
    case 'tower': towerGeom(m, lights, b); break;
    case 'ferry':
      f.box(0, .01, 0, L, .10, D, '#a79068', '#ccbb91');
      f.box(.2, .12, .2, L - .4, .16, D - .4, '#6c978e', '#a4c8b0');
      for (let j = 0; j < 4; j++) f.box(.25 + j * .7, .25, .2, .12, .56, .12, '#d1c7a3');
      f.box(.36, .83, .3, L - .72, .1, 1.15, '#3e817f', '#95caca');
      m.glass(() => f.box(.5, .4, .25, L - 1, .3, .05, '#8fd3e2'));
      f.box(1.2, .94, .7, .15, .48, .13, '#ddd5ad');
      for (let i = 0; i < lv; i++) f.box(.4 + i * .5, .12, D - .25, .35, .18, .12, '#e8f0f0', '#2f7c8a');
      break;
    case 'metro':
      f.box(.12, .01, .12, L - .24, .35, D - .24, '#354a59', '#527688');
      f.box(.24, .38, .24, L - .48, .6, D - .48, '#416b7c', '#83acb7');
      m.glass(() => f.box(.3, .5, D - .26, L - .6, .3, .03, '#9fdcea'));
      f.box(-.0, .98, D / 2 - .18, L, .08, .36, '#9aa8b0', '#c9d3d8');
      for (let i = 0; i < Math.min(3, lv + 1); i++) {
        f.box(.08 + i * .98, 1.06, D / 2 - .14, .9, .26, .28, '#e7eef0', '#cfd8dc');
        m.glass(() => f.box(.12 + i * .98, 1.15, D / 2 - .145, .82, .08, .29, '#36586a'));
      }
      localFrame(lights, b).box(.35, .55, D - .23, L - .7, .2, .02, '#ffe3a1');
      break;
    case 'parking': {
      f.box(0, .02, 0, L, .06, D, '#3c4850', '#4b5961');
      for (let i = 0; i <= 6; i++) for (const v of [.15, 1.75]) f.box(.2 + i * .6, .085, v, .03, .006, 1.1, '#dfe5df');
      const cars = ['#d65f5f', '#5f9bd6', '#e8d27a', '#e7eef0', '#7fc79a', '#9a86d6'];
      for (let i = 0; i < 6; i++) for (const v of [.35, 1.95]) if (hash(b.id * 13 + i, v) > .3) {
        f.box(.3 + i * .6, .09, v, .38, .12, .66, cars[(i + (v > 1 ? 3 : 0)) % 6]);
        m.glass(() => f.box(.33 + i * .6, .21, v + .14, .32, .07, .36, '#2b3a44'));
      }
      if (lv >= 2) {
        f.box(.1, .55, .1, L - .2, .07, D - .2, '#56646c', '#6a7a82');
        for (const u of [.15, L - .3]) for (const v of [.15, D - .3]) f.box(u, .06, v, .15, .5, .15, '#6a7a82');
        for (let i = 0; i < 5; i++) f.box(.35 + i * .7, .62, .9, .38, .14, .62, cars[(i + 2) % 6]);
      }
      if (lv >= 3) {
        f.box(.1, 1.05, .1, L - .2, .07, D - .2, '#56646c', '#6a7a82');
        for (const u of [.15, L - .3]) for (const v of [.15, D - .3]) f.box(u, .62, v, .15, .44, .15, '#6a7a82');
        for (let i = 0; i < 4; i++) f.box(.6 + i * .75, 1.12, 1.6, .38, .14, .62, cars[(i + 4) % 6]);
      }
      f.box(L - .5, .08, D - .45, .35, .4, .3, '#d9a55a', '#ffd27a');
      break;
    }
    case 'shops':
      f.box(.1, .03, .1, L - .2, .78, D - .2, '#5d6f86', '#8fa3b8');
      m.glass(() => { for (let i = 0; i < 4; i++) f.box(.2 + i * .66, .12, D - .12, .56, .5, .04, '#9fdcf0'); });
      for (let i = 0; i < 4; i++) f.extrude([[.2 + i * .66, .7, D - .1], [.76 + i * .66, .7, D - .1], [.76 + i * .66, .62, D + .16], [.2 + i * .66, .62, D + .16]], [0, .03, 0], ['#e46d6d', '#f2c24f', '#5fc2a8', '#a07ae0'][i]);
      f.box(.6, .82, .4, L - 1.2, .2, .1, '#ffe08a');
      for (let i = 1; i < lv; i++) f.box(.25 + i * .5, .81, .35, .35, .35, .35, '#7d90a6', '#b8c8d6');
      for (let i = 0; i < 3; i++) { f.cylinder(.5 + i * .9, .03, -.0 + .05, .09, .02, '#e8e2d0'); f.cylinder(.5 + i * .9, .05, .05, .015, .22, '#8d8a82', 5); f.cone(.5 + i * .9, .25, .05, .2, .09, ['#e46d6d', '#5fc2a8', '#f2c24f'][i], 8); }
      localFrame(lights, b).box(.2, .12, D - .09, L - .4, .5, .02, '#ffe3a1');
      break;
    case 'cargo':
      f.box(0, .025, 0, L, .06, D, '#4f5b61', '#66747a');
      f.box(.1, .08, .08, L - .2, .95, .9, '#7a6a55', '#b8a07a');
      for (let i = 0; i < 6; i++) f.box(.2 + i * .6, .3, .975, .45, .62, .03, '#5c5042');
      f.box(.05, 1.03, .03, L - .1, .08, 1, '#5a4c3e', '#cfb68a');
      for (let i = 0; i < 2 + lv; i++) f.box(.25 + i * .7, .09, 2.55, .55, .28, .3, ['#c85b4c', '#3f7fb5', '#d6a640', '#4f9a6c', '#8c62b5'][i]);
      f.box(1.95, .088, 1.2, .1, .006, 1.4, '#f2c24f');
      f.box(1.2, .088, 1.9, 1.6, .006, .08, '#f2c24f');
      localFrame(lights, b).box(.4, .5, 1.0, L - .8, .1, .02, '#ffe3a1');
      break;
    case 'deicing':
      f.box(0, .02, 0, L, .06, D, '#4b5d6b', '#5e7a8c');
      f.cylinder(.6, .08, .6, .38, .85, '#d7e3ea', 12, '#f3f8fb');
      f.cylinder(1.4, .08, .6, .38, .85, '#c9d8e2', 12, '#f3f8fb');
      f.box(2.0, .08, .9, .8, .38, .5, '#3d7fb0', '#6fb6e0');
      f.box(2.15, .46, 1.0, .12, .55 + .15 * lv, .12, '#e5eef3');
      f.box(1.4, .95 + .15 * lv, 1.0, .9, .07, .12, '#e5eef3');
      f.box(.2, .085, 1.55, L - .4, .006, .08, '#5fd0ff');
      break;
  }
}

// ---------- aircraft ----------

function planeModel(cls, liveryId) {
  const m = meshBuilder(), s = CLASS[cls], L = s.len, S = s.span, liv = LIVERIES[liveryId] || LIVERIES.SK;
  const r = s.cargo ? .27 : cls === 'wide' ? .25 : cls === 'regional' ? .17 : .21, y0 = .52, seg = 12;
  const rings = [[-.6, .1], [-.53, .42], [-.42, .82], [-.3, 1], [.32, 1], [.47, .93], [.57, .76], [.64, .52], [.685, .26], [.705, .04]];
  for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < seg; i++) {
    const a = i * 2 * Math.PI / seg, b = (i + 1) * 2 * Math.PI / seg, [x1, k1] = rings[j], [x2, k2] = rings[j + 1], mid = Math.cos((a + b) / 2);
    const col = mid < -.45 ? liv.belly : mid < -.05 && x1 > -.45 && x2 < .6 ? liv.stripe : liv.body;
    m.quad([x1 * L, y0 + Math.cos(a) * r * k1, Math.sin(a) * r * k1], [x1 * L, y0 + Math.cos(b) * r * k1, Math.sin(b) * r * k1],
      [x2 * L, y0 + Math.cos(b) * r * k2, Math.sin(b) * r * k2], [x2 * L, y0 + Math.cos(a) * r * k2, Math.sin(a) * r * k2], col);
  }
  m.glass(() => {
    m.box(.54 * L, y0 + r * .38, -r * .5, .08 * L, r * .3, r, '#1d3646');
    if (!s.cargo) for (const z of [r * .985, -r * .985 - .012]) m.box(-.36 * L, y0 + r * .28, z, .78 * L, .045, .012, '#26404e');
  });
  for (const z of [r * .99, -r * .99 - .012]) { m.box(.42 * L, y0 - r * .25, z, .045, r * .7, .012, '#9aa6ad'); m.box(-.4 * L, y0 - r * .25, z, .045, r * .7, .012, '#9aa6ad'); }
  // Swept, tapered wings with a little thickness and coloured winglets.
  const wy = y0 - r * .5;
  for (const side of [-1, 1]) {
    const root = r * .9 * side, tip = S / 2 * side;
    m.extrude([[.16 * L, wy, root], [-.2 * L, wy, root], [-.3 * L, wy + .04, tip], [-.14 * L, wy + .04, tip]], [0, .035, 0], '#cfd9dd', '#b9c5ca');
    m.face([[-.3 * L, wy + .04, tip], [-.14 * L, wy + .04, tip], [-.22 * L, wy + .26, tip * 1.01]], [0, 0, side], liv.tail);
    m.face([[-.3 * L, wy + .04, tip], [-.14 * L, wy + .04, tip], [-.22 * L, wy + .26, tip * 1.01]], [0, 0, -side], liv.tail);
    const engines = cls === 'wide' || s.cargo ? [.36, .66] : [.42];
    for (const e of engines) {
      const ez = root + (tip - root) * e, lead = .16 * L + (-.14 * L - .16 * L) * e, er = r * (cls === 'regional' ? .42 : .5);
      m.tube(lead - .02 - er * 2.6, lead + .06, wy - er * .9, ez, er * .82, er, '#c4ced3', 10);
      m.tube(lead + .06, lead + .065, wy - er * .9, ez, er * .78, er * .78, '#2b333a', 10);
      m.box(lead - er * 1.6, wy - er * .2, ez - .015, er * 1.5, er * .5, .03, '#aeb9be');
    }
    m.extrude([[-.5 * L, y0 + r * .15, side * r * .5], [-.62 * L, y0 + r * .15, side * r * .5], [-.68 * L, y0 + r * .2, side * S * .19], [-.6 * L, y0 + r * .2, side * S * .19]], [0, .025, 0], '#d2dbdf');
  }
  // Fin with the airline colour and an accent band.
  const fin = [[-.42 * L, y0 + r * .7, 0], [-.62 * L, y0 + r * .5, 0], [-.68 * L, y0 + r + .55 * L * .3, 0], [-.56 * L, y0 + r + .55 * L * .3, 0]];
  m.extrude(fin.map(p => [p[0], p[1], -.018]), [0, 0, .036], liv.tail);
  m.extrude([[-.52 * L, y0 + r + .2 * L * .3, -.022], [-.62 * L, y0 + r + .17 * L * .3, -.022], [-.645 * L, y0 + r + .3 * L * .3, -.022], [-.545 * L, y0 + r + .33 * L * .3, -.022]], [0, 0, .044], liv.accent);
  // Landing gear.
  m.box(.45 * L, .04, -.025, .05, y0 - r - .02, .05, '#30383e');
  for (const z of [-r * .9, r * .9 - .07]) m.box(-.12 * L, .04, z, .1, y0 - r * .6 - .04, .07, '#30383e');
  return m;
}

// Navigation lights: red port, green starboard, white tail and a red beacon. Drawn emissive at night.
function planeLightsModel(cls) {
  const m = meshBuilder(), s = CLASS[cls], L = s.len, S = s.span, r = s.cargo ? .27 : cls === 'wide' ? .25 : cls === 'regional' ? .17 : .21, wy = .52 - r * .5 + .06;
  m.box(-.3 * L, wy, -S / 2 - .03, .06, .05, .05, '#ff4d4d', '#ff4d4d', true);
  m.box(-.3 * L, wy, S / 2 - .02, .06, .05, .05, '#4dff7a', '#4dff7a', true);
  m.box(-.7 * L, .52, -.025, .05, .05, .05, '#ffffff', '#ffffff', true);
  m.box(-.05 * L, .52 + r, -.025, .06, .04, .05, '#ff3030', '#ff3030', true);
  return m;
}

// ---------- ground vehicles (x forward, z right, origin on the ground) ----------

function wheels(m, xs, half, r = .045) { for (const x of xs) for (const z of [-half, half - .03]) m.box(x - r, 0, z, r * 2, r * 2, .03, '#1f2427'); }

const VEHICLES = {
  fuel(m) { m.box(-.42, .06, -.13, .84, .06, .26, '#3a4248'); m.box(.22, .1, -.13, .22, .2, .26, '#f2f2ee', '#d8dad5'); m.glass(() => m.box(.42, .2, -.11, .02, .08, .22, '#2b4654')); m.tube(-.42, .2, .23, 0, .12, .12, '#e7e4da', 10); m.box(-.3, .34, -.04, .3, .02, .08, '#c94f3d'); wheels(m, [-.3, -.1, .3], .14); },
  tug(m) { m.box(-.24, .04, -.16, .48, .1, .32, '#f2c94c', '#ffd966'); m.box(-.2, .14, -.12, .16, .1, .24, '#3a4248'); m.glass(() => m.box(-.19, .18, -.11, .14, .05, .22, '#2b4654')); wheels(m, [-.15, .15], .17); },
  baggage(m) {
    m.box(.05, .04, -.09, .26, .09, .18, '#f2c94c'); m.box(.08, .13, -.06, .1, .08, .12, '#3a4248'); wheels(m, [.1, .26], .1, .035);
    for (let i = 0; i < 2; i++) {
      const x = -.32 - i * .38;
      m.box(x, .05, -.1, .32, .04, .2, '#8f979c'); wheels(m, [x + .05, x + .27], .11, .03);
      for (let k = 0; k < 3; k++) m.box(x + .03 + k * .1, .09, -.08 + (k % 2) * .03, .08, .06 + (k % 2) * .02, .12, ['#3d5a80', '#9b4f3f', '#3f6f4f', '#5b4b7a'][(i + k) % 4]);
    }
  },
  belt(m) { m.box(-.3, .05, -.08, .5, .08, .16, '#e4e1d6'); m.extrude([[-.3, .14, -.06], [.36, .44, -.06], [.36, .47, -.06], [-.3, .17, -.06]], [0, 0, .12], '#30373c'); m.box(.05, .13, -.07, .12, .1, .14, '#f2c94c'); wheels(m, [-.22, .12], .09); },
  catering(m) { m.box(-.32, .06, -.12, .66, .06, .24, '#3a4248'); m.box(.2, .1, -.12, .16, .18, .24, '#f2f2ee'); m.box(-.32, .3, -.12, .5, .26, .24, '#eef1f3', '#d9dde0'); for (const x of [-.25, .05]) m.box(x, .12, -.02, .03, .18, .04, '#8c9499'); m.box(-.3, .4, -.125, .46, .05, .005, '#d84b4b'); wheels(m, [-.22, .25], .13); },
  loader(m) { m.box(-.36, .05, -.22, .72, .07, .44, '#d8d8d0'); m.box(-.34, .12, -.2, .68, .14, .4, '#e3e3db', '#c9c9c0'); m.box(-.32, .27, -.18, .64, .02, .36, '#7e868b'); m.box(.3, .27, -.2, .06, .14, .4, '#f2c94c'); wheels(m, [-.25, .25], .23); },
  van(m) { m.box(-.26, .05, -.12, .52, .2, .24, '#f2f2ee', '#e3e5e2'); m.glass(() => m.box(.18, .14, -.11, .08, .08, .22, '#2b4654')); m.box(-.24, .14, -.125, .4, .04, .005, '#f28a1d'); wheels(m, [-.16, .16], .13); }
};
const VEHICLE_BEACONS = {fuel: [.32, .31, 0], tug: [-.12, .25, 0], baggage: [.13, .22, 0], belt: [.1, .24, 0], catering: [.28, .3, 0], loader: [.33, .42, 0], van: [-.05, .26, 0]};
function vehicleModel(kind) { const m = meshBuilder(); VEHICLES[kind](m); return m; }
function beaconModel() { const m = meshBuilder(); m.box(-.025, 0, -.025, .05, .04, .05, '#ff9a2e', '#ffb15c', true); return m; }

// Telescopic jet bridge tunnel: unit length along +x, scaled at draw time; the cab is a separate mesh.
function tunnelModel() {
  const m = meshBuilder();
  m.box(0, .46, -.11, 1, .18, .22, '#c3ccd1', '#e3e9ec', true);
  m.glass(() => m.box(0, .52, -.115, 1, .06, .23, '#6fa9bf'));
  return m;
}
function bridgeCabModel() {
  const m = meshBuilder();
  m.box(-.04, .42, -.16, .2, .26, .32, '#aeb8be', '#d5dde1', true);
  m.box(-.02, .02, -.04, .08, .4, .08, '#69767e');
  m.box(-.08, .02, -.12, .16, .06, .24, '#3b4349');
  return m;
}

// ---------- sky, clouds, weather ----------

function cloudModel(seed) {
  const m = meshBuilder(), n = 5 + Math.floor(hash(seed, 1) * 3);
  for (let i = 0; i < n; i++) {
    const x = (i - n / 2) * .8 + hash(seed, i + 2) * .5, z = (hash(seed, i + 10) - .5) * 1.3, r = .7 + hash(seed, i + 20) * .7 - Math.abs(i - n / 2) * .08;
    m.sphere(x, r * .25 + hash(seed, i + 30) * .2, z, r * 1.15, r * .7, r, '#ffffff', 10, 6);
  }
  return m;
}

function weatherModel(kind) {
  const m = meshBuilder();
  if (kind === 'rain') for (let i = 0; i < 700; i++) m.box(rand(-35, 35), rand(0, 18), rand(-35, 35), .025, .55, .025, '#a9c9da');
  else if (kind === 'snow') for (let i = 0; i < 900; i++) m.box(rand(-35, 35), rand(0, 18), rand(-35, 35), .07, .07, .07, '#ffffff');
  else for (let i = 0; i < 650; i++) m.box(rand(-35, 35), rand(0, 5), rand(-35, 35), .7, .03, .03, '#e0c08e');
  return m;
}

function shadowBlobModel() { const m = meshBuilder(); m.disc(0, .12, 0, .65, '#1d3038', 16); return m; }
