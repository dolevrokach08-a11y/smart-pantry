#!/usr/bin/env node
/* ===== Smart Pantry — Israeli price fetcher (Phase 1b) =====
 *
 * Pulls Shufersal's public "price transparency" data (חוק שקיפות מחירים),
 * decodes the gzipped XML, and writes a compact `prices.json` at the repo root:
 *
 *   { chain, store, storeName, updated, count, prices:{barcode:price}, promos:{barcode:{p,was,txt}} }
 *
 * The web app fetches that file and merges it into its items by barcode — no
 * Firebase required, so it works on plain GitHub Pages. A scheduled GitHub
 * Action (.github/workflows/prices.yml) runs this and commits the result.
 *
 * Shufersal portal (no login): https://prices.shufersal.co.il/
 *   catID=2 -> PriceFull (per store)   catID=4 -> PromoFull   catID=5 -> Stores
 *
 * Node 18+ only (uses global fetch + built-in zlib). No npm dependencies.
 *
 * Env:
 *   STORE_ID   pick a specific Shufersal store id (default: first one listed)
 *   NO_PROMOS  set to "1" to skip the (heavier) promo file
 */
'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const PORTAL = 'https://prices.shufersal.co.il';
const UA = { 'User-Agent': 'Mozilla/5.0 (SmartPantry price fetcher)' };
const CHAIN_NAME = 'שופרסל';

const RX = {
  item: /<Item>([\s\S]*?)<\/Item>/g,
  code: /<ItemCode>([\s\S]*?)<\/ItemCode>/,
  name: /<ItemName>([\s\S]*?)<\/ItemName>/,
  price: /<ItemPrice>([\s\S]*?)<\/ItemPrice>/,
  storeId: /<StoreI[dD]>([\s\S]*?)<\/StoreI[dD]>/,
  promo: /<Promotion>([\s\S]*?)<\/Promotion>/g,
  promoDesc: /<PromotionDescription>([\s\S]*?)<\/PromotionDescription>/,
  discounted: /<DiscountedPrice>([\s\S]*?)<\/DiscountedPrice>/,
  promoItemCode: /<ItemCode>([\s\S]*?)<\/ItemCode>/g,
};

async function getText(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}
async function getGunzip(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
}

/** Newest .gz download link from a category grid, optionally for one store. */
async function latestLink(catID, kind, storeFilter) {
  const grid = await getText(`${PORTAL}/FileObject/UpdateCategory?catID=${catID}&storeId=0`);
  const links = [...grid.matchAll(/href="([^"]+\.gz[^"]*)"/g)]
    .map((m) => m[1].replace(/&amp;/g, '&'))
    .filter((u) => u.includes(kind));
  const chosen = storeFilter ? links.find((u) => u.includes(`-${storeFilter}-`)) || links[0] : links[0];
  if (!chosen) throw new Error(`no ${kind} link for catID=${catID}`);
  return chosen;
}

function parsePrices(xml) {
  const prices = {};
  for (const m of xml.matchAll(RX.item)) {
    const b = m[1];
    const code = (b.match(RX.code) || [, ''])[1].trim();
    const price = parseFloat((b.match(RX.price) || [, ''])[1]);
    if (code && price > 0) prices[code] = Math.round(price * 100) / 100;
  }
  const storeId = (xml.match(RX.storeId) || [, ''])[1].trim();
  return { prices, storeId };
}

/* Conservative promo parse: only single-item promotions with an explicit
 * DiscountedPrice are trusted (unambiguous "this barcode, this price").
 * Multi-item / conditional deals (2-for-1, member clubs) are skipped for now. */
function parsePromos(xml, basePrices) {
  const promos = {};
  let kept = 0;
  for (const m of xml.matchAll(RX.promo)) {
    const blk = m[1];
    const dp = parseFloat((blk.match(RX.discounted) || [, ''])[1]);
    if (!(dp > 0)) continue;
    const codes = [...blk.matchAll(RX.promoItemCode)].map((x) => x[1].trim()).filter(Boolean);
    if (codes.length !== 1) continue; // only unambiguous single-item promos
    const code = codes[0];
    const was = basePrices[code];
    if (was != null && dp >= was) continue; // not actually cheaper
    promos[code] = {
      p: Math.round(dp * 100) / 100,
      was: was != null ? was : null,
      txt: ((blk.match(RX.promoDesc) || [, ''])[1].trim() || 'מבצע').slice(0, 60),
    };
    kept++;
  }
  return { promos, kept };
}

(async function main() {
  const t0 = Date.now();
  const storeFilter = process.env.STORE_ID || '';
  console.log(`[prices] fetching Shufersal PriceFull${storeFilter ? ` (store ${storeFilter})` : ''}…`);

  const priceUrl = await latestLink(2, 'PriceFull', storeFilter);
  const priceXml = await getGunzip(priceUrl);
  const { prices, storeId } = parsePrices(priceXml);
  console.log(`[prices] store ${storeId}: ${Object.keys(prices).length} items`);

  let promos = {};
  if (process.env.NO_PROMOS !== '1') {
    try {
      const promoUrl = await latestLink(4, 'PromoFull', storeFilter);
      const promoXml = await getGunzip(promoUrl);
      const res = parsePromos(promoXml, prices);
      promos = res.promos;
      console.log(`[prices] promos: ${res.kept} single-item deals`);
    } catch (e) {
      console.warn(`[prices] promo fetch skipped: ${e.message}`);
    }
  }

  // store name (best effort, from the Stores file)
  let storeName = '';
  try {
    const storesUrl = await latestLink(5, 'Stores', '');
    const storesXml = await getGunzip(storesUrl);
    const n = String(parseInt(storeId, 10)); // stores file uses unpadded ids
    const re = new RegExp(`<StoreID>0*${n}</StoreID>[\\s\\S]*?<StoreName>([\\s\\S]*?)</StoreName>`);
    storeName = (storesXml.match(re) || [, ''])[1].trim();
  } catch { /* non-fatal */ }

  const out = {
    chain: CHAIN_NAME,
    store: storeId,
    storeName,
    updated: new Date().toISOString(),
    count: Object.keys(prices).length,
    prices,
    promos,
  };

  const dest = path.join(__dirname, '..', 'prices.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  const kb = Math.round(fs.statSync(dest).size / 1024);
  console.log(`[prices] wrote ${dest} (${kb} KB, ${out.count} prices, ${Object.keys(promos).length} promos) in ${Date.now() - t0}ms`);
})().catch((e) => {
  console.error('[prices] FAILED:', e.message);
  process.exit(1);
});
