// Postura 3D: load a body scan mesh, stand it on a posture grid, find joints, and cut sections.
// Body frame after normalisation: metres, Y up (floor at 0), X toward the person's left,
// Z toward the person's front. The stance line (left foot to right foot) runs along X.

import * as THREE from './vendor/three/three.module.js';

const LMI = { nose: 0, lEye: 2, rEye: 5, lEar: 7, rEar: 8, lSh: 11, rSh: 12, lHip: 23, rHip: 24, lKnee: 25, rKnee: 26, lAnk: 27, rAnk: 28, lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32 };
export { LMI };
const PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];

// ---------- Loading ----------
export async function loadScanFile(file) {
  const name = file.name.toLowerCase();
  const ext = name.split('.').pop();
  let object;
  if (ext === 'obj') {
    const { OBJLoader } = await import('./vendor/three/addons/loaders/OBJLoader.js');
    object = new OBJLoader().parse(await file.text());
  } else if (ext === 'ply') {
    const { PLYLoader } = await import('./vendor/three/addons/loaders/PLYLoader.js');
    const geo = new PLYLoader().parse(await file.arrayBuffer());
    if (!geo.index && geo.attributes.position.count % 3 !== 0) throw new Error('point-cloud');
    object = new THREE.Mesh(geo);
  } else if (ext === 'stl') {
    const { STLLoader } = await import('./vendor/three/addons/loaders/STLLoader.js');
    object = new THREE.Mesh(new STLLoader().parse(await file.arrayBuffer()));
  } else if (ext === 'glb' || ext === 'gltf') {
    const { GLTFLoader } = await import('./vendor/three/addons/loaders/GLTFLoader.js');
    const data = ext === 'glb' ? await file.arrayBuffer() : await file.text();
    const gltf = await new GLTFLoader().parseAsync(data, '');
    object = gltf.scene;
  } else {
    throw new Error('format');
  }
  object.updateMatrixWorld(true);
  const skin = new THREE.MeshStandardMaterial({ color: 0xc9b8a6, roughness: 0.85, metalness: 0 });
  let faces = 0;
  object.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    faces += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    const textured = mats.some((m) => m && m.map);
    const vcol = !!g.attributes.color;
    if (!textured) {
      o.material = vcol ? new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }) : skin;
    }
    if (!g.attributes.normal) g.computeVertexNormals();
  });
  if (!faces) throw new Error('no-mesh');
  return object;
}

// World-space triangle soup (skinning baked in) as a flat Float32Array [x,y,z, x,y,z, x,y,z, ...].
export function bakeTriangles(object) {
  object.updateMatrixWorld(true);
  const chunks = [];
  let total = 0;
  const v = new THREE.Vector3();
  object.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const pos = g.attributes.position;
    const idx = g.index;
    const n = idx ? idx.count : pos.count;
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const vi = idx ? idx.getX(i) : i;
      v.fromBufferAttribute(pos, vi);
      if (o.isSkinnedMesh) o.applyBoneTransform(vi, v);
      v.applyMatrix4(o.matrixWorld);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    }
    chunks.push(out); total += out.length;
  });
  const all = new Float32Array(total);
  let off = 0;
  for (const c of chunks) { all.set(c, off); off += c.length; }
  return all;
}

function applyMatrixToTris(tris, m) {
  const v = new THREE.Vector3();
  for (let i = 0; i < tris.length; i += 3) {
    v.set(tris[i], tris[i + 1], tris[i + 2]).applyMatrix4(m);
    tris[i] = v.x; tris[i + 1] = v.y; tris[i + 2] = v.z;
  }
}

function boundsOf(tris) {
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < tris.length; i += 3) {
    for (let k = 0; k < 3; k++) { const a = tris[i + k]; if (a < min[k]) min[k] = a; if (a > max[k]) max[k] = a; }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

// ---------- Slicing ----------
// A Slicer cuts the triangle soup with axis-aligned planes and returns line segments.
export class Slicer {
  constructor(tris) {
    this.t = tris;
    const n = tris.length / 9;
    this.n = n;
    this.lo = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    this.hi = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    for (let i = 0; i < n; i++) {
      const b = i * 9;
      for (let k = 0; k < 3; k++) {
        const a = tris[b + k], c = tris[b + 3 + k], d = tris[b + 6 + k];
        this.lo[k][i] = Math.min(a, c, d); this.hi[k][i] = Math.max(a, c, d);
      }
    }
  }
  // axis 0 = x, 1 = y, 2 = z. Returns flat [u1,v1,u2,v2,...] in the other two axes:
  // y-plane -> (x, z); x-plane -> (z, y); z-plane -> (x, y).
  cut(axis, h) {
    const { t, n } = this;
    const lo = this.lo[axis], hi = this.hi[axis];
    const [ua, va] = axis === 1 ? [0, 2] : axis === 0 ? [2, 1] : [0, 1];
    const out = [];
    const pts = [];
    for (let i = 0; i < n; i++) {
      if (lo[i] > h || hi[i] < h) continue;
      const b = i * 9;
      pts.length = 0;
      for (let e = 0; e < 3; e++) {
        const p = b + e * 3, q = b + ((e + 1) % 3) * 3;
        const a = t[p + axis], c = t[q + axis];
        if ((a - h) * (c - h) < 0 || (a === h && c !== h)) {
          const s = (h - a) / (c - a);
          pts.push(t[p + ua] + s * (t[q + ua] - t[p + ua]), t[p + va] + s * (t[q + va] - t[p + va]));
        }
      }
      if (pts.length >= 4) out.push(pts[0], pts[1], pts[2], pts[3]);
    }
    return out;
  }
}

// Group cut segments into connected blobs (arms, legs, torso). Each segment joins its own two
// endpoints, and points in neighbouring grid cells join too, so gaps under `cell` are bridged.
export function components(seg, cell = 0.015) {
  // Densify long segments so low-poly meshes still give a usable outline.
  const pts = [];
  for (let i = 0; i < seg.length; i += 4) {
    const du = seg[i + 2] - seg[i], dv = seg[i + 3] - seg[i + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(du, dv) / 0.005));
    for (let j = 0; j <= k; j++) pts.push(seg[i] + (du * j) / k, seg[i + 1] + (dv * j) / k);
  }
  const ids = new Map();
  const parent = [];
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const cellOf = (u, v) => {
    const k = `${Math.floor(u / cell)},${Math.floor(v / cell)}`;
    let id = ids.get(k);
    if (id === undefined) { id = parent.length; parent.push(id); ids.set(k, id); }
    return id;
  };
  const pc = new Int32Array(pts.length / 2);
  for (let i = 0; i < pts.length; i += 2) pc[i / 2] = cellOf(pts[i], pts[i + 1]);
  // Consecutive densified points along a segment are connected.
  let q = 0;
  for (let i = 0; i < seg.length; i += 4) {
    const du = seg[i + 2] - seg[i], dv = seg[i + 3] - seg[i + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(du, dv) / 0.005));
    for (let j = 0; j < k; j++) union(pc[q + j], pc[q + j + 1]);
    q += k + 1;
  }
  for (const [k, id] of ids) {
    const [cx, cy] = k.split(',').map(Number);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const o = ids.get(`${cx + dx},${cy + dy}`);
      if (o !== undefined) union(id, o);
    }
  }
  const groups = new Map();
  for (let i = 0; i < pc.length; i++) {
    const r = find(pc[i]);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(pts[i * 2], pts[i * 2 + 1]);
  }
  return [...groups.values()].map(describe).filter((c) => c.n >= 6).sort((a, b) => b.n - a.n);
}

function hull(pts) {
  const P = [];
  for (let i = 0; i < pts.length; i += 2) P.push([pts[i], pts[i + 1]]);
  P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const p of P) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  upper.pop(); lower.pop();
  return lower.concat(upper);
}

function polyStats(poly) {
  let per = 0, area = 0, cx = 0, cy = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    per += Math.hypot(b[0] - a[0], b[1] - a[1]);
    const cr = a[0] * b[1] - b[0] * a[1];
    area += cr; cx += (a[0] + b[0]) * cr; cy += (a[1] + b[1]) * cr;
  }
  area /= 2;
  if (Math.abs(area) < 1e-9) return { per, area: 0, c: poly[0] || [0, 0] };
  return { per, area: Math.abs(area), c: [cx / (6 * area), cy / (6 * area)] };
}

function describe(pts) {
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (let i = 0; i < pts.length; i += 2) {
    minU = Math.min(minU, pts[i]); maxU = Math.max(maxU, pts[i]);
    minV = Math.min(minV, pts[i + 1]); maxV = Math.max(maxV, pts[i + 1]);
  }
  return { pts, n: pts.length / 2, minU, maxU, minV, maxV, cu: (minU + maxU) / 2, cv: (minV + maxV) / 2 };
}

// Star-shaped outline: farthest point in each angular bin around the centre. Good for limbs and torso.
function radialOutline(pts, c, bins = 120) {
  const r = new Float32Array(bins).fill(-1);
  for (let i = 0; i < pts.length; i += 2) {
    const du = pts[i] - c[0], dv = pts[i + 1] - c[1];
    let a = Math.atan2(dv, du); if (a < 0) a += Math.PI * 2;
    const b = Math.min(bins - 1, Math.floor((a / (Math.PI * 2)) * bins));
    const d = Math.hypot(du, dv);
    if (d > r[b]) r[b] = d;
  }
  // Fill empty bins from neighbours.
  for (let pass = 0; pass < bins; pass++) {
    let missing = false;
    for (let b = 0; b < bins; b++) if (r[b] < 0) {
      const p = r[(b + bins - 1) % bins], q = r[(b + 1) % bins];
      if (p >= 0 && q >= 0) r[b] = (p + q) / 2; else if (p >= 0) r[b] = p; else if (q >= 0) r[b] = q; else missing = true;
    }
    if (!missing) break;
  }
  const poly = [];
  for (let b = 0; b < bins; b++) {
    const a = ((b + 0.5) / bins) * Math.PI * 2;
    poly.push([c[0] + Math.cos(a) * r[b], c[1] + Math.sin(a) * r[b]]);
  }
  return poly;
}

// Orientation of the long axis of a cross-section, in degrees from the X axis.
// Positive = the person's left side sits further forward (rotated to the right).
function principalAngle(poly) {
  let mx = 0, mz = 0;
  for (const p of poly) { mx += p[0]; mz += p[1]; }
  mx /= poly.length; mz /= poly.length;
  let sxx = 0, szz = 0, sxz = 0;
  for (const p of poly) { const dx = p[0] - mx, dz = p[1] - mz; sxx += dx * dx; szz += dz * dz; sxz += dx * dz; }
  let a = 0.5 * Math.atan2(2 * sxz, sxx - szz) * (180 / Math.PI);
  if (a > 45) a -= 90; if (a < -45) a += 90;
  return a;
}

// Left/right shape difference of a section, mirrored about its own centre line (x = cx).
// Returns the share of area on the person's left and a 0..100 mismatch index.
function lrSymmetry(poly, cx) {
  let left = 0, right = 0;
  const n = poly.length;
  for (let i = 0; i < n; i++) {
    const a = poly[i], b = poly[(i + 1) % n];
    // Area of triangle (centre, a, b), assigned by which side its midpoint falls.
    const cz = poly.reduce((s, p) => s + p[1], 0) / n;
    const ar = Math.abs((a[0] - cx) * (b[1] - cz) - (b[0] - cx) * (a[1] - cz)) / 2;
    if ((a[0] + b[0]) / 2 >= cx) left += ar; else right += ar;
  }
  const tot = left + right || 1;
  return { leftPct: (left / tot) * 100 };
}

// ---------- Rendering helpers for joint detection ----------
function makeRenderer(w, h) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(1);
  r.setSize(w, h, false);
  r.outputColorSpace = THREE.SRGBColorSpace;
  return r;
}

function studioScene(root) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe9ecea);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a8a8a, 1.6));
  const d = new THREE.DirectionalLight(0xffffff, 1.4); d.position.set(1, 3, 4); scene.add(d);
  const d2 = new THREE.DirectionalLight(0xffffff, 0.6); d2.position.set(-2, 2, -3); scene.add(d2);
  scene.add(root);
  return scene;
}

// Render the body orthographically from a direction and return the canvas plus a pixel->world mapper.
function renderView(renderer, scene, box, dir, W, H) {
  const size = new THREE.Vector3(); box.getSize(size);
  const center = new THREE.Vector3(); box.getCenter(center);
  const viewH = size.y * 1.12;
  const viewW = viewH * (W / H);
  const cam = new THREE.OrthographicCamera(-viewW / 2, viewW / 2, viewH / 2, -viewH / 2, 0.01, 50);
  cam.position.copy(center).addScaledVector(dir, 10);
  cam.up.set(0, 1, 0);
  cam.lookAt(center);
  cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  renderer.render(scene, cam);
  const toWorld = (u, v) => new THREE.Vector3(u * 2 - 1, 1 - v * 2, 0).unproject(cam);
  return { canvas: renderer.domElement, toWorld };
}

const VIEW_DIRS = {
  front: new THREE.Vector3(0, 0, 1), back: new THREE.Vector3(0, 0, -1),
  left: new THREE.Vector3(1, 0, 0), right: new THREE.Vector3(-1, 0, 0),
};

// ---------- Main pipeline ----------
// detect(canvas) -> array of 33 {x,y,visibility} or null. progress(msg) for UI.
// opts.known: the mesh is already in metres, Y up, facing +Z (built by Postura's own video scan).
// opts.landmarks: 33 joints in the mesh's own frame, used instead of detecting on renders.
export async function analyzeScan(object, detect, progress = () => {}, opts = {}) {
  progress('Reading the mesh');
  let tris = bakeTriangles(object);
  if (tris.length < 9 * 200) throw new Error('too-small');

  // 1. Units and up axis. Usually the tallest dimension is height, but a scanned floor patch can be
  // wider than the person is tall, so each axis is tried until the pose model sees an upright person.
  const b0 = boundsOf(tris);
  const axisOrder = [0, 1, 2].sort((a, b) => b0.size[b] - b0.size[a]);
  const unitFor = (tall) => (tall > 300 ? 0.001 : tall > 30 ? 0.01 : tall > 3 ? 0.1 : 1); // mm, cm, dm, m
  const baseFor = (axis) => {
    if (opts.known) return new THREE.Matrix4();
    const toYUp = new THREE.Matrix4();
    if (axis === 0) toYUp.makeRotationZ(Math.PI / 2);
    else if (axis === 2) toYUp.makeRotationX(-Math.PI / 2);
    const u = unitFor(b0.size[axisOrder[0]]);
    return new THREE.Matrix4().makeScale(u, u, u).premultiply(toYUp);
  };
  let base = baseFor(axisOrder[0]);

  const holder = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(object);
  holder.add(inner);
  const W = 480, H = 800;
  const renderer = makeRenderer(W, H);
  const scene = studioScene(holder);

  const setPose = (flip, yaw) => {
    const m = base.clone();
    if (flip) m.premultiply(new THREE.Matrix4().makeRotationX(Math.PI));
    m.premultiply(new THREE.Matrix4().makeRotationY(yaw));
    inner.matrixAutoUpdate = false;
    inner.matrix.copy(m);
    inner.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(holder);
    // Stand on the floor, centred.
    const c = new THREE.Vector3(); box.getCenter(c);
    const t = new THREE.Matrix4().makeTranslation(-c.x, -box.min.y, -c.z);
    inner.matrix.premultiply(t);
    inner.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(holder);
  };

  // Each candidate orientation: up axis, upright or upside down, four headings.
  progress('Finding which way you face');
  let best = null;
  search: for (const axis of opts.known ? [] : axisOrder) {
    base = baseFor(axis);
    for (const flip of [false, true]) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        const box = setPose(flip, yaw);
        const view = renderView(renderer, scene, box, VIEW_DIRS.front, W, H);
        const lm = await detect(view.canvas);
        if (!lm) continue;
        const vis = (i) => lm[i].visibility ?? 0;
        const face = (vis(0) + vis(2) + vis(5)) / 3;
        const upright = lm[0].y < Math.min(lm[27].y, lm[28].y) ? 1 : -2;
        const tallInFrame = Math.max(lm[29].y, lm[30].y) - lm[0].y > 0.45 ? 0.5 : -1;
        const facing = lm[11].x > lm[12].x ? 0.6 : 0; // person's left appears on image-right when facing us
        const width = Math.min(1, Math.abs(lm[11].x - lm[12].x) / (Math.abs(lm[23].y - lm[11].y) || 1));
        const score = face + upright + tallInFrame + facing + width * 2;
        if (!best || score > best.score) best = { axis, flip, yaw, score };
      }
      if (best && best.score > 2.7) break search;
    }
  }

  // Apply the winning orientation and bake it into the triangles.
  const pose = best || { axis: opts.known ? 1 : axisOrder[0], flip: false, yaw: 0 };
  base = baseFor(pose.axis);
  let box = setPose(pose.flip, pose.yaw);
  object.updateMatrixWorld(true);
  tris = bakeTriangles(holder);
  let slicer = new Slicer(tris);

  // 2. Trim a scanned floor patch: a bottom layer far wider than the feet.
  progress('Placing you on the grid');
  const floorCut = findFloorCut(slicer, box);
  if (floorCut > 0) {
    tris = dropBelow(tris, floorCut);
    const lift = new THREE.Matrix4().makeTranslation(0, -floorCut, 0);
    inner.matrix.premultiply(lift); inner.updateMatrixWorld(true);
    applyMatrixToTris(tris, lift);
    slicer = new Slicer(tris);
    renderer.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.004)]; // hide the floor patch in joint renders
  }

  // 3. Square the stance: rotate so the line between the two feet runs along X.
  const feet = footBlobs(slicer, 0.07);
  let stanceYaw = 0;
  if (feet) {
    const dx = feet[1].cu - feet[0].cu, dz = feet[1].cv - feet[0].cv;
    stanceYaw = Math.atan2(dz, dx); // rotate by +this about Y to bring the line onto X
    if (Math.abs(stanceYaw) > Math.PI / 2) stanceYaw -= Math.sign(stanceYaw) * Math.PI;
    if (Math.abs(stanceYaw) > 0.9) stanceYaw = 0; // the coarse search is within 45°, so anything larger is noise
  }
  const rot = new THREE.Matrix4().makeRotationY(stanceYaw);
  inner.matrix.premultiply(rot); inner.updateMatrixWorld(true);
  applyMatrixToTris(tris, rot);
  slicer = new Slicer(tris);
  // Feet point forward: the sole extends further in front of the ankle than behind it.
  // If the sole's centre sits behind the ankle, the body faces -Z, so turn it around.
  const sole = components(slicer.cut(1, 0.015), 0.02);
  const ankle = components(slicer.cut(1, 0.1), 0.02);
  if (!opts.known && sole.length && ankle.length) {
    const avgZ = (cs) => { let s = 0, n = 0; for (const c of cs.slice(0, 2)) { s += c.cv * c.n; n += c.n; } return s / n; };
    const soleZ = sole.slice(0, 2).reduce((s, c) => s + (c.minV + c.maxV) / 2, 0) / Math.min(2, sole.length);
    if (globalThis.__plumbDebug) globalThis.__plumbDebug.push({ k: 'facing', soleZ, ankleZ: avgZ(ankle), pose });
    if (soleZ < avgZ(ankle) - 0.01) {
      const turn = new THREE.Matrix4().makeRotationY(Math.PI);
      inner.matrix.premultiply(turn); inner.updateMatrixWorld(true);
      applyMatrixToTris(tris, turn);
      slicer = new Slicer(tris);
    }
  }
  // Re-centre on the base of support (between the feet) so the plumb line is x = z = 0 at the floor.
  slicer = new Slicer(tris);
  const feet2 = footBlobs(slicer, 0.07);
  // Plumb line: side to side, midway between the feet; front to back, about 2.5 cm in front of the
  // ankle joints (the classic plumb-line landmark just ahead of the outer ankle bone).
  const ankles = components(slicer.cut(1, 0.1), 0.02).slice(0, 2);
  const ankleZ = ankles.length === 2 ? (ankles[0].cv + ankles[1].cv) / 2 + 0.025 : null;
  const baseC = feet2 ? [(feet2[0].cu + feet2[1].cu) / 2, ankleZ ?? (feet2[0].cv + feet2[1].cv) / 2] : [0, ankleZ ?? 0];
  const recenter = new THREE.Matrix4().makeTranslation(-baseC[0], 0, -baseC[1]);
  inner.matrix.premultiply(recenter); inner.updateMatrixWorld(true);
  applyMatrixToTris(tris, recenter);
  slicer = new Slicer(tris);
  box = new THREE.Box3().setFromObject(holder);
  const bb = boundsOf(tris);
  const height = bb.max[1];

  // 4. Joints: detect on four orthographic renders and combine into 3D.
  progress('Finding your joints in 3D');
  const views = {};
  for (const k of opts.landmarks ? [] : ['front', 'back', 'left', 'right']) {
    const v = renderView(renderer, scene, box, VIEW_DIRS[k], W, H);
    const lm = await detect(v.canvas);
    if (globalThis.__plumbDebug) globalThis.__plumbDebug.push({ k, url: v.canvas.toDataURL('image/jpeg', 0.8), lm });
    views[k] = lm ? lm.map((l) => ({ w: v.toWorld(l.x, l.y), vis: l.visibility ?? 0 })) : null;
  }
  renderer.dispose();
  let landmarks = opts.landmarks
    ? opts.landmarks.map((l) => { const v = new THREE.Vector3(l.x, l.y, l.z).applyMatrix4(inner.matrix); return { x: v.x, y: v.y, z: v.z, vis: l.vis ?? 1 }; })
    : combineViews(views);
  let estimated = false;
  if (!landmarks) { landmarks = geometricLandmarks(slicer, height); estimated = true; }

  // 5. Sections and measurements.
  progress('Cutting sections');
  const analysis = measure(slicer, tris, landmarks, height);
  holder.remove(inner);
  return { object: inner, tris, landmarks, estimated, height, ...analysis };
}

function dropBelow(tris, y) {
  const keep = [];
  for (let i = 0; i < tris.length; i += 9) {
    if (Math.max(tris[i + 1], tris[i + 4], tris[i + 7]) < y + 0.004) continue;
    for (let k = 0; k < 9; k++) keep.push(tris[i + k]);
  }
  return new Float32Array(keep);
}

function findFloorCut(slicer, box) {
  const extentAt = (y) => {
    const seg = slicer.cut(1, y);
    if (!seg.length) return 0;
    let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity;
    for (let i = 0; i < seg.length; i += 2) { a = Math.min(a, seg[i]); b = Math.max(b, seg[i]); c = Math.min(c, seg[i + 1]); d = Math.max(d, seg[i + 1]); }
    return (b - a) * (d - c);
  };
  const ref = extentAt(0.12); // around the lower shins
  if (!ref) return 0;
  let cut = 0;
  for (let y = 0.002; y < 0.08; y += 0.004) {
    if (extentAt(y) > Math.max(ref * 8, 0.3)) cut = y; else if (cut) break; // a floor patch, not feet
  }
  return cut ? cut + 0.004 : 0;
}

function footBlobs(slicer, y) {
  const comps = components(slicer.cut(1, y), 0.02);
  if (comps.length < 2 || comps[1].n < comps[0].n * 0.4) return null;
  return comps.slice(0, 2).sort((a, b) => a.cu - b.cu); // [person's right (smaller x), left]
}

// Combine 2D detections from four orthographic views into 3D joint centres.
// Front/back views give x and y; side views give z. Pairs are assigned left/right by world x.
export function combineViews(views) {
  const fb = ['front', 'back'].filter((k) => views[k]);
  if (!fb.length) return null;
  // Per view, label each pair by world position: the person's left is +x. The model often
  // mislabels a back view as a front view, so labels alone cannot be trusted.
  for (const k of fb) {
    const v = views[k];
    for (const [l, r] of PAIRS) if (v[l].w.x < v[r].w.x) { const t = v[l]; v[l] = v[r]; v[r] = t; }
  }
  const out = [];
  for (let i = 0; i < 33; i++) {
    let sx = 0, sy = 0, sw = 0;
    for (const k of fb) { const p = views[k][i]; const w = (0.2 + p.vis) * (k === 'back' ? 0.6 : 1); sx += p.w.x * w; sy += p.w.y * w; sw += w; }
    out.push({ x: sx / sw, y: sy / sw, z: 0, vis: Math.max(...fb.map((k) => views[k][i].vis)) });
  }
  // Fix left/right labels by position: the person's left is +x.
  for (const [l, r] of PAIRS) if (out[l].x < out[r].x) { const t = out[l]; out[l] = out[r]; out[r] = t; }
  // Depth from side views: use the pair's mean, which is robust to label swaps in profile.
  const sides = ['left', 'right'].filter((k) => views[k]);
  const zOf = (i) => {
    if (!sides.length) return 0;
    let s = 0, w = 0;
    for (const k of sides) { const p = views[k][i]; const ww = 0.2 + p.vis; s += p.w.z * ww; w += ww; }
    return s / w;
  };
  const paired = new Set();
  for (const [l, r] of PAIRS) {
    const z = (zOf(l) + zOf(r)) / 2;
    out[l].z = z; out[r].z = z; paired.add(l); paired.add(r);
  }
  for (let i = 0; i < 33; i++) if (!paired.has(i)) out[i].z = zOf(i);
  // Side views also refine y a little.
  return out;
}

// Fallback joints from body proportions when the pose model finds nothing.
function geometricLandmarks(slicer, H) {
  const pts = Array.from({ length: 33 }, () => ({ x: 0, y: 0, z: 0, vis: 0.3 }));
  const legsAt = (y) => {
    const c = components(slicer.cut(1, y)).slice(0, 2).sort((a, b) => b.cu - a.cu);
    return c.length === 2 ? c : null;
  };
  const set = (i, x, y, z) => { pts[i] = { x, y, z, vis: 0.3 }; };
  for (const [l, r, f] of [[27, 28, 0.039], [29, 30, 0.012], [31, 32, 0.012], [25, 26, 0.285], [23, 24, 0.5]]) {
    const y = H * f;
    const c = legsAt(f >= 0.45 ? H * 0.43 : y);
    if (c) {
      set(l, c[0].cu, y, c[0].cv); set(r, c[1].cu, y, c[1].cv);
      if (f >= 0.45) { pts[l].x *= 0.85; pts[r].x *= 0.85; }
    }
  }
  const sy = H * 0.818;
  const torso = components(slicer.cut(1, sy)).sort((a, b) => Math.abs(a.cu) - Math.abs(b.cu))[0];
  if (torso) {
    const half = (torso.maxU - torso.minU) * 0.38;
    set(11, torso.cu + half, sy, torso.cv); set(12, torso.cu - half, sy, torso.cv);
  }
  const hy = H * 0.915;
  const head = components(slicer.cut(1, hy)).sort((a, b) => b.n - a.n)[0];
  if (head) {
    set(7, head.maxU - 0.01, hy, head.cv); set(8, head.minU + 0.01, hy, head.cv);
    set(0, head.cu, H * 0.9, head.maxV); set(2, head.cu + 0.03, H * 0.935, head.maxV - 0.02); set(5, head.cu - 0.03, H * 0.935, head.maxV - 0.02);
  }
  return pts;
}

// ---------- Measurements ----------
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });

function pickNear(comps, x, z) {
  let best = null, bd = Infinity;
  for (const c of comps) {
    const d = Math.hypot(c.cu - x, c.cv - z) - Math.min(0.2, c.n / 5000);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function sectionAt(slicer, y, target, opts) {
  opts = opts || {};
  const seg = slicer.cut(1, y);
  if (!seg.length) return null;
  const comps = components(seg);
  const c = pickNear(comps, target.x, target.z);
  if (!c) return null;
  let pts = c.pts;
  let clipped = false;
  if (opts.side) {
    // Legs that touch (inner thighs) form one blob; keep this leg's half.
    const keep = [];
    for (let i = 0; i < pts.length; i += 2) if ((pts[i] - opts.midX) * opts.side >= 0) keep.push(pts[i], pts[i + 1]);
    if (keep.length < pts.length - 4 && keep.length > 20) { pts = keep; clipped = c.minU < opts.midX && c.maxU > opts.midX; }
  }
  if (opts.clipX) {
    const [a, b] = opts.clipX;
    const width = c.maxU - c.minU;
    if (width > (b - a) * 1.12) {
      const keep = [];
      for (let i = 0; i < pts.length; i += 2) if (pts[i] >= a && pts[i] <= b) keep.push(pts[i], pts[i + 1]);
      if (keep.length > 20) { pts = keep; clipped = true; }
    }
  }
  const h = hull(pts);
  const hs = polyStats(h);
  const outline = radialOutline(pts, hs.c);
  const os = polyStats(outline);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of outline) { minU = Math.min(minU, p[0]); maxU = Math.max(maxU, p[0]); minV = Math.min(minV, p[1]); maxV = Math.max(maxV, p[1]); }
  // Raw cut segments that belong to this blob, for drawing the true section.
  const raw = [];
  const inBlob = (u, v) => u >= c.minU - 0.005 && u <= c.maxU + 0.005 && v >= c.minV - 0.005 && v <= c.maxV + 0.005;
  for (let i = 0; i < seg.length; i += 4) if (inBlob(seg[i], seg[i + 1]) && inBlob(seg[i + 2], seg[i + 3])) raw.push(seg[i], seg[i + 1], seg[i + 2], seg[i + 3]);
  return {
    y,
    girth: hs.per,
    area: os.area,
    width: maxU - minU,
    depth: maxV - minV,
    centroid: { x: os.c[0], z: os.c[1] },
    angle: principalAngle(outline),
    leftPct: lrSymmetry(outline, os.c[0]).leftPct,
    outline: outline.map((p) => [Math.round(p[0] * 1000) / 1000, Math.round(p[1] * 1000) / 1000]),
    raw,
    clipped,
  };
}

function searchSection(slicer, y0, y1, steps, target, opts, pickMax) {
  let best = null;
  for (let i = 0; i <= steps; i++) {
    const y = y0 + ((y1 - y0) * i) / steps;
    const s = sectionAt(slicer, y, target, opts);
    if (!s) continue;
    if (!best || (pickMax ? s.girth > best.girth : s.girth < best.girth)) best = s;
  }
  return best;
}

// Profile of a vertical plane: for each 1 cm of height, the front-most and back-most body point.
function profile(slicer, axis, at, y0, y1, keep) {
  const seg = slicer.cut(axis, at); // x-plane -> (z, y); z-plane -> (x, y)
  const bins = new Map();
  for (let i = 0; i < seg.length; i += 2) {
    const u = seg[i], y = seg[i + 1];
    if (y < y0 || y > y1 || (keep && !keep(u, y))) continue;
    const b = Math.round(y * 100);
    const e = bins.get(b) || { lo: Infinity, hi: -Infinity };
    e.lo = Math.min(e.lo, u); e.hi = Math.max(e.hi, u);
    bins.set(b, e);
  }
  const rows = [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([b, e]) => ({ y: b / 100, lo: e.lo, hi: e.hi }));
  return { rows, seg };
}

function linePoint(a, b, y) { const t = (y - a.y) / ((b.y - a.y) || 1e-6); return a.u + t * (b.u - a.u); }

// Back curve depths from the mid-sagittal back contour (Z smaller = further back).
function backCurves(rows, L) {
  const s = mid(L[11], L[12]), hp = mid(L[23], L[24]);
  const back = rows.filter((r) => isFinite(r.lo)).map((r) => ({ y: r.y, u: r.lo }));
  const range = (y0, y1) => back.filter((r) => r.y >= y0 && r.y <= y1);
  const torso = s.y - hp.y;
  const c7y = s.y + torso * 0.08;
  const c7 = range(c7y - 0.015, c7y + 0.015)[0];
  const thorRows = range(hp.y + torso * 0.45, c7y);
  const buttRows = range(hp.y - torso * 0.35, hp.y + torso * 0.1);
  if (!c7 || thorRows.length < 5 || buttRows.length < 3) return null;
  const thorApex = thorRows.reduce((a, b) => (b.u < a.u ? b : a));
  const buttApex = buttRows.reduce((a, b) => (b.u < a.u ? b : a));
  const lumRows = range(buttApex.y, thorApex.y);
  let lumApex = null, lumDepth = 0;
  for (const r of lumRows) { const d = r.u - linePoint(thorApex, buttApex, r.y); if (d > lumDepth) { lumDepth = d; lumApex = r; } }
  let thorDepth = 0;
  if (lumApex) for (const r of range(lumApex.y, c7.y)) { const d = linePoint(c7, lumApex, r.y) - r.u; if (d > thorDepth) thorDepth = d; }
  // Depths beyond 12 cm mean the contour picked up something other than the back (hair, clothing, a gap).
  if (lumDepth > 0.12 || thorDepth > 0.12) return null;
  return { c7, thorApex, lumApex, buttApex, lumbarDepth: lumDepth, thoracicDepth: thorDepth };
}

function centreOfMass(tris) {
  // Volume centroid via signed tetrahedra; falls back to surface centroid for open scans.
  let V = 0, cx = 0, cy = 0, cz = 0, A = 0, ax = 0, ay = 0, az = 0;
  for (let i = 0; i < tris.length; i += 9) {
    const x1 = tris[i], y1 = tris[i + 1], z1 = tris[i + 2], x2 = tris[i + 3], y2 = tris[i + 4], z2 = tris[i + 5], x3 = tris[i + 6], y3 = tris[i + 7], z3 = tris[i + 8];
    const v = (x1 * (y2 * z3 - z2 * y3) - y1 * (x2 * z3 - z2 * x3) + z1 * (x2 * y3 - y2 * x3)) / 6;
    V += v; cx += v * (x1 + x2 + x3) / 4; cy += v * (y1 + y2 + y3) / 4; cz += v * (z1 + z2 + z3) / 4;
    const ux = x2 - x1, uy = y2 - y1, uz = z2 - z1, wx = x3 - x1, wy = y3 - y1, wz = z3 - z1;
    const a = Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) / 2;
    A += a; ax += a * (x1 + x2 + x3) / 3; ay += a * (y1 + y2 + y3) / 3; az += a * (z1 + z2 + z3) / 3;
  }
  const vol = Math.abs(V);
  if (vol > 0.02 && vol < 0.35) return { x: cx / V, y: cy / V, z: cz / V, volume: vol, method: 'volume' };
  return { x: ax / A, y: ay / A, z: az / A, volume: null, method: 'surface' };
}

function measure(slicer, tris, L, H) {
  const sh = mid(L[11], L[12]), hp = mid(L[23], L[24]), ear = mid(L[7], L[8]);
  const torso = sh.y - hp.y;
  const shoulderSpan = Math.abs(L[11].x - L[12].x);
  const clipTorso = [sh.x - shoulderSpan / 2 - 0.035, sh.x + shoulderSpan / 2 + 0.035];
  const S = {};
  const T = (p) => ({ x: p.x, z: p.z });

  S.head = sectionAt(slicer, ear.y, T(ear));
  S.neck = searchSection(slicer, sh.y + torso * 0.12, sh.y + (ear.y - sh.y) * 0.55, 6, T(mid(sh, ear)), null, false);
  S.shoulders = sectionAt(slicer, sh.y - torso * 0.04, T(sh), { clipX: [clipTorso[0] - 0.04, clipTorso[1] + 0.04] });
  S.chest = sectionAt(slicer, sh.y - torso * 0.28, T(mid(sh, hp)), { clipX: clipTorso });
  S.waist = searchSection(slicer, hp.y + torso * 0.25, hp.y + torso * 0.62, 10, T(mid(sh, hp)), { clipX: clipTorso }, false);
  S.hips = searchSection(slicer, hp.y - torso * 0.3, hp.y + torso * 0.08, 10, T(hp), { clipX: [hp.x - shoulderSpan * 0.75, hp.x + shoulderSpan * 0.75] }, true);
  for (const [side, h, k, a] of [['L', 23, 25, 27], ['R', 24, 26, 28]]) {
    const hip = L[h], knee = L[k], ank = L[a];
    const thighY = hip.y - (hip.y - knee.y) * 0.4;
    const o = { side: side === 'L' ? 1 : -1, midX: hp.x };
    S['thigh' + side] = sectionAt(slicer, thighY, T(mid(hip, knee)), o);
    S['knee' + side] = sectionAt(slicer, knee.y, T(knee), o);
    S['calf' + side] = searchSection(slicer, knee.y - (knee.y - ank.y) * 0.15, knee.y - (knee.y - ank.y) * 0.6, 8, T(mid(knee, ank)), o, true);
    S['ankle' + side] = searchSection(slicer, ank.y + 0.02, ank.y + (knee.y - ank.y) * 0.25, 6, T(ank), o, false);
  }
  for (const k of Object.keys(S)) if (!S[k]) delete S[k];

  // Vertical sections through the body: sagittal (side) at the plumb line and frontal through the hips.
  const sag = profile(slicer, 0, hp.x, 0, H, (u) => Math.abs(u - hp.z) < 0.4);
  const front = profile(slicer, 2, hp.z, 0, H);
  const curves = backCurves(sag.rows, L);
  const com = centreOfMass(tris);
  return { sections: S, sagittal: sag, frontal: front, curves, com };
}
