'use strict';
/* A small self-contained WebGL renderer: every model and material is generated from triangles at runtime. */

const canvas = document.getElementById('world');
const gl = canvas.getContext('webgl2', {antialias: true, alpha: false, powerPreference: 'high-performance'}) ||
  canvas.getContext('webgl', {antialias: true, alpha: false});

const VERTEX_SHADER = `attribute vec3 aPosition;attribute vec3 aColor;attribute vec3 aNormal;
uniform mat4 uProjection,uView,uModel;varying vec3 vColor,vNormal;varying float vDistance;
void main(){vec4 eye=uView*uModel*vec4(aPosition,1.0);gl_Position=uProjection*eye;vDistance=-eye.z;vColor=aColor;vNormal=(uModel*vec4(aNormal,0.0)).xyz;}`;
const FRAGMENT_SHADER = `precision mediump float;varying vec3 vColor,vNormal;varying float vDistance;
uniform vec3 uTint,uFog;uniform float uAlpha,uLight,uFogStart,uFogRange,uFogMax;
void main(){vec3 n=normalize(vNormal);float diffuse=max(dot(n,normalize(vec3(-0.45,0.92,0.42))),0.0);
float shade=(0.52+0.48*diffuse)*uLight;vec3 lit=vColor*uTint*shade;float fog=clamp((vDistance-uFogStart)/uFogRange,0.0,uFogMax);
gl_FragColor=vec4(mix(lit,uFog,fog),uAlpha);}`;

let loc = null;
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const camera = {x: 23, z: 16, az: .7, elev: .88, dist: 47};
const viewMat = new Float32Array(16), projMat = new Float32Array(16);
let eye = [0, 0, 0], forward = [0, 0, -1], right = [1, 0, 0], up = [0, 1, 0];
let worldMesh = null, lightsMesh = null, statusMesh = null, statusKey = '', shadowMesh = null, worldDirty = true, lastScreenAspect = null;
const planeMeshes = {}, weatherMeshes = {}, overlayCache = {};

function initRenderer() {
  if (!gl) return false;
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  const program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const u = name => gl.getUniformLocation(program, name);
  loc = {p: gl.getAttribLocation(program, 'aPosition'), c: gl.getAttribLocation(program, 'aColor'), n: gl.getAttribLocation(program, 'aNormal'),
    proj: u('uProjection'), view: u('uView'), model: u('uModel'), tint: u('uTint'), alpha: u('uAlpha'), light: u('uLight'),
    fog: u('uFog'), fogStart: u('uFogStart'), fogRange: u('uFogRange'), fogMax: u('uFogMax')};
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  return true;
}

// ---------- mesh building ----------

const rgb = hex => [parseInt(hex.slice(1, 3), 16) / 255, parseInt(hex.slice(3, 5), 16) / 255, parseInt(hex.slice(5, 7), 16) / 255];
const colorCache = new Map();
const color = c => Array.isArray(c) ? c : colorCache.get(c) || (colorCache.set(c, rgb(c)), colorCache.get(c));
const norm = v => { const d = Math.hypot(...v) || 1; return v.map(q => q / d); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function meshBuilder() {
  const data = [];
  function triangle(a, b, c, col) {
    const n = norm(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]])), co = color(col);
    for (const p of [a, b, c]) data.push(p[0], p[1], p[2], co[0], co[1], co[2], n[0], n[1], n[2]);
  }
  function quad(a, b, c, d, col) { triangle(a, b, c, col); triangle(a, c, d, col); }
  function box(x, y, z, w, h, d, col, top = col) {
    const x2 = x + w, y2 = y + h, z2 = z + d;
    quad([x, y2, z], [x, y2, z2], [x2, y2, z2], [x2, y2, z], top);
    quad([x, y, z2], [x2, y, z2], [x2, y2, z2], [x, y2, z2], col);
    quad([x2, y, z], [x, y, z], [x, y2, z], [x2, y2, z], col);
    quad([x, y, z], [x, y, z2], [x, y2, z2], [x, y2, z], col);
    quad([x2, y, z2], [x2, y, z], [x2, y2, z], [x2, y2, z2], col);
  }
  function disc(cx, y, cz, r, col, segments = 12) {
    for (let i = 0; i < segments; i++) {
      const a = i * 2 * Math.PI / segments, b = (i + 1) * 2 * Math.PI / segments;
      triangle([cx, y, cz], [cx + r * Math.sin(a), y, cz + r * Math.cos(a)], [cx + r * Math.sin(b), y, cz + r * Math.cos(b)], col);
    }
  }
  function cylinder(cx, y, cz, r, h, col, segments = 10, top = col) {
    for (let i = 0; i < segments; i++) {
      const a = i * 2 * Math.PI / segments, b = (i + 1) * 2 * Math.PI / segments;
      const ax = cx + r * Math.sin(a), az = cz + r * Math.cos(a), bx = cx + r * Math.sin(b), bz = cz + r * Math.cos(b);
      quad([ax, y, az], [bx, y, bz], [bx, y + h, bz], [ax, y + h, az], col);
      triangle([cx, y + h, cz], [ax, y + h, az], [bx, y + h, bz], top);
    }
  }
  function cone(cx, y, cz, r, h, col, segments = 8) {
    for (let i = 0; i < segments; i++) {
      const a = i * 2 * Math.PI / segments, b = (i + 1) * 2 * Math.PI / segments;
      triangle([cx + r * Math.sin(a), y, cz + r * Math.cos(a)], [cx + r * Math.sin(b), y, cz + r * Math.cos(b)], [cx, y + h, cz], col);
    }
  }
  return {data, triangle, quad, box, disc, cylinder, cone};
}

function upload(m, usage = gl.STATIC_DRAW) {
  const arr = new Float32Array(m.data), buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, arr, usage);
  return {buffer, count: arr.length / 9};
}
function dispose(mesh) { if (mesh) gl.deleteBuffer(mesh.buffer); }

function draw(mesh, model = identity, tint = [1, 1, 1], alpha = 1) {
  if (!mesh || !mesh.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
  gl.enableVertexAttribArray(loc.p);
  gl.enableVertexAttribArray(loc.c);
  gl.enableVertexAttribArray(loc.n);
  gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, 36, 0);
  gl.vertexAttribPointer(loc.c, 3, gl.FLOAT, false, 36, 12);
  gl.vertexAttribPointer(loc.n, 3, gl.FLOAT, false, 36, 24);
  gl.uniformMatrix4fv(loc.model, false, model);
  gl.uniform3fv(loc.tint, tint);
  gl.uniform1f(loc.alpha, alpha);
  gl.depthMask(alpha >= 1);
  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  gl.depthMask(true);
}

// Building models are written in local (u, v) coordinates so rotated footprints reuse the same code.
function localFrame(m, b) {
  const t = TYPES[b.type], L = t.w, D = t.h;
  const p = (u, v) => localToWorld(b, u, v);
  return {L, D,
    box: (u, y, v, du, dy, dv, col, top) => b.rot ? m.box(b.x + v, y, b.y + u, dv, dy, du, col, top) : m.box(b.x + u, y, b.y + v, du, dy, dv, col, top),
    disc: (u, y, v, r, col, seg) => { const q = p(u, v); m.disc(q.x, y, q.y, r, col, seg); },
    cylinder: (u, y, v, r, h, col, seg, top) => { const q = p(u, v); m.cylinder(q.x, y, q.y, r, h, col, seg, top); },
    cone: (u, y, v, r, h, col, seg) => { const q = p(u, v); m.cone(q.x, y, q.y, r, h, col, seg); }};
}

// Cheap deterministic pseudo-random numbers keep scenery stable between rebuilds.
const hash = (i, salt = 0) => { const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return s - Math.floor(s); };

function terrain(m) {
  const location = G.location;
  if (location === 'island') {
    m.box(-28, -.32, -28, W + 56, .21, H + 56, '#164e67', '#2c7890');
    for (let i = 0; i < 45; i++) {
      const x = (i * 31 % 98) - 24, z = (i * 49 % 82) - 24;
      if (x > -2 && x < W + 2 && z > -2 && z < H + 2) continue;
      m.box(x, -.1, z, 2.7, .015, .08, '#72aab0');
    }
    m.box(-1.3, -.17, -1.3, W + 2.6, .14, H + 2.6, '#af9874', '#e8cd92');
    m.box(0, -.035, 0, W, .05, H, '#597a6b', '#74a089');
    for (let i = 0; i < 54; i++) {
      const x = (i * 73 % 505) / 10, z = (i * 37 % 342) / 10;
      if (at(Math.floor(x), Math.floor(z))) continue;
      m.box(x, .01, z, .1, .57, .1, '#83765e');
      m.box(x - .29, .52, z - .28, .72, .23, .72, '#388271', '#5cb89b');
    }
  } else if (location === 'city') {
    m.box(-10, -.24, -10, W + 20, .19, H + 20, '#354450', '#516171');
    m.box(0, -.035, 0, W, .05, H, '#3e5359', '#687a7d');
    for (let x = 0; x < W; x += 5) m.box(x, .014, 0, .08, .009, H, '#a3a395');
    for (let z = 0; z < H; z += 5) m.box(0, .014, z, W, .009, .08, '#a3a395');
    for (let i = 0; i < 46; i++) {
      const x = (i * 13 % 68) - 9, z = (i * 29 % 52) - 9;
      if (x >= -2 && x < W + 2 && z >= -2 && z < H + 2) continue;
      const height = 2 + (i * 7 % 7);
      m.box(x, .01, z, 1.5, height, 1.3, i % 3 ? '#344e5d' : '#40596b', i % 2 ? '#95adb7' : '#6a899c');
      for (let h = 1; h < height; h += 1) m.box(x + .2, h, z + 1.31, 1.1, .12, .03, '#e8ca92');
    }
  } else if (location === 'desert') {
    m.box(-15, -.22, -15, W + 30, .18, H + 30, '#9d7657', '#c9a879');
    m.box(0, -.035, 0, W, .05, H, '#b19469', '#d5b785');
    for (let i = 0; i < 90; i++) {
      const x = (i * 79 % 499) / 10, z = (i * 37 % 337) / 10;
      if (at(Math.floor(x), Math.floor(z))) continue;
      if (i % 4) m.box(x, .013, z, .5, .025, .2, '#e3ca92');
      else { m.box(x + .3, .012, z + .3, .09, .46, .09, '#4d7761'); m.box(x + .12, .29, z + .3, .28, .06, .06, '#4d7761'); }
    }
    for (let i = 0; i < 8; i++) { const x = i % 2 ? -7 : W + 2, z = (i * 19 % 39) - 2; m.box(x, -.04, z, 3, 1 + i % 4, 2, '#9d7c59', '#b9976b'); }
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
      m.cone(x, -.2 + h * .6, z, r * .4, h * .4, '#f3f7f9', 7);
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
      if (!at(x, z) && x > 1 && z > 1) { m.box(x + .46, .01, z + .46, .07, .22, .07, '#5c6755'); m.box(x + .21, .17, z + .21, .57, .44, .57, '#3b6b55', '#528367'); }
    }
  }
  const line = {desert: '#dfc89a', city: '#7d969a', mountain: '#a7b6ba'}[location] || '#55756a';
  for (let x = 0; x <= W; x++) m.box(x, .016, 0, .014, .005, H, line);
  for (let z = 0; z <= H; z++) m.box(0, .016, z, W, .005, .014, line);
}

function taxiGeom(m, lights, b) {
  const x = b.x, z = b.y;
  m.box(x, .012, z, 1, .07, 1, '#374955', '#43565e');
  m.box(x + .075, .083, z + .075, .85, .008, .85, b.level > 1 ? '#475d63' : '#43545d');
  const linked = [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dz]) => ['taxi', 'gate', 'runway', 'cargo'].includes(at(x + dx, z + dz)?.type));
  m.box(x + .44, .094, z + .44, .12, .009, .12, '#e8b858');
  for (const [dx, dz] of linked) {
    if (dx) m.box(x + (dx < 0 ? 0 : .5), .094, z + .47, .5, .009, .06, '#e8b858');
    else m.box(x + .47, .094, z + (dz < 0 ? 0 : .5), .06, .009, .5, '#e8b858');
  }
  if ((b.x + b.y) % 2 === 0) lights.disc(x + .5, .1, z + .5, .05, '#7dffb0', 6);
}

function runwayGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D;
  f.box(0, .025, 0, L, .10, D, '#37414c', '#38444e');
  f.box(.09, .127, .13, L - .18, .008, .035, '#d2e4e7');
  f.box(.09, .127, D - .16, L - .18, .008, .035, '#d2e4e7');
  for (let i = 1; i < L - 1; i += 2) f.box(i + .13, .129, D / 2 - .035, .94, .008, .07, '#f7f4dc');
  for (const side of [.33, L - 1.18]) for (let j = 0; j < 4; j++) f.box(side, .13, .22 + j * .38, .5, .008, .055, '#f0f2ee');
  for (let i = 1; i < b.level; i++) for (const side of [1.2, L - 1.5]) f.box(side + i * .14 - .14, .13, D / 2 - .3, .07, .008, .6, '#7fd9ff');
  for (const u of [.48, L - .48]) for (const v of [-.18, D + .1]) f.box(u - .14, .015, v, .28, .16, .08, '#b98636', '#ffe49b');
  for (const u of [-.2, L + .12]) f.box(u, .015, D / 2 - .14, .08, .16, .28, '#b98636', '#ffe49b');
  for (let i = 1; i < L * 2; i++) for (const v of [.08, D - .08]) f.disc(i * .5, .148, v, .038, i % 2 ? '#ffde89' : '#b4f0e2', 6);
  const fl = localFrame(lights, b);
  for (let i = 1; i < L * 2; i += 2) for (const v of [.08, D - .08]) fl.disc(i * .5, .155, v, .075, '#fff1b8', 6);
  for (let j = 0; j < 5; j++) { fl.disc(-.1, .155, .2 + j * .4, .07, '#7dff9a', 6); fl.disc(L + .1, .155, .2 + j * .4, .07, '#ff7d7d', 6); }
}

function gateGeom(m, b) {
  const x = b.x, z = b.y, w = b.w, d = b.h;
  m.box(x, .03, z, w, .055, d, '#505e68', '#657b7a');
  m.box(x + .13, .089, z + .1, w - .26, .008, .045, '#dce6ce');
  m.box(x + .13, .089, z + d - .145, w - .26, .008, .045, '#dce6ce');
  m.box(x + .1, .09, z + .1, .04, .008, d - .2, '#dce6ce');
  m.box(x + w - .14, .09, z + .1, .04, .008, d - .2, '#dce6ce');
  m.box(x + .12, .1, z + .12, .24, .11, .25, '#607a87', '#8cb8b7');
  m.box(x + .23, .22, z + .21, .16, .06, .18, '#a2c3ca');
  if (b.level >= 2) m.box(x + w - .5, .1, z + .12, .33, .09, .28, '#7764a7', '#c6b7ea');
  if (b.level >= 3) m.box(x + .5, .1, z + .12, .5, .07, .16, '#a88a3f', '#ffd27a');
}

function terminalGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D;
  f.box(.13, .05, .14, L - .26, 1.35, D - .28, '#427184', '#6198a4');
  f.box(.05, 1.4, .05, L - .1, .13, D - .1, '#32546a', '#b7c9be');
  f.box(.5, 1.53, .45, L - 1, .09, D - .9, '#526e7c', '#739aa6');
  for (let i = 0; i < 12; i++) {
    const u = .35 + i * (L - .7) / 12;
    f.box(u, .42, .085, (L - .9) / 12, .7, .07, '#6db6c2', '#89d1d4');
    f.box(u, .42, D - .16, (L - .9) / 12, .7, .07, '#6db6c2', '#89d1d4');
  }
  for (let j = 0; j < 4; j++) {
    const v = .35 + j * (D - .7) / 4;
    f.box(.085, .4, v, .07, .72, (D - .9) / 4, '#73b8c5');
    f.box(L - .155, .4, v, .07, .72, (D - .9) / 4, '#73b8c5');
  }
  f.box(.1, .02, D - .02, L - .2, .2, .45, '#305260', '#a5c5c0');
  for (let i = 0; i < b.level; i++) f.box(1.1 + i * .8, 1.63, D / 2 - .22, .5, .07, .44, '#497f8d', '#b2e4df');
  const fl = localFrame(lights, b);
  fl.box(.4, .5, .06, L - .8, .5, .03, '#ffe3a1');
  fl.box(.4, .5, D - .11, L - .8, .5, .03, '#ffe3a1');
}

function utilityGeom(m, lights, b) {
  const f = localFrame(m, b), L = f.L, D = f.D, lv = b.level;
  switch (b.type) {
    case 'ferry':
      f.box(0, .01, 0, L, .10, D, '#a79068', '#ccbb91');
      f.box(.2, .12, .2, L - .4, .16, D - .4, '#6c978e', '#a4c8b0');
      for (let j = 0; j < 4; j++) f.box(.25 + j * .7, .25, .2, .12, .56, .12, '#d1c7a3');
      f.box(.36, .83, .3, L - .72, .1, 1.15, '#3e817f', '#95caca');
      f.box(1.2, .94, .7, .15, .48, .13, '#ddd5ad');
      break;
    case 'metro':
      f.box(.12, .01, .12, L - .24, .35, D - .24, '#354a59', '#527688');
      f.box(.24, .38, .24, L - .48, 1, D - .48, '#416b7c', '#83acb7');
      f.box(.08, 1.38, .08, L - .16, .15, D - .16, '#508481', '#bde2d6');
      for (let j = 0; j < 5; j++) f.box(.35 + j * .5, .66, D - .2, .26, .27, .06, '#c6e9e0');
      localFrame(lights, b).box(.35, .66, D - .17, 2.3, .27, .03, '#ffe3a1');
      break;
    case 'solar':
      f.box(0, .02, 0, L, .08, D, '#b5966a', '#dfbf85');
      for (let j = 0; j < 3; j++) for (let i = 0; i < 2; i++) f.box(.15 + j * .92, .19, .15 + i * .85, .75, .06, .68, '#315d79', '#67a6bb');
      f.box(1.5, .1, .8, .08, .3, .08, '#746e5d');
      break;
    case 'service':
      f.box(.12, .03, .12, L - .24, .92, D - .24, '#526a72', '#77969f');
      f.box(.02, .96, .04, L - .04, .12, D - .08, '#384b59', '#a3b5b7');
      for (let i = 0; i < 3; i++) f.box(.2 + i * .9, .13, D - .02, .62, .62, .04, '#789b9d', '#cedfdb');
      f.box(L - .65, 1.1, .45, .34, .32, .34, '#596e74', '#94adaf');
      for (let i = 1; i < lv; i++) f.box(.3 + i * .4, 1.09, .3, .25, .14, .25, '#e0b966', '#ffc76e');
      break;
    case 'fuel':
      f.box(0, .025, 0, L, .055, D, '#596259', '#707760');
      f.cylinder(.85, .1, 1, .67, .9, '#bbc6b8', 12);
      f.cylinder(2.08, .1, 1, .64, .9, '#9facaa', 12);
      f.box(.8, 1.01, .5, 1.4, .07, .08, '#c7a855', '#ebd07c');
      for (let j = 0; j < lv; j++) f.box(.65 + j * .74, .1, .11, .13, .36, .13, '#e0b966', '#ffc76e');
      break;
    case 'parking': {
      f.box(0, .02, 0, L, .06, D, '#3c4850', '#4b5961');
      for (let i = 0; i <= 6; i++) for (const v of [.15, 1.75]) f.box(.2 + i * .6, .085, v, .03, .006, 1.1, '#dfe5df');
      const cars = ['#d65f5f', '#5f9bd6', '#e8d27a', '#e7eef0', '#7fc79a', '#9a86d6'];
      for (let i = 0; i < 6; i++) for (const v of [.35, 1.95]) if (hash(b.id * 13 + i, v) > .3) {
        f.box(.3 + i * .6, .09, v, .38, .14, .66, cars[(i + (v > 1 ? 3 : 0)) % 6]);
        f.box(.34 + i * .6, .23, v + .14, .3, .08, .36, '#2b3a44');
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
      for (let i = 0; i < 4; i++) f.box(.2 + i * .66, .12, D - .12, .56, .5, .04, '#9fdcf0');
      for (let i = 0; i < 4; i++) f.box(.2 + i * .66, .64, D - .08, .56, .08, .3, ['#e46d6d', '#f2c24f', '#5fc2a8', '#a07ae0'][i]);
      f.box(.6, .82, .4, L - 1.2, .2, .1, '#ffe08a');
      for (let i = 1; i < lv; i++) f.box(.25 + i * .5, .81, .35, .35, .35, .35, '#7d90a6', '#b8c8d6');
      localFrame(lights, b).box(.2, .12, D - .09, L - .4, .5, .02, '#ffe3a1');
      break;
    case 'cargo':
      f.box(0, .025, 0, L, .06, D, '#4f5b61', '#66747a');
      f.box(.1, .08, .08, L - .2, .95, .9, '#7a6a55', '#b8a07a');
      for (let i = 0; i < 6; i++) f.box(.2 + i * .6, .3, .975, .45, .62, .03, '#5c5042');
      f.box(.05, 1.03, .03, L - .1, .08, 1, '#5a4c3e', '#cfb68a');
      for (let i = 0; i < 2 + lv; i++) f.box(.25 + i * .7, .09, 2.55, .55, .28, .3, ['#c85b4c', '#3f7fb5', '#d6a640', '#4f9a6c', '#8c62b5'][i]);
      f.box(1.95, .09, 1.2, .1, .006, 1.4, '#f2c24f');
      f.box(1.2, .09, 1.9, 1.6, .006, .08, '#f2c24f');
      localFrame(lights, b).box(.4, .5, 1.0, L - .8, .1, .02, '#ffe3a1');
      break;
    case 'deicing':
      f.box(0, .02, 0, L, .06, D, '#4b5d6b', '#5e7a8c');
      f.cylinder(.6, .08, .6, .38, .85, '#d7e3ea', 10, '#f3f8fb');
      f.cylinder(1.4, .08, .6, .38, .85, '#c9d8e2', 10, '#f3f8fb');
      f.box(2.0, .08, .9, .8, .38, .5, '#3d7fb0', '#6fb6e0');
      f.box(2.15, .46, 1.0, .12, .55 + .15 * lv, .12, '#e5eef3');
      f.box(1.4, .95 + .15 * lv, 1.0, .9, .07, .12, '#e5eef3');
      f.box(.2, .085, 1.55, L - .4, .006, .08, '#5fd0ff');
      break;
    default: // tower
      f.box(.35, .02, .35, L - .7, 1.55, D - .7, '#566d79', '#718996');
      f.box(.2, 1.58, .2, L - .4, .62, D - .4, '#4a697d', '#8bc1c5');
      for (let i = 0; i < 4; i++) { const p = .31 + i * .37; f.box(p, 1.67, .15, .20, .37, .08, '#badfdf'); f.box(p, 1.67, D - .23, .20, .37, .08, '#badfdf'); }
      f.box(.08, 2.22, .08, L - .16, .14, D - .16, '#344a5a', '#c0c9ba');
      f.box(L / 2 - .05, 2.36, D / 2 - .05, .1, .68 + .2 * (lv - 1), .1, '#c7c7b1', '#f0f1d0');
      localFrame(lights, b).disc(L / 2, 3.06 + .2 * (lv - 1), D / 2, .1, '#ff5f5f', 8);
      localFrame(lights, b).box(.21, 1.7, .19, L - .42, .3, .02, '#bdf3ff');
  }
}

function buildWorld() {
  const m = meshBuilder(), lights = meshBuilder();
  terrain(m);
  for (const b of G.buildings) {
    if (b.type === 'taxi') taxiGeom(m, lights, b);
    else if (b.type === 'runway') runwayGeom(m, lights, b);
    else if (b.type === 'gate') gateGeom(m, b);
    else if (b.type === 'terminal') terminalGeom(m, lights, b);
    else utilityGeom(m, lights, b);
  }
  dispose(worldMesh);
  dispose(lightsMesh);
  worldMesh = upload(m);
  lightsMesh = upload(lights);
  worldDirty = false;
  statusKey = '';
}

// Small status lamps on every stand: aqua — free, gold — reserved, red — occupied.
function standStatus(b) {
  const p = b.gatePlane && G.planes.find(q => q.id === b.gatePlane);
  return !p ? 0 : ['service', 'ready'].includes(p.state) ? 2 : 1;
}
function buildStatus() {
  const stands = G.buildings.filter(b => b.type === 'gate' || b.type === 'cargo');
  const key = stands.map(b => b.id + ':' + standStatus(b)).join(',');
  if (key === statusKey && statusMesh) return;
  statusKey = key;
  const m = meshBuilder();
  for (const b of stands) {
    const s = standStatus(b), body = ['#488879', '#ac8741', '#af544d'][s], top = ['#8ee7ce', '#ffe094', '#ff917e'][s];
    const p = b.type === 'cargo' ? localToWorld(b, TYPES.cargo.w - .35, 2.7) : {x: b.x + b.w - .29, y: b.y + b.h - .28};
    m.box(p.x, .10, p.y, .14, .32, .14, body, top);
  }
  dispose(statusMesh);
  statusMesh = upload(m);
}

function planeModel(cls) {
  const m = meshBuilder(), spec = CLASS[cls], len = spec.len, span = spec.span, col = spec.color, cargo = !!spec.cargo, radius = cargo ? .26 : .22;
  const rings = [[-len * .57, .07], [-len * .44, radius * .86], [-len * .22, radius], [len * .31, radius], [len * .55, radius * .6], [len * .7, .015]];
  for (let j = 0; j < rings.length - 1; j++) for (let i = 0; i < 8; i++) {
    const a = i * Math.PI / 4, b = (i + 1) * Math.PI / 4, [x1, r1] = rings[j], [x2, r2] = rings[j + 1];
    m.quad([x1, .52 + Math.cos(a) * r1, Math.sin(a) * r1], [x1, .52 + Math.cos(b) * r1, Math.sin(b) * r1],
      [x2, .52 + Math.cos(b) * r2, Math.sin(b) * r2], [x2, .52 + Math.cos(a) * r2, Math.sin(a) * r2], col);
  }
  for (const s of [-1, 1]) {
    const wing = [[-len * .25, .53, s * .15], [len * .14, .53, s * .15], [-len * .09, .50, s * span * .49], [-len * .30, .50, s * span * .51]];
    m.quad(wing[0], wing[1], wing[2], wing[3], '#dae7e7');
    m.quad(wing[3], wing[2], wing[1], wing[0], '#dae7e7');
    m.box(-len * .4, .52, s > 0 ? span * .12 : -span * .41, len * .24, .05, span * .29, '#becfd4', '#dce6df');
    m.box(-len * .09, .39, s > 0 ? span * .19 : -span * .28, len * .16, .11, .09, '#536873', '#7695a0');
    if (cls === 'wide') m.box(-len * .14, .39, s > 0 ? span * .33 : -span * .42, len * .12, .1, .09, '#536873', '#7695a0');
  }
  const tail = cargo ? '#b0623a' : '#67c6bb';
  m.triangle([-len * .46, .62, 0], [-len * .62, 1.04, 0], [-len * .26, .62, 0], tail);
  m.triangle([-len * .26, .62, 0], [-len * .62, 1.04, 0], [-len * .46, .62, 0], tail);
  m.box(len * .38, .65, -.105, .18, .025, .21, '#204b60', '#497083');
  if (!cargo) for (const s of [-1, 1]) m.box(-len * .3, .58, s > 0 ? radius - .01 : -radius - .005, len * .62, .035, .015, '#2c5367');
  return upload(m);
}

function weatherModel(kind) {
  const m = meshBuilder();
  if (kind === 'rain') for (let i = 0; i < 700; i++) m.box(rand(-35, 35), rand(0, 18), rand(-35, 35), .025, .55, .025, '#a9c9da');
  else if (kind === 'snow') for (let i = 0; i < 900; i++) m.box(rand(-35, 35), rand(0, 18), rand(-35, 35), .07, .07, .07, '#ffffff');
  else for (let i = 0; i < 650; i++) m.box(rand(-35, 35), rand(0, 5), rand(-35, 35), .7, .03, .03, '#e0c08e');
  return upload(m);
}

// ---------- camera ----------

function perspective(fov, aspect, near, far) {
  const f = 1 / Math.tan(fov / 2), o = projMat;
  o.fill(0);
  o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far);
}

function view() {
  eye = [camera.x + Math.sin(camera.az) * Math.cos(camera.elev) * camera.dist, Math.sin(camera.elev) * camera.dist, camera.z + Math.cos(camera.az) * Math.cos(camera.elev) * camera.dist];
  forward = norm([camera.x - eye[0], -eye[1], camera.z - eye[2]]);
  right = norm(cross(forward, [0, 1, 0]));
  up = cross(right, forward);
  viewMat.set([right[0], up[0], -forward[0], 0, right[1], up[1], -forward[1], 0, right[2], up[2], -forward[2], 0,
    -(right[0] * eye[0] + right[1] * eye[1] + right[2] * eye[2]), -(up[0] * eye[0] + up[1] * eye[1] + up[2] * eye[2]),
    forward[0] * eye[0] + forward[1] * eye[1] + forward[2] * eye[2], 1]);
}

function center() {
  cameraTouched = false;
  const r = canvas.getBoundingClientRect(), focus = G.buildings.filter(b => ['runway', 'gate', 'terminal', 'cargo'].includes(b.type));
  const minX = Math.max(-1, Math.min(4, ...focus.map(b => b.x - 1))), maxX = Math.min(W + 1, Math.max(33, ...focus.map(b => b.x + b.w + 1)));
  const minZ = Math.max(-1, Math.min(5, ...focus.map(b => b.y - 1))), maxZ = Math.min(H + 1, Math.max(24, ...focus.map(b => b.y + b.h + 1)));
  camera.x = (minX + maxX) / 2;
  camera.z = (minZ + maxZ) / 2;
  camera.az = .64;
  camera.elev = r.width < r.height ? 1.04 : .92;
  const aspect = r.width / Math.max(1, r.height), tan = Math.tan(Math.PI / 6), corners = [[minX, minZ], [maxX, minZ], [minX, maxZ], [maxX, maxZ]];
  for (let dist = 24; dist <= 145; dist += 1.5) {
    camera.dist = dist;
    view();
    const fits = corners.every(([x, z]) => {
      const v = [x - eye[0], -eye[1], z - eye[2]], depth = v[0] * forward[0] + v[1] * forward[1] + v[2] * forward[2];
      if (depth <= .1) return false;
      const nx = (v[0] * right[0] + v[1] * right[1] + v[2] * right[2]) / (depth * tan * aspect), ny = (v[0] * up[0] + v[1] * up[1] + v[2] * up[2]) / (depth * tan);
      return Math.abs(nx) < .87 && Math.abs(ny) < .70;
    });
    if (fits) break;
  }
}

function screenCell(e) {
  const r = canvas.getBoundingClientRect();
  view();
  const aspect = r.width / r.height, nx = (2 * (e.clientX - r.left) / r.width - 1) * aspect * Math.tan(Math.PI / 6), ny = (1 - 2 * (e.clientY - r.top) / r.height) * Math.tan(Math.PI / 6);
  const ray = norm([forward[0] + right[0] * nx + up[0] * ny, forward[1] + right[1] * nx + up[1] * ny, forward[2] + right[2] * nx + up[2] * ny]);
  if (ray[1] >= -.001) return {x: -1, y: -1};
  const distance = -eye[1] / ray[1];
  return {x: Math.floor(eye[0] + distance * ray[0]), y: Math.floor(eye[2] + distance * ray[2])};
}

function resize() {
  const r = canvas.getBoundingClientRect(), cap = {high: 2, medium: 1.5, low: 1}[settings.quality] || 2;
  const dpr = Math.min(window.devicePixelRatio || 1, cap), aspect = r.width / Math.max(1, r.height);
  const changed = lastScreenAspect && Math.abs(aspect / lastScreenAspect - 1) > .08;
  canvas.width = Math.max(1, Math.floor(r.width * dpr));
  canvas.height = Math.max(1, Math.floor(r.height * dpr));
  lastScreenAspect = aspect;
  if (changed && !cameraTouched) center();
}

// ---------- overlays ----------

function overlay(name, key, build, alpha) {
  let cache = overlayCache[name];
  if (!cache || cache.key !== key) {
    dispose(cache);
    const m = meshBuilder();
    build(m);
    cache = overlayCache[name] = {...upload(m), key};
  }
  draw(cache, identity, [1, 1, 1], alpha);
}

function outline(name, x, z, w, d, col, alpha = .95) {
  overlay(name, [x, z, w, d, col].join(','), m => {
    const y = .21;
    m.box(x, y, z, w, .035, .065, col);
    m.box(x, y, z, .065, .035, d, col);
    m.box(x, y, z + d - .065, w, .035, .065, col);
    m.box(x + w - .065, y, z, .065, .035, d, col);
  }, alpha);
}

function ghost(x, z, w, d, type, ok) {
  const h = TYPES[type]?.height || .2, col = ok ? '#58d8b6' : '#e97783';
  overlay('ghostFill', [x, z, w, d, ok].join(','), m => m.box(x, .2, z, w, .03, d, ok ? '#55ffcd' : '#ff7779'), .35);
  overlay('ghost', [x, z, w, d, type, ok].join(','), m => m.box(x, .20, z, w, h, d, col), .24);
}

function drawDrafts() {
  if (!draft) {
    if (hover && inside(hover)) {
      if (buildTool(tool)) {
        const d = dims(tool, TYPES[tool].rotate ? buildRot : 0);
        ghost(hover.x, hover.y, d.w, d.h, tool, canPlace(tool, hover.x, hover.y, TYPES[tool].rotate ? buildRot : 0) && G.money >= buildCost(tool));
      } else if (tool === 'bulldoze') {
        const b = at(hover.x, hover.y);
        if (b) outline('hover', b.x, b.y, b.w, b.h, '#ff7779', .9);
      } else if (tool === 'inspect') {
        const b = at(hover.x, hover.y);
        if (b && b.id !== selected) outline('hover', b.x, b.y, b.w, b.h, '#bff7ec', .55);
      }
    }
    return;
  }
  const a = draftAssessment();
  if (draft.mode === 'demolish') {
    overlay('demolish', draft.ids.join(','), m => {
      for (const id of draft.ids) { const b = building(id); if (b) m.box(b.x, .2, b.y, b.w, (TYPES[b.type].height || .2) + .05, b.h, '#ff6b74'); }
    }, .38);
  } else if (draft.type === 'taxi') {
    overlay('taxiDraft', (a.valid ? 'ok:' : 'bad:') + draft.tiles.map(c => k(c.x, c.y)).join('|'), m => {
      for (const c of draft.tiles) m.box(c.x, .19, c.y, 1, .17, 1, a.valid ? '#5effcf' : '#ff777e');
    }, .42);
  } else {
    const d = dims(draft.type, draft.rot);
    ghost(draft.x, draft.y, d.w, d.h, draft.type, a.valid);
  }
}

// ---------- frame ----------

function daylight(hour) {
  if (hour < 4.5 || hour >= 21) return 0;
  if (hour < 7) return (hour - 4.5) / 2.5;
  if (hour < 18) return 1;
  return 1 - (hour - 18) / 3;
}

// Yaw around Y, then pitch (nose up) around the local Z axis and bank around the local X axis.
function planeMatrix(x, y, z, yaw, bank = 0, pitch = 0) {
  const c = Math.cos(yaw), s = Math.sin(yaw), cb = Math.cos(bank), sb = Math.sin(bank), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return new Float32Array([
    c * cp, sp, s * cp, 0,
    -sp * cb * c - sb * s, cp * cb, -sp * cb * s + sb * c, 0,
    sp * sb * c - cb * s, -cp * sb, sp * sb * s + cb * c, 0,
    x, y, z, 1]);
}

function render(now) {
  if (worldDirty) buildWorld();
  buildStatus();
  const r = canvas.getBoundingClientRect();
  if (!r.width || !r.height) return;
  view();
  perspective(Math.PI / 3, r.width / r.height, .1, 320);

  const hour = (G.minutes % 1440) / 60, day = daylight(hour), w = weatherNow(), loc0 = place(G.location);
  const night = [.06, .10, .17], warm = day > 0 && day < 1 ? (1 - Math.abs(day - .5) * 2) * .22 : 0, dim = w.dim || 1;
  let sky = loc0.sky.map((c, i) => (night[i] + (c - night[i]) * day + [warm, warm * .4, -warm * .25][i]) * (.75 + .25 * dim));
  if (w.fog) sky = sky.map((c, i) => c * .45 + (G.wx.kind === 'sand' ? [.62, .5, .36] : [.55, .6, .64])[i] * .55 * (.45 + .55 * day));
  const light = (.5 + .5 * day) * dim;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(sky[0], sky[1], sky[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  gl.uniformMatrix4fv(loc.proj, false, projMat);
  gl.uniformMatrix4fv(loc.view, false, viewMat);
  gl.uniform3fv(loc.fog, sky);
  gl.uniform1f(loc.light, light);
  gl.uniform1f(loc.fogStart, w.fog ? camera.dist * .3 : camera.dist * .8);
  gl.uniform1f(loc.fogRange, w.fog ? camera.dist * 1.1 : Math.max(45, camera.dist * 1.8));
  gl.uniform1f(loc.fogMax, w.fog ? .85 : .66);

  draw(worldMesh);
  draw(statusMesh);
  const lampAlpha = clamp((.85 - day * dim) / .45, 0, 1);
  if (lampAlpha > .02) { gl.uniform1f(loc.light, 1.25); draw(lightsMesh, identity, [1, 1, 1], lampAlpha); gl.uniform1f(loc.light, light); }

  if (!shadowMesh) { const m = meshBuilder(); m.disc(0, .12, 0, .65, '#1d3038', 16); shadowMesh = upload(m); }
  const holding = G.planes.filter(p => p.state === 'holding'), cx = W / 2, cz = H / 2;
  for (const p of G.planes) {
    let x = p.x, z = p.y, alt = p.alt || 0, angle = p.angle, alpha = 1, bank = 0, pitch = 0;
    if (p.state === 'holding') {
      const i = holding.indexOf(p), n = holding.length, theta = G.minutes * .035 + i * 2 * Math.PI / n, radius = 21 + (i % 3) * 3.5;
      x = cx + Math.cos(theta) * radius; z = cz + Math.sin(theta) * radius * .78;
      alt = 7 + (i % 3) * 1.3;
      angle = Math.atan2(Math.cos(theta) * .78, -Math.sin(theta));
      bank = .32;
      alpha = Math.min(.9, p.wait / 4);
    } else if (p.state === 'approach') { alpha = clamp(p.progress / .12, 0, 1); pitch = alt > 0 ? .06 : 0; }
    else if (p.state === 'takeoff') { alpha = clamp((1 - p.progress) / .18, 0, 1); pitch = alt > 0 ? .16 : 0; }
    if (alpha <= .01) continue;
    const mesh = planeMeshes[p.class] || (planeMeshes[p.class] = planeModel(p.class));
    if (alt < 6) {
      const c = Math.cos(angle), s = Math.sin(angle), scale = 1 - alt / 9;
      draw(shadowMesh, new Float32Array([c * scale, 0, s * scale, 0, 0, 1, 0, 0, -s * scale, 0, c * scale, 0, x, .02, z, 1]), [1, 1, 1], .5 * (1 - alt / 6) * alpha);
    }
    draw(mesh, planeMatrix(x, .04 + alt, z, angle, bank, pitch), p.charter ? [1.08, 1, .8] : [1, 1, 1], alpha);
  }

  const b = building(selected);
  if (b) outline('selection', b.x, b.y, b.w, b.h, '#68ffe0');
  drawDrafts();

  if (settings.particles && w.particles) {
    const t = now / 1000, mesh = weatherMeshes[w.particles] || (weatherMeshes[w.particles] = weatherModel(w.particles));
    const translate = (x, y, z) => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
    if (w.particles === 'sand') {
      const off = (t * 9) % 70;
      for (const dx of [off, off - 70]) draw(mesh, translate(camera.x + dx, 0, camera.z), [1, 1, 1], .45);
    } else {
      const speedY = w.particles === 'rain' ? (G.wx.kind === 'storm' ? 22 : 15) : 1.6, off = (t * speedY) % 18, sway = w.particles === 'snow' ? Math.sin(t * .7) * 1.2 : 0;
      for (const dy of [-off, 18 - off]) draw(mesh, translate(camera.x + sway, dy, camera.z), [1, 1, 1], w.particles === 'rain' ? .5 : .85);
    }
  }
}
