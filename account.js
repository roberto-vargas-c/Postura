// Postura accounts: email and password sign-in with Firebase, and syncing scan results to the account.
// Photos never leave the device: a photo scan is synced without its images (landmarks and scores only).
// Each record is stored as one JSON string, because Firestore does not allow nested arrays.

import { FIREBASE_CONFIG } from './firebase-config.js';

const MAX_DOC = 900 * 1024;
let fb = null, auth = null, db = null;
let listeners = [];

function loadScript(src) {
  return new Promise((ok, no) => {
    const s = document.createElement('script');
    s.src = src; s.onload = ok; s.onerror = () => no(new Error('load ' + src));
    document.head.appendChild(s);
  });
}

export function available() {
  if (!FIREBASE_CONFIG) return false;
  try { if (window.top !== window.self) return false; } catch { return false; }
  return location.protocol === 'https:' || location.hostname === 'localhost';
}

export async function init() {
  if (fb) return true;
  if (!available()) return false;
  await loadScript('vendor/firebase/firebase-app-compat.js');
  await Promise.all([loadScript('vendor/firebase/firebase-auth-compat.js'), loadScript('vendor/firebase/firebase-firestore-compat.js')]);
  fb = window.firebase;
  fb.initializeApp(FIREBASE_CONFIG);
  auth = fb.auth(); db = fb.firestore();
  auth.onAuthStateChanged((u) => listeners.forEach((f) => f(u)));
  return true;
}

export function onChange(f) { listeners.push(f); if (auth) f(auth.currentUser); }
export function user() { return auth ? auth.currentUser : null; }

export function friendlyError(e) {
  const c = (e && e.code) || '';
  if (c === 'auth/invalid-email') return 'That email address does not look right.';
  if (c === 'auth/missing-password') return 'Enter your password.';
  if (c === 'auth/weak-password') return 'Choose a password with at least 8 characters.';
  if (c === 'auth/email-already-in-use') return 'There is already an account with this email. Sign in instead, or reset the password.';
  if (c === 'auth/invalid-credential' || c === 'auth/wrong-password' || c === 'auth/user-not-found' || c === 'auth/invalid-login-credentials') return 'The email or password is not right. Try again, or reset the password.';
  if (c === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes, or reset the password.';
  if (c === 'auth/network-request-failed') return 'No connection. Check your internet and try again.';
  if (c === 'auth/requires-recent-login') return 'For your safety, sign out and in again, then repeat this.';
  if (c === 'auth/operation-not-allowed') return 'Email sign-in is not switched on for Postura yet.';
  return 'Something went wrong. Try again in a moment.';
}

export async function signUp(email, password) {
  if (password.length < 8) throw { code: 'auth/weak-password' };
  const cred = await auth.createUserWithEmailAndPassword(email, password);
  try { await cred.user.sendEmailVerification(); } catch { /* not essential */ }
  return cred.user;
}
export const signIn = (email, password) => auth.signInWithEmailAndPassword(email, password).then((c) => c.user);
export const resetPassword = (email) => auth.sendPasswordResetEmail(email);
export const signOut = () => auth.signOut();

const scansRef = (uid) => db.collection('users').doc(uid).collection('scans');

// A copy of a record that is safe and small enough to store: photos removed.
export function cloudCopy(rec) {
  const c = JSON.parse(JSON.stringify(rec));
  if (c.captures) for (const v of Object.keys(c.captures)) if (c.captures[v]) delete c.captures[v].image;
  return c;
}

export async function pushScan(rec) {
  const u = user(); if (!u || !rec || rec.example) return false;
  const json = JSON.stringify(cloudCopy(rec));
  if (json.length > MAX_DOC) return false;
  await scansRef(u.uid).doc(String(rec.id)).set({ json, date: rec.date || null, type: rec.type || 'photo', v: 1 });
  return true;
}

export async function pullScans() {
  const u = user(); if (!u) return [];
  const snap = await scansRef(u.uid).get();
  const out = [];
  snap.forEach((d) => { try { out.push(JSON.parse(d.data().json)); } catch { /* skip a damaged record */ } });
  return out;
}

export async function deleteScans(ids) {
  const u = user(); if (!u) return;
  const ref = scansRef(u.uid);
  const all = ids || (await ref.get()).docs.map((d) => d.id);
  for (let i = 0; i < all.length; i += 400) {
    const batch = db.batch();
    all.slice(i, i + 400).forEach((id) => batch.delete(ref.doc(String(id))));
    await batch.commit();
  }
}

// Deletes the person's synced scans and then the account itself.
export async function deleteAccount() {
  const u = user(); if (!u) return;
  await deleteScans();
  await u.delete();
}
