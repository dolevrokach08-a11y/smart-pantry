#!/usr/bin/env node
/* ===== Smart Pantry — multi-chain, multi-store price fetcher (Phase 1d) =====
 *
 * Builds a full branch directory + per-store prices for the tracked national
 * barcodes, so the app can let the user pick their branch per chain and compare
 * the basket at *their* stores. Writes prices.json:
 *
 *   { updated, tracked:[...],
 *     chains: { "<name>": { stores: { "<id>": {name} },
 *                           prices: { "<id>": { "<barcode>": price } } } } }
 *
 * Sources (scripts/chains.json): "shufersal" = public portal; "cerberus" =
 * publishedprices.co.il login (public creds, empty password).
 *
 * Env:
 *   MAX_STORES  cap stores fetched per chain (local testing). Unset = all.
 *
 * Node 18+, zero deps. The heavy fetch really runs in CI; locally Netspark
 * breaks Node TLS to publishedprices (use scripts/gen-prices-local.ps1).
 */
'use strict';
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SHUF = 'https://prices.shufersal.co.il';
const CERB = 'https://url.publishedprices.co.il';
const UA = { 'User-Agent': 'Mozilla/5.0 (SmartPantry price fetcher)' };
const MAX = process.env.MAX_STORES ? parseInt(process.env.MAX_STORES, 10) : Infinity;
const CONCURRENCY = 8;

const RX = {
  item: /<Item>([\s\S]*?)<\/Item>/g,
  code: /<ItemCode>([\s\S]*?)<\/ItemCode>/,
  price: /<ItemPrice>([\s\S]*?)<\/ItemPrice>/,
  store: /<Store>([\s\S]*?)<\/Store>/g,
  sid: /<StoreI[dD]>([\s\S]*?)<\/StoreI[dD]>/,
  sname: /<StoreName>([\s\S]*?)<\/StoreName>/,
  csrf: /name="csrftoken"\s+content="([^"]+)"/,
};

const stripBom = (s) => s.replace(/^﻿/, '');
// Cerberus store files are UTF-16; everything else UTF-8.
function decode(b) {
  if (b[0] === 0xff && b[1] === 0xfe) return stripBom(b.toString('utf16le'));
  return stripBom(b.toString('utf8'));
}
function parsePrices(xml, keep) {
  const out = {};
  for (const m of xml.matchAll(RX.item)) {
    const code = (m[1].match(RX.code) || [, ''])[1].trim();
    if (!keep.has(code)) continue;
    const p = parseFloat((m[1].match(RX.price) || [, ''])[1]);
    if (p > 0) out[code] = Math.round(p * 100) / 100;
  }
  return out;
}
function parseStores(xml) {
  const stores = {};
  for (const m of xml.matchAll(RX.store)) {
    const id = (m[1].match(RX.sid) || [, ''])[1].trim().replace(/^0+/, '') || '0';
    const name = (m[1].match(RX.sname) || [, ''])[1].trim();
    if (id && name) stores[id] = { name };
  }
  return stores;
}
async function buf(url, headers) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`${r.status} ${url.slice(0, 50)}`);
  return Buffer.from(await r.arrayBuffer());
}
const gunzip = (b) => zlib.gunzipSync(b).toString('utf8');

/** Run async tasks with limited concurrency. */
async function pool(items, fn, n = CONCURRENCY) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; try { await fn(items[idx]); } catch { /* skip store */ } }
  }));
}

/* ---------- Shufersal (public) ---------- */
async function shufLink(catID, storeId, kind) {
  const grid = (await buf(`${SHUF}/FileObject/UpdateCategory?catID=${catID}&storeId=${storeId}`)).toString('utf8');
  return [...grid.matchAll(/href="([^"]+\.gz[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&')).find((u) => u.includes(kind));
}
async function fetchShufersal(keep) {
  const stores = parseStores(gunzip(await buf(await shufLink(5, 0, 'Stores'))));
  const ids = Object.keys(stores).slice(0, MAX);
  const prices = {};
  await pool(ids, async (id) => {
    const link = await shufLink(2, id, 'PriceFull');
    if (!link) return;
    const got = parsePrices(gunzip(await buf(link)), keep);
    if (Object.keys(got).length) prices[id] = got;
  });
  return { stores, prices };
}

/* ---------- publishedprices (Cerberus) ---------- */
async function cerberusSession(user) {
  const jar = {};
  const cookie = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
  const absorb = (r) => (r.headers.getSetCookie ? r.headers.getSetCookie() : []).forEach((c) => { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); });
  const form = (body) => ({ method: 'POST', headers: { ...UA, Cookie: cookie(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
  const get = async (u) => { const r = await fetch(u, { headers: { ...UA, Cookie: cookie() } }); absorb(r); return r; };
  const csrf1 = (RX.csrf.exec(await (await get(`${CERB}/login`)).text()) || [, ''])[1];
  await fetch(`${CERB}/login/user`, form({ username: user, password: '', csrftoken: csrf1 })).then(absorb);
  const fileHtml = await (await get(`${CERB}/file`)).text();
  if (/name="username"/.test(fileHtml)) throw new Error(`login failed: ${user}`);
  const csrf2 = (RX.csrf.exec(fileHtml) || [, ''])[1];
  const dir = await fetch(`${CERB}/file/json/dir`, form({ sEcho: 1, iDisplayStart: 0, iDisplayLength: 100000, cd: '/', csrftoken: csrf2 }));
  const files = (JSON.parse(await dir.text()).aaData || []).map((r) => r.name).filter(Boolean);
  return { cookie, files };
}
async function fetchCerberus(chain, keep) {
  const { cookie, files } = await cerberusSession(chain.user);
  const dl = (name) => buf(`${CERB}/file/d/${name}`, { Cookie: cookie() });
  const storesFile = files.find((n) => /Stores/.test(n));
  const stores = storesFile ? parseStores(decode(await dl(storesFile))) : {};
  // newest PriceFull per store id (store id = dash-delimited token after the chain id)
  const pfByStore = {};
  for (const n of files.filter((f) => /^PriceFull/.test(f))) {
    const id = (n.match(new RegExp(`${chain.chainId}-(?:\\d+-)?0*(\\d+)-`)) || [, ''])[1];
    if (id && (!pfByStore[id] || n > pfByStore[id])) pfByStore[id] = n;
  }
  const ids = Object.keys(stores).filter((id) => pfByStore[id]).slice(0, MAX);
  const prices = {};
  await pool(ids, async (id) => {
    const got = parsePrices(gunzip(await dl(pfByStore[id])), keep); // PriceFull files are gzipped
    if (Object.keys(got).length) prices[id] = got;
  });
  return { stores, prices };
}

(async function main() {
  const t0 = Date.now();
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'chains.json'), 'utf8'));
  const tracked = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracked-barcodes.json'), 'utf8')).barcodes;
  const keep = new Set(tracked);
  // Local mode: parse pre-downloaded files from $PRICES_CACHE/<chainId>/ (a
  // Stores file + <storeId>.gz PriceFull files), used by gen-prices-local.ps1.
  const cacheDir = process.env.PRICES_CACHE;
  const fromCache = (ch) => {
    const dir = path.join(cacheDir, ch.chainId);
    const list = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const sf = list.find((f) => /stores/i.test(f));
    const stores = sf ? parseStores(/\.gz$/.test(sf) ? gunzip(fs.readFileSync(path.join(dir, sf))) : decode(fs.readFileSync(path.join(dir, sf)))) : {};
    const prices = {};
    for (const f of list.filter((f) => /^\d+\.gz$/.test(f))) {
      const got = parsePrices(gunzip(fs.readFileSync(path.join(dir, f))), keep);
      if (Object.keys(got).length) prices[f.replace('.gz', '')] = got;
    }
    return { stores, prices };
  };

  const chains = {};
  for (const ch of cfg.chains) {
    try {
      const res = cacheDir ? fromCache(ch)
        : ch.type === 'shufersal' ? await fetchShufersal(keep) : await fetchCerberus(ch, keep);
      chains[ch.name] = { stores: res.stores, prices: res.prices };
      console.log(`[prices] ${ch.name}: ${Object.keys(res.stores).length} branches, prices for ${Object.keys(res.prices).length}`);
    } catch (e) { console.warn(`[prices] ${ch.name}: SKIPPED — ${e.message}`); }
  }
  const dest = path.join(__dirname, '..', 'prices.json');
  fs.writeFileSync(dest, JSON.stringify({ updated: new Date().toISOString(), tracked, chains }));
  console.log(`[prices] wrote ${dest} in ${Date.now() - t0}ms`);
  if (!Object.keys(chains).length) process.exit(1);
})().catch((e) => { console.error('[prices] FAILED:', e.message); process.exit(1); });
