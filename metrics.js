// Postura alignment metrics.
// Pure functions: take MediaPipe Pose landmarks (normalized 0..1) plus image size,
// return per-metric measurements. No DOM access, so this file runs in Node for tests.

export const LM = {
  nose: 0, lEye: 2, rEye: 5, lEar: 7, rEar: 8,
  lShoulder: 11, rShoulder: 12, lHip: 23, rHip: 24,
  lKnee: 25, rKnee: 26, lAnkle: 27, rAnkle: 28,
  lHeel: 29, rHeel: 30, lFoot: 31, rFoot: 32,
};

const DEG = 180 / Math.PI;
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

// Convert normalized landmarks to pixel space so angles are not distorted by aspect ratio.
export function toPixels(landmarks, w, h) {
  return landmarks.map((l) => ({ x: l.x * w, y: l.y * h, v: l.visibility ?? 1 }));
}

// Standing height in pixels, estimated from eye line to heel line.
// Eyes sit about 6.4% of stature below the top of the head.
export function bodyHeightPx(p) {
  const eye = mid(p[LM.lEye], p[LM.rEye]);
  const heel = mid(p[LM.lHeel], p[LM.rHeel]);
  return Math.max(1, (heel.y - eye.y) / 0.936);
}

// Angle of the line from the person's right point to their left point.
// Positive means the person's LEFT side is higher (image y grows downward).
function levelAngle(right, left) {
  const dx = left.x - right.x;
  const dy = right.y - left.y;
  let a = Math.atan2(dy, Math.abs(dx)) * DEG;
  return a;
}

// Interior angle at b (degrees) formed by a-b-c.
function jointAngle(a, b, c) {
  const v1 = { x: a.x - b.x, y: a.y - b.y };
  const v2 = { x: c.x - b.x, y: c.y - b.y };
  const cos = (v1.x * v2.x + v1.y * v2.y) / (Math.hypot(v1.x, v1.y) * Math.hypot(v2.x, v2.y));
  return Math.acos(Math.min(1, Math.max(-1, cos))) * DEG;
}

// Signed horizontal distance of point k from the line a->c, measured at k's height.
function offsetFromLine(a, c, k) {
  const t = (k.y - a.y) / ((c.y - a.y) || 1e-6);
  const lx = a.x + t * (c.x - a.x);
  return k.x - lx;
}

// Thresholds: [typical, notable]. Below the first = typical, above the second = notable.
// These are screening heuristics drawn from common posture-assessment practice,
// widened to allow for the error of 2D pose estimation from a phone photo.
export const THRESHOLDS = {
  headTilt: [2.5, 5],
  forwardHead: [12, 22],
  shoulderLevel: [1.5, 3.5],
  shoulderForward: [2, 4],      // % of height
  trunkShift: [1.5, 3],
  trunkLean: [3, 6],
  pelvicLevel: [1.5, 3.5],
  pelvicShift: [2, 4],          // % of height
  kneeFrontal: [5, 10],
  kneeSagittal: [5, 10],
  weightShift: [1.5, 3],        // % of height
  shoulderRotation: [4, 8],     // from the photo's 3D estimate, so wider limits
  pelvicRotation: [4, 8],
  trunkTwist: [5, 10],
};

export function grade(value, key) {
  const [g, n] = THRESHOLDS[key];
  const v = Math.abs(value);
  let score;
  if (v <= g) score = 100 - 20 * (v / g);
  else if (v <= n) score = 80 - 30 * ((v - g) / (n - g));
  else score = Math.max(0, 50 - 25 * ((v - n) / n));
  const status = v <= g ? 'good' : v <= n ? 'mild' : 'notable';
  return { status, score: Math.round(score) };
}

const GOOD_TEXT = {
  headTilt: 'Head sits level',
  forwardHead: 'Ear sits close to over the shoulder',
  shoulderLevel: 'Shoulders sit level',
  shoulderForward: 'Shoulders stack over the hips',
  trunkShift: 'Upper body centred over the pelvis',
  trunkLean: 'Torso upright over the hips',
  pelvicLevel: 'Hips sit level',
  pelvicShift: 'Hips line up over the ankles',
  kneeFrontal: 'Hip, knee and ankle in a straight line',
  kneeSagittal: 'Knee straight without locking back',
  weightShift: 'Weight evenly centred between your feet',
  shoulderRotation: 'Shoulders square to the camera',
  pelvicRotation: 'Pelvis square to the camera',
  trunkTwist: 'Shoulders and pelvis face the same way',
};

function metric(key, label, value, unit, detail, extra = {}) {
  const g = grade(value, key);
  const text = g.status === 'good' ? GOOD_TEXT[key] : detail;
  return { key, label, value: Math.round(value * 10) / 10, unit, detail: text, ...g, ...extra };
}

const side = (v, pos, neg) => (Math.abs(v) < 0.05 ? 'level' : v > 0 ? pos : neg);

// view: 'front' | 'back'. In an unmirrored front photo the person's right is on image-left;
// in a back photo the person's right is on image-right.
export function frontalMetrics(p, view, heightCm) {
  const H = bodyHeightPx(p);
  const cm = (px) => (heightCm ? (px / H) * heightCm : null);
  const pct = (px) => (px / H) * 100;

  // Pick person-right / person-left by image position, not by model labels,
  // because the model can swap labels on a back view.
  const byX = (a, b) => (a.x <= b.x ? [a, b] : [b, a]);
  const orient = (pair) => {
    const [imgLeft, imgRight] = byX(pair[0], pair[1]);
    return view === 'front' ? { R: imgLeft, L: imgRight } : { R: imgRight, L: imgLeft };
  };

  const sh = orient([p[LM.lShoulder], p[LM.rShoulder]]);
  const hp = orient([p[LM.lHip], p[LM.rHip]]);
  const earsVisible = p[LM.lEar].v > 0.5 && p[LM.rEar].v > 0.5;
  const head = orient(earsVisible ? [p[LM.lEar], p[LM.rEar]] : [p[LM.lEye], p[LM.rEye]]);

  // For legs, keep each knee with the hip and ankle on the same image side.
  const legs = ['L', 'R'].map((s) => {
    const hip = hp[s];
    const knees = [p[LM.lKnee], p[LM.rKnee]];
    const ankles = [p[LM.lAnkle], p[LM.rAnkle]];
    const near = (arr) => arr.reduce((best, k) => (Math.abs(k.x - hip.x) < Math.abs(best.x - hip.x) ? k : best));
    return { s, hip, knee: near(knees), ankle: near(ankles) };
  });

  const out = [];
  const sign = view === 'front' ? 1 : -1; // +x in image = person's left (front) / right (back)

  const ht = levelAngle(head.R, head.L);
  out.push(metric('headTilt', 'Head tilt', ht, '°',
    side(ht, 'Tilted toward your right (left ear higher)', 'Tilted toward your left (right ear higher)'),
    { region: 'head', view, dir: ht }));

  const st = levelAngle(sh.R, sh.L);
  const sDiff = Math.abs(sh.L.y - sh.R.y);
  out.push(metric('shoulderLevel', 'Shoulder level', st, '°',
    side(st, 'Left shoulder higher', 'Right shoulder higher') +
      (cm(sDiff) != null ? ` by about ${cm(sDiff).toFixed(1)} cm` : ''),
    { region: 'shoulders', view, dir: st }));

  const pt = levelAngle(hp.R, hp.L);
  const pDiff = Math.abs(hp.L.y - hp.R.y);
  out.push(metric('pelvicLevel', 'Hip level', pt, '°',
    side(pt, 'Left hip higher', 'Right hip higher') +
      (cm(pDiff) != null ? ` by about ${cm(pDiff).toFixed(1)} cm` : ''),
    { region: 'hips', view, dir: pt }));

  const mS = mid(sh.L, sh.R), mH = mid(hp.L, hp.R);
  const shift = Math.atan2((mS.x - mH.x) * sign, mH.y - mS.y) * DEG; // + = toward person's left
  out.push(metric('trunkShift', 'Side shift of upper body', shift, '°',
    side(shift, 'Upper body leans toward your left', 'Upper body leans toward your right'),
    { region: 'torso', view, dir: shift }));

  for (const leg of legs) {
    const ang = jointAngle(leg.hip, leg.knee, leg.ankle);
    const dev = 180 - ang;
    const off = offsetFromLine(leg.hip, leg.ankle, leg.knee);
    const midX = mH.x;
    const towardMid = Math.sign(midX - leg.knee.x) === Math.sign(off) || Math.abs(off) < 0.5;
    const inward = towardMid; // knee displaced toward the midline = valgus
    const name = leg.s === 'L' ? 'Left' : 'Right';
    out.push(metric('kneeFrontal', `${name} knee alignment`, dev, '°',
      dev < 1 ? 'Straight line from hip to ankle' :
        inward ? 'Knee drifts inward (knock-knee pattern)' : 'Knee bows outward (bow-leg pattern)',
      { region: 'knees', view, leg: leg.s, signed: inward ? dev : -dev }));
  }

  if (view === 'front') {
    const lA = p[LM.lAnkle], rA = p[LM.rAnkle];
    const mA = mid(lA, rA);
    const ws = (mH.x - mA.x) * sign; // + = pelvis over the left foot
    out.push(metric('weightShift', 'Weight over feet', pct(ws), '% ht',
      side(ws, 'Pelvis sits over your left foot', 'Pelvis sits over your right foot') +
        (cm(Math.abs(ws)) != null ? ` (about ${cm(Math.abs(ws)).toFixed(1)} cm off centre)` : ''),
      { region: 'ankles', view, dir: ws }));
  }
  return out;
}

// Side view. Uses the leg and shoulder nearest the camera, and works whichever way the person faces.
export function sagittalMetrics(p, heightCm) {
  const H = bodyHeightPx(p);
  const cm = (px) => (heightCm ? (px / H) * heightCm : null);
  const pct = (px) => (px / H) * 100;

  const earMid = mid(p[LM.lEar], p[LM.rEar]);
  const facing = Math.sign(p[LM.nose].x - earMid.x) || 1; // +1 = facing image-right

  const vis = (ids) => ids.reduce((s, i) => s + p[i].v, 0);
  const leftNear = vis([LM.lEar, LM.lShoulder, LM.lHip, LM.lKnee, LM.lAnkle]) >=
    vis([LM.rEar, LM.rShoulder, LM.rHip, LM.rKnee, LM.rAnkle]);
  const E = leftNear ? p[LM.lEar] : p[LM.rEar];
  const S = leftNear ? p[LM.lShoulder] : p[LM.rShoulder];
  const Hp = leftNear ? p[LM.lHip] : p[LM.rHip];
  const K = leftNear ? p[LM.lKnee] : p[LM.rKnee];
  const A = leftNear ? p[LM.lAnkle] : p[LM.rAnkle];
  const fwd = (a, b) => (a.x - b.x) * facing; // + = a is in front of b

  const out = [];
  const fh = Math.atan2(fwd(E, S), S.y - E.y) * DEG;
  out.push(metric('forwardHead', 'Forward head', fh, '°',
    fh >= 0 ? `Ear sits ${cm(fwd(E, S)) != null ? `about ${cm(fwd(E, S)).toFixed(1)} cm ` : ''}in front of the shoulder`
      : 'Ear sits behind the shoulder',
    { region: 'head', view: 'side' }));

  const sf = pct(fwd(S, Hp));
  out.push(metric('shoulderForward', 'Shoulders over hips', sf, '% ht',
    sf >= 0 ? `Shoulders sit ${cm(fwd(S, Hp)) != null ? `about ${cm(fwd(S, Hp)).toFixed(1)} cm ` : ''}in front of the hips (rounded or forward posture)`
      : `Shoulders sit ${cm(-fwd(S, Hp)) != null ? `about ${cm(-fwd(S, Hp)).toFixed(1)} cm ` : ''}behind the hips (sway-back pattern)`,
    { region: 'shoulders', view: 'side' }));

  const lean = Math.atan2(fwd(S, Hp), Hp.y - S.y) * DEG;
  out.push(metric('trunkLean', 'Trunk lean', lean, '°',
    lean >= 0 ? 'Torso tips forward from the hips' : 'Torso tips backward from the hips',
    { region: 'torso', view: 'side' }));

  // Plumb reference: a vertical just in front of the ankle bone.
  const plumbX = A.x + facing * 0.012 * H;
  const ps = pct((Hp.x - plumbX) * facing);
  out.push(metric('pelvicShift', 'Hips over ankles', ps, '% ht',
    ps >= 0 ? 'Hips push forward of the plumb line' : 'Hips sit behind the plumb line',
    { region: 'hips', view: 'side' }));

  const kAng = jointAngle(Hp, K, A);
  const kOff = offsetFromLine(Hp, A, K) * facing; // + = knee in front of hip-ankle line (bent)
  const kDev = 180 - kAng;
  out.push(metric('kneeSagittal', `${leftNear ? 'Left' : 'Right'} knee (side)`, kDev, '°',
    kDev < 1 ? 'Knee straight, not locked' :
      kOff < 0 ? 'Knee pushes back past straight (hyperextension)' : 'Knee stays slightly bent',
    { region: 'knees', view: 'side', signed: kOff < 0 ? -kDev : kDev }));

  return { metrics: out, plumb: { x: plumbX, facing, nearLeft: leftNear } };
}

// Front and back photos measure the same things. Average them into one reading,
// keeping both raw values so the report can show how well the two photos agree.
function mergeFrontBack(list) {
  const groups = new Map();
  for (const m of list) {
    const id = m.key + (m.leg || '');
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(m);
  }
  const out = [];
  for (const ms of groups.values()) {
    if (ms.length === 1) { out.push(ms[0]); continue; }
    const sv = (m) => (m.signed ?? m.value);
    const avg = ms.reduce((s, m) => s + sv(m), 0) / ms.length;
    const pick = ms.find((m) => Math.sign(sv(m)) === Math.sign(avg)) || ms[0];
    const g = grade(avg, pick.key);
    out.push({
      ...pick, ...g,
      value: Math.round((pick.signed != null ? Math.abs(avg) : avg) * 10) / 10,
      signed: pick.signed != null ? avg : undefined,
      detail: g.status === 'good' ? GOOD_TEXT[pick.key] : pick.detail,
      view: 'frontback',
      perView: ms.map((m) => ({ view: m.view, value: Math.abs(m.value) })),
    });
  }
  return out;
}

export const REGIONS = [
  { id: 'head', name: 'Head and neck' },
  { id: 'shoulders', name: 'Shoulders' },
  { id: 'torso', name: 'Torso and spine' },
  { id: 'hips', name: 'Hips and pelvis' },
  { id: 'knees', name: 'Knees' },
  { id: 'ankles', name: 'Feet and balance' },
];

const ADVICE = {
  head: 'Forward head is very common with screen use. Chin tucks and checking screen height are typical starting points.',
  shoulders: 'Uneven or forward shoulders often relate to carrying habits, desk setup, and chest or upper-back tightness.',
  torso: 'A sideways or forward trunk lean can come from habit, a leg-length difference, or how you stand on the day.',
  hips: 'Hip height and hip position are affected by stance. Stand evenly on both feet and rescan to confirm.',
  knees: 'Knee angles from photos are approximate. Loose trousers and foot position change them by several degrees.',
  ankles: 'This shows where your weight sits over your feet while standing relaxed.',
};

// Combine front, back and side measurements into region summaries.
// Rotation from MediaPipe world landmarks of the front photo (metres; x to image right, z toward
// the camera is negative). Positive = the person's left side is further forward.
export function rotationMetrics(world) {
  const rot = (l, r) => Math.atan2(-(world[l].z - world[r].z), world[l].x - world[r].x) * DEG;
  const sr = rot(LM.lShoulder, LM.rShoulder), pr = rot(LM.lHip, LM.rHip);
  const tw = sr - pr;
  const dir = (v, what) => `${v >= 0 ? 'Left' : 'Right'} ${what} further forward`;
  return [
    metric('shoulderRotation', 'Shoulder rotation', sr, '°', dir(sr, 'shoulder'), { region: 'shoulders', view: 'est3d' }),
    metric('pelvicRotation', 'Pelvis rotation', pr, '°', dir(pr, 'hip'), { region: 'hips', view: 'est3d' }),
    metric('trunkTwist', 'Trunk twist', tw, '°', `Shoulders turned to your ${tw >= 0 ? 'right' : 'left'} relative to the pelvis`, { region: 'torso', view: 'est3d' }),
  ];
}

export function buildReport(views, heightCm, world) {
  const all = [];
  const frontal = [];
  for (const v of ['front', 'back']) if (views[v]) frontal.push(...frontalMetrics(views[v], v, heightCm));
  all.push(...mergeFrontBack(frontal));
  if (world && world.length === 33) all.push(...rotationMetrics(world));
  let plumb = null;
  if (views.side) { const s = sagittalMetrics(views.side, heightCm); all.push(...s.metrics); plumb = s.plumb; }

  const regions = REGIONS.map((r) => {
    const ms = all.filter((m) => m.region === r.id);
    if (!ms.length) return { ...r, metrics: [], score: null, status: 'none', advice: ADVICE[r.id] };
    const score = Math.round(ms.reduce((s, m) => s + m.score, 0) / ms.length);
    const rank = { good: 0, mild: 1, notable: 2 };
    const worst = ms.reduce((w, m) => (rank[m.status] > rank[w] ? m.status : w), 'good');
    return { ...r, metrics: ms, score, status: worst, advice: ADVICE[r.id] };
  });
  const scored = regions.filter((r) => r.score != null);
  const overall = scored.length ? Math.round(scored.reduce((s, r) => s + r.score, 0) / scored.length) : null;
  return { regions, overall, plumb };
}

// Photo quality checks before a capture is accepted.
export function checkPose(landmarks, view) {
  const issues = [];
  if (!landmarks) return { ok: false, issues: ['No person found. Make sure your whole body is in the frame and well lit.'] };
  const need = [LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip, LM.lKnee, LM.rKnee, LM.lAnkle, LM.rAnkle];
  const inFrame = landmarks.every((l, i) => i > 10 && i < 29 ? (l.y > 0.0 && l.y < 1.0 && l.x > 0 && l.x < 1) : true);
  if (!inFrame) issues.push('Part of your body is cut off. Step back until head to feet fit in the frame.');
  const top = Math.min(landmarks[LM.nose].y, landmarks[LM.lEye].y, landmarks[LM.rEye].y);
  const bottom = Math.max(landmarks[LM.lHeel].y, landmarks[LM.rHeel].y);
  if (bottom - top < 0.45) issues.push('You look small in the frame. Move a little closer so your body fills most of the height.');
  if (view !== 'side') {
    const low = need.filter((i) => (landmarks[i].visibility ?? 1) < 0.5);
    if (low.length > 2) issues.push('Some joints are hard to see. Wear fitted clothing and stand against a plain background.');
    const sw = Math.abs(landmarks[LM.lShoulder].x - landmarks[LM.rShoulder].x);
    const tl = Math.abs(mid(landmarks[LM.lHip], landmarks[LM.rHip]).y - mid(landmarks[LM.lShoulder], landmarks[LM.rShoulder]).y);
    if (sw / (tl || 1) < 0.35) issues.push(`You seem turned. Square your body ${view === 'front' ? 'to face' : 'with your back to'} the camera.`);
  } else {
    const sw = Math.abs(landmarks[LM.lShoulder].x - landmarks[LM.rShoulder].x);
    const tl = Math.abs(mid(landmarks[LM.lHip], landmarks[LM.rHip]).y - mid(landmarks[LM.lShoulder], landmarks[LM.rShoulder]).y);
    if (sw / (tl || 1) > 0.3) issues.push('Turn a full 90° so your side faces the camera.');
  }
  return { ok: issues.length === 0, issues };
}
