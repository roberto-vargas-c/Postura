// Postura video scan: build a 3D body from a turn-around video.
// The phone stays still; the person turns once on the spot. Each frame gives a body outline
// (segmentation mask) and a rotation angle. Carving a voxel grid with every outline gives the
// visual hull, which is meshed with surface nets and handed to the normal 3D pipeline.

import * as THREE from './vendor/three/three.module.js';
import { combineViews } from './scan3d.js';

const DEG = Math.PI / 180;

// ---------- Frames ----------
export async function extractFrames(file, { count = 72, maxSide = 640 } = {}, progress = () => {}) {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto';
  video.src = url;
  await new Promise((res, rej) => {
    video.onloadeddata = res;
    video.onerror = () => rej(new Error('video-decode'));
    setTimeout(() => rej(new Error('video-decode')), 20000);
  });
  let dur = video.duration;
  if (!isFinite(dur) || dur <= 0) {
    // Some recordings (webm from MediaRecorder) report Infinity until seeked to the end.
    video.currentTime = 1e7;
    await new Promise((r) => { video.onseeked = r; setTimeout(r, 3000); });
    dur = video.duration;
  }
  if (!isFinite(dur) || dur < 4) throw new Error('video-short');
  const k = Math.min(1, maxSide / Math.max(video.videoWidth, video.videoHeight));
  const w = Math.round(video.videoWidth * k), h = Math.round(video.videoHeight * k);
  const frames = [];
  const n = Math.min(count, Math.round(dur * 6));
  for (let i = 0; i < n; i++) {
    const t = 0.1 + ((dur - 0.25) * i) / (n - 1);
    video.currentTime = t;
    await new Promise((r) => { video.onseeked = r; setTimeout(r, 4000); });
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(video, 0, 0, w, h);
    frames.push({ canvas: c, t });
    if (i % 6 === 0) progress(i / n);
  }
  URL.revokeObjectURL(url);
  return frames;
}

// ---------- Per-frame analysis ----------
// landmarker: a MediaPipe PoseLandmarker in IMAGE mode. Segmentation is switched on for the scan.
export async function analyzeFrames(frames, landmarker, progress = () => {}) {
  await landmarker.setOptions({ outputSegmentationMasks: true });
  const out = [];
  try {
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const r = landmarker.detect(f.canvas);
      const lm = r.landmarks?.[0] || null;
      const world = r.worldLandmarks?.[0] || null;
      let mask = null;
      if (r.segmentationMasks?.[0]) {
        const m = r.segmentationMasks[0];
        mask = { w: m.width, h: m.height, data: new Float32Array(m.getAsFloat32Array()) };
        for (const mm of r.segmentationMasks) mm.close?.();
      }
      out.push({ t: f.t, w: f.canvas.width, h: f.canvas.height, lm, world, mask });
      if (i % 4 === 0) { progress(i / frames.length); await new Promise((r2) => setTimeout(r2, 0)); }
    }
  } finally {
    await landmarker.setOptions({ outputSegmentationMasks: false });
  }
  return out;
}

const median = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };

// Silhouette rows: top and bottom of the person in a mask.
function maskExtent(mask) {
  const { w, h, data } = mask;
  let top = -1, bot = -1, sx = 0, n = 0;
  for (let y = 0; y < h; y++) {
    let any = false;
    for (let x = 0; x < w; x++) if (data[y * w + x] > 0.5) { any = true; sx += x; n++; }
    if (any) { if (top < 0) top = y; bot = y; }
  }
  return { top, bot, cx: n ? sx / n : w / 2 };
}

// How squarely the person faces (or turns their back to) the camera, 0..1.
function frontalness(f) {
  if (!f.lm) return 0;
  const L = f.lm;
  const sw = Math.abs(L[11].x - L[12].x) * f.w;
  const tl = Math.abs((L[23].y + L[24].y) / 2 - (L[11].y + L[12].y) / 2) * f.h || 1;
  return Math.min(1, (sw / tl) / 0.9);
}

// ---------- Rotation per frame ----------
// The turn is found from the silhouette itself, which is more reliable than the pose model's depth:
// 1. Turning starts and stops where the outline starts and stops changing.
// 2. The torso outline is widest facing the camera or facing away (0°, 180°, 360°) and narrowest
//    side-on (90°, 270°). Those four moments anchor the turn, and frames in between are spread
//    evenly, so an uneven turning speed is corrected four times per turn.
function torsoWidth(f) {
  if (!f.mask || !f.lm) return null;
  const { w, h, data } = f.mask;
  const L = f.lm;
  const y0 = Math.round(((L[11].y + L[12].y) / 2) * h), y1 = Math.round(((L[23].y + L[24].y) / 2) * h);
  const widths = [];
  for (let y = Math.min(y0, y1); y <= Math.max(y0, y1); y += 2) {
    let a = -1, b = -1;
    for (let x = 0; x < w; x++) if (data[y * w + x] > 0.5) { if (a < 0) a = x; b = x; }
    if (a >= 0) widths.push(b - a);
  }
  return widths.length ? median(widths) : null;
}

function frameYaws(fr) {
  const n = fr.length;
  // Motion: mean change in the mask between frames.
  const diff = fr.map((f, i) => {
    if (!i || !f.mask || !fr[i - 1].mask) return 0;
    const A = f.mask.data, B = fr[i - 1].mask.data;
    let d = 0;
    for (let k = 0; k < A.length; k += 7) d += Math.abs((A[k] > 0.5) - (B[k] > 0.5));
    return d / (A.length / 7);
  });
  const thr = Math.max(0.002, median(diff) * 0.35);
  let s = 0, e = n - 1;
  while (s < n - 1 && diff[s + 1] < thr) s++;
  while (e > 0 && diff[e] < thr) e--;
  if (e - s < n * 0.4) { s = 0; e = n - 1; }

  const W = fr.map(torsoWidth);
  const Ws = W.map((_, i) => { const v = W.slice(Math.max(0, i - 1), i + 2).filter((x) => x != null); return v.length ? v.reduce((a, b) => a + b) / v.length : null; });
  const L = e - s;
  const argExt = (a, b, sign) => {
    let bi = -1, bv = -Infinity;
    for (let i = Math.max(s, Math.round(a)); i <= Math.min(e, Math.round(b)); i++) if (Ws[i] != null && sign * Ws[i] > bv) { bv = sign * Ws[i]; bi = i; }
    return bi;
  };
  const m1 = argExt(s + 0.12 * L, s + 0.42 * L, -1);
  const mid = m1 >= 0 ? argExt(m1 + 0.12 * L, s + 0.75 * L, 1) : -1;
  const m2 = mid >= 0 ? argExt(mid + 0.12 * L, e - 0.08 * L, -1) : -1;
  let anchors = [[s, 0], [e, 360]];
  if (m1 > s && mid > m1 && m2 > mid && e > m2) anchors = [[s, 0], [m1, 90], [mid, 180], [m2, 270], [e, 360]];
  const yaw = fr.map((f, i) => {
    if (i < s || i > e) return null;
    for (let k = 0; k < anchors.length - 1; k++) {
      const [ia, ya] = anchors[k], [ib, yb] = anchors[k + 1];
      if (i >= ia && i <= ib) {
        const ta = fr[ia].t, tb = fr[ib].t;
        return ya + ((f.t - ta) / ((tb - ta) || 1)) * (yb - ya);
      }
    }
    return null;
  });
  return { yaw, start: s, end: e, method: anchors.length === 5 ? 'outline' : 'steady', turned: 360 };
}

// ---------- Carving ----------
function carve(fr, yaws, geom, res, dirSign, minMiss) {
  const { s, floorV, cxs } = geom;
  const X0 = -0.5, Z0 = -0.5, nx = Math.round(1 / res), nz = nx;
  const ny = Math.round(geom.heightM * 1.04 / res);
  const miss = new Uint8Array(nx * ny * nz);
  const xs = new Float32Array(nx), zs = new Float32Array(nz);
  for (let i = 0; i < nx; i++) xs[i] = X0 + (i + 0.5) * res;
  for (let k = 0; k < nz; k++) zs[k] = Z0 + (k + 0.5) * res;
  for (let f = 0; f < fr.length; f++) {
    const F = fr[f];
    if (!F.mask || yaws[f] == null) continue;
    const { w, h, data } = F.mask;
    const sx = w / F.w, sy = h / F.h; // mask may be at a different size than the frame
    const th = dirSign * yaws[f] * DEG, c = Math.cos(th), sn = Math.sin(th);
    const cu = cxs[f];
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * res;
      const v = Math.round((floorV - y * s) * sy);
      if (v < 0 || v >= h) continue;
      const row = v * w;
      for (let k = 0; k < nz; k++) {
        const zc = zs[k] * sn;
        const base = (j * nz + k) * nx;
        for (let i = 0; i < nx; i++) {
          const u = Math.round((cu + (xs[i] * c + zc) * s) * sx);
          if (u < 0 || u >= w) continue;
          if (data[row + u] < 0.4 && miss[base + i] < 255) miss[base + i]++;
        }
      }
    }
  }
  const occ = new Uint8Array(nx * ny * nz);
  let count = 0;
  for (let i = 0; i < occ.length; i++) if (miss[i] < minMiss) { occ[i] = 1; count++; }
  return { occ, nx, ny, nz, res, X0, Z0, count };
}

// Keep only the largest connected blob (drops specks carved out of background noise).
function largestBlob(g) {
  const { occ, nx, ny, nz } = g;
  const lab = new Int32Array(occ.length);
  let best = 0, bestId = 0, id = 0;
  const stack = new Int32Array(occ.length);
  for (let s = 0; s < occ.length; s++) {
    if (!occ[s] || lab[s]) continue;
    id++; let sp = 0, size = 0; stack[sp++] = s; lab[s] = id;
    while (sp) {
      const p = stack[--sp]; size++;
      const i = p % nx, k = Math.floor(p / nx) % nz, j = Math.floor(p / (nx * nz));
      const nb = [i > 0 ? p - 1 : -1, i < nx - 1 ? p + 1 : -1, k > 0 ? p - nx : -1, k < nz - 1 ? p + nx : -1, j > 0 ? p - nx * nz : -1, j < ny - 1 ? p + nx * nz : -1];
      for (const q of nb) if (q >= 0 && occ[q] && !lab[q]) { lab[q] = id; stack[sp++] = q; }
    }
    if (size > best) { best = size; bestId = id; }
  }
  for (let s = 0; s < occ.length; s++) occ[s] = lab[s] === bestId ? 1 : 0;
  g.count = best;
  return g;
}

// ---------- Surface nets ----------
function surfaceNets(g) {
  const { occ, nx, ny, nz, res, X0, Z0 } = g;
  const at = (i, j, k) => (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz ? 0 : occ[(j * nz + k) * nx + i]);
  // Cells span voxel centres (i..i+1); include a one-cell border so the surface closes.
  const cx = nx + 1, cy = ny + 1, cz = nz + 1;
  const vid = new Int32Array(cx * cy * cz).fill(-1);
  const pos = [];
  const cidx = (i, j, k) => ((j + 1) * cz + (k + 1)) * cx + (i + 1);
  const corners = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1]];
  const edges = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  for (let j = -1; j < ny; j++) for (let k = -1; k < nz; k++) for (let i = -1; i < nx; i++) {
    const v = corners.map(([a, b, c]) => at(i + a, j + b, k + c));
    const sum = v.reduce((x, y) => x + y, 0);
    if (sum === 0 || sum === 8) continue;
    let px = 0, py = 0, pz = 0, n = 0;
    for (const [a, b] of edges) if (v[a] !== v[b]) {
      px += (corners[a][0] + corners[b][0]) / 2; py += (corners[a][1] + corners[b][1]) / 2; pz += (corners[a][2] + corners[b][2]) / 2; n++;
    }
    vid[cidx(i, j, k)] = pos.length / 3;
    pos.push(X0 + (i + 0.5 + px / n) * res, (j + 0.5 + py / n) * res, Z0 + (k + 0.5 + pz / n) * res);
  }
  const idx = [];
  const quad = (a, b, c, d, flip) => { if (a < 0 || b < 0 || c < 0 || d < 0) return; if (flip) idx.push(a, c, b, a, d, c); else idx.push(a, b, c, a, c, d); };
  for (let j = -1; j < ny; j++) for (let k = -1; k < nz; k++) for (let i = -1; i < nx; i++) {
    const v0 = at(i, j, k);
    // +x edge between voxel (i,j,k) and (i+1,j,k): cells (i, j-1..j, k-1..k)
    if (j >= 0 && k >= 0) {
      const v1 = at(i + 1, j, k);
      if (v0 !== v1) quad(vid[cidx(i, j - 1, k - 1)], vid[cidx(i, j, k - 1)], vid[cidx(i, j, k)], vid[cidx(i, j - 1, k)], !v0);
    }
    if (i >= 0 && k >= 0) {
      const v1 = at(i, j + 1, k);
      if (v0 !== v1) quad(vid[cidx(i - 1, j, k - 1)], vid[cidx(i - 1, j, k)], vid[cidx(i, j, k)], vid[cidx(i, j, k - 1)], !v0);
    }
    if (i >= 0 && j >= 0) {
      const v1 = at(i, j, k + 1);
      if (v0 !== v1) quad(vid[cidx(i - 1, j - 1, k)], vid[cidx(i, j - 1, k)], vid[cidx(i, j, k)], vid[cidx(i - 1, j, k)], !v0);
    }
  }
  return { pos: new Float32Array(pos), idx: new Uint32Array(idx) };
}

function smooth(mesh, iters = 3, lambda = 0.5) {
  const { pos, idx } = mesh;
  const n = pos.length / 3;
  const nbr = Array.from({ length: n }, () => new Set());
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    nbr[a].add(b); nbr[a].add(c); nbr[b].add(a); nbr[b].add(c); nbr[c].add(a); nbr[c].add(b);
  }
  let p = pos;
  for (let it = 0; it < iters; it++) {
    const q = new Float32Array(p.length);
    for (let v = 0; v < n; v++) {
      let sx = 0, sy = 0, sz = 0;
      for (const u of nbr[v]) { sx += p[u * 3]; sy += p[u * 3 + 1]; sz += p[u * 3 + 2]; }
      const m = nbr[v].size || 1;
      // Keep the floor contact flat.
      const l = p[v * 3 + 1] < 0.012 ? 0 : lambda;
      q[v * 3] = p[v * 3] + l * (sx / m - p[v * 3]);
      q[v * 3 + 1] = p[v * 3 + 1] + l * (sy / m - p[v * 3 + 1]);
      q[v * 3 + 2] = p[v * 3 + 2] + l * (sz / m - p[v * 3 + 2]);
    }
    p = q;
  }
  mesh.pos = p;
  return mesh;
}

// Colour each vertex from the frame that sees it most directly.
function colourMesh(mesh, fr, yaws, geom, dirSign, normals) {
  const n = mesh.pos.length / 3;
  const col = new Float32Array(n * 3).fill(0.75);
  const ctxs = fr.map((f) => (f.canvas ? f.canvas.getContext('2d').getImageData(0, 0, f.w, f.h) : null));
  const dirs = fr.map((f, i) => (yaws[i] == null ? null : { c: Math.cos(dirSign * yaws[i] * DEG), s: Math.sin(dirSign * yaws[i] * DEG) }));
  for (let v = 0; v < n; v++) {
    const x = mesh.pos[v * 3], y = mesh.pos[v * 3 + 1], z = mesh.pos[v * 3 + 2];
    const nxv = normals[v * 3], nzv = normals[v * 3 + 2];
    let bestF = -1, bestD = 0.2;
    for (let f = 0; f < fr.length; f++) {
      const d = dirs[f]; if (!d || !ctxs[f]) continue;
      // Rotated normal's component toward the camera (+Z in camera space).
      const facing = -nxv * d.s + nzv * d.c;
      if (facing > bestD) { bestD = facing; bestF = f; }
    }
    if (bestF < 0) continue;
    const d = dirs[bestF], F = fr[bestF];
    const u = Math.round(geom.cxs[bestF] + (x * d.c + z * d.s) * geom.s);
    const vv = Math.round(geom.floorV - y * geom.s);
    if (u < 0 || vv < 0 || u >= F.w || vv >= F.h) continue;
    const o = (vv * F.w + u) * 4, D = ctxs[bestF].data;
    col[v * 3] = Math.pow(D[o] / 255, 2.2); col[v * 3 + 1] = Math.pow(D[o + 1] / 255, 2.2); col[v * 3 + 2] = Math.pow(D[o + 2] / 255, 2.2);
  }
  return col;
}

// ---------- Main ----------
// frames: [{canvas, t}], heightM: the person's height. Returns { object, landmarks, info }.
export async function buildBodyFromFrames(frames, landmarker, heightM, progress = () => {}) {
  progress('Finding you in each frame', 0);
  const fr = await analyzeFrames(frames, landmarker, (p) => progress('Finding you in each frame', p));
  fr.forEach((f, i) => { f.canvas = frames[i].canvas; });
  const good = fr.filter((f) => f.lm && f.mask);
  if (good.length < fr.length * 0.6) throw new Error('video-noperson');

  progress('Working out how you turned', 0);
  // Scale and floor from the frames: pixels per metre from silhouette height.
  const ext = fr.map((f) => (f.mask ? maskExtent(f.mask) : null));
  const heights = ext.filter(Boolean).map((e, i) => e.bot - e.top);
  const maskScale = fr.find((f) => f.mask).mask.h / fr[0].h;
  const s = median(heights) / maskScale / heightM; // px (frame) per metre
  const floorV = median(ext.filter(Boolean).map((e) => e.bot)) / maskScale + 1;
  // Turning axis: midpoint of the ankles, smoothed over time.
  const raw = fr.map((f, i) => (f.lm ? ((f.lm[27].x + f.lm[28].x) / 2) * f.w : ext[i] ? ext[i].cx / maskScale : f.w / 2));
  const cxs = raw.map((_, i) => median(raw.slice(Math.max(0, i - 3), i + 4)));
  const geom = { s, floorV, cxs, heightM };
  const { yaw, start, end, method, turned } = frameYaws(fr);
  const yaws = yaw;

  // Turning left or right gives the same outlines, only mirrored front to back. Carve as if the
  // turn went one way and fix the mirror afterwards from the face (the nose is in front of the ears).
  const dirSign = 1;

  progress('Building your 3D body', 0);
  await new Promise((r) => setTimeout(r, 0));
  // A voxel is removed only when several frames see background there: the pose model's outline
  // occasionally drops a limb for a frame, and a strict hull would carve that limb away.
  let grid = carve(fr, yaws, geom, 0.01, dirSign, Math.max(3, Math.round(fr.length * 0.1)));
  grid = largestBlob(grid);
  if (grid.count < 2000) throw new Error('video-carve');
  let mesh = surfaceNets(grid);
  mesh = smooth(mesh, 4, 0.55);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.pos, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.idx, 1));
  geo.computeVertexNormals();
  const colors = colourMesh(mesh, fr, yaws, geom, dirSign, geo.attributes.normal.array);
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }));

  // Joints: the frames closest to front, back and each side, mapped into body coordinates.
  const nearest = (target) => {
    let bi = -1, bd = 1e9;
    fr.forEach((f, i) => { if (yaws[i] == null || !f.lm) return; const d = Math.abs(((yaws[i] - target + 540) % 360) - 180); if (d < bd) { bd = d; bi = i; } });
    return bd < 25 ? bi : -1;
  };
  const toBody = (i, axis, sign) => fr[i].lm.map((l) => {
    const h = (l.x * fr[i].w - cxs[i]) / s, y = (floorV - l.y * fr[i].h) / s;
    return { w: { x: axis === 'x' ? sign * h : 0, y, z: axis === 'z' ? sign * h : 0 }, vis: l.visibility ?? 0 };
  });
  // With yaw θ the image's horizontal axis shows x·cosθ + z·sinθ (θ signed by the turning direction).
  const views = {};
  const iF = nearest(0) >= 0 ? nearest(0) : nearest(360);
  const iB = nearest(180), iP = nearest(90), iM = nearest(270);
  if (iF >= 0) views.front = toBody(iF, 'x', 1);
  if (iB >= 0) views.back = toBody(iB, 'x', -1);
  // sin(dir*90°) = dir: at yaw 90 the image shows dir·z.
  if (iP >= 0) views[dirSign > 0 ? 'right' : 'left'] = toBody(iP, 'z', dirSign);
  if (iM >= 0) views[dirSign > 0 ? 'left' : 'right'] = toBody(iM, 'z', -dirSign);
  const landmarks = combineViews(views);
  if (landmarks && landmarks[0].z < (landmarks[7].z + landmarks[8].z) / 2) {
    const p = geo.attributes.position.array;
    for (let i = 2; i < p.length; i += 3) p[i] = -p[i];
    const ix = geo.index.array;
    for (let t = 0; t < ix.length; t += 3) { const tmp = ix[t + 1]; ix[t + 1] = ix[t + 2]; ix[t + 2] = tmp; }
    geo.attributes.position.needsUpdate = true; geo.index.needsUpdate = true;
    geo.computeVertexNormals();
    for (const l of landmarks) l.z = -l.z;
  }
  return { object, landmarks, info: { method, turned, frames: fr.length, used: end - start + 1, dirSign, pxPerM: s, floorV, maskScale, medH: median(heights), maskW: fr.find((f) => f.mask).mask.w } };
}
