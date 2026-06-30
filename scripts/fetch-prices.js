#!/usr/bin/env node
/* ===== Smart Pantry — full-catalog multi-chain price fetcher (Phase 1e) =====
 *
 * For each chain we fetch ONE representative store's FULL price file and keep
 * every national (729-prefix) product — so ANY product the user adds gets a
 * price, not just a hand-picked tracked list. We also harvest product NAMES to
 * build catalog.json (the name→barcode index used by the add form).
 *
 *   prices.json:  { updated, version:4,
 *     chains: { "<name>": { store: {id,name},
 *                           prices: { "<barcode>": price },
 *                           promos: { "<barcode>": {price,desc} } } } }
 *   catalog.json: { updated, count, items: [[barcode, name], ...] }   (union of chains)
 *
 * Sources (scripts/chains.json): "shufersal" = public portal; "cerberus" =
 * publishedprices.co.il login (public creds, empty password). Optional per-chain
 * "store" pins the representative branch id; empty = first available.
 *
 * Node 18+, zero deps. CI reaches Shufersal but NOT publishedprices (geo-block),
 * so the cerberus chains are refreshed from an Israeli machine via
 * scripts/gen-prices-local.ps1; both paths MERGE (a chain is only replaced when
 * this run actually fetched it), so each keeps the other's chains intact.
 */
'use strict';
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SHUF = 'https://prices.shufersal.co.il';
const CERB = 'https://url.publishedprices.co.il';
const UA = { 'User-Agent': 'Mozilla/5.0 (SmartPantry price fetcher)' };
const NATIONAL = /^729\d{10}$/; // Israeli national 13-digit barcode (crosses chains)

const RX = {
  item: /<Item>([\s\S]*?)<\/Item>/g,
  code: /<ItemCode>([\s\S]*?)<\/ItemCode>/,
  name: /<ItemN[ma]me>([\s\S]*?)<\/ItemN[ma]me>/, // ItemName (some feeds: ItemNme)
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
/* Parse a PriceFull XML: keep every national product, returning its price and
 * (into `names`) its display name. out: { barcode: price }. */
function parseCatalog(xml, names) {
  const out = {};
  for (const m of xml.matchAll(RX.item)) {
    const body = m[1];
    const code = g1(body, RX.code);
    if (!NATIONAL.test(code)) continue;
    const p = parseFloat(g1(body, RX.price));
    if (!(p > 0)) continue;
    out[code] = Math.round(p * 100) / 100;
    if (names && !names[code]) { const nm = g1(body, RX.name).replace(/\s+/g, ' '); if (nm) names[code] = nm; }
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
/* Genuine single-unit SALES from a PromoFull XML, for the barcodes we priced.
 * Most "promotions" are coupon/club echoes (DiscountedPrice == regular), so we
 * keep only: active now, not a coupon, RewardType=1, MinQty<=1, and STRICTLY
 * below the store's regular price. out: { barcode: {price, desc} }. */
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

/* ---------- Shufersal (public) ---------- */
async function shufLink(catID, storeId, kind) {
  const grid = (await buf(`${SHUF}/FileObject/UpdateCategory?catID=${catID}&storeId=${storeId}`)).toString('utf8');
  return [...grid.matchAll(/href="([^"]+\.gz[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&')).find((u) => u.includes(kind));
}
async function fetchShufersal(chain, names) {
  const stores = parseStores(gunzip(await buf(await shufLink(5, 0, 'Stores'))));
  const repId = (chain.store && stores[chain.store]) ? chain.store : Object.keys(stores)[0];
  if (!repId) throw new Error('no stores');
  const link = await shufLink(2, repId, 'PriceFull');
  if (!link) throw new Error('no PriceFull for rep store');
  const prices = parseCatalog(gunzip(await buf(link)), names);
  let promos = {};
  const plink = await shufLink(4, repId, 'PromoFull');
  if (plink) promos = parsePromos(gunzip(await buf(plink)), new Set(Object.keys(prices)), prices);
  return { store: { id: repId, name: (stores[repId] || {}).name || '' }, prices, promos };
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
async function fetchCerberus(chain, names) {
  const { cookie, files } = await cerberusSession(chain.user);
  const dl = (name) => buf(`${CERB}/file/d/${name}`, { Cookie: cookie() });
  const storesFile = files.find((n) => /Stores/.test(n));
  const stores = storesFile ? parseStores(decode(await dl(storesFile))) : {};
  // newest PriceFull / PromoFull per store id (store id = dash-delimited token after the chain id)
  const idOf = (n) => (n.match(new RegExp(`${chain.chainId}-(?:\\d+-)?0*(\\d+)-`)) || [, ''])[1];
  const newestByStore = (re) => {
    const m = {};
    for (const n of files.filter((f) => re.test(f))) { const id = idOf(n); if (id && (!m[id] || n > m[id])) m[id] = n; }
    return m;
  };
  const pfByStore = newestByStore(/^PriceFull/);
  const promoByStore = newestByStore(/^PromoFull/);
  const repId = (chain.store && pfByStore[chain.store]) ? chain.store : Object.keys(pfByStore)[0];
  if (!repId) throw new Error('no PriceFull files');
  const prices = parseCatalog(gunzip(await dl(pfByStore[repId])), names);
  let promos = {};
  if (promoByStore[repId]) promos = parsePromos(gunzip(await dl(promoByStore[repId])), new Set(Object.keys(prices)), prices);
  return { store: { id: repId, name: (stores[repId] || {}).name || '' }, prices, promos };
}

/* ---------- local cache mode (gen-prices-local.ps1) ---------- */
// Parse pre-downloaded files from $PRICES_CACHE/<chainId>/: a Stores file + the
// representative <storeId>.gz PriceFull (+ optional <storeId>.promo.gz). If
// several stores were cached, the first is used as the representative.
function fromCache(cacheDir, ch, names) {
  const dir = path.join(cacheDir, ch.chainId);
  const list = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const sf = list.find((f) => /stores/i.test(f));
  const stores = sf ? parseStores(/\.gz$/.test(sf) ? gunzip(fs.readFileSync(path.join(dir, sf))) : decode(fs.readFileSync(path.join(dir, sf)))) : {};
  const priceFiles = list.filter((f) => /^\d+\.gz$/.test(f)).sort();
  for (const f of priceFiles) {
    const id = f.replace('.gz', '');
    try {
      const prices = parseCatalog(gunzip(fs.readFileSync(path.join(dir, f))), names);
      if (!Object.keys(prices).length) continue;
      let promos = {};
      const pf = path.join(dir, `${id}.promo.gz`);
      if (fs.existsSync(pf)) promos = parsePromos(gunzip(fs.readFileSync(pf)), new Set(Object.keys(prices)), prices);
      return { store: { id, name: (stores[id] || {}).name || '' }, prices, promos };
    } catch (e) { /* skip a corrupt/partial cached file, try next */ }
  }
  throw new Error('no usable cached PriceFull');
}

(async function main() {
  const t0 = Date.now();
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'chains.json'), 'utf8'));
  const cacheDir = process.env.PRICES_CACHE;

  const dest = path.join(__dirname, '..', 'prices.json');
  const catDest = path.join(__dirname, '..', 'catalog.json');
  // Merge: seed chains + catalog names from the existing files; only replace a
  // chain we actually fetched this run (CI=Shufersal, local=cerberus).
  let chains = {};
  try { chains = JSON.parse(fs.readFileSync(dest, 'utf8')).chains || {}; } catch (e) { chains = {}; }
  const names = {};
  try { for (const [b, n] of (JSON.parse(fs.readFileSync(catDest, 'utf8')).items || [])) names[b] = n; } catch (e) {}

  for (const ch of cfg.chains) {
    try {
      const res = cacheDir ? fromCache(cacheDir, ch, names)
        : ch.type === 'shufersal' ? await fetchShufersal(ch, names) : await fetchCerberus(ch, names);
      const n = Object.keys(res.prices).length;
      if (n) {
        chains[ch.name] = { store: res.store, prices: res.prices, promos: res.promos || {} };
        const nSale = Object.keys(res.promos || {}).length;
        console.log(`[prices] ${ch.name}: store ${res.store.id} "${res.store.name}", ${n} products, ${nSale} sales`);
      } else {
        console.log(`[prices] ${ch.name}: no prices this run — kept ${chains[ch.name] ? 'existing' : 'nothing'}`);
      }
    } catch (e) { console.warn(`[prices] ${ch.name}: SKIPPED (${e.message}) — kept ${chains[ch.name] ? 'existing' : 'nothing'}`); }
  }

  fs.writeFileSync(dest, JSON.stringify({ updated: new Date().toISOString(), version: 4, chains }));
  const items = Object.entries(names).map(([b, n]) => [b, n]);
  fs.writeFileSync(catDest, JSON.stringify({ updated: new Date().toISOString(), count: items.length, items }));
  const sizeKB = (s) => (fs.statSync(s).size / 1024).toFixed(0);
  console.log(`[prices] wrote prices.json (${Object.keys(chains).length} chains, ${sizeKB(dest)}KB) + catalog.json (${items.length} products, ${sizeKB(catDest)}KB) in ${Date.now() - t0}ms`);
  if (!Object.keys(chains).length) process.exit(1);
})().catch((e) => { console.error('[prices] FAILED:', e.message); process.exit(1); });
