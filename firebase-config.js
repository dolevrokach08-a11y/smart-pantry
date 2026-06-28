// ===== Firebase config (OPTIONAL — enables household real-time sync) =====
// The app works fully WITHOUT this (local-first via localStorage). To sync the
// pantry live across all household phones/browsers:
//   1. Create a Firebase project + Firestore (free Spark plan is enough).
//   2. Paste your web-app config below, replacing the REPLACE_ME values.
//   3. Open the site — firebase-sync.js will pick it up automatically.
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

// Single shared household document. Everyone in the house uses the same id.
export const HOUSEHOLD_ID = 'main';

export function isConfigured() {
  return firebaseConfig.apiKey && firebaseConfig.apiKey !== 'REPLACE_ME';
}
