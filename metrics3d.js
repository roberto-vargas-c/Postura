// Region metrics for a 3D body scan. Input: the result of analyzeScan (landmarks in metres,
// X = person's left, Y = up, Z = forward; plumb line at x = z = 0, midway between the feet).

import { REGIONS } from './metrics.js';

const DEG = 180 / Math.PI;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 });
const cm = (m) => m * 100;

// [typical, notable] limits on |value|. Bands are two-sided: [notableLow, typicalLow, typicalHigh, notableHigh].
const LIMITS = {
  headTilt: [2.5, 5], forwardHead: [12, 22], headOverPlumb: [3, 6],
  shoulderLevel: [1.5, 3.5], shoulderRotation: [3, 7], shoulderForward: [3, 6],
  trunkShift: [1.5, 3], trunkLean: [3, 6], trunkTwist: [4, 8], torsoBalance: [2, 4],
  pelvicLevel: [1.5, 3.5], pelvicRotation: [3, 7], pelvicShift: [3, 6],
  kneeFrontal: [5, 10], kneeSagittal: [5, 10], legLength: [1, 2], girthAsym: [3, 6],
  comX: [1.5, 3], comZ: [3, 5],
};
const BANDS = { lumbarDepth: [1.5, 2.5, 5.5, 7], thoracicDepth: [0.5, 1.5, 5, 7] };

function scoreFor(v, g, n) {
  if (v <= g) return 100 - 20 * (v / g);
  if (v <= n) return 80 - 30 * ((v - g) / (n - g));
  return Math.max(0, 50 - 25 * ((v - n) / n));
}

function m(key, label, value, unit, detail, goodText, extra = {}) {
  let status, score, range;
  if (BANDS[key]) {
    const [nl, tl, th, nh] = BANDS[key];
    const dist = value < tl ? tl - value : value > th ? value - th : 0;
    const span = value < tl ? tl - nl : nh - th;
    status = dist === 0 ? 'good' : dist <= span ? 'mild' : 'notable';
    score = Math.round(dist === 0 ? 95 : scoreFor(dist, 0.0001, span) );
    range = `Typical ${tl} to ${th} ${unit}`;
  } else {
    const [g, n] = LIMITS[key];
    const v = Math.abs(value);
    status = v <= g ? 'good' : v <= n ? 'mild' : 'notable';
    score = Math.round(scoreFor(v, g, n));
    range = `Typical up to ${g}${unit === '°' ? '°' : ' ' + unit} · notable above ${n}${unit === '°' ? '°' : ' ' + unit}`;
  }
  return { key, label, value: Math.round(value * 10) / 10, unit, status, score, range, view: '3d', detail: status === 'good' && goodText ? goodText : detail, ...extra };
}

const dirWord = (v, pos, neg) => (v >= 0 ? pos : neg);

function jointAngle(a, b, c, axes) {
  const [p, q] = axes;
  const v1 = [a[p] - b[p], a[q] - b[q]], v2 = [c[p] - b[p], c[q] - b[q]];
  const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (Math.hypot(...v1) * Math.hypot(...v2));
  return Math.acos(Math.max(-1, Math.min(1, cos))) * DEG;
}
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export function build3dReport(scan) {
  const L = scan.landmarks, S = scan.sections;
  const out = [];
  const lSh = L[11], rSh = L[12], lHip = L[23], rHip = L[24], lEar = L[7], rEar = L[8];
  const sh = mid(lSh, rSh), hp = mid(lHip, rHip), ear = mid(lEar, rEar);

  // Head and neck
  const ht = Math.atan2(lEar.y - rEar.y, lEar.x - rEar.x) * DEG;
  out.push(m('headTilt', 'Head tilt', ht, '°', dirWord(ht, 'Left ear higher, head tilts to your right', 'Right ear higher, head tilts to your left'), 'Head sits level', { region: 'head' }));
  const fh = Math.atan2(ear.z - sh.z, ear.y - sh.y) * DEG;
  out.push(m('forwardHead', 'Forward head', fh, '°', fh >= 0 ? `Ear sits ${cm(ear.z - sh.z).toFixed(1)} cm in front of the shoulder joint` : 'Ear sits behind the shoulder joint', 'Ear sits close to over the shoulder', { region: 'head' }));
  if (S.head) {
    const hz = cm(S.head.centroid.z);
    out.push(m('headOverPlumb', 'Head over plumb line', hz, 'cm', `Centre of the head sits ${Math.abs(hz).toFixed(1)} cm ${hz >= 0 ? 'in front of' : 'behind'} the plumb line`, 'Head centred over the base of support', { region: 'head' }));
  }

  // Shoulders
  const sl = Math.atan2(lSh.y - rSh.y, lSh.x - rSh.x) * DEG;
  out.push(m('shoulderLevel', 'Shoulder level', sl, '°', `${sl >= 0 ? 'Left' : 'Right'} shoulder higher by ${cm(Math.abs(lSh.y - rSh.y)).toFixed(1)} cm`, 'Shoulders sit level', { region: 'shoulders' }));
  if (S.shoulders) {
    const a = S.shoulders.angle;
    out.push(m('shoulderRotation', 'Shoulder rotation', a, '°', `${a >= 0 ? 'Left' : 'Right'} shoulder sits further forward, upper body turned to your ${a >= 0 ? 'right' : 'left'}`, 'Shoulders square to your feet', { region: 'shoulders' }));
  }
  const sf = cm(sh.z - hp.z);
  out.push(m('shoulderForward', 'Shoulders over hips', sf, 'cm', sf >= 0 ? `Shoulder joints sit ${sf.toFixed(1)} cm in front of the hip joints` : `Shoulder joints sit ${(-sf).toFixed(1)} cm behind the hip joints (sway-back pattern)`, 'Shoulders stack over the hips', { region: 'shoulders' }));

  // Torso and spine
  const shift = Math.atan2(sh.x - hp.x, sh.y - hp.y) * DEG;
  out.push(m('trunkShift', 'Side shift of upper body', shift, '°', `Upper body shifts toward your ${shift >= 0 ? 'left' : 'right'}`, 'Upper body centred over the pelvis', { region: 'torso' }));
  const lean = Math.atan2(sh.z - hp.z, sh.y - hp.y) * DEG;
  out.push(m('trunkLean', 'Trunk lean', lean, '°', lean >= 0 ? 'Torso tips forward from the hips' : 'Torso tips backward from the hips', 'Torso upright over the hips', { region: 'torso' }));
  if (S.shoulders && S.hips) {
    const tw = S.shoulders.angle - S.hips.angle;
    out.push(m('trunkTwist', 'Trunk twist', tw, '°', `Shoulders turned ${Math.abs(tw).toFixed(1)}° to your ${tw >= 0 ? 'right' : 'left'} relative to the pelvis`, 'Shoulders and pelvis face the same way', { region: 'torso' }));
  }
  for (const k of ['chest', 'waist']) if (S[k]) {
    const d = S[k].leftPct - 50;
    out.push(m('torsoBalance', `${k === 'chest' ? 'Chest' : 'Waist'} left/right balance`, d, 'pts', `${S[k].leftPct.toFixed(1)}% of the ${k} section is on your left side`, `Section splits evenly, ${S[k].leftPct.toFixed(1)}% left`, { region: 'torso' }));
  }
  if (scan.curves) {
    out.push(m('thoracicDepth', 'Upper back curve', cm(scan.curves.thoracicDepth), 'cm', cm(scan.curves.thoracicDepth) > BANDS.thoracicDepth[2] ? 'Upper back rounds more than typical' : 'Upper back flatter than typical', 'Upper back curve in the typical range', { region: 'torso' }));
    out.push(m('lumbarDepth', 'Lower back curve', cm(scan.curves.lumbarDepth), 'cm', cm(scan.curves.lumbarDepth) > BANDS.lumbarDepth[2] ? 'Lower back arches more than typical' : 'Lower back flatter than typical', 'Lower back curve in the typical range', { region: 'torso' }));
  }

  // Hips and pelvis
  const pl = Math.atan2(lHip.y - rHip.y, lHip.x - rHip.x) * DEG;
  out.push(m('pelvicLevel', 'Hip level', pl, '°', `${pl >= 0 ? 'Left' : 'Right'} hip higher by ${cm(Math.abs(lHip.y - rHip.y)).toFixed(1)} cm`, 'Hips sit level', { region: 'hips' }));
  if (S.hips) {
    const a = S.hips.angle;
    out.push(m('pelvicRotation', 'Pelvis rotation', a, '°', `${a >= 0 ? 'Left' : 'Right'} hip sits further forward, pelvis turned to your ${a >= 0 ? 'right' : 'left'}`, 'Pelvis square to your feet', { region: 'hips' }));
  }
  const ps = cm(hp.z);
  out.push(m('pelvicShift', 'Hips over feet', ps, 'cm', ps >= 0 ? `Hip joints sit ${ps.toFixed(1)} cm in front of the plumb line` : `Hip joints sit ${(-ps).toFixed(1)} cm behind the plumb line`, 'Hips line up over the feet', { region: 'hips' }));

  // Knees and legs
  for (const [side, h, k, a] of [['Left', 23, 25, 27], ['Right', 24, 26, 28]]) {
    const dev = 180 - jointAngle(L[h], L[k], L[a], ['x', 'y']);
    const t = (L[k].y - L[h].y) / ((L[a].y - L[h].y) || 1e-6);
    const lineX = L[h].x + t * (L[a].x - L[h].x);
    const inward = Math.sign(L[k].x - lineX) === Math.sign(hp.x - L[k].x);
    out.push(m('kneeFrontal', `${side} knee alignment`, dev, '°', inward ? 'Knee drifts inward (knock-knee pattern)' : 'Knee bows outward (bow-leg pattern)', 'Hip, knee and ankle in a straight line', { region: 'knees' }));
  }
  const kmid = mid(L[25], L[26]), amid = mid(L[27], L[28]);
  const kdev = 180 - jointAngle(hp, kmid, amid, ['z', 'y']);
  const kt = (kmid.y - hp.y) / ((amid.y - hp.y) || 1e-6);
  const kBehind = kmid.z < hp.z + kt * (amid.z - hp.z);
  out.push(m('kneeSagittal', 'Knees from the side', kdev, '°', kBehind ? 'Knees push back past straight (hyperextension)' : 'Knees stay slightly bent', 'Knees straight without locking back', { region: 'knees' }));
  const legL = dist3(L[23], L[25]) + dist3(L[25], L[27]), legR = dist3(L[24], L[26]) + dist3(L[26], L[28]);
  const ld = cm(legL - legR);
  out.push(m('legLength', 'Leg length difference', ld, 'cm', `${ld >= 0 ? 'Left' : 'Right'} leg measures ${Math.abs(ld).toFixed(1)} cm longer, hip to ankle (apparent, from joint estimates)`, 'Legs measure about the same length', { region: 'knees' }));
  for (const [name, key] of [['Thigh', 'thigh'], ['Knee', 'knee'], ['Calf', 'calf']]) {
    const a = S[key + 'L'], b = S[key + 'R'];
    if (!a || !b) continue;
    const pct = ((a.girth - b.girth) / ((a.girth + b.girth) / 2)) * 100;
    out.push(m('girthAsym', `${name} girth, left vs right`, pct, '%', `Left ${cm(a.girth).toFixed(1)} cm, right ${cm(b.girth).toFixed(1)} cm`, `Left ${cm(a.girth).toFixed(1)} cm, right ${cm(b.girth).toFixed(1)} cm`, { region: 'knees' }));
  }

  // Feet and balance
  if (scan.com) {
    const cx = cm(scan.com.x), cz = cm(scan.com.z);
    out.push(m('comX', 'Weight, side to side', cx, 'cm', `Centre of mass sits ${Math.abs(cx).toFixed(1)} cm toward your ${cx >= 0 ? 'left' : 'right'} foot`, 'Weight centred between your feet', { region: 'ankles' }));
    out.push(m('comZ', 'Weight, front to back', cz, 'cm', `Centre of mass sits ${Math.abs(cz).toFixed(1)} cm ${cz >= 0 ? 'toward your toes' : 'toward your heels'}`, 'Weight centred over mid-foot', { region: 'ankles' }));
  }
  const a = S.ankleL, b = S.ankleR;
  if (a && b) {
    const pct = ((a.girth - b.girth) / ((a.girth + b.girth) / 2)) * 100;
    out.push(m('girthAsym', 'Ankle girth, left vs right', pct, '%', `Left ${cm(a.girth).toFixed(1)} cm, right ${cm(b.girth).toFixed(1)} cm`, `Left ${cm(a.girth).toFixed(1)} cm, right ${cm(b.girth).toFixed(1)} cm`, { region: 'ankles' }));
  }

  const ADVICE = {
    head: 'Measured from the 3D surface and joint centres, so head position is independent of camera angle.',
    shoulders: 'Rotation is measured from the shoulder cross-section against the line between your feet.',
    torso: 'Back curves come from the mid-line side section. They depend on body shape, so compare against your own earlier scans.',
    hips: 'Pelvis rotation comes from the hip cross-section. Stand with feet parallel and weight even for repeatable results.',
    knees: 'Girth differences under 3% are normal. Leg length uses estimated joint centres, so treat it as a hint.',
    ankles: 'Centre of mass is computed from the scanned body volume and compared with the midpoint between your feet.',
  };

  const regions = REGIONS.map((r) => {
    const ms = out.filter((x) => x.region === r.id);
    if (!ms.length) return { ...r, metrics: [], score: null, status: 'none', advice: ADVICE[r.id] };
    const score = Math.round(ms.reduce((s, x) => s + x.score, 0) / ms.length);
    const rank = { good: 0, mild: 1, notable: 2 };
    const worst = ms.reduce((w, x) => (rank[x.status] > rank[w] ? x.status : w), 'good');
    return { ...r, metrics: ms, score, status: worst, advice: ADVICE[r.id] };
  });
  const scored = regions.filter((r) => r.score != null);
  const overall = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null;
  return { regions, overall };
}

export const SECTION_NAMES = {
  head: 'Head (ear level)', neck: 'Neck', shoulders: 'Shoulders', chest: 'Chest', waist: 'Waist (narrowest)', hips: 'Hips (widest)',
  thighL: 'Left thigh', thighR: 'Right thigh', kneeL: 'Left knee', kneeR: 'Right knee',
  calfL: 'Left calf', calfR: 'Right calf', ankleL: 'Left ankle', ankleR: 'Right ankle',
};
