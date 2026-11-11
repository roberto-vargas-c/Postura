// A procedural sample body for the example 3D report. Not a real person: a smooth mannequin
// built from lofted elliptical cross-sections, with a few deliberate asymmetries
// (right shoulder lower, pelvis turned slightly, head forward) so the report has something to show.
import * as THREE from './vendor/three/three.module.js';

// rings: [{ x, y, z, rx, rz, rot }] bottom to top. Returns a closed tube with flat caps.
function loft(rings, seg = 28) {
  const pos = [], idx = [];
  for (const r of rings) {
    const c = Math.cos(r.rot || 0), s = Math.sin(r.rot || 0);
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      const lx = Math.cos(a) * r.rx, lz = Math.sin(a) * r.rz;
      pos.push(r.x + lx * c - lz * s, r.y, r.z + lx * s + lz * c);
    }
  }
  for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < seg; i++) {
    const a = k * seg + i, b = k * seg + ((i + 1) % seg), c = a + seg, d = b + seg;
    idx.push(a, c, b, b, c, d);
  }
  const cap = (k, flip) => {
    const ci = pos.length / 3; const r = rings[k];
    pos.push(r.x, r.y, r.z);
    for (let i = 0; i < seg; i++) {
      const a = k * seg + i, b = k * seg + ((i + 1) % seg);
      if (flip) idx.push(ci, a, b); else idx.push(ci, b, a);
    }
  };
  cap(0, true); cap(rings.length - 1, false);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Tube along a straight limb from a to b, radii given as [t, r] stops.
function limb(a, b, stops, seg = 22) {
  const rings = [];
  const n = 14;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    let r = stops[0][1];
    for (let k = 0; k < stops.length - 1; k++) if (t >= stops[k][0] && t <= stops[k + 1][0]) {
      const u = (t - stops[k][0]) / (stops[k + 1][0] - stops[k][0]);
      r = stops[k][1] + (stops[k + 1][1] - stops[k][1]) * (0.5 - Math.cos(u * Math.PI) / 2);
    }
    rings.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t, rx: r, rz: r * 0.95 });
  }
  if (a.y > b.y) rings.reverse();
  return loft(rings, seg);
}

function ellipsoid(cx, cy, cz, rx, ry, rz, seg = 28) {
  const g = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.7));
  g.scale(rx, ry, rz); g.translate(cx, cy, cz);
  return g;
}

export function buildMannequin() {
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0xc8b39f, roughness: 0.8 });
  const add = (g) => group.add(new THREE.Mesh(g, mat));
  const V = (x, y, z) => ({ x, y, z });

  // Torso: hips to neck, with a slight pelvis rotation and a lower right shoulder.
  const T = [
    // y, half-width, half-depth, z-centre, rotation (rad), x-shift
    [0.80, 0.150, 0.105, -0.005, 0.06, 0],
    [0.86, 0.172, 0.120, -0.010, 0.06, 0],
    [0.93, 0.168, 0.115, -0.006, 0.05, 0],
    [1.00, 0.150, 0.100, 0.004, 0.03, 0.002],
    [1.06, 0.138, 0.094, 0.010, 0.02, 0.004],
    [1.12, 0.142, 0.098, 0.006, 0.02, 0.005],
    [1.20, 0.155, 0.110, 0.000, 0.01, 0.005],
    [1.28, 0.165, 0.118, -0.006, 0.00, 0.004],
    [1.36, 0.172, 0.112, -0.012, 0.00, 0.003],
    [1.41, 0.178, 0.098, -0.010, 0.00, 0.002],
    [1.45, 0.150, 0.080, -0.002, 0.00, 0.001],
    [1.48, 0.075, 0.060, 0.010, 0.00, 0.001],
  ];
  add(loft(T.map(([y, rx, rz, z, rot, x]) => ({ x, y, z, rx, rz, rot })), 40));
  // Neck and head (head sits a little forward).
  add(limb(V(0.001, 1.46, 0.012), V(0.001, 1.58, 0.035), [[0, 0.058], [1, 0.054]]));
  add(ellipsoid(0.002, 1.665, 0.045, 0.078, 0.112, 0.098));
  add(ellipsoid(0.002, 1.655, 0.142, 0.016, 0.026, 0.02)); // nose
  add(ellipsoid(0.079, 1.66, 0.035, 0.012, 0.028, 0.02));  // ears
  add(ellipsoid(-0.075, 1.66, 0.035, 0.012, 0.028, 0.02));
  add(ellipsoid(0.03, 1.685, 0.128, 0.014, 0.008, 0.008)); // brow / eye bumps
  add(ellipsoid(-0.026, 1.685, 0.128, 0.014, 0.008, 0.008));

  // Shoulders (right one 1.6 cm lower) and arms in an A-pose.
  const shL = V(0.185, 1.415, -0.012), shR = V(-0.183, 1.399, -0.012);
  add(ellipsoid(shL.x - 0.01, shL.y + 0.005, shL.z, 0.06, 0.05, 0.055));
  add(ellipsoid(shR.x + 0.01, shR.y + 0.005, shR.z, 0.06, 0.05, 0.055));
  for (const [sh, sx] of [[shL, 1], [shR, -1]]) {
    const el = V(sh.x + sx * 0.11, sh.y - 0.29, sh.z - 0.02);
    const wr = V(el.x + sx * 0.08, el.y - 0.25, el.z + 0.04);
    add(limb(sh, el, [[0, 0.052], [0.3, 0.048], [1, 0.038]]));
    add(limb(el, wr, [[0, 0.038], [0.4, 0.036], [1, 0.026]]));
    add(ellipsoid(wr.x + sx * 0.012, wr.y - 0.08, wr.z + 0.005, 0.022, 0.085, 0.045));
  }

  // Legs: left knee drifts slightly inward.
  for (const [sx, kneeIn] of [[1, 0.012], [-1, 0]]) {
    const hip = V(sx * 0.088, 0.88, 0.0);
    const knee = V(sx * (0.098 - kneeIn), 0.49, 0.012);
    const ank = V(sx * 0.105, 0.075, -0.005);
    add(limb(hip, knee, [[0, 0.092], [0.25, 0.088], [0.75, 0.066], [1, 0.054]], 30));
    add(limb(knee, ank, [[0, 0.054], [0.25, 0.058], [0.4, 0.056], [0.85, 0.034], [1, 0.034]], 28));
    // Foot: heel to toes, pointing forward and a little out.
    const foot = new THREE.BoxGeometry(0.085, 0.07, 0.24, 2, 2, 4);
    foot.translate(0, 0.035, 0.055);
    foot.rotateY(sx * 0.12);
    foot.translate(ank.x, 0, ank.z);
    add(foot);
    add(ellipsoid(ank.x, 0.07, ank.z - 0.01, 0.042, 0.045, 0.05));
  }
  return group;
}
