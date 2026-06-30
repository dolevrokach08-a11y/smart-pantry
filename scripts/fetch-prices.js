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
  promo: /<Promotion>([\s\S]*?)<\/Promotion>/g,
  pend: /<PromotionEndDateTime>([\s\S]*?)<\/PromotionEndDateTime>/,
  pstart: /<PromotionStartDateTime>([\s\S]*?)<\/PromotionStartDateTime>/,
  coupon: /<AdditionalIsCoupon>([\s\S]*?)<\/AdditionalIsCoupon>/,
  pdesc: /<PromotionDescription>([\s\S]*?)<\/PromotionDescription>/,
  pitem: /<PromotionItem>([\s\S]*?)<\/PromotionItem>/g,
  reward: /<RewardType>([\s\S]*?)<\/RewardType>/,
  minqty: /<MinQty>([\s\S]*?)<\/MinQty>/,
  dprice: /<DiscountedPrice>([\s\S]*?)<\/DiscountedPrice>/,
};
const g1 = (s, re) => (s.match(re) || [, ''])[1].trim();

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
/* Extract genuine single-unit SALES for tracked barcodes from a PromoFull XML.
 * Real-data caveat: most "promotions" are coupon/club programs whose
 * <DiscountedPrice> just echoes the regular price. We keep a promo only when it
 * is: active now, not a coupon, RewardType=1 (a real discounted price),
 * MinQty<=1 (priced per single unit), and STRICTLY below the regular price
 * (`regular` from the same store's PriceFull). out: { barcode: {price, desc} }. */
function parsePromos(xml, keep, regular) {
  const now = Date.now();
  const out = {};
  for (const pm of xml.matchAll(RX.promo)) {
    const blk = pm[1];
    const end = Date.parse(g1(blk, RX.pend));
    const start = Date.parse(g1(blk, RX.pstart));
    if (end && end < now) continue;
    if (start && start > now) continue;
    if (g1(blk, RX.coupon) === '1') continue;
    const desc = g1(blk, RX.pdesc).slice(0, 50);
    for (const im of blk.matchAll(RX.pitem)) {
      const it = im[1];
      const code = g1(it, RX.code);
      if (!keep.has(code)) continue;
      if (g1(it, RX.reward) !== '1') continue;
      if ((parseFloat(g1(it, RX.minqty)) || 0) > 1) continue;
      const dp = parseFloat(g1(it, RX.dprice));
      if (!(dp > 0)) continue;
      const reg = regular[code];
      if (reg != null && dp >= reg) continue;
      const price = Math.round(dp * 100) / 100;
      if (!out[code] || price < out[code].price) out[code] = { price, desc };
    }
  }
  return out;
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
  const prices = {}, promos = {};
  await pool(ids, async (id) => {
    const link = await shufLink(2, id, 'PriceFull');
    if (!link) return;
    const got = parsePrices(gunzip(await buf(link)), keep);
    if (!Object.keys(got).length) return;
    prices[id] = got;
    const plink = await shufLink(4, id, 'PromoFull'); // promos priced relative to this store's regulars
    if (plink) { const sale = parsePromos(gunzip(await buf(plink)), keep, got); if (Object.keys(sale).length) promos[id] = sale; }
  });
  return { stores, prices, promos };
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
  // newest PriceFull / PromoFull per store id (store id = dash-delimited token after the chain id)
  const newestByStore = (re) => {
    const m = {};
    for (const n of files.filter((f) => re.test(f))) {
      const id = (n.match(new RegExp(`${chain.chainId}-(?:\\d+-)?0*(\\d+)-`)) || [, ''])[1];
      if (id && (!m[id] || n > m[id])) m[id] = n;
    }
    return m;
  };
  const pfByStore = newestByStore(/^PriceFull/);
  const promoByStore = newestByStore(/^PromoFull/);
  const ids = Object.keys(stores).filter((id) => pfByStore[id]).slice(0, MAX);
  const prices = {}, promos = {};
  await pool(ids, async (id) => {
    const got = parsePrices(gunzip(await dl(pfByStore[id])), keep); // PriceFull files are gzipped
    if (!Object.keys(got).length) return;
    prices[id] = got;
    if (promoByStore[id]) { const sale = parsePromos(gunzip(await dl(promoByStore[id])), keep, got); if (Object.keys(sale).length) promos[id] = sale; }
  });
  return { stores, prices, promos };
}

(async function main() {
  const t0 = Date.now();
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'chains.json'), 'utf8'));
  const tracked = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracked-barcodes.json'), 'utf8')).barcodes;
  const keep = new Set(tracked);
  // Local mode: parse pre-downloaded files from $PRICES_CACHE/<chainId>/ (a
  // Stores file + <storeId>.gz PriceFull + optional <storeId>.promo.gz PromoFull
  // files), used by gen-prices-local.ps1.
  const cacheDir = process.env.PRICES_CACHE;
  const fromCache = (ch) => {
    const dir = path.join(cacheDir, ch.chainId);
    const list = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    const sf = list.find((f) => /stores/i.test(f));
    const stores = sf ? parseStores(/\.gz$/.test(sf) ? gunzip(fs.readFileSync(path.join(dir, sf))) : decode(fs.readFileSync(path.join(dir, sf)))) : {};
    const prices = {}, promos = {};
    for (const f of list.filter((f) => /^\d+\.gz$/.test(f))) {
      const id = f.replace('.gz', '');
      try {
        const got = parsePrices(gunzip(fs.readFileSync(path.join(dir, f))), keep);
        if (!Object.keys(got).length) continue;
        prices[id] = got;
        const pf = path.join(dir, `${id}.promo.gz`);
        if (fs.existsSync(pf)) { const sale = parsePromos(gunzip(fs.readFileSync(pf)), keep, got); if (Object.keys(sale).length) promos[id] = sale; }
      } catch (e) { /* skip a corrupt/partial cached file */ }
    }
    return { stores, prices, promos };
  };

  const dest = path.join(__dirname, '..', 'prices.json');
  // Merge: start from the existing file and only replace a chain when this run
  // actually fetched prices for it. So CI (which can reach Shufersal but not the
  // login portals) keeps the cerberus chains last fetched from an Israeli IP,
  // and a local cerberus refresh keeps CI's full Shufersal data.
  let chains = {};
  try { chains = JSON.parse(fs.readFileSync(dest, 'utf8')).chains || {}; } catch (e) { chains = {}; }
  for (const ch of cfg.chains) {
    try {
      const res = cacheDir ? fromCache(ch)
        : ch.type === 'shufersal' ? await fetchShufersal(keep) : await fetchCerberus(ch, keep);
      if (Object.keys(res.prices).length) {
        chains[ch.name] = { stores: res.stores, prices: res.prices, promos: res.promos || {} };
        const nSale = Object.values(res.promos || {}).reduce((s, o) => s + Object.keys(o).length, 0);
        console.log(`[prices] ${ch.name}: ${Object.keys(res.stores).length} branches, prices for ${Object.keys(res.prices).length}, ${nSale} active sales`);
      } else {
        console.log(`[prices] ${ch.name}: no prices this run — kept ${chains[ch.name] ? 'existing' : 'nothing'}`);
      }
    } catch (e) { console.warn(`[prices] ${ch.name}: SKIPPED (${e.message}) — kept ${chains[ch.name] ? 'existing' : 'nothing'}`); }
  }
  fs.writeFileSync(dest, JSON.stringify({ updated: new Date().toISOString(), tracked, chains }));
  console.log(`[prices] wrote ${dest} (${Object.keys(chains).length} chains) in ${Date.now() - t0}ms`);
  if (!Object.keys(chains).length) process.exit(1);
})().catch((e) => { console.error('[prices] FAILED:', e.message); process.exit(1); });
