'use strict';
/* Self-contained WebGL renderer: sun shadows (RGBA-packed depth, works on WebGL1 and 2), a moving sun,
   hemisphere ambient light, glass/water highlights, a sky dome, clouds, animated airside life and weather. */

const canvas = document.getElementById('world');
const gl = canvas.getContext('webgl2', {antialias: true, alpha: false, powerPreference: 'high-performance'}) ||
  canvas.getContext('webgl', {antialias: true, alpha: false});

const PRECISION = '#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\nprecision mediump float;\n#endif\n';

const MAIN_VS = `attribute vec3 aPosition;attribute vec3 aColor;attribute vec3 aNormal;attribute float aSpec;
uniform mat4 uProjection,uView,uModel,uLightVP;uniform float uTime,uWave;
varying vec3 vColor,vNormal,vWorld;varying float vSpec,vDistance;varying vec4 vShadow;
void main(){
  vec4 world=uModel*vec4(aPosition,1.0);vec3 normal=(uModel*vec4(aNormal,0.0)).xyz;
  if(uWave>0.0){
    float a=world.x*0.33+uTime*0.9,b=world.z*0.27-uTime*1.15,c=(world.x+world.z)*0.19+uTime*0.6;
    world.y+=uWave*(sin(a)+sin(b)+0.6*sin(c))*0.33;
    float dx=uWave*0.33*(0.33*cos(a)+0.114*cos(c)),dz=uWave*0.33*(0.27*cos(b)+0.114*cos(c));
    normal=vec3(-dx,1.0,-dz);
  }
  vec4 eye=uView*world;gl_Position=uProjection*eye;
  vDistance=-eye.z;vColor=aColor;vNormal=normal;vWorld=world.xyz;vSpec=aSpec;
  vShadow=uLightVP*vec4(world.xyz+normalize(normal)*0.045,1.0);
}`;
const MAIN_FS = PRECISION + `varying vec3 vColor,vNormal,vWorld;varying float vSpec,vDistance;varying vec4 vShadow;
uniform vec3 uTint,uFog,uSunDir,uSunColor,uSkyAmb,uGroundAmb,uEye;
uniform float uAlpha,uFogStart,uFogRange,uFogMax,uEmissive,uShadowOn,uShadowStrength;
uniform sampler2D uShadowMap;uniform vec2 uShadowTexel;uniform vec4 uClouds[14];uniform float uCloudCount;
float cloudShade(){
  float s=1.0;
  for(int i=0;i<14;i++){if(float(i)>=uCloudCount)break;vec4 c=uClouds[i];float d=distance(vWorld.xz,c.xy)/c.z;s*=1.0-c.w*(1.0-smoothstep(0.35,1.0,d));}
  return s;
}
float unpackDepth(vec4 c){return dot(c,vec4(1.0,1.0/255.0,1.0/65025.0,1.0/16581375.0));}
float tap(vec2 uv,float z){return z>unpackDepth(texture2D(uShadowMap,uv))?0.0:1.0;}
float shadowTerm(float ndl){
  if(uShadowOn<0.5)return 1.0;
  vec3 c=vShadow.xyz/vShadow.w*0.5+0.5;
  if(c.x<0.0||c.x>1.0||c.y<0.0||c.y>1.0||c.z>1.0)return 1.0;
  c.z-=0.0012+0.0035*(1.0-ndl);
  vec2 t=uShadowTexel;
  return (tap(c.xy+vec2(-0.7,-0.7)*t,c.z)+tap(c.xy+vec2(0.7,-0.7)*t,c.z)+tap(c.xy+vec2(-0.7,0.7)*t,c.z)+tap(c.xy+vec2(0.7,0.7)*t,c.z))*0.25;
}
void main(){
  vec3 n=normalize(vNormal);
  float ndl=max(dot(n,uSunDir),0.0);
  float sh=mix(1.0,shadowTerm(ndl),uShadowStrength)*cloudShade();
  vec3 base=vColor*uTint;
  vec3 ambient=mix(uGroundAmb,uSkyAmb,0.5+0.5*n.y);
  vec3 color=base*(ambient+uSunColor*ndl*sh);
  if(vSpec>0.0){vec3 v=normalize(uEye-vWorld);vec3 h=normalize(uSunDir+v);color+=uSunColor*pow(max(dot(n,h),0.0),56.0)*vSpec*sh*1.6+base*vSpec*0.08;}
  color=mix(color,base,uEmissive);
  float fog=max(clamp((vDistance-uFogStart)/uFogRange,0.0,uFogMax),smoothstep(130.0,250.0,vDistance));
  gl_FragColor=vec4(mix(color,uFog,fog),uAlpha);
}`;
const DEPTH_VS = `attribute vec3 aPosition;uniform mat4 uLightVP,uModel;void main(){gl_Position=uLightVP*uModel*vec4(aPosition,1.0);}`;
const DEPTH_FS = PRECISION + `void main(){vec4 e=fract(vec4(1.0,255.0,65025.0,16581375.0)*gl_FragCoord.z);e-=e.yzww*vec4(1.0/255.0,1.0/255.0,1.0/255.0,0.0);gl_FragColor=e;}`;
const SKY_VS = `attribute vec3 aPosition;uniform mat4 uProjection,uViewRot;varying vec3 vDir;
void main(){vDir=aPosition;vec4 p=uProjection*uViewRot*vec4(aPosition*150.0,1.0);gl_Position=p.xyww;}`;
const SKY_FS = PRECISION + `varying vec3 vDir;uniform vec3 uZenith,uHorizon,uSunDir,uSunColor,uMoonDir;uniform float uNight,uSunVis;
void main(){
  vec3 d=normalize(vDir);float h=d.y;
  vec3 col=mix(uHorizon,uZenith,smoothstep(0.0,0.6,h));
  col=mix(col,uHorizon*0.85,smoothstep(0.0,-0.25,h));
  float s=max(dot(d,uSunDir),0.0);
  col+=uSunColor*(pow(s,900.0)*2.2+pow(s,28.0)*0.28+pow(s,6.0)*0.08)*uSunVis;
  float mo=max(dot(d,uMoonDir),0.0);col+=vec3(0.85,0.9,1.0)*smoothstep(0.9993,0.9996,mo)*uNight;
  vec3 q=floor(d*190.0);float star=step(0.9968,fract(sin(dot(q,vec3(12.9898,78.233,37.719)))*43758.5453));
  col+=star*uNight*smoothstep(0.05,0.35,h)*0.8;
  gl_FragColor=vec4(col,1.0);
}`;

let prog = null, depthProg = null, skyProg = null, loc = null, dloc = null, sloc = null;
const identity = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
const camera = {x: 23, z: 16, az: .7, elev: .88, dist: 47};
const viewMat = new Float32Array(16), projMat = new Float32Array(16);
let eye = [0, 0, 0], forward = [0, 0, -1], right = [1, 0, 0], up = [0, 1, 0];
let worldMesh = null, lightsMesh = null, waterMesh = null, statusMesh = null, statusKey = '', skyMesh = null, worldDirty = true, lastScreenAspect = null;
let shadowTarget = null, shadowFrame = 0, bridgeRigs = [], cloudField = [];
const meshCache = {}, overlayCache = {}, planeVisual = new Map(), bridgeState = new Map();
const enabledAttribs = new Set();

function compileProgram(vs, fs) {
  const compile = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(p));
  return p;
}

function initRenderer() {
  if (!gl) return false;
  prog = compileProgram(MAIN_VS, MAIN_FS);
  depthProg = compileProgram(DEPTH_VS, DEPTH_FS);
  skyProg = compileProgram(SKY_VS, SKY_FS);
  const uniforms = (p, names) => Object.fromEntries(names.map(n => [n, gl.getUniformLocation(p, 'u' + n)]));
  loc = {p: gl.getAttribLocation(prog, 'aPosition'), c: gl.getAttribLocation(prog, 'aColor'), n: gl.getAttribLocation(prog, 'aNormal'), s: gl.getAttribLocation(prog, 'aSpec'),
    ...uniforms(prog, ['Projection', 'View', 'Model', 'LightVP', 'Time', 'Wave', 'Tint', 'Fog', 'SunDir', 'SunColor', 'SkyAmb', 'GroundAmb', 'Eye', 'Alpha',
      'FogStart', 'FogRange', 'FogMax', 'Emissive', 'ShadowOn', 'ShadowStrength', 'ShadowMap', 'ShadowTexel', 'CloudCount'])};
  loc.Clouds = gl.getUniformLocation(prog, 'uClouds');
  dloc = {p: gl.getAttribLocation(depthProg, 'aPosition'), ...uniforms(depthProg, ['LightVP', 'Model'])};
  sloc = {p: gl.getAttribLocation(skyProg, 'aPosition'), ...uniforms(skyProg, ['Projection', 'ViewRot', 'Zenith', 'Horizon', 'SunDir', 'SunColor', 'MoonDir', 'Night', 'SunVis'])};
  gl.enable(gl.DEPTH_TEST);
  gl.depthFunc(gl.LEQUAL);
  gl.enable(gl.CULL_FACE);
  gl.cullFace(gl.BACK);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  skyMesh = skyDome();
  return true;
}

// ---------- buffers ----------

function upload(m) {
  const arr = new Float32Array(m.data), buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
  return {buffer, count: arr.length / VERTEX_FLOATS};
}
function dispose(mesh) { if (mesh?.buffer) gl.deleteBuffer(mesh.buffer); }
function cached(key, build) { return meshCache[key] || (meshCache[key] = upload(build())); }

// Enables exactly the given vertex attribute locations; stale arrays from another program would break draws.
function useAttribs(list) {
  for (const l of [...enabledAttribs]) if (!list.includes(l)) { gl.disableVertexAttribArray(l); enabledAttribs.delete(l); }
  for (const l of list) if (l >= 0 && !enabledAttribs.has(l)) { gl.enableVertexAttribArray(l); enabledAttribs.add(l); }
}

function skyDome() {
  const pts = [], seg = 24, rings = 12;
  const p = (i, j) => { const t = i * 2 * Math.PI / seg, f = j * Math.PI / rings; return [Math.sin(f) * Math.cos(t), Math.cos(f), Math.sin(f) * Math.sin(t)]; };
  for (let j = 0; j < rings; j++) for (let i = 0; i < seg; i++) pts.push(...p(i, j), ...p(i + 1, j), ...p(i + 1, j + 1), ...p(i, j), ...p(i + 1, j + 1), ...p(i, j + 1));
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(pts), gl.STATIC_DRAW);
  return {buffer, count: pts.length / 3};
}

const SHADOW_SIZE = {high: 2048, medium: 1024, low: 0};
function ensureShadowTarget() {
  const size = Math.min(SHADOW_SIZE[settings.quality] ?? 2048, gl.getParameter(gl.MAX_TEXTURE_SIZE));
  if (shadowTarget?.size === size || (!size && !shadowTarget)) return shadowTarget;
  if (shadowTarget) { gl.deleteTexture(shadowTarget.tex); gl.deleteRenderbuffer(shadowTarget.rb); gl.deleteFramebuffer(shadowTarget.fb); shadowTarget = null; }
  if (!size) return null;
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  for (const [k2, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k2, v);
  const rb = gl.createRenderbuffer();
  gl.bindRenderbuffer(gl.RENDERBUFFER, rb);
  gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, size, size);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, rb);
  const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  shadowTarget = ok ? {tex, rb, fb, size} : null;
  return shadowTarget;
}

// ---------- matrices ----------

function lookAt(e, t, upv) {
  const f = norm(sub3(t, e)), r = norm(cross(f, upv)), u = cross(r, f);
  return new Float32Array([r[0], u[0], -f[0], 0, r[1], u[1], -f[1], 0, r[2], u[2], -f[2], 0, -dot3(r, e), -dot3(u, e), dot3(f, e), 1]);
}
function ortho(l, r, b, t, n, f) {
  return new Float32Array([2 / (r - l), 0, 0, 0, 0, 2 / (t - b), 0, 0, 0, 0, -2 / (f - n), 0, -(r + l) / (r - l), -(t + b) / (t - b), -(f + n) / (f - n), 1]);
}
function mul(a, b) {
  const o = new Float32Array(16);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
  return o;
}
// Yaw around Y, then pitch (nose up) around the local Z axis, bank around the local X axis, optional X scale.
function poseMatrix(x, y, z, yaw, bank = 0, pitch = 0, sx = 1, s = 1) {
  const c = Math.cos(yaw), sn = Math.sin(yaw), cb = Math.cos(bank), sb = Math.sin(bank), cp = Math.cos(pitch), sp = Math.sin(pitch);
  return new Float32Array([
    c * cp * sx * s, sp * sx * s, sn * cp * sx * s, 0,
    (-sp * cb * c - sb * sn) * s, cp * cb * s, (-sp * cb * sn + sb * c) * s, 0,
    (sp * sb * c - cb * sn) * s, -cp * sb * s, (sp * sb * sn + cb * c) * s, 0,
    x, y, z, 1]);
}
const translate = (x, y, z, s = 1) => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1]);

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
    -dot3(right, eye), -dot3(up, eye), dot3(forward, eye), 1]);
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
      const v = [x - eye[0], -eye[1], z - eye[2]], depth = dot3(v, forward);
      if (depth <= .1) return false;
      return Math.abs(dot3(v, right) / (depth * tan * aspect)) < .87 && Math.abs(dot3(v, up) / (depth * tan)) < .70;
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

// ---------- world ----------

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
  for (const mesh of [worldMesh, lightsMesh, waterMesh]) dispose(mesh);
  worldMesh = upload(m);
  lightsMesh = upload(lights);
  waterMesh = G.location === 'island' ? upload(waterModel()) : null;
  bridgeRigs = G.buildings.filter(b => b.type === 'gate' && gateTerminal(b)).map(b => ({id: b.id, rig: gateRig(b)}));
  for (const id of [...bridgeState.keys()]) if (!bridgeRigs.some(r => r.id === id)) bridgeState.delete(id);
  cloudField = Array.from({length: 14}, (_, i) => ({seed: i, x: hash(i, 41) * (W + 60) - 30, z: hash(i, 42) * (H + 50) - 25, alt: 20 + hash(i, 43) * 6, scale: 1.8 + hash(i, 44) * 1.6}));
  worldDirty = false;
  statusKey = '';
}

// Small status lamps on every stand: aqua — free, gold — aircraft inbound, red — occupied.
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

// ---------- lighting ----------

const OVERCAST = {clear: 0, cloudy: .45, rain: .75, storm: .9, fog: .7, snow: .7, sand: .6, heat: 0};
const CLOUDS = {clear: 4, cloudy: 10, rain: 12, storm: 14, fog: 0, snow: 10, sand: 0, heat: 2};
const mix3 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

function daylight(hour) {
  if (hour < 4.5 || hour >= 21) return 0;
  if (hour < 7) return (hour - 4.5) / 2.5;
  if (hour < 18) return 1;
  return 1 - (hour - 18) / 3;
}

function lighting() {
  const hour = (G.minutes % 1440) / 60, day = daylight(hour), kind = G.wx.kind, over = OVERCAST[kind] ?? 0, loc0 = place(G.location);
  // The sun rises in the east (+x), crosses the southern sky (+z) at noon and sets in the west.
  const t = clamp((hour - 4.6) / 16, 0, 1), phi = Math.PI * t, elev = Math.max(.1, Math.sin(Math.PI * t) * 1.05);
  const sunDir = norm([Math.cos(phi) * Math.cos(elev), Math.sin(elev), Math.sin(phi) * Math.cos(elev)]);
  const moonDir = norm([-.35, .85, -.4]), sunWeight = smooth(0, .35, day);
  const warm = day > 0 && day < 1 ? 1 - Math.abs(day - .5) * 2 : clamp(1 - Math.abs(elev - .1) * 4, 0, 1) * (day > 0 ? .6 : 0);
  const daySky = loc0.sky, nightSky = [.02, .04, .1];
  let zenith = mix3(nightSky, daySky.map(c => c * .82), day), horizon = mix3([.07, .11, .2], mix3(daySky, [1, 1, 1], .35), day);
  horizon = mix3(horizon, [.98, .58, .36], warm * .55);
  const grey = [.6, .64, .68].map(c => c * (.35 + .65 * day));
  zenith = mix3(zenith, grey.map(c => c * .9), over);
  horizon = mix3(horizon, kind === 'sand' ? [.74, .6, .42].map(c => c * (.4 + .6 * day)) : grey, over);
  let sunColor = mix3([.64, .61, .55], [.82, .5, .3], warm * .8).map(c => c * sunWeight * (1 - over * .72));
  sunColor = mix3([.18, .21, .31], sunColor, sunWeight);
  const skyAmb = mix3([.28, .32, .43], [.44, .47, .52], day).map(c => c + over * .06 * day);
  const groundAmb = mix3([.12, .13, .17], [.3, .29, .26], day);
  return {day, over, warm, sunDir, moonDir, lightDir: norm(mix3(moonDir, sunDir, sunWeight)), sunColor, skyAmb, groundAmb, zenith, horizon,
    shadow: sunWeight * smooth(.1, .3, elev) * (1 - over * .85), night: 1 - day, sunVis: sunWeight * (1 - over)};
}

// ---------- draw helpers ----------

let drawProgram = null;
function setProgram(p) { if (drawProgram !== p) { gl.useProgram(p); drawProgram = p; } }

function draw(mesh, model = identity, tint = [1, 1, 1], alpha = 1, emissive = 0, wave = 0) {
  if (!mesh || !mesh.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
  useAttribs([loc.p, loc.c, loc.n, loc.s]);
  gl.vertexAttribPointer(loc.p, 3, gl.FLOAT, false, 40, 0);
  gl.vertexAttribPointer(loc.c, 3, gl.FLOAT, false, 40, 12);
  gl.vertexAttribPointer(loc.n, 3, gl.FLOAT, false, 40, 24);
  if (loc.s >= 0) gl.vertexAttribPointer(loc.s, 1, gl.FLOAT, false, 40, 36);
  gl.uniformMatrix4fv(loc.Model, false, model);
  gl.uniform3fv(loc.Tint, tint);
  gl.uniform1f(loc.Alpha, alpha);
  gl.uniform1f(loc.Emissive, emissive);
  gl.uniform1f(loc.Wave, wave);
  gl.depthMask(alpha >= 1);
  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
  gl.depthMask(true);
}

function drawDepth(mesh, model) {
  if (!mesh || !mesh.count) return;
  gl.bindBuffer(gl.ARRAY_BUFFER, mesh.buffer);
  useAttribs([dloc.p]);
  gl.vertexAttribPointer(dloc.p, 3, gl.FLOAT, false, 40, 0);
  gl.uniformMatrix4fv(dloc.Model, false, model);
  gl.drawArrays(gl.TRIANGLES, 0, mesh.count);
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
  draw(cache, identity, [1, 1, 1], alpha, .55);
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

// ---------- animated airside ----------

const GROUND_STATES = ['exit_runway', 'taxi_in', 'dock', 'service', 'ready', 'taxi_out', 'lineup'];

// Where and how an aircraft is drawn this frame. Ground headings are eased so turns look natural,
// and during pushback the aircraft keeps facing the terminal while it rolls backwards.
function planePose(p, holding, gameDt) {
  let x = p.x, z = p.y, alt = p.alt || 0, angle = p.angle, alpha = 1, bank = 0, pitch = 0;
  if (p.state === 'holding') {
    const i = holding.indexOf(p), n = holding.length, theta = G.minutes * .035 + i * 2 * Math.PI / n, radius = 21 + (i % 3) * 3.5;
    x = W / 2 + Math.cos(theta) * radius;
    z = H / 2 + Math.sin(theta) * radius * .78;
    alt = 7 + (i % 3) * 1.3;
    angle = Math.atan2(Math.cos(theta) * .78, -Math.sin(theta));
    bank = .32;
    alpha = Math.min(.95, p.wait / 4);
  } else if (p.state === 'approach') { alpha = clamp(p.progress / .12, 0, 1); pitch = alt > 0 ? .06 : 0; }
  else if (p.state === 'takeoff') { alpha = clamp((1 - p.progress) / .18, 0, 1); pitch = alt > 0 ? .16 : 0; }
  let vis = planeVisual.get(p.id);
  if (!vis) { vis = {angle}; planeVisual.set(p.id, vis); }
  vis.seen = true;
  if (GROUND_STATES.includes(p.state)) {
    const g = building(p.gateId);
    const pushing = g && (p.state === 'ready' || p.state === 'taxi_out' && p.pathIndex === 0);
    const target = pushing ? standHeading(g) : angle;
    const delta = Math.atan2(Math.sin(target - vis.angle), Math.cos(target - vis.angle)), step = gameDt * 2.6;
    vis.angle += clamp(delta, -step, step);
    angle = vis.angle;
  } else vis.angle = angle;
  return {x, z, alt, angle, alpha, bank, pitch};
}

// Plane-local position (x forward, z starboard) to world.
function planeLocal(pose, lx, lz) {
  const c = Math.cos(pose.angle), s = Math.sin(pose.angle);
  return {x: pose.x + c * lx - s * lz, z: pose.z + s * lx + c * lz};
}

// Ground crew around a parked aircraft; each vehicle drives in and out with the turnaround progress.
function crewFor(p) {
  const s = CLASS[p.class], L = s.len, S = s.span, r = s.cargo ? .27 : p.class === 'wide' ? .25 : p.class === 'regional' ? .17 : .21;
  const list = [
    {kind: 'fuel', lx: -.08 * L, lz: S * .34, yaw: 0, from: .03, to: .7},
    {kind: 'baggage', lx: -.05 * L, lz: r + 1.15, yaw: Math.PI, from: .08, to: .86}
  ];
  if (s.cargo) list.push({kind: 'loader', lx: .3 * L, lz: -(r + .42), yaw: Math.PI / 2, from: .02, to: .9});
  else list.push({kind: 'belt', lx: .2 * L, lz: r + .4, yaw: -Math.PI / 2, from: .05, to: .88}, {kind: 'catering', lx: -.36 * L, lz: r + .38, yaw: -Math.PI / 2, from: .12, to: .7});
  return list;
}

function vehicleFrames(p, pose, now) {
  const out = [], progress = p.state === 'service' ? p.service : p.state === 'ready' ? 1.2 : -1;
  if (progress >= 0) for (const v of crewFor(p)) {
    const enter = clamp((progress - v.from) / .06, 0, 1), leave = clamp((progress - v.to) / .08, 0, 1);
    if (enter <= 0 || leave >= 1) continue;
    const away = (1 - enter) * 2.4 + leave * 2.4, side = Math.sign(v.lz) || 1;
    const pos = planeLocal(pose, v.lx, v.lz + side * away);
    out.push({kind: v.kind, x: pos.x, z: pos.z, yaw: pose.angle + v.yaw, alpha: Math.min(enter * 1.6, 1 - leave)});
  }
  const g = building(p.gateId);
  if (g?.type === 'gate' && (p.state === 'ready' || p.state === 'taxi_out' && p.pathIndex === 0)) {
    const pos = planeLocal(pose, CLASS[p.class].len * .7 + .28, 0);
    out.push({kind: 'tug', x: pos.x, z: pos.z, yaw: pose.angle + Math.PI, alpha: p.state === 'ready' ? clamp(p.wait / 3, 0, 1) : 1});
  }
  if (p.delay > 0 && p.state === 'service') {
    const pos = planeLocal(pose, -.1, -CLASS[p.class].span * .36);
    out.push({kind: 'van', x: pos.x, z: pos.z, yaw: pose.angle, alpha: 1, flash: Math.sin(now / 90) > 0});
  }
  return out;
}

// Jet bridges extend to the forward port door while an aircraft is being serviced at the stand.
function bridgeFrames(poses, gameDt) {
  const out = [];
  for (const {id, rig} of bridgeRigs) {
    const g = building(id);
    if (!g) continue;
    let state = bridgeState.get(id);
    const home = {x: rig.cx + rig.fx * .2 - rig.rx * .55, z: rig.cz + rig.fz * .2 - rig.rz * .55};
    let target = home;
    const p = g.gatePlane && G.planes.find(q => q.id === g.gatePlane), pose = p && poses.get(p.id);
    if (p && pose && p.state === 'service') {
      const L = CLASS[p.class].len, r = CLASS[p.class].cargo ? .27 : p.class === 'wide' ? .25 : p.class === 'regional' ? .17 : .21;
      target = planeLocal(pose, .36 * L, -(r + .07));
    }
    const dx = target.x - rig.rot.x, dz = target.z - rig.rot.z, len = Math.max(.25, Math.hypot(dx, dz)), ang = Math.atan2(dz, dx);
    if (!state) { state = {len, ang}; bridgeState.set(id, state); }
    const dl = len - state.len, da = Math.atan2(Math.sin(ang - state.ang), Math.cos(ang - state.ang));
    state.len += clamp(dl, -gameDt * 1.4, gameDt * 1.4);
    state.ang += clamp(da, -gameDt * 2.2, gameDt * 2.2);
    out.push({x: rig.rot.x, z: rig.rot.z, len: state.len, ang: state.ang});
  }
  return out;
}

// ---------- frame ----------

function render(now, gameDt = 0) {
  if (worldDirty) buildWorld();
  buildStatus();
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  view();
  perspective(Math.PI / 3, rect.width / rect.height, .1, 320);
  const L = lighting(), w = weatherNow(), t = now / 1000, quality = settings.quality;

  // Collect what is drawn this frame so the shadow pass and the main pass see the same scene.
  const opaque = [{mesh: worldMesh, model: identity}], faded = [], emissive = [], dynamicCasters = [];
  const holding = G.planes.filter(p => p.state === 'holding'), poses = new Map();
  const lampAlpha = clamp((.85 - L.day * (1 - L.over * .5)) / .45, 0, 1), blink = Math.sin(t * 6) > .3;
  for (const v of planeVisual.values()) v.seen = false;
  for (const p of G.planes) {
    const pose = planePose(p, holding, gameDt);
    poses.set(p.id, pose);
    if (pose.alpha <= .01) continue;
    const livery = liveryKey(p), mesh = cached('plane:' + p.class + ':' + livery, () => planeModel(p.class, livery));
    const model = poseMatrix(pose.x, .04 + pose.alt, pose.z, pose.angle, pose.bank, pose.pitch);
    (pose.alpha >= 1 ? opaque : faded).push({mesh, model, alpha: pose.alpha, plane: p, pose});
    if (lampAlpha > .05 || pose.alt > .5) emissive.push({mesh: cached('planeLights:' + p.class, () => planeLightsModel(p.class)), model, alpha: pose.alpha * Math.max(lampAlpha, .7) * (blink ? 1 : .55)});
    for (const v of vehicleFrames(p, pose, now)) {
      const vm = poseMatrix(v.x, 0, v.z, v.yaw);
      (v.alpha >= .99 ? opaque : faded).push({mesh: cached('vehicle:' + v.kind, () => vehicleModel(v.kind)), model: vm, alpha: v.alpha});
      const b = VEHICLE_BEACONS[v.kind];
      if ((v.flash ?? blink) && b) {
        const c = Math.cos(v.yaw), s = Math.sin(v.yaw);
        emissive.push({mesh: cached('beacon', beaconModel), model: translate(v.x + c * b[0] - s * b[2], b[1], v.z + s * b[0] + c * b[2]), alpha: v.alpha});
      }
    }
  }
  for (const id of [...planeVisual.keys()]) if (!planeVisual.get(id).seen) planeVisual.delete(id);
  for (const br of bridgeFrames(poses, gameDt)) {
    opaque.push({mesh: cached('tunnel', tunnelModel), model: poseMatrix(br.x, 0, br.z, br.ang, 0, 0, br.len)});
    opaque.push({mesh: cached('bridgeCab', bridgeCabModel), model: poseMatrix(br.x + Math.cos(br.ang) * br.len, 0, br.z + Math.sin(br.ang) * br.len, br.ang)});
  }
  // Clouds drift with the wind; their soft shadows are projected along the light onto the ground.
  const clouds = [], cloudUniform = new Float32Array(14 * 4);
  if (quality !== 'low') {
    const count = CLOUDS[G.wx.kind] ?? 4, span = W + 80, shade = .3 * smooth(.05, .4, L.day) * (1 - L.over * .4);
    for (const c of cloudField.slice(0, count)) {
      const x = ((c.x + t * .35 + 40) % span + span) % span - 40, i = clouds.length;
      clouds.push({mesh: cached('cloud:' + (c.seed % 4), () => cloudModel(c.seed % 4)), model: poseMatrix(x, c.alt, c.z, c.seed, 0, 0, 1, c.scale)});
      const k2 = c.alt / Math.max(.2, L.lightDir[1]);
      cloudUniform.set([x - L.lightDir[0] * k2, c.z - L.lightDir[2] * k2, 2.3 * c.scale, shade], i * 4);
    }
  }

  // Shadow pass: depth from the sun into an RGBA-packed texture.
  const target = ensureShadowTarget(), shadowsOn = !!target && L.shadow > .02;
  const centerW = [W / 2, 0, H / 2], lightVP = mul(ortho(-42, 42, -42, 42, 1, 180), lookAt(add3(centerW, L.lightDir.map(v => v * 90)), centerW, Math.abs(L.lightDir[1]) > .98 ? [0, 0, 1] : [0, 1, 0]));
  if (shadowsOn && (quality === 'high' || shadowFrame++ % 2 === 0)) {
    setProgram(depthProg);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fb);
    gl.viewport(0, 0, target.size, target.size);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.uniformMatrix4fv(dloc.LightVP, false, lightVP);
    for (const d of opaque) drawDepth(d.mesh, d.model);
    for (const d of faded) if (d.alpha > .5) drawDepth(d.mesh, d.model);
    gl.enable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(L.horizon[0], L.horizon[1], L.horizon[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

  // Sky dome.
  setProgram(skyProg);
  const rot = new Float32Array(viewMat);
  rot[12] = rot[13] = rot[14] = 0;
  gl.uniformMatrix4fv(sloc.Projection, false, projMat);
  gl.uniformMatrix4fv(sloc.ViewRot, false, rot);
  gl.uniform3fv(sloc.Zenith, L.zenith);
  gl.uniform3fv(sloc.Horizon, L.horizon);
  gl.uniform3fv(sloc.SunDir, L.sunDir);
  gl.uniform3fv(sloc.SunColor, mix3([1, .9, .7], [1, .6, .35], L.warm));
  gl.uniform3fv(sloc.MoonDir, L.moonDir);
  gl.uniform1f(sloc.Night, L.night * (1 - L.over));
  gl.uniform1f(sloc.SunVis, L.sunVis);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.bindBuffer(gl.ARRAY_BUFFER, skyMesh.buffer);
  useAttribs([sloc.p]);
  gl.vertexAttribPointer(sloc.p, 3, gl.FLOAT, false, 12, 0);
  gl.drawArrays(gl.TRIANGLES, 0, skyMesh.count);
  gl.enable(gl.DEPTH_TEST);
  gl.enable(gl.CULL_FACE);

  // Main pass.
  setProgram(prog);
  gl.uniformMatrix4fv(loc.Projection, false, projMat);
  gl.uniformMatrix4fv(loc.View, false, viewMat);
  gl.uniformMatrix4fv(loc.LightVP, false, lightVP);
  gl.uniform1f(loc.Time, t);
  gl.uniform3fv(loc.Fog, L.horizon);
  gl.uniform3fv(loc.SunDir, L.lightDir);
  gl.uniform3fv(loc.SunColor, L.sunColor);
  gl.uniform3fv(loc.SkyAmb, L.skyAmb);
  gl.uniform3fv(loc.GroundAmb, L.groundAmb);
  gl.uniform3fv(loc.Eye, eye);
  gl.uniform1f(loc.FogStart, w.fog ? camera.dist * .3 : camera.dist * .85);
  gl.uniform1f(loc.FogRange, w.fog ? camera.dist * 1.1 : Math.max(50, camera.dist * 2));
  gl.uniform1f(loc.FogMax, w.fog ? .85 : .6);
  gl.uniform1f(loc.ShadowOn, shadowsOn ? 1 : 0);
  gl.uniform1f(loc.ShadowStrength, shadowsOn ? L.shadow : 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, shadowsOn ? target.tex : null);
  gl.uniform1i(loc.ShadowMap, 0);
  gl.uniform2f(loc.ShadowTexel, shadowsOn ? 1 / target.size : 0, shadowsOn ? 1 / target.size : 0);
  gl.uniform4fv(loc.Clouds, cloudUniform);
  gl.uniform1f(loc.CloudCount, clouds.length);

  for (const d of opaque) draw(d.mesh, d.model);
  if (waterMesh) draw(waterMesh, identity, [1, 1, 1], 1, 0, quality === 'low' ? 0 : .09);
  draw(statusMesh, identity, [1, 1, 1], 1, .35);

  if (lampAlpha > .02) draw(lightsMesh, identity, [1, 1, 1], lampAlpha, 1);
  for (const d of emissive) draw(d.mesh, d.model, [1, 1, 1], d.alpha, 1);

  if (!shadowsOn) {
    const blob = cached('blob', shadowBlobModel);
    for (const d of [...opaque, ...faded]) if (d.plane && d.pose.alt < 6) {
      const c = Math.cos(d.pose.angle), s = Math.sin(d.pose.angle), k2 = 1 - d.pose.alt / 9;
      draw(blob, new Float32Array([c * k2, 0, s * k2, 0, 0, 1, 0, 0, -s * k2, 0, c * k2, 0, d.pose.x, .02, d.pose.z, 1]), [1, 1, 1], .45 * (1 - d.pose.alt / 6) * d.alpha);
    }
  }
  for (const d of faded) draw(d.mesh, d.model, [1, 1, 1], d.alpha);

  const b = building(selected);
  if (b) outline('selection', b.x, b.y, b.w, b.h, '#68ffe0');
  drawDrafts();

  // Cloud bodies only show when the camera is high enough; their shadows are always there.
  const cloudAlpha = clamp((eye[1] - 32) / 40, 0, .5);
  if (cloudAlpha > .02) {
    gl.uniform1f(loc.CloudCount, 0);
    const tint = (L.over > .6 ? [.78, .81, .85] : [1, 1, 1]).map(v => v * (.35 + .65 * L.day));
    for (const c of clouds) draw(c.mesh, c.model, tint, cloudAlpha, .55);
  }

  if (settings.particles && w.particles) {
    const mesh = cached('weather:' + w.particles, () => weatherModel(w.particles));
    if (w.particles === 'sand') {
      const off = (t * 9) % 70;
      for (const dx of [off, off - 70]) draw(mesh, translate(camera.x + dx, 0, camera.z), [1, 1, 1], .45, .3);
    } else {
      const speedY = w.particles === 'rain' ? (G.wx.kind === 'storm' ? 22 : 15) : 1.6, off = (t * speedY) % 18, sway = w.particles === 'snow' ? Math.sin(t * .7) * 1.2 : 0;
      for (const dy of [-off, 18 - off]) draw(mesh, translate(camera.x + sway, dy, camera.z), [1, 1, 1], w.particles === 'rain' ? .5 : .85, .4);
    }
  }
}
