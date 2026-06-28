// ===== Firebase sync layer (optional, opt-in) =====
// Loaded as a module AFTER app.js. If firebase-config.js is filled in, this:
//   - subscribes to the household doc and pushes remote changes into SP
//   - registers window.SP_cloudSave so every local save mirrors to Firestore
// If not configured, it does nothing and the app stays purely local.
import { firebaseConfig, HOUSEHOLD_ID, isConfigured } from './firebase-config.js';

if (!isConfigured()) {
  console.info('[SmartPantry] Firebase not configured — running local-only. Fill firebase-config.js to enable household sync.');
} else {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
  const { initializeFirestore, doc, setDoc, onSnapshot } =
    await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');

  const app = initializeApp(firebaseConfig);
  // Force long-polling (Netspark TLS filter breaks WebChannel streaming).
  const db = initializeFirestore(app, { experimentalForceLongPolling: true });
  const ref = doc(db, 'households', HOUSEHOLD_ID);

  let applyingRemote = false;

  // Push local saves to Firestore (debounced).
  let saveTimer;
  window.SP_cloudSave = (state) => {
    if (applyingRemote) return; // don't echo a remote update back up
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      setDoc(ref, state).catch((e) => console.warn('[SmartPantry] cloud save failed', e));
    }, 400);
  };

  // Pull remote changes into the local state.
  onSnapshot(ref, (snap) => {
    if (!snap.exists()) return;
    const remote = snap.data();
    const localTs = (window.SP && SP.load && SP.load().updatedAt) || '';
    // Only apply if remote is newer than what we have, to avoid loops.
    if (remote.updatedAt && remote.updatedAt > localTs) {
      applyingRemote = true;
      window.SP.replaceState(remote);
      applyingRemote = false;
    }
  }, (err) => console.warn('[SmartPantry] snapshot error', err));

  console.info('[SmartPantry] Firebase household sync active.');
}
