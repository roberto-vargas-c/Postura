// Postura 3D report: viewer, posture grid, sections, measurements and comparison.
import * as THREE from './vendor/three/three.module.js';
import { SECTION_NAMES } from './metrics3d.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = (v) => Math.round(v * 10) / 10;
const cm = (m) => m * 100;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

// ---------- Record (what we keep in history) ----------
function packSeg(seg, maxSegs = 6000) {
  const n = seg.length / 4;
  const step = Math.max(1, Math.ceil(n / maxSegs));
  const out = [];
  for (let i = 0; i < n; i += step) for (let k = 0; k < 4; k++) out.push(Math.round(seg[i * 4 + k] * 1000));
  return out; // millimetres
}

export function toRecord(res, report, extra = {}) {
  const sections = {};
  for (const [k, s] of Object.entries(res.sections)) {
    sections[k] = {
      y: s.y, girth: s.girth, area: s.area, width: s.width, depth: s.depth, angle: s.angle, leftPct: s.leftPct,
      centroid: s.centroid, outline: s.outline, clipped: s.clipped,
    };
  }
  const pt = (p) => p && { y: Math.round(p.y * 1000) / 1000, u: Math.round(p.u * 1000) / 1000 };
  return {
    id: Date.now(), type: '3d', date: new Date().toISOString(),
    height: res.height, estimated: res.estimated,
    landmarks: res.landmarks.map((l) => ({ x: Math.round(l.x * 1000) / 1000, y: Math.round(l.y * 1000) / 1000, z: Math.round(l.z * 1000) / 1000 })),
    com: res.com && { x: res.com.x, y: res.com.y, z: res.com.z, volume: res.com.volume, method: res.com.method },
    curves: res.curves && { c7: pt(res.curves.c7), thorApex: pt(res.curves.thorApex), lumApex: pt(res.curves.lumApex), buttApex: pt(res.curves.buttApex), lumbarDepth: res.curves.lumbarDepth, thoracicDepth: res.curves.thoracicDepth },
    sections,
    sagSeg: packSeg(res.sagittal.seg),
    frontSeg: packSeg(res.frontal.seg),
    overall: report.overall,
    regions: report.regions.map((r) => ({ id: r.id, score: r.score, status: r.status })),
    ...extra,
  };
}

// ---------- SVG helpers ----------
function gridLines(x0, y0, x1, y1, step, major) {
  let s = '';
  const sx = Math.ceil(x0 / step) * step, sy = Math.ceil(y0 / step) * step;
  for (let x = sx; x <= x1 + 1e-9; x += step) {
    const isMaj = Math.abs(Math.round(x / major) * major - x) < 1e-6;
    s += `<line x1="${r1(x)}" y1="${y0}" x2="${r1(x)}" y2="${y1}" class="${isMaj ? 'gmaj' : 'gmin'}"/>`;
  }
  for (let y = sy; y <= y1 + 1e-9; y += step) {
    const isMaj = Math.abs(Math.round(y / major) * major - y) < 1e-6;
    s += `<line x1="${x0}" y1="${r1(y)}" x2="${x1}" y2="${r1(y)}" class="${isMaj ? 'gmaj' : 'gmin'}"/>`;
  }
  return s;
}

const polyPath = (pts, fx, fy) => pts.map((p, i) => `${i ? 'L' : 'M'}${r1(fx(p))} ${r1(fy(p))}`).join('') + 'Z';

// Top-down cross-section. Screen: front of the body at the top, person's left on screen left
// (as if looking down from behind). Units: cm.
function sectionSvg(parts, prevParts, opts = {}) {
  const all = parts.flatMap((p) => p.outline);
  if (!all.length) return '';
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of all) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z); }
  if (opts.plumb) { minX = Math.min(minX, -0.02); maxX = Math.max(maxX, 0.02); minZ = Math.min(minZ, -0.02); maxZ = Math.max(maxZ, 0.02); }
  const pad = 0.04;
  const sx = (x) => -cm(x), sy = (z) => -cm(z);
  const X0 = sx(maxX + pad), X1 = sx(minX - pad), Y0 = sy(maxZ + pad), Y1 = sy(minZ - pad);
  const w = X1 - X0, h = Y1 - Y0;
  let body = gridLines(Math.floor(X0), Math.floor(Y0), Math.ceil(X1), Math.ceil(Y1), 1, 5);
  if (opts.plumb) body += `<g class="plumb-mark"><line x1="-2" y1="0" x2="2" y2="0"/><line x1="0" y1="-2" x2="0" y2="2"/></g>`;
  for (const p of prevParts || []) body += `<path d="${polyPath(p.outline, (q) => sx(q[0]), (q) => sy(q[1]))}" class="sec-prev"/>`;
  // Mirror ghost: each outline reflected about its own centre line (single) or onto its partner (pairs).
  if (parts.length === 1) {
    const c = parts[0].centroid.x;
    body += `<path d="${polyPath(parts[0].outline, (q) => sx(2 * c - q[0]), (q) => sy(q[1]))}" class="sec-ghost"/>`;
    body += `<line x1="${r1(sx(c))}" y1="${Y0}" x2="${r1(sx(c))}" y2="${Y1}" class="sec-axis"/>`;
  } else if (parts.length === 2) {
    const c = (parts[0].centroid.x + parts[1].centroid.x) / 2;
    for (const p of parts) body += `<path d="${polyPath(p.outline, (q) => sx(2 * c - q[0]), (q) => sy(q[1]))}" class="sec-ghost"/>`;
    body += `<line x1="${r1(sx(c))}" y1="${Y0}" x2="${r1(sx(c))}" y2="${Y1}" class="sec-axis"/>`;
  }
  for (const p of parts) {
    body += `<path d="${polyPath(p.outline, (q) => sx(q[0]), (q) => sy(q[1]))}" class="sec-line"/>`;
    body += `<circle cx="${r1(sx(p.centroid.x))}" cy="${r1(sy(p.centroid.z))}" r="${Math.max(0.5, w / 90)}" class="sec-c"/>`;
    if (opts.showAxis && parts.length === 1) {
      const a = (p.angle * Math.PI) / 180, L = cm(p.width) * 0.6;
      const cx = sx(p.centroid.x), cy = sy(p.centroid.z);
      // Long axis: angle measured from +X toward +Z; on screen x flips and z flips.
      body += `<line x1="${r1(cx + Math.cos(a) * L)}" y1="${r1(cy - Math.sin(a) * L * -1)}" x2="${r1(cx - Math.cos(a) * L)}" y2="${r1(cy + Math.sin(a) * L * -1)}" class="sec-rot"/>`;
    }
  }
  const fs = Math.max(2, w / 18);
  body += `<text x="${r1(X0 + fs * 0.4)}" y="${r1(Y1 - fs * 0.4)}" class="sec-lbl" font-size="${r1(fs)}">L</text>`;
  body += `<text x="${r1(X1 - fs * 0.4)}" y="${r1(Y1 - fs * 0.4)}" class="sec-lbl" text-anchor="end" font-size="${r1(fs)}">R</text>`;
  body += `<text x="${r1((X0 + X1) / 2)}" y="${r1(Y0 + fs * 1.1)}" class="sec-lbl" text-anchor="middle" font-size="${r1(fs)}">front</text>`;
  return `<svg class="sec-svg" viewBox="${r1(X0)} ${r1(Y0)} ${r1(w)} ${r1(h)}" role="img" aria-label="${esc(opts.label || 'Cross-section')}">${body}</svg>`;
}

// Vertical section on the posture grid. axis 'side': u = z (front to the right); 'front': u = x (person's left on the right).
function verticalSvg(rec, prev, view) {
  const seg = view === 'side' ? rec.sagSeg : rec.frontSeg;
  const pseg = prev ? (view === 'side' ? prev.sagSeg : prev.frontSeg) : null;
  const H = cm(rec.height);
  const half = view === 'side' ? 40 : 50;
  const X0 = -half, X1 = half, Y0 = -(H + 8), Y1 = 4;
  let s = gridLines(X0, Y0, X1, Y1, 5, 10);
  const segPath = (arr, mirror) => {
    let d = '';
    for (let i = 0; i < arr.length; i += 4) {
      const u1 = arr[i] / 10, v1 = arr[i + 1] / 10, u2 = arr[i + 2] / 10, v2 = arr[i + 3] / 10;
      d += `M${mirror ? -u1 : u1} ${-v1}L${mirror ? -u2 : u2} ${-v2}`;
    }
    return d;
  };
  s += `<line x1="${X0}" y1="0" x2="${X1}" y2="0" class="floor"/>`;
  s += `<line x1="0" y1="${Y0}" x2="0" y2="0" class="plumb"/>`;
  if (pseg) s += `<path d="${segPath(pseg)}" class="vs-prev"/>`;
  if (view === 'front') s += `<path d="${segPath(seg, true)}" class="vs-ghost"/>`;
  s += `<path d="${segPath(seg)}" class="vs-line"/>`;
  const L = rec.landmarks;
  const pts = view === 'side'
    ? [['Ear', mid(L[7], L[8])], ['Shoulder', mid(L[11], L[12])], ['Hip', mid(L[23], L[24])], ['Knee', mid(L[25], L[26])], ['Ankle', mid(L[27], L[28])]].map(([n, p]) => [n, cm(p.z), cm(p.y)])
    : [[null, cm(L[11].x), cm(L[11].y)], [null, cm(L[12].x), cm(L[12].y)], [null, cm(L[23].x), cm(L[23].y)], [null, cm(L[24].x), cm(L[24].y)], [null, cm(L[25].x), cm(L[25].y)], [null, cm(L[26].x), cm(L[26].y)], [null, cm(L[27].x), cm(L[27].y)], [null, cm(L[28].x), cm(L[28].y)], [null, cm(L[7].x), cm(L[7].y)], [null, cm(L[8].x), cm(L[8].y)]];
  if (view === 'side') {
    s += `<polyline points="${pts.map((p) => `${r1(p[1])},${r1(-p[2])}`).join(' ')}" class="vs-chain"/>`;
    const c = rec.curves;
    if (c && c.c7 && c.lumApex && c.thorApex && c.buttApex) {
      const P = (q) => `${r1(cm(q.u))},${r1(-cm(q.y))}`;
      s += `<polyline points="${P(c.c7)} ${P(c.lumApex)}" class="vs-ref"/><polyline points="${P(c.thorApex)} ${P(c.buttApex)}" class="vs-ref"/>`;
      for (const [q, n] of [[c.c7, 'C7'], [c.thorApex, 'T'], [c.lumApex, 'L'], [c.buttApex, 'S']]) s += `<circle cx="${r1(cm(q.u))}" cy="${r1(-cm(q.y))}" r="1.1" class="vs-curve"/><text x="${r1(cm(q.u) - 2.2)}" y="${r1(-cm(q.y) + 1)}" class="vs-lbl" text-anchor="end">${n}</text>`;
    }
    for (const [n, u, v] of pts) s += `<circle cx="${r1(u)}" cy="${r1(-v)}" r="1.3" class="vs-joint"/><text x="${r1(u + 2.5)}" y="${r1(-v + 1)}" class="vs-lbl">${n}</text>`;
  } else {
    for (const [a, b] of [[0, 1], [2, 3], [8, 9]]) {
      const p = pts[a], q = pts[b];
      const ext = 8;
      const dx = q[1] - p[1], dy = q[2] - p[2], len = Math.hypot(dx, dy) || 1;
      s += `<line x1="${r1(p[1] - (dx / len) * ext)}" y1="${r1(-(p[2] - (dy / len) * ext))}" x2="${r1(q[1] + (dx / len) * ext)}" y2="${r1(-(q[2] + (dy / len) * ext))}" class="vs-level"/>`;
    }
    for (const [, u, v] of pts) s += `<circle cx="${r1(u)}" cy="${r1(-v)}" r="1.2" class="vs-joint"/>`;
    s += `<text x="${X1 - 2}" y="${Y0 + 5}" class="vs-lbl" text-anchor="end">L</text><text x="${X0 + 2}" y="${Y0 + 5}" class="vs-lbl">R</text>`;
  }
  if (rec.com) {
    const u = view === 'side' ? cm(rec.com.z) : cm(rec.com.x);
    s += `<g class="com"><circle cx="${r1(u)}" cy="${r1(-cm(rec.com.y))}" r="2.2"/><line x1="${r1(u)}" y1="${r1(-cm(rec.com.y))}" x2="${r1(u)}" y2="0"/></g>`;
  }
  return `<svg class="vs-svg" viewBox="${X0} ${Y0} ${X1 - X0} ${Y1 - Y0}" role="img" aria-label="${view === 'side' ? 'Side' : 'Front'} section on a 5 cm grid">${s}</svg>`;
}

// ---------- Viewer ----------
export class Viewer {
  constructor(host, object, rec) {
    this.host = host;
    const w = host.clientWidth || 600, h = Math.round(Math.min(560, Math.max(380, w * 1.05)));
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(w, h);
    this.renderer.localClippingEnabled = true;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    host.appendChild(this.renderer.domElement);
    const scene = (this.scene = new THREE.Scene());
    scene.background = new THREE.Color(0x18221f);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x445550, 1.5));
    const d = new THREE.DirectionalLight(0xffffff, 1.6); d.position.set(1.5, 3, 2.5); scene.add(d);
    const d2 = new THREE.DirectionalLight(0xbfe6dc, 0.6); d2.position.set(-2, 1.5, -2); scene.add(d2);
    const H = rec.height;

    // Posture grid: floor plus two backdrops, 5 cm squares with 10 cm emphasis.
    const grid = (this.grid = new THREE.Group());
    const mk = (size, div) => { const g = new THREE.GridHelper(size, div, 0x4f6a63, 0x2b3a36); g.material.transparent = true; g.material.opacity = 0.9; return g; };
    const floor = mk(2, 40); grid.add(floor);
    const back = mk(2.4, 48); back.rotation.x = Math.PI / 2; back.position.set(0, 1.2, -0.6); grid.add(back);
    const side = mk(2.4, 48); side.rotation.z = Math.PI / 2; side.position.set(-0.75, 1.2, 0); grid.add(side);
    scene.add(grid);
    const plumbMat = new THREE.LineBasicMaterial({ color: 0xe2ab4c });
    const plumb = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, H + 0.12, 0)]), plumbMat);
    grid.add(plumb);

    // Body
    this.body = object;
    const clip = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.002)];
    object.traverse((o) => {
      if (!o.isMesh) return;
      o.material = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => { const c = m.clone(); c.clippingPlanes = clip; c.side = THREE.DoubleSide; return c; });
      if (o.material.length === 1) o.material = o.material[0];
    });
    scene.add(object);

    // Skeleton
    const L = rec.landmarks.map((p) => new THREE.Vector3(p.x, p.y, p.z));
    const bones = [[11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16], [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [7, 8]];
    const sk = (this.skeleton = new THREE.Group());
    const pos = [];
    for (const [a, b] of bones) pos.push(L[a], L[b]);
    sk.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pos), new THREE.LineBasicMaterial({ color: 0x7af0cc, depthTest: false })));
    const sph = new THREE.SphereGeometry(0.012, 12, 8);
    const sm = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false });
    for (const i of [0, 7, 8, 11, 12, 13, 14, 23, 24, 25, 26, 27, 28]) { const m = new THREE.Mesh(sph, sm); m.position.copy(L[i]); sk.add(m); }
    if (rec.com) {
      const c = new THREE.Mesh(new THREE.SphereGeometry(0.02, 16, 10), new THREE.MeshBasicMaterial({ color: 0xe2ab4c, depthTest: false }));
      c.position.set(rec.com.x, rec.com.y, rec.com.z); sk.add(c);
      sk.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([c.position.clone(), new THREE.Vector3(rec.com.x, 0, rec.com.z)]), new THREE.LineDashedMaterial({ color: 0xe2ab4c, dashSize: 0.03, gapSize: 0.02, depthTest: false })).computeLineDistances());
    }
    sk.renderOrder = 10;
    scene.add(sk);

    // Section rings
    const rings = (this.rings = new THREE.Group());
    this.ringByKey = {};
    for (const [k, s] of Object.entries(rec.sections)) {
      const pts = s.outline.map(([x, z]) => new THREE.Vector3(x, s.y, z));
      pts.push(pts[0]);
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xf2c26b, depthTest: false, transparent: true, opacity: 0.9 }));
      line.renderOrder = 11;
      rings.add(line); this.ringByKey[k] = line;
    }
    scene.add(rings);

    this.camera = new THREE.PerspectiveCamera(30, w / h, 0.05, 30);
    this.target = new THREE.Vector3(0, H * 0.52, 0);
    this.dist = H * 2.6;
    this.preset('front');
    this.ready = import('./vendor/three/addons/controls/OrbitControls.js').then(({ OrbitControls }) => {
      this.controls = new OrbitControls(this.camera, this.renderer.domElement);
      this.controls.target.copy(this.target);
      this.controls.enableDamping = true;
      this.controls.addEventListener('change', () => this.render());
      this.controls.update();
      this.render();
    });
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.render();
  }
  resize() {
    const w = this.host.clientWidth; if (!w) return;
    const h = Math.round(Math.min(560, Math.max(380, w * 1.05)));
    this.renderer.setSize(w, h); this.camera.aspect = w / h; this.camera.updateProjectionMatrix(); this.render();
  }
  preset(v) {
    const t = this.target, d = this.dist;
    const p = { front: [0, 0.05, 1], back: [0, 0.05, -1], side: [1, 0.05, 0], left: [1, 0.05, 0], right: [-1, 0.05, 0], top: [0.0001, 1, 0.12], angle: [0.8, 0.35, 0.9] }[v] || [0, 0, 1];
    const dir = new THREE.Vector3(...p).normalize();
    this.camera.position.copy(t).addScaledVector(dir, d);
    this.camera.lookAt(t);
    if (this.controls) { this.controls.target.copy(t); this.controls.update(); }
    this.render();
  }
  toggle(what, on) {
    if (what === 'body') this.body.visible = on;
    if (what === 'xray') this.body.traverse((o) => { if (o.isMesh) for (const m of [].concat(o.material)) { m.transparent = on; m.opacity = on ? 0.32 : 1; m.depthWrite = !on; m.needsUpdate = true; } });
    if (what === 'skeleton') this.skeleton.visible = on;
    if (what === 'sections') this.rings.visible = on;
    if (what === 'grid') this.grid.visible = on;
    this.render();
  }
  highlight(key) {
    for (const [k, l] of Object.entries(this.ringByKey)) { l.material.color.set(k === key ? 0xffffff : 0xf2c26b); l.material.opacity = key && k !== key ? 0.35 : 0.9; }
    this.render();
  }
  render() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      if (this.controls) this.controls.update();
      this.renderer.render(this.scene, this.camera);
    });
  }
  snapshot() { this.renderer.render(this.scene, this.camera); return this.renderer.domElement.toDataURL('image/jpeg', 0.85); }
  dispose() { this.ro.disconnect(); this.controls?.dispose(); this.renderer.dispose(); this.renderer.domElement.remove(); }
}

// ---------- Report HTML ----------
const STATUS_LABEL = { good: 'Typical', mild: 'Slight', notable: 'Notable', none: 'Not measured' };

function scoreWord(s) {
  if (s == null) return '';
  return s >= 85 ? 'Well aligned' : s >= 70 ? 'Mostly aligned' : s >= 55 ? 'Some asymmetry' : 'Marked asymmetry';
}

function gauge(score) {
  const r = 42, c = 2 * Math.PI * r, f = Math.max(0, Math.min(100, score ?? 0)) / 100;
  return `<svg class="gauge" viewBox="0 0 100 100" role="img" aria-label="Overall alignment score ${score} out of 100">
    <circle cx="50" cy="50" r="${r}" class="g-track"/>
    <circle cx="50" cy="50" r="${r}" class="g-fill" stroke-dasharray="${(c * f).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 50 50)"/>
    <text x="50" y="50" class="g-num">${score ?? '–'}</text><text x="50" y="66" class="g-sub">of 100</text></svg>`;
}

function metricRow(m, prevVal) {
  const unitTxt = m.unit === '°' ? '°' : m.unit === '%' ? '%' : ` ${m.unit}`;
  const delta = prevVal != null ? r1(m.value - prevVal) : null;
  return `<li class="metric">
    <div class="m-head"><span class="m-label">${esc(m.label)}</span><span class="tag">3D</span>
      <span class="m-val ${m.status}">${Math.abs(m.value).toFixed(1)}<small>${esc(unitTxt.trim())}</small></span></div>
    <p class="m-detail">${esc(m.detail)}</p>
    <p class="m-range">${esc(m.range)}${delta != null ? ` · ${delta === 0 ? 'unchanged' : `${delta > 0 ? '+' : ''}${delta}${esc(unitTxt.trim())} since last scan`}` : ''}</p>
  </li>`;
}

const SECTION_GROUPS = [
  { id: 'head', name: 'Head', keys: ['head'] },
  { id: 'neck', name: 'Neck', keys: ['neck'] },
  { id: 'shoulders', name: 'Shoulders', keys: ['shoulders'], axis: true },
  { id: 'chest', name: 'Chest', keys: ['chest'], axis: true },
  { id: 'waist', name: 'Waist', keys: ['waist'], axis: true },
  { id: 'hips', name: 'Hips', keys: ['hips'], axis: true },
  { id: 'thigh', name: 'Thighs', keys: ['thighL', 'thighR'] },
  { id: 'knee', name: 'Knees', keys: ['kneeL', 'kneeR'] },
  { id: 'calf', name: 'Calves', keys: ['calfL', 'calfR'] },
  { id: 'ankle', name: 'Ankles', keys: ['ankleL', 'ankleR'] },
];

function sectionCard(g, rec, prev) {
  const parts = g.keys.map((k) => rec.sections[k]).filter(Boolean);
  if (!parts.length) return '';
  const pparts = prev ? g.keys.map((k) => prev.sections?.[k]).filter(Boolean) : [];
  const svg = sectionSvg(parts, pparts, { plumb: g.keys.length === 1 && !['head', 'neck'].includes(g.id) ? false : false, showAxis: g.axis, label: `${g.name} cross-section` });
  const d = (k, f) => {
    const a = rec.sections[k], b = prev?.sections?.[k];
    if (!a || !b) return '';
    const v = r1(cm(f(a) - f(b)));
    return ` <span class="dl ${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : v === 0 ? '±' : ''}${v}</span>`;
  };
  let rows = '';
  if (parts.length === 1) {
    const k = g.keys[0], s = parts[0];
    rows += `<tr><th>Girth</th><td>${r1(cm(s.girth))} cm${d(k, (x) => x.girth)}</td></tr>`;
    rows += `<tr><th>Width × depth</th><td>${r1(cm(s.width))} × ${r1(cm(s.depth))} cm</td></tr>`;
    rows += `<tr><th>Height from floor</th><td>${r1(cm(s.y))} cm</td></tr>`;
    if (g.axis) rows += `<tr><th>Rotation</th><td>${r1(Math.abs(s.angle))}° ${s.angle >= 0 ? 'left side forward' : 'right side forward'}</td></tr>`;
    rows += `<tr><th>Left / right area</th><td>${r1(s.leftPct)}% / ${r1(100 - s.leftPct)}%</td></tr>`;
    rows += `<tr><th>Centre vs plumb</th><td>${r1(Math.abs(cm(s.centroid.x)))} cm ${s.centroid.x >= 0 ? 'left' : 'right'}, ${r1(Math.abs(cm(s.centroid.z)))} cm ${s.centroid.z >= 0 ? 'forward' : 'back'}</td></tr>`;
  } else {
    const [a, b] = g.keys.map((k) => rec.sections[k]);
    if (a && b) {
      const pct = ((a.girth - b.girth) / ((a.girth + b.girth) / 2)) * 100;
      rows += `<tr><th></th><td class="lr-h">Left</td><td class="lr-h">Right</td></tr>`;
      rows += `<tr><th>Girth</th><td>${r1(cm(a.girth))}${d(g.keys[0], (x) => x.girth)}</td><td>${r1(cm(b.girth))}${d(g.keys[1], (x) => x.girth)}</td></tr>`;
      rows += `<tr><th>Width × depth</th><td>${r1(cm(a.width))} × ${r1(cm(a.depth))}</td><td>${r1(cm(b.width))} × ${r1(cm(b.depth))}</td></tr>`;
      rows += `<tr><th>Height</th><td>${r1(cm(a.y))}</td><td>${r1(cm(b.y))}</td></tr>`;
      rows += `<tr><th>Difference</th><td colspan="2">${r1(Math.abs(pct))}% ${Math.abs(pct) < 0.5 ? '' : pct > 0 ? 'larger on the left' : 'larger on the right'}</td></tr>`;
    }
  }
  const clipped = parts.some((p) => p.clipped);
  return `<article class="sec-card" data-sec="${g.keys[0]}">
    <header><h4>${g.name}</h4>${clipped ? '<span class="chip mild" title="Body parts touched here (arm against torso, or inner thighs), so the section was split at the touching line">split</span>' : ''}</header>
    ${svg}
    <table class="sec-tab">${rows}</table>
  </article>`;
}

function measurementsTable(rec, prev) {
  const row = (name, k) => {
    const s = rec.sections[k]; if (!s) return '';
    const p = prev?.sections?.[k];
    const dv = p ? r1(cm(s.girth - p.girth)) : null;
    return `<tr><th>${esc(name)}</th><td>${r1(cm(s.girth))}</td><td>${r1(cm(s.width))}</td><td>${r1(cm(s.depth))}</td><td>${dv == null ? '–' : `${dv > 0 ? '+' : ''}${dv}`}</td></tr>`;
  };
  return `<div class="tab-wrap"><table class="meas">
    <thead><tr><th>Section</th><th>Girth</th><th>Width</th><th>Depth</th><th>Change</th></tr></thead>
    <tbody>${Object.entries(SECTION_NAMES).map(([k, n]) => row(n, k)).join('')}</tbody>
  </table></div>
  <p class="muted small">All values in cm. Girth is the tape-measure length around the section (convex hull), width and depth are the section's extent.
  Height ${r1(cm(rec.height))} cm${rec.com?.volume ? ` · body volume ${r1(rec.com.volume * 1000)} litres` : ''}.</p>`;
}

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return iso; }
}

export function report3dHtml(rec, report, prev, opts = {}) {
  const counts = { good: 0, mild: 0, notable: 0 };
  report.regions.forEach((r) => { if (counts[r.status] != null) counts[r.status]++; });
  const prevMetrics = {};
  if (prev?.metrics) for (const m of prev.metrics) prevMetrics[m.label] = m.value;
  const prevReg = prev ? Object.fromEntries(prev.regions.map((r) => [r.id, r.score])) : {};
  const top = report.regions.filter((r) => r.status === 'notable' || r.status === 'mild').sort((a, b) => a.score - b.score).slice(0, 2);
  const delta = (id, s) => {
    if (prevReg[id] == null || s == null) return '';
    const d = s - prevReg[id];
    if (Math.abs(d) < 2) return '<span class="delta">same as last scan</span>';
    return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d} since last scan</span>`;
  };
  return `
  ${opts.example ? '<div class="example-flag">Example report. This is a sample body model, not you.</div>' : ''}
  ${rec.source === 'video' ? '<p class="muted small video-note">Built from a turn-around video. A body made from outlines fills in hollows, such as between the arms and the chest, so chest girth reads high and fine detail is softer than with a dedicated 3D scan. Compare video scans with video scans.</p>' : ''}
  <header class="r-head">
    <div class="r-title">
      <p class="eyebrow">3D alignment report</p>
      <h2>${scoreWord(report.overall)}</h2>
      <p class="r-meta">${fmtDate(rec.date)}${rec.source === 'video' ? ' · video scan' : ''} · height ${r1(cm(rec.givenHeight || rec.height))} cm${prev ? ` · compared with ${fmtDate(prev.date)}` : ''}</p>
      <ul class="r-counts">
        <li><b class="dot good"></b>${counts.good} typical</li>
        <li><b class="dot mild"></b>${counts.mild} slight</li>
        <li><b class="dot notable"></b>${counts.notable} notable</li>
      </ul>
      ${top.length ? `<p class="r-focus">Biggest differences: ${top.map((r) => `<strong>${r.name.toLowerCase()}</strong>`).join(' and ')}.</p>` : '<p class="r-focus">Every region measured within the typical range.</p>'}
    </div>
    ${gauge(report.overall)}
  </header>
  ${rec.estimated ? '<p class="issues warn">Joints could not be detected on this scan, so they were estimated from body proportions. Angles are less reliable; girths and sections are still measured from the surface.</p>' : ''}
  <p class="disclaimer"><strong>Not a medical device.</strong> Postura is for general wellness and education. It does not diagnose, treat or prevent any condition. Scan accuracy depends on the scanning app, clothing and how still you stood. If you have pain, numbness or a concern, see a physiotherapist or doctor.</p>

  <section class="v3d">
    <div class="v3d-head"><h3>Your body on the posture grid</h3><p class="muted">Drag to orbit, pinch or scroll to zoom. Grid squares are 5 cm, the gold line is the plumb line through the middle of your feet, the gold dot is your centre of mass.</p></div>
    ${opts.live ? `<div class="v3d-stage" id="v3d-stage"></div>
    <div class="row v3d-tools" role="toolbar" aria-label="Viewer controls">
      <div class="seg" role="group" aria-label="View">${['front', 'side', 'back', 'top', 'angle'].map((v) => `<button class="seg-b" data-view="${v}">${v[0].toUpperCase() + v.slice(1)}</button>`).join('')}</div>
      <div class="seg" role="group" aria-label="Layers">${[['body', 'Body', true], ['xray', 'X-ray', false], ['skeleton', 'Joints', true], ['sections', 'Sections', true], ['grid', 'Grid', true]].map(([k, n, on]) => `<button class="seg-b" data-layer="${k}" aria-pressed="${on}">${n}</button>`).join('')}</div>
    </div>` : `<p class="issues">The interactive 3D view is available right after importing a scan. Saved scans keep their sections and measurements below.</p>`}
  </section>

  <section class="regions">
    ${report.regions.map((r) => `
      <article class="region ${r.status}">
        <header><h3>${r.name}</h3><span class="chip ${r.status}">${STATUS_LABEL[r.status]}</span></header>
        ${r.score != null ? `<div class="r-score"><span class="num">${r.score}</span><span class="bar"><i style="width:${r.score}%"></i></span>${delta(r.id, r.score)}</div>` : ''}
        <ul class="metrics">${r.metrics.map((m) => metricRow(m, prevMetrics[m.label])).join('') || '<li class="m-detail">Not measured in this scan.</li>'}</ul>
        <p class="advice">${esc(r.advice)}</p>
      </article>`).join('')}
  </section>

  <section class="vsec">
    <h3>Vertical sections</h3>
    <p class="muted">Cuts straight through the body on the 5 cm grid. The side section runs through the middle of the pelvis; the front section runs through the hip joints. In the front section the dashed copy is the mirror image of the other side, so any gap between the solid and dashed lines is left/right asymmetry.${prev ? ' The dotted outline is your previous scan.' : ''}</p>
    <div class="vsec-grid">
      <figure>${verticalSvg(rec, prev, 'side')}<figcaption>Side section (facing right)${rec.curves ? ` · upper back ${r1(cm(rec.curves.thoracicDepth))} cm, lower back ${r1(cm(rec.curves.lumbarDepth))} cm` : ''}</figcaption></figure>
      <figure>${verticalSvg(rec, prev, 'front')}<figcaption>Front section with mirror overlay</figcaption></figure>
    </div>
  </section>

  <section class="hsec">
    <h3>Cross-sections</h3>
    <p class="muted">Seen from above with the front of your body at the top. Solid line: this scan. Dashed: the section mirrored left to right, so the space between them shows asymmetry.${prev ? ' Dotted: previous scan.' : ''} On torso sections the straight line shows the section's long axis, used for rotation.</p>
    <div class="sec-grid">${SECTION_GROUPS.map((g) => sectionCard(g, rec, prev)).join('')}</div>
  </section>

  <section class="meas-sec">
    <h3>Measurements</h3>
    ${measurementsTable(rec, prev)}
  </section>

  <section class="howto">
    <h3>Getting a reliable 3D result</h3>
    <ul>
      <li>Stand in a relaxed A-pose: arms 20 to 30° away from your sides, feet hip-width apart and parallel.</li>
      <li>Wear fitted clothing, tie hair up, and stay as still as you can while the scan runs.</li>
      <li>Rescan every few weeks under the same conditions. Postura compares each scan with the previous one.</li>
    </ul>
  </section>`;
}

export function wireViewer(root, viewer) {
  root.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => viewer.preset(b.dataset.view)));
  root.querySelectorAll('[data-layer]').forEach((b) => b.addEventListener('click', () => {
    const on = b.getAttribute('aria-pressed') !== 'true';
    b.setAttribute('aria-pressed', String(on));
    viewer.toggle(b.dataset.layer, on);
  }));
  root.querySelectorAll('.sec-card').forEach((c) => {
    c.addEventListener('mouseenter', () => viewer.highlight(c.dataset.sec));
    c.addEventListener('mouseleave', () => viewer.highlight(null));
    c.addEventListener('click', () => { viewer.highlight(c.dataset.sec); viewer.preset('angle'); });
  });
}
