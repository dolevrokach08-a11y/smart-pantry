// ===== Firebase config (OPTIONAL — enables cross-device sync via login) =====
// The app works fully WITHOUT this (local-first via localStorage). To sync the
// pantry live across all your devices (your phone, your PC, your partner's
// phone) with a simple username + password (no email, no verification):
//
//   1. Create a Firebase project (free Spark plan is enough).
//   2. Build → Authentication → Sign-in method → enable "Email/Password".
//      (We never send email — a username is mapped to a synthetic address
//       "<username>@smartpantry.app" behind the scenes.)
//   3. Build → Firestore Database → create a database.
//   4. Paste the Firestore rules from firestore.rules (locks each account to
//      its own data).
//   5. Project settings → your web app → paste the config below (replace the
//      REPLACE_ME values), then open the site. firebase-sync.js picks it up.
//
// Same long-polling note as finance-tracker: Netspark's TLS filter breaks
// Firestore's default WebChannel transport, so we force long-polling.

export const firebaseConfig = {
  apiKey: 'REPLACE_ME',
  authDomain: 'REPLACE_ME.firebaseapp.com',
  projectId: 'REPLACE_ME',
  storageBucket: 'REPLACE_ME.firebasestorage.app',
  messagingSenderId: 'REPLACE_ME',
  appId: 'REPLACE_ME',
};

// Usernames are mapped to synthetic emails so Firebase's Email/Password
// provider accepts them — the user only ever types a username. No mail is sent.
export const SYNTH_DOMAIN = '@smartpantry.app';

export function isConfigured() {
  return firebaseConfig.apiKey && firebaseConfig.apiKey !== 'REPLACE_ME';
}
