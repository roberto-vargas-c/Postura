import { toPixels, buildReport, checkPose, LM, REGIONS, THRESHOLDS } from './metrics.js';
import { exampleViews } from './example.js';
import { build3dReport } from './metrics3d.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const VIEWS = ['front', 'side', 'back'];
const VIEW_INFO = {
  front: {
    title: 'Front photo',
    lines: [
      'Face the camera, feet hip-width apart, toes pointing forward.',
      'Let your arms hang relaxed, a little away from your sides.',
      'Look straight ahead and breathe out normally. Do not try to stand "perfectly".',
    ],
  },
  side: {
    title: 'Side photo',
    lines: [
      'Turn 90° so your left or right side faces the camera.',
      'Keep your feet where they were and arms relaxed by your sides.',
      'Tie back long hair so your ear is visible.',
    ],
  },
  back: {
    title: 'Back photo',
    lines: [
      'Turn so your back faces the camera.',
      'Keep the same relaxed stance, feet hip-width apart.',
      'Arms hang a little away from your sides so your waist is visible.',
    ],
  },
};

const STATUS_LABEL = { good: 'Typical', mild: 'Slight', notable: 'Notable', none: 'Not measured' };
const STORE_KEY = 'plumbline.scans.v1';

const state = {
  heightCm: null,
  step: 0,
  captures: {}, // view -> { landmarks, w, h, image (dataURL) }
  pending: null,
  landmarker: null,
  mode: 'IMAGE',
  live: null,
  voice: false,
};

// ---------- Model ----------
let loadingPromise = null;
async function getLandmarker() {
  if (state.landmarker) return state.landmarker;
  if (!loadingPromise) {
    loadingPromise = (async () => {
      const { FilesetResolver, PoseLandmarker } = await import('./vendor/vision_bundle.mjs');
      const base = new URL('./wasm', location.href).href;
      const fileset = await FilesetResolver.forVisionTasks(base);
      // The model file carries a .wasm suffix only so static hosts serve it; it is a MediaPipe .task bundle.
      const resp = await fetch(new URL('./models/pose_landmarker_full.task.wasm', location.href).href);
      if (!resp.ok) throw new Error('model fetch failed');
      const model = new Uint8Array(await resp.arrayBuffer());
      const opts = (delegate) => ({
        baseOptions: { modelAssetBuffer: model, delegate },
        runningMode: 'IMAGE',
        numPoses: 1,
        minPoseDetectionConfidence: 0.5,
      });
      let lm;
      try { lm = await PoseLandmarker.createFromOptions(fileset, opts('GPU')); }
      catch { lm = await PoseLandmarker.createFromOptions(fileset, opts('CPU')); }
      state.landmarker = lm;
      state.mode = 'IMAGE';
      return lm;
    })().catch((e) => { loadingPromise = null; throw e; });
  }
  return loadingPromise;
}

async function setMode(mode) {
  const lm = await getLandmarker();
  if (state.mode !== mode) { await lm.setOptions({ runningMode: mode }); state.mode = mode; }
  return lm;
}

// ---------- Screens ----------
function show(id) {
  $$('.screen').forEach((s) => { s.hidden = s.id !== id; });
  const stepIdx = { home: 0, prep: 0, capture: state.step + 1, analyzing: 4, report: 4 }[id] ?? 0;
  $$('#steps li').forEach((li, i) => {
    li.classList.toggle('done', i < stepIdx);
    li.classList.toggle('current', i === stepIdx);
  });
  $('#steps').hidden = !['prep', 'capture', 'analyzing', 'report'].includes(id);
  const section = id === 'scans' ? 'scans' : (id === 'report' || id === 'report3d') ? 'report' : 'scan';
  $$('#tabs .tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.go === section)));
  document.body.classList.toggle('focus', ['capture', 'analyzing', 'processing3d'].includes(id));
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 3200);
}

// ---------- Home ----------
function initHome() {
  const agree = $('#agree');
  const start = $('#start');
  const sync = () => { start.disabled = !agree.checked; $('#start3d').disabled = !agree.checked; $('#import3d-open').disabled = !agree.checked; };
  agree.addEventListener('change', sync);
  sync();
  start.addEventListener('click', () => {
    const h = parseFloat($('#height').value);
    state.heightCm = h >= 100 && h <= 230 ? h : null;
    state.captures = {};
    state.step = 0;
    show('prep');
    getLandmarker().catch(() => {}); // start downloading the model while they read
  });
  $('#example').addEventListener('click', showExample);
  $('#prep-go').addEventListener('click', () => openCapture(0));
  $('#prep-back').addEventListener('click', () => show('home'));
  renderHistory();
}

// ---------- Capture ----------
function openCapture(i) {
  state.step = i;
  const view = VIEWS[i];
  const info = VIEW_INFO[view];
  $('#cap-count').textContent = `Photo ${i + 1} of 3`;
  $('#cap-title').textContent = info.title;
  $('#cap-lines').innerHTML = info.lines.map((l) => `<li>${l}</li>`).join('');
  $$('.guide-fig').forEach((f) => { f.hidden = f.dataset.view !== view; });
  $('#cap-choose').hidden = false;
  $('#cap-review').hidden = true;
  $('#cap-live').hidden = true;
  $('#cap-back').textContent = i === 0 ? 'Back to setup' : 'Previous photo';
  show('capture');
}

async function handleFile(file) {
  if (!file) return;
  const view = VIEWS[state.step];
  setBusy(true, 'Finding your joints…');
  try {
    const img = await loadImage(file);
    const canvas = imageToCanvas(img, 1600);
    await analyzeCanvas(canvas, view);
  } catch (e) {
    console.error(e);
    toast(modelError(e));
  } finally {
    setBusy(false);
  }
}

function modelError(e) {
  const msg = String(e && (e.message || e));
  if (/fetch|network|wasm|load/i.test(msg)) return 'The pose model could not load. Check your connection and try again.';
  return 'That photo could not be read. Try another one.';
}

function loadImage(file) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { res(img); setTimeout(() => URL.revokeObjectURL(url), 1000); };
    img.onerror = () => rej(new Error('image decode failed'));
    img.src = url;
  });
}

function imageToCanvas(src, maxSide) {
  const w0 = src.naturalWidth || src.videoWidth || src.width;
  const h0 = src.naturalHeight || src.videoHeight || src.height;
  const k = Math.min(1, maxSide / Math.max(w0, h0));
  const c = document.createElement('canvas');
  c.width = Math.round(w0 * k);
  c.height = Math.round(h0 * k);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c;
}

async function analyzeCanvas(canvas, view) {
  const lm = await setMode('IMAGE');
  const res = lm.detect(canvas);
  const landmarks = res.landmarks && res.landmarks[0] ? res.landmarks[0].map((l) => ({ x: l.x, y: l.y, z: l.z, visibility: l.visibility })) : null;
  const check = checkPose(landmarks, view);
  const image = canvas.toDataURL('image/jpeg', 0.82);
  const world = res.worldLandmarks && res.worldLandmarks[0] ? res.worldLandmarks[0].map((l) => ({ x: l.x, y: l.y, z: l.z })) : null;
  state.pending = { view, landmarks, world, w: canvas.width, h: canvas.height, image, check };
  renderReview();
}

function renderReview() {
  const p = state.pending;
  $('#cap-choose').hidden = true;
  $('#cap-live').hidden = true;
  $('#cap-review').hidden = false;
  const c = $('#review-canvas');
  const img = new Image();
  img.onload = () => {
    c.width = p.w; c.height = p.h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0);
    if (p.landmarks) drawSkeleton(ctx, toPixels(p.landmarks, p.w, p.h), p.w);
  };
  img.src = p.image;
  const box = $('#review-issues');
  if (p.check.ok) {
    box.className = 'issues ok';
    box.innerHTML = '<p><strong>Looks good.</strong> All the joints we need are visible.</p>';
  } else {
    box.className = 'issues warn';
    box.innerHTML = `<p><strong>${p.landmarks ? 'Check this photo' : 'No body found'}</strong></p><ul>${p.check.issues.map((i) => `<li>${i}</li>`).join('')}</ul>`;
  }
  $('#review-use').disabled = !p.landmarks;
  $('#review-use').textContent = p.check.ok ? 'Use this photo' : 'Use it anyway';
}

function acceptPending() {
  const p = state.pending;
  if (!p || !p.landmarks) return;
  state.captures[p.view] = p;
  state.pending = null;
  if (state.step < VIEWS.length - 1) openCapture(state.step + 1);
  else finishScan();
}

function setBusy(on, msg) {
  $('#busy').hidden = !on;
  if (msg) $('#busy-msg').textContent = msg;
}

// ---------- Live camera guidance ----------
async function startLive() {
  const view = VIEWS[state.step];
  setBusy(true, 'Loading pose model…');
  try {
    await getLandmarker();
  } catch (e) { setBusy(false); toast(modelError(e)); return; }
  setBusy(true, 'Starting camera…');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: state.live?.facing || 'user', width: { ideal: 1280 }, height: { ideal: 1920 } },
      audio: false,
    });
  } catch (e) {
    setBusy(false);
    toast('The camera is not available here. Use "Take photo" instead.');
    $('#live-btn').hidden = true;
    return;
  }
  setBusy(false);
  const video = $('#live-video');
  video.srcObject = stream;
  await video.play().catch(() => {});
  const facing = stream.getVideoTracks()[0].getSettings().facingMode || state.live?.facing || 'user';
  state.live = { stream, facing, okSince: 0, countdownStart: 0, prev: null, lastSpoken: '', lastSpokenAt: 0, raf: 0, view };
  $('#cap-choose').hidden = true;
  $('#cap-live').hidden = false;
  $('#live-stage').classList.toggle('mirror', facing === 'user');
  try { state.live.wake = await navigator.wakeLock?.request('screen'); } catch {}
  await setMode('VIDEO');
  loopLive();
}

function stopLive() {
  const L = state.live;
  if (!L) return;
  cancelAnimationFrame(L.raf);
  L.stream?.getTracks().forEach((t) => t.stop());
  try { L.wake?.release(); } catch {}
  state.live = { facing: L.facing };
  if ('speechSynthesis' in window) speechSynthesis.cancel();
}

function speak(msg) {
  const L = state.live;
  if (!state.voice || !('speechSynthesis' in window) || !L) return;
  const now = performance.now();
  if (msg === L.lastSpoken && now - L.lastSpokenAt < 6000) return;
  if (now - L.lastSpokenAt < 2200) return;
  L.lastSpoken = msg; L.lastSpokenAt = now;
  speechSynthesis.cancel();
  speechSynthesis.speak(new SpeechSynthesisUtterance(msg));
}

function loopLive() {
  const L = state.live;
  const video = $('#live-video');
  const canvas = $('#live-overlay');
  const tick = () => {
    if (!state.live || state.live !== L || !L.stream) return;
    if (video.readyState >= 2 && video.videoWidth) {
      if (canvas.width !== video.videoWidth) { canvas.width = video.videoWidth; canvas.height = video.videoHeight; }
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const res = state.landmarker.detectForVideo(video, performance.now());
      const lms = res.landmarks && res.landmarks[0];
      const chk = checkPose(lms ? lms.map((l) => ({ ...l })) : null, L.view);
      let msg; let tone = 'warn';
      if (lms) drawSkeleton(ctx, toPixels(lms, canvas.width, canvas.height), canvas.width, chk.ok ? 'ok' : 'warn');
      if (chk.ok) {
        const moving = L.prev && lms ? avgMove(L.prev, lms) > 0.006 : true;
        if (moving) { L.okSince = 0; L.countdownStart = 0; msg = 'Hold still'; }
        else {
          if (!L.okSince) L.okSince = performance.now();
          if (performance.now() - L.okSince > 700 && !L.countdownStart) L.countdownStart = performance.now();
          if (L.countdownStart) {
            const left = 3 - Math.floor((performance.now() - L.countdownStart) / 1000);
            if (left <= 0) { captureLive(); return; }
            msg = `Hold still… ${left}`; tone = 'ok';
          } else msg = 'Good, hold still';
        }
      } else {
        L.okSince = 0; L.countdownStart = 0;
        msg = shortIssue(chk.issues[0], L.view);
      }
      if (lms) L.prev = lms;
      const pill = $('#live-status');
      pill.textContent = msg;
      pill.dataset.tone = tone;
      speak(msg.replace(/…\s*\d$/, '').replace(/\d$/, ''));
    }
    L.raf = requestAnimationFrame(tick);
  };
  L.raf = requestAnimationFrame(tick);
}

function shortIssue(issue, view) {
  if (!issue) return 'Step into the frame';
  if (/No person/.test(issue)) return 'Step into the frame';
  if (/cut off/.test(issue)) return 'Step back, head to feet in frame';
  if (/small/.test(issue)) return 'Come a little closer';
  if (/turned/.test(issue)) return view === 'front' ? 'Face the camera' : 'Turn your back to the camera';
  if (/90°/.test(issue)) return 'Turn sideways';
  if (/hard to see/.test(issue)) return 'Joints hard to see, improve the light';
  return issue;
}

function avgMove(a, b) {
  let s = 0; const ids = [LM.nose, LM.lShoulder, LM.rShoulder, LM.lHip, LM.rHip, LM.lAnkle, LM.rAnkle];
  for (const i of ids) s += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return s / ids.length;
}

async function captureLive() {
  const video = $('#live-video');
  const canvas = imageToCanvas(video, 1600);
  const view = state.live.view;
  stopLive();
  flash();
  setBusy(true, 'Finding your joints…');
  try { await analyzeCanvas(canvas, view); }
  catch (e) { toast(modelError(e)); }
  finally { setBusy(false); }
}

function flash() {
  const f = $('#flash');
  f.hidden = false;
  f.classList.remove('go'); void f.offsetWidth; f.classList.add('go');
  setTimeout(() => { f.hidden = true; }, 450);
}

// ---------- Drawing ----------
const BONES = [
  [11, 12], [11, 23], [12, 24], [23, 24], [11, 13], [13, 15], [12, 14], [14, 16],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [28, 30], [29, 31], [30, 32], [27, 31], [28, 32],
];

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

function drawSkeleton(ctx, p, w, tone) {
  const lw = Math.max(2, w / 260);
  ctx.save();
  ctx.lineCap = 'round';
  ctx.strokeStyle = tone === 'warn' ? 'rgba(255,196,80,.9)' : 'rgba(120,240,205,.95)';
  ctx.lineWidth = lw;
  for (const [a, b] of BONES) {
    if (p[a].v < 0.3 || p[b].v < 0.3) continue;
    ctx.beginPath(); ctx.moveTo(p[a].x, p[a].y); ctx.lineTo(p[b].x, p[b].y); ctx.stroke();
  }
  ctx.fillStyle = '#fff';
  for (const i of [0, 7, 8, 11, 12, 23, 24, 25, 26, 27, 28]) {
    if (p[i].v < 0.3) continue;
    ctx.beginPath(); ctx.arc(p[i].x, p[i].y, lw * 1.4, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}

const STATUS_RGB = { good: '#7FB37E', mild: '#E0A64B', notable: '#EE6D58' };

function statusFor(report, key, view) {
  for (const r of report.regions) for (const m of r.metrics) if (m.key === key && (m.view === view || (m.view === 'frontback' && view !== 'side'))) return m.status;
  return 'good';
}

// Render the annotated analysis image for one view; returns a dataURL.
function annotatedImage(capIn, view, report) {
  let cap = capIn;
  return new Promise((resolve) => {
    const img = new Image();
    const draw = () => {
      const c = document.createElement('canvas');
      c.width = cap.w; c.height = cap.h;
      const ctx = c.getContext('2d');
      if (cap.image) ctx.drawImage(img, 0, 0);
      else { ctx.fillStyle = '#1E2621'; ctx.fillRect(0, 0, c.width, c.height); drawGrid(ctx, c.width, c.height); }
      ctx.fillStyle = 'rgba(10,18,16,.28)';
      ctx.fillRect(0, 0, c.width, c.height);
      const p = toPixels(cap.landmarks, cap.w, cap.h);
      drawSkeleton(ctx, p, cap.w);
      const lw = Math.max(3, cap.w / 180);
      const line = (a, b, color, dash) => {
        ctx.save(); ctx.strokeStyle = color; ctx.lineWidth = lw; if (dash) ctx.setLineDash(dash);
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.restore();
      };
      const extend = (a, b, k) => {
        const dx = b.x - a.x, dy = b.y - a.y;
        return [{ x: a.x - dx * k, y: a.y - dy * k }, { x: b.x + dx * k, y: b.y + dy * k }];
      };
      if (view === 'front' || view === 'back') {
        const pairs = [[11, 12, 'shoulderLevel'], [23, 24, 'pelvicLevel'], [7, 8, 'headTilt']];
        for (const [a, b, key] of pairs) {
          const [e1, e2] = extend(p[a], p[b], 0.35);
          const y0 = (p[a].y + p[b].y) / 2;
          line({ x: e1.x, y: y0 }, { x: e2.x, y: y0 }, 'rgba(255,255,255,.55)', [lw * 2, lw * 2]);
          line(e1, e2, STATUS_RGB[statusFor(report, key, view)]);
        }
        const mA = { x: (p[27].x + p[28].x) / 2, y: (p[29].y + p[30].y) / 2 };
        line(mA, { x: mA.x, y: Math.max(0, p[0].y - cap.h * 0.08) }, 'rgba(255,255,255,.6)', [lw * 2, lw * 2]);
        const mS = { x: (p[11].x + p[12].x) / 2, y: (p[11].y + p[12].y) / 2 };
        const mH = { x: (p[23].x + p[24].x) / 2, y: (p[23].y + p[24].y) / 2 };
        line(mH, mS, STATUS_RGB[statusFor(report, 'trunkShift', view)]);
      } else {
        const pl = report.plumb;
        if (pl) {
          line({ x: pl.x, y: cap.h }, { x: pl.x, y: 0 }, '#E0A64B', [lw * 3, lw * 1.5]);
          const n = pl.nearLeft;
          const pts = (n ? [7, 11, 23, 25, 27] : [8, 12, 24, 26, 28]).map((i) => p[i]);
          ctx.save(); ctx.strokeStyle = '#fff'; ctx.lineWidth = lw * 0.8; ctx.beginPath();
          pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y))); ctx.stroke(); ctx.restore();
          const keys = ['forwardHead', 'shoulderForward', 'pelvicShift', 'kneeSagittal', null];
          pts.forEach((q, i) => {
            ctx.fillStyle = keys[i] ? STATUS_RGB[statusFor(report, keys[i], 'side')] : '#fff';
            ctx.beginPath(); ctx.arc(q.x, q.y, lw * 2.2, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
          });
        }
      }
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    if (!cap.image) { draw(); return; }
    img.onload = draw;
    img.onerror = () => { cap = { ...cap, image: null }; draw(); };
    img.src = cap.image;
  });
}

function drawGrid(ctx, w, h) {
  ctx.strokeStyle = 'rgba(255,255,255,.06)'; ctx.lineWidth = 1;
  for (let x = 0; x < w; x += w / 12) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += w / 12) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
}

// ---------- Report ----------
async function finishScan() {
  show('analyzing');
  await new Promise((r) => setTimeout(r, 60));
  const px = {};
  for (const v of VIEWS) if (state.captures[v]) px[v] = toPixels(state.captures[v].landmarks, state.captures[v].w, state.captures[v].h);
  const report = buildReport(px, state.heightCm, state.captures.front?.world);
  const scan = {
    id: Date.now(),
    date: new Date().toISOString(),
    heightCm: state.heightCm,
    overall: report.overall,
    regions: report.regions.map((r) => ({ id: r.id, score: r.score, status: r.status })),
    captures: {},
  };
  for (const v of VIEWS) {
    const c = state.captures[v];
    if (c) scan.captures[v] = { landmarks: c.landmarks, world: c.world, w: c.w, h: c.h, image: c.image };
  }
  const prev = loadHistory().find((s) => s.type !== '3d') || null;
  await renderReport(scan, report, prev, false);
  saveScan(scan);
  show('report');
}

async function showExample() {
  const views = exampleViews();
  const scan = { id: 0, date: new Date().toISOString(), heightCm: 175, example: true, captures: {} };
  for (const v of VIEWS) scan.captures[v] = { landmarks: views[v], w: 900, h: 1200, image: null };
  const px = {};
  for (const v of VIEWS) px[v] = toPixels(views[v], 900, 1200);
  const report = buildReport(px, 175);
  scan.overall = report.overall;
  scan.regions = report.regions.map((r) => ({ id: r.id, score: r.score, status: r.status }));
  await renderReport(scan, report, null, true);
  show('report');
}

async function openSaved(id) {
  const scan = loadHistory().find((s) => s.id === id);
  if (!scan) return;
  if (scan.type === '3d') return open3dSaved(scan);
  const px = {};
  for (const v of VIEWS) if (scan.captures?.[v]) px[v] = toPixels(scan.captures[v].landmarks, scan.captures[v].w, scan.captures[v].h);
  const report = buildReport(px, scan.heightCm, scan.captures?.front?.world);
  const hist = loadHistory().filter((s) => s.type !== '3d');
  const prev = hist[hist.findIndex((s) => s.id === id) + 1] || null;
  await renderReport(scan, report, prev, false);
  show('report');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return iso; }
}

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

const VIEW_TAG = { front: 'Front', back: 'Back', side: 'Side', frontback: 'Front + back', est3d: '3D estimate' };

function metricRow(m) {
  const [g, n] = THRESHOLDS[m.key];
  const unit = m.unit === '% ht' ? '% of height' : m.unit;
  const max = n * 2;
  const pos = Math.min(100, (Math.abs(m.value) / max) * 100);
  return `<li class="metric">
    <div class="m-head"><span class="m-label">${esc(m.label)}</span><span class="tag">${VIEW_TAG[m.view]}</span>
      <span class="m-val ${m.status}">${Math.abs(m.value).toFixed(1)}<small>${m.unit === '°' ? '°' : '%'}</small></span></div>
    <div class="scale" aria-hidden="true"><span class="z-good" style="width:${(g / max) * 100}%"></span><span class="z-mild" style="width:${((n - g) / max) * 100}%"></span><span class="z-notable"></span><i style="left:${pos}%"></i></div>
    <p class="m-detail">${esc(m.detail)}</p>
    ${m.perView ? `<p class="m-range">Front ${m.perView.find((q) => q.view === 'front').value.toFixed(1)}${m.unit === '°' ? '°' : '%'} · back ${m.perView.find((q) => q.view === 'back').value.toFixed(1)}${m.unit === '°' ? '°' : '%'}, averaged</p>` : ''}
    <p class="m-range">Typical up to ${g}${m.unit === '°' ? '°' : '%'} · notable above ${n}${m.unit === '°' ? '°' : '%'}${m.unit === '% ht' ? ' of height' : ''}</p>
  </li>`;
}

async function renderReport(scan, report, prev, isExample) {
  const imgs = {};
  for (const v of VIEWS) if (scan.captures[v]) imgs[v] = await annotatedImage(scan.captures[v], v, report);
  const prevMap = prev ? Object.fromEntries(prev.regions.map((r) => [r.id, r.score])) : {};
  const counts = { good: 0, mild: 0, notable: 0 };
  report.regions.forEach((r) => { if (counts[r.status] != null) counts[r.status]++; });
  const delta = (id, s) => {
    if (prevMap[id] == null || s == null) return '';
    const d = s - prevMap[id];
    if (Math.abs(d) < 2) return '<span class="delta">same as last scan</span>';
    return `<span class="delta ${d > 0 ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d} since last scan</span>`;
  };

  const top = report.regions.filter((r) => r.status === 'notable' || r.status === 'mild')
    .sort((a, b) => a.score - b.score).slice(0, 2);

  const html = `
  ${isExample ? '<div class="example-flag">Example report. These numbers come from a made-up person, not from you.</div>' : ''}
  <header class="r-head">
    <div class="r-title">
      <p class="eyebrow">Alignment report</p>
      <h2>${scoreWord(report.overall)}</h2>
      <p class="r-meta">${fmtDate(scan.date)}${scan.heightCm ? ` · height ${scan.heightCm} cm` : ' · no height given, distances shown as % of height'}</p>
      <ul class="r-counts">
        <li><b class="dot good"></b>${counts.good} typical</li>
        <li><b class="dot mild"></b>${counts.mild} slight</li>
        <li><b class="dot notable"></b>${counts.notable} notable</li>
      </ul>
      ${top.length ? `<p class="r-focus">Biggest differences: ${top.map((r) => `<strong>${r.name.toLowerCase()}</strong>`).join(' and ')}.</p>` : '<p class="r-focus">Every region measured within the typical range.</p>'}
    </div>
    ${gauge(report.overall)}
  </header>
  <p class="disclaimer"><strong>Not a medical device.</strong> Postura is for general wellness and education. It does not diagnose, treat or prevent any condition. Measurements from phone photos are approximate, and clothing, camera angle and how you stand on the day can shift them by several degrees. If you have pain, numbness, or a concern about your posture, see a physiotherapist or doctor.</p>

  <section class="regions">
    ${report.regions.map((r) => `
      <article class="region ${r.status}">
        <header>
          <h3>${r.name}</h3>
          <span class="chip ${r.status}">${STATUS_LABEL[r.status]}</span>
        </header>
        ${r.score != null ? `<div class="r-score"><span class="num">${r.score}</span><span class="bar"><i style="width:${r.score}%"></i></span>${delta(r.id, r.score)}</div>` : ''}
        <ul class="metrics">${r.metrics.map(metricRow).join('') || '<li class="m-detail">Not measured in this scan.</li>'}</ul>
        <p class="advice">${esc(r.advice)}</p>
      </article>`).join('')}
  </section>

  <section class="photos">
    <h3>What was measured</h3>
    <p class="muted">Coloured lines follow the same scale as the report: green typical, amber slight, red notable. Dashed lines are level and plumb references. On the side view the gold line is the plumb line.</p>
    <div class="photo-grid">
      ${VIEWS.filter((v) => imgs[v]).map((v) => `<figure><img src="${imgs[v]}" alt="${VIEW_TAG[v]} view with joint markers and alignment lines"><figcaption>${VIEW_TAG[v]}</figcaption></figure>`).join('')}
    </div>
  </section>

  <section class="howto">
    <h3>Getting a reliable result</h3>
    <ul>
      <li>Repeat the scan on two or three different days. Trust patterns that show up every time, not a single reading.</li>
      <li>Keep the phone upright at hip height, 2.5 to 3 m away, and in the same spot each time.</li>
      <li>Fitted clothing and bare feet make the hip, knee and ankle points far more accurate.</li>
    </ul>
  </section>`;
  $('#report-body').innerHTML = html;
  $('#report').dataset.scanId = scan.id;
  state.lastReport = { scan, report, html };
  $('#save-report').hidden = false;
}

// ---------- Export ----------
async function saveReport() {
  const r = state.lastReport;
  if (!r) return;
  const css = $('#app-style').textContent;
  let html = r.html;
  if (r.is3d && state.viewer) {
    const shot = state.viewer.snapshot();
    html = html.replace(/<div class="v3d-stage" id="v3d-stage"><\/div>[\s\S]*?<\/div>\s*<\/div>/, `<img class="v3d-shot" src="${shot}" alt="3D view of the scan on the posture grid">`);
  }
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Postura report ${fmtDate(r.scan.date)}</title><style>${css}</style></head><body><main class="wrap report-export"><div id="report-body">${html}</div></main></body></html>`;
  const name = `postura-report-${r.scan.date.slice(0, 10)}.html`;
  try {
    const dl = window.claude?.use ? await window.claude.use('downloads') : null;
    if (dl) { await dl.save({ filename: name, data: new Blob([doc], { type: 'text/html' }) }); toast('Report saved'); return; }
  } catch (e) {
    if (e && /declin|cancel|abort/i.test(String(e.code || e.message))) return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([doc], { type: 'text/html' }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  toast('Report downloaded');
}

// ---------- History (this browser only) ----------
function loadHistory() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch { return []; }
}

async function shrink(dataUrl, w) {
  return new Promise((res) => {
    const img = new Image();
    img.onload = () => { res(imageToCanvas(img, w).toDataURL('image/jpeg', 0.72)); };
    img.onerror = () => res(null);
    img.src = dataUrl;
  });
}

async function saveScan(scan) {
  const copy = JSON.parse(JSON.stringify(scan));
  for (const v of VIEWS) {
    const c = copy.captures[v];
    if (c?.image) {
      const small = await shrink(c.image, 640);
      const k = 640 / Math.max(c.w, c.h);
      if (small && k < 1) { c.image = small; c.w = Math.round(c.w * k); c.h = Math.round(c.h * k); }
    }
  }
  let list = loadHistory();
  list.unshift(copy);
  list = list.slice(0, 12);
  for (let n = list.length; n > 0; n--) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, n))); break; } catch { /* storage full or blocked */ }
  }
  renderHistory();
}

function renderHistory() {
  const list = loadHistory();
  const box = $('#history');
  if (!list.length) { box.innerHTML = '<p class="muted">Your scans are kept on this device only. After your first scan you will see them here and can compare them over time.</p>'; return; }
  box.innerHTML = `<ul class="hist">${list.map((s) => `
    <li><button class="hist-item" data-id="${s.id}">
      <span class="h-score ${worst(s.regions)}">${s.overall ?? '–'}</span>
      <span class="h-text"><strong>${scoreWord(s.overall)}</strong><span>${s.type === '3d' ? (s.source === 'video' ? '3D video scan' : '3D scan') : 'Photo scan'} · ${fmtDate(s.date)}</span></span>
      <span class="h-bars">${REGIONS.map((r) => { const x = s.regions.find((q) => q.id === r.id); return `<i class="${x?.status || 'none'}" title="${r.name}: ${x?.score ?? '–'}"></i>`; }).join('')}</span>
    </button></li>`).join('')}</ul>
    <button class="link" id="clear-history">Delete saved scans</button>`;
  $$('.hist-item', box).forEach((b) => b.addEventListener('click', () => openSaved(Number(b.dataset.id))));
  $('#clear-history').addEventListener('click', () => {
    const b = $('#clear-history');
    if (b.dataset.armed) { try { localStorage.removeItem(STORE_KEY); } catch {} renderHistory(); toast('Saved scans deleted'); }
    else { b.dataset.armed = '1'; b.textContent = 'Tap again to delete all saved scans'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Delete saved scans'; } }, 4000); }
  });
}

function worst(regions) {
  const rank = { good: 0, mild: 1, notable: 2 };
  return regions.reduce((w, r) => ((rank[r.status] ?? -1) > (rank[w] ?? -1) ? r.status : w), 'good');
}


// ---------- 3D scan ----------
let scan3dMod = null;
let report3dMod = null;
async function load3dModules() {
  if (!scan3dMod) [scan3dMod, report3dMod] = await Promise.all([import('./scan3d.js'), import('./report3d.js')]);
  return { scan3d: scan3dMod, report3d: report3dMod };
}

function open3dImport() {
  show('import3d');
  getLandmarker().catch(() => {});
  load3dModules().catch(() => {});
}

function setProgress(steps, current) {
  $('#p3d').innerHTML = steps.map((s, i) => `<li class="${i < current ? 'done' : i === current ? 'now' : ''}">${s}</li>`).join('');
}

const STEPS_3D = ['Reading the mesh', 'Finding which way you face', 'Placing you on the grid', 'Finding your joints in 3D', 'Cutting sections', 'Building the report'];

async function handleMesh(file, opts = {}) {
  if (!file) return;
  show('processing3d');
  setProgress(STEPS_3D, 0);
  $('#p3d-file').textContent = opts.label || file.name;
  try {
    const [{ scan3d, report3d }, lm] = await Promise.all([load3dModules(), getLandmarker()]);
    await setMode('IMAGE');
    const object = opts.object || await scan3d.loadScanFile(file);
    const detect = async (canvas) => {
      const r = state.landmarker.detect(canvas);
      return r.landmarks && r.landmarks[0] ? r.landmarks[0].map((l) => ({ x: l.x, y: l.y, visibility: l.visibility })) : null;
    };
    const res = await scan3d.analyzeScan(object, detect, (msg) => {
      const i = STEPS_3D.indexOf(msg);
      if (i >= 0) setProgress(STEPS_3D, i);
    });
    setProgress(STEPS_3D, 5);
    const report = build3dReport(res);
    const prev = opts.example ? null : (loadHistory().find((s) => s.type === '3d') || null);
    const rec = report3d.toRecord(res, report, {
      metrics: report.regions.flatMap((r) => r.metrics.map((m) => ({ label: m.label, value: m.value }))),
      example: !!opts.example,
    });
    show3dReport(rec, report, prev, res.object, !!opts.example);
    if (!opts.example) save3d(rec);
  } catch (e) {
    console.error(e);
    const code = String(e && e.message);
    const msg = code === 'format' ? 'That file type is not supported. Export your scan as OBJ, PLY, STL or GLB.'
      : code === 'point-cloud' ? 'This PLY file is a point cloud. Export a mesh instead (OBJ, GLB or a PLY with faces).'
      : code === 'no-mesh' || code === 'too-small' ? 'No body mesh was found in that file.'
      : /fetch|wasm|model/i.test(code) ? 'The pose model could not load. Check your connection and try again.'
      : 'That scan could not be read. Try exporting it again as OBJ or GLB.';
    show('import3d');
    toast(msg);
  }
}

function show3dReport(rec, report, prev, object, isExample) {
  if (state.viewer) { state.viewer.dispose(); state.viewer = null; }
  const html = report3dMod.report3dHtml(rec, report, prev, { live: !!object, example: isExample });
  const body = $('#report3d-body');
  body.innerHTML = html;
  show('report3d');
  if (object) {
    state.viewer = new report3dMod.Viewer($('#v3d-stage'), object, rec);
    report3dMod.wireViewer(body, state.viewer);
  }
  state.lastReport = { scan: rec, report, html, is3d: true };
}

async function open3dSaved(rec) {
  await load3dModules();
  const report = build3dReport({ ...rec, sections: rec.sections });
  const list = loadHistory().filter((s) => s.type === '3d');
  const prev = list[list.findIndex((s) => s.id === rec.id) + 1] || null;
  show3dReport(rec, report, prev, null, false);
}

function save3d(rec) {
  let list = loadHistory();
  list.unshift(rec);
  list = list.slice(0, 16);
  for (let n = list.length; n > 0; n--) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(list.slice(0, n))); break; } catch { /* storage full or blocked */ }
  }
  renderHistory();
}

async function show3dExample() {
  const { buildMannequin } = await import('./mannequin.js');
  await handleMesh({ name: 'example' }, { object: buildMannequin(), example: true, label: 'Sample body model' });
}

// ---------- Video scan ----------
let scanVideoMod = null;
function openVideoScan() {
  const h = parseFloat($('#height').value);
  if (h >= 100 && h <= 230 && !$('#vs-height').value) $('#vs-height').value = h;
  show('videoscan');
  getLandmarker().catch(() => {});
  load3dModules().catch(() => {});
  if (!scanVideoMod) import('./scanvideo.js').then((m) => { scanVideoMod = m; }).catch(() => {});
}

const STEPS_VIDEO = ['Reading video frames', 'Finding you in each frame', 'Working out how you turned', 'Building your 3D body', 'Placing you on the grid', 'Cutting sections', 'Building the report'];

function videoHeightM() {
  const h = parseFloat($('#vs-height').value);
  return h >= 100 && h <= 230 ? h / 100 : null;
}

// frames: optional pre-extracted frames (used by tests); otherwise read from the video file.
async function handleVideo(file, opts = {}) {
  if (!file && !opts.frames) return;
  const heightM = opts.heightM || videoHeightM();
  if (!heightM) { toast('Enter your height first, so Postura can measure in centimetres.'); $('#vs-height').focus(); return; }
  show('processing3d');
  setProgress(STEPS_VIDEO, 0);
  $('#p3d-file').textContent = opts.label || (file && file.name) || 'Turn-around video';
  const t0 = performance.now();
  try {
    const [{ scan3d, report3d }, sv] = await Promise.all([load3dModules(), scanVideoMod || import('./scanvideo.js')]);
    scanVideoMod = sv;
    await getLandmarker();
    await setMode('IMAGE');
    const frames = opts.frames || await sv.extractFrames(file, {}, () => {});
    const body = await sv.buildBodyFromFrames(frames, state.landmarker, heightM, (msg) => {
      const i = STEPS_VIDEO.indexOf(msg);
      if (i >= 0) setProgress(STEPS_VIDEO, i);
    });
    setProgress(STEPS_VIDEO, 4);
    const res = await scan3d.analyzeScan(body.object, async () => null, (msg) => {
      const i = STEPS_VIDEO.indexOf(msg);
      if (i >= 0) setProgress(STEPS_VIDEO, i);
      else if (msg === 'Cutting sections') setProgress(STEPS_VIDEO, 5);
    }, { known: true, landmarks: body.landmarks });
    setProgress(STEPS_VIDEO, 6);
    const report = build3dReport(res);
    const prev = loadHistory().find((s) => s.type === '3d') || null;
    const rec = report3d.toRecord(res, report, {
      metrics: report.regions.flatMap((r) => r.metrics.map((m) => ({ label: m.label, value: m.value }))),
      source: 'video', givenHeight: heightM,
    });
    console.info('video scan built in', Math.round(performance.now() - t0), 'ms', body.info);
    show3dReport(rec, report, prev, res.object, false);
    save3d(rec);
  } catch (e) {
    console.error(e);
    const code = String(e && e.message);
    const msg = code === 'video-decode' ? 'That video could not be read here. Try recording again, or save it as MP4.'
      : code === 'video-short' ? 'The video is too short. Turn slowly, all the way round, over 20 to 30 seconds.'
      : code === 'video-noperson' ? 'Postura could not see your whole body in most of the video. Step back so you fit from head to feet, with good light.'
      : code === 'video-carve' ? 'The 3D body could not be built. Keep the phone still, turn on the spot, and keep your whole body in view.'
      : /fetch|wasm|model/i.test(code) ? 'The pose model could not load. Check your connection and try again.'
      : 'That video could not be turned into a 3D body. Try recording again.';
    show('videoscan');
    toast(msg);
  }
}
if (typeof window !== 'undefined') window.__posturaVideo = handleVideo;

// ---------- Sections menu ----------
function goSection(go) {
  if (go === 'scan') { stopLive(); renderHistory(); show('home'); return; }
  if (go === 'scans') { stopLive(); renderHistory(); show('scans'); return; }
  if (state.lastReport && !state.lastReport.scan?.example) { show(state.lastReport.is3d ? 'report3d' : 'report'); return; }
  const latest = loadHistory()[0];
  if (latest) { openSaved(latest.id); return; }
  toast('No reports yet. Your latest report appears here after your first scan.');
}

// ---------- Wire up ----------
function init() {
  initHome();
  const canLive = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext;
  $('#live-btn').hidden = !canLive;
  $('#live-btn').addEventListener('click', startLive);
  $('#file-camera').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('#file-pick').addEventListener('change', (e) => { handleFile(e.target.files[0]); e.target.value = ''; });
  $('#review-use').addEventListener('click', acceptPending);
  $('#review-retake').addEventListener('click', () => openCapture(state.step));
  $('#live-cancel').addEventListener('click', () => { stopLive(); openCapture(state.step); });
  $('#live-flip').addEventListener('click', async () => {
    const f = state.live?.facing === 'user' ? 'environment' : 'user';
    stopLive(); state.live = { facing: f }; startLive();
  });
  const vt = $('#voice');
  vt.hidden = !('speechSynthesis' in window);
  vt.addEventListener('click', () => {
    state.voice = !state.voice;
    vt.setAttribute('aria-pressed', String(state.voice));
    vt.textContent = state.voice ? 'Voice cues on' : 'Voice cues off';
  });
  $('#cap-back').addEventListener('click', () => { if (state.step === 0) show('prep'); else openCapture(state.step - 1); });
  $('#report-home').addEventListener('click', () => { renderHistory(); show('home'); });
  $('#report-again').addEventListener('click', () => { state.captures = {}; state.step = 0; show('prep'); });
  $('#save-report').addEventListener('click', saveReport);
  $('#brand').addEventListener('click', (e) => { e.preventDefault(); stopLive(); show('home'); });
  $$('#tabs .tab').forEach((t) => t.addEventListener('click', () => goSection(t.dataset.go)));
  $('#start3d').addEventListener('click', openVideoScan);
  $('#import3d-open').addEventListener('click', open3dImport);
  $('#vs-import').addEventListener('click', open3dImport);
  $('#videoscan-back').addEventListener('click', () => show('home'));
  $('#vs-record').addEventListener('change', (e) => { handleVideo(e.target.files[0]); e.target.value = ''; });
  $('#vs-pick').addEventListener('change', (e) => { handleVideo(e.target.files[0]); e.target.value = ''; });
  $('#import3d-back').addEventListener('click', () => show('home'));
  $('#example3d').addEventListener('click', show3dExample);
  $('#mesh-file').addEventListener('change', (e) => { handleMesh(e.target.files[0]); e.target.value = ''; });
  const drop = $('#drop3d');
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handleMesh(e.dataTransfer.files[0]); });
  $('#r3d-again').addEventListener('click', openVideoScan);
  $('#r3d-save').addEventListener('click', saveReport);
  $('#r3d-home').addEventListener('click', () => { renderHistory(); show('home'); });
  show('home');
}

init();
