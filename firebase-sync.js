// ===== Firebase sync layer (optional, opt-in, account-based) =====
// Loaded as a module AFTER app.js. If firebase-config.js is filled in, this:
//   - exposes window.SP_auth (register / login / logout / current user) so the
//     settings UI can offer a simple username + password login (no email).
//   - while logged in, syncs the pantry to households/{uid} in Firestore:
//     remote changes flow into SP, and every local save mirrors up.
// Each account's data is a single doc keyed by the user's uid, so any device
// that logs into the same account sees the same pantry. firestore.rules locks
// each doc to its owner. If not configured, the app stays purely local.
import { firebaseConfig, isConfigured, SYNTH_DOMAIN } from './firebase-config.js';

if (!isConfigured()) {
  console.info('[SmartPantry] Firebase not configured — running local-only. Fill firebase-config.js to enable cross-device sync.');
} else {
  const { initializeApp } = await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js');
  const { initializeFirestore, doc, setDoc, onSnapshot } =
    await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js');
  const { getAuth, setPersistence, browserLocalPersistence, onAuthStateChanged,
    createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut } =
    await import('https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js');

  const app = initializeApp(firebaseConfig);
  // Force long-polling (Netspark TLS filter breaks WebChannel streaming).
  const db = initializeFirestore(app, { experimentalForceLongPolling: true });
  const auth = getAuth(app);
  // Keep the session on the device so a login survives reloads / app restarts.
  await setPersistence(auth, browserLocalPersistence).catch(() => {});

  // username → synthetic email accepted by the Email/Password provider.
  const emailFor = (u) => String(u).trim().toLowerCase().replace(/\s+/g, '') + SYNTH_DOMAIN;

  let unsub = null;          // active Firestore snapshot unsubscribe
  let applyingRemote = false; // guard so a remote-applied change isn't echoed up
  let saveTimer = null;
  let currentName = null;     // display username of the logged-in user
  const authListeners = [];

  function stopSync() {
    if (unsub) { unsub(); unsub = null; }
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    delete window.SP_cloudSave;
  }

  function startSync(uid) {
    const ref = doc(db, 'households', uid);
    let first = true;

    // mirror local saves up (debounced)
    window.SP_cloudSave = (state) => {
      if (applyingRemote) return;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        setDoc(ref, state).catch((e) => console.warn('[SmartPantry] cloud save failed', e));
      }, 400);
    };

    unsub = onSnapshot(ref, (snap) => {
      if (first) {
        first = false;
        if (!snap.exists()) {
          // brand-new account → adopt this device's current pantry as its seed
          const local = (window.SP && SP.load) ? SP.load() : null;
          if (local) setDoc(ref, local).catch((e) => console.warn('[SmartPantry] seed failed', e));
          return;
        }
        // existing account → this device adopts the account's pantry on login
        applyingRemote = true;
        window.SP.replaceState(snap.data());
        applyingRemote = false;
        return;
      }
      // ongoing: apply a remote change only when it's newer than what we have
      if (!snap.exists()) return;
      const remote = snap.data();
      const localTs = (window.SP && SP.load && SP.load().updatedAt) || '';
      if (remote.updatedAt && remote.updatedAt > localTs) {
        applyingRemote = true;
        window.SP.replaceState(remote);
        applyingRemote = false;
      }
    }, (err) => console.warn('[SmartPantry] snapshot error', err));
  }

  onAuthStateChanged(auth, (user) => {
    stopSync();
    currentName = user ? (user.email || '').split('@')[0] : null;
    if (user) startSync(user.uid);
    authListeners.forEach((cb) => { try { cb(currentName); } catch (e) {} });
  });

  // Public API for the settings UI.
  window.SP_auth = {
    user: () => currentName,
    onChange: (cb) => { authListeners.push(cb); },
    register: (u, p) => createUserWithEmailAndPassword(auth, emailFor(u), p),
    login: (u, p) => signInWithEmailAndPassword(auth, emailFor(u), p),
    logout: () => signOut(auth),
  };

  console.info('[SmartPantry] Firebase device sync ready (username/password auth).');
}
