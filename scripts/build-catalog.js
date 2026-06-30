#!/usr/bin/env node
/* ===== Smart Pantry — name→barcode catalog builder =====
 *
 * Builds catalog.json: a curated index of national products (barcode + name)
 * so the app can resolve a typed product NAME to a barcode (and then price it),
 * instead of requiring the user to know the barcode.
 *
 * Source: one Shufersal store's full PriceFull (public portal). We keep only
 * Israeli national barcodes (729-prefix, 13 digits) that carry a name — this
 * drops store-internal SKUs and yields ~5k common products (~75KB gzipped).
 *
 *   catalog.json: { updated, count, items: [[barcode, name], ...] }
 *
 * Env: CATALOG_STORE (Shufersal storeId, default 1). Node 18+, zero deps.
 */
'use strict';
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SHUF = 'https://prices.shufersal.co.il';
const UA = { 'User-Agent': 'Mozilla/5.0 (SmartPantry catalog builder)' };
const STORE = process.env.CATALOG_STORE || '1';
const g = (s, re) => { const m = s.match(re); return m ? m[1].trim() : ''; };

(async function main() {
  const t0 = Date.now();
  const grid = await (await fetch(`${SHUF}/FileObject/UpdateCategory?catID=2&storeId=${STORE}`, { headers: UA })).text();
  const link = [...grid.matchAll(/href="([^"]+\.gz[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&')).find((u) => /PriceFull/i.test(u));
  if (!link) throw new Error('no PriceFull link');
  const xml = zlib.gunzipSync(Buffer.from(await (await fetch(link, { headers: UA })).arrayBuffer())).toString('utf8');

  const seen = {};
  for (const m of xml.matchAll(/<Item>([\s\S]*?)<\/Item>/g)) {
    const code = g(m[1], /<ItemCode>([\s\S]*?)<\/ItemCode>/);
    if (!/^729\d{10}$/.test(code) || seen[code]) continue; // national 13-digit, deduped
    const name = g(m[1], /<ItemName>([\s\S]*?)<\/ItemName>/).replace(/\s+/g, ' ').trim();
    if (name) seen[code] = name;
  }
  const items = Object.entries(seen).map(([b, n]) => [b, n]);
  const dest = path.join(__dirname, '..', 'catalog.json');
  fs.writeFileSync(dest, JSON.stringify({ updated: new Date().toISOString(), count: items.length, items }));
  console.log(`[catalog] wrote ${items.length} products to ${dest} in ${Date.now() - t0}ms`);
})().catch((e) => { console.error('[catalog] FAILED:', e.message); process.exit(1); });
