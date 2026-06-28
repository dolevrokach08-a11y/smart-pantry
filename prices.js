/* ===== Smart Pantry — price loader (Phase 1b) =====
 * Fetches prices.json (written by the scheduled GitHub Action from Shufersal's
 * public transparency data) and merges it into items by barcode. Fully
 * optional: if the file is missing, the app just runs without prices.
 */
(function () {
  'use strict';
  if (!window.SP || typeof SP.applyPrices !== 'function') return;
  // cache-bust lightly so a fresh deploy shows new prices; SW is network-first anyway.
  fetch('prices.json', { cache: 'no-cache' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data) return;
      SP.applyPrices(data);
      const meta = SP.priceInfo();
      if (meta) console.info(`[SmartPantry] prices: ${meta.count} from ${meta.chain}${meta.storeName ? ' · ' + meta.storeName : ''} (updated ${meta.updated})`);
    })
    .catch(() => { /* offline / no file — ignore */ });
})();
