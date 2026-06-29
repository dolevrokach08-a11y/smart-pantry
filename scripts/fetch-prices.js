#!/usr/bin/env node
/* ===== Smart Pantry — multi-chain price fetcher (Phase 1c) =====
 *
 * Pulls per-store price files from several Israeli chains (חוק שקיפות מחירים),
 * keeps only the tracked national barcodes, and writes prices.json:
 *
 *   { updated, tracked:[...], chains: { "<name>": { store, prices:{barcode:price} } } }
 *
 * The app fetches it and, for each item, picks the cheapest chain + compares
 * the whole shopping basket across chains. No Firebase — plain GitHub Pages.
 *
 * Two source types (scripts/chains.json):
 *   - "shufersal": public portal https://prices.shufersal.co.il (no login)
 *   - "cerberus":  https://url.publishedprices.co.il — login with the public
 *                  credentials the transparency law mandates (empty password).
 *
 * Node 18+ (global fetch + zlib), zero npm deps. Runs in GitHub Actions; note
 * that on a Netspark-filtered local machine the publishedprices TLS handshake
 * fails in Node (the CI runner is unaffected) — see scripts/gen-prices-local.ps1.
 */
'use strict';

const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');

const SHUF = 'https://prices.shufersal.co.il';
const CERB = 'https://url.publishedprices.co.il';
const UA = { 'User-Agent': 'Mozilla/5.0 (SmartPantry price fetcher)' };

const RX = {
  item: /<Item>([\s\S]*?)<\/Item>/g,
  code: /<ItemCode>([\s\S]*?)<\/ItemCode>/,
  price: /<ItemPrice>([\s\S]*?)<\/ItemPrice>/,
  store: /<StoreI[dD]>([\s\S]*?)<\/StoreI[dD]>/,
  csrf: /name="csrftoken"\s+content="([^"]+)"/,
};

function parsePrices(xml, keep) {
  const out = {};
  for (const m of xml.matchAll(RX.item)) {
    const b = m[1];
    const code = (b.match(RX.code) || [, ''])[1].trim();
    if (!keep.has(code)) continue;
    const price = parseFloat((b.match(RX.price) || [, ''])[1]);
    if (price > 0) out[code] = Math.round(price * 100) / 100;
  }
  const store = (xml.match(RX.store) || [, ''])[1].trim();
  return { prices: out, store };
}

async function gunzipUrl(url, headers) {
  const r = await fetch(url, { headers: { ...UA, ...headers } });
  if (!r.ok) throw new Error(`GET ${url.slice(0, 60)} -> ${r.status}`);
  return zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8');
}

/* ---- Shufersal public portal ---- */
async function fetchShufersal(chain, keep) {
  const grid = await (await fetch(`${SHUF}/FileObject/UpdateCategory?catID=2&storeId=0`, { headers: UA })).text();
  const links = [...grid.matchAll(/href="([^"]+PriceFull[^"]+\.gz[^"]*)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const url = chain.store ? links.find((u) => u.includes(`-${chain.store}-`)) || links[0] : links[0];
  if (!url) throw new Error('no Shufersal PriceFull link');
  return parsePrices(await gunzipUrl(url, {}), keep);
}

/* ---- publishedprices.co.il (Cerberus) login + download ---- */
function cookieJar() {
  const jar = {};
  return {
    absorb(res) {
      const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
      for (const c of sc) { const [kv] = c.split(';'); const i = kv.indexOf('='); jar[kv.slice(0, i)] = kv.slice(i + 1); }
    },
    header() { return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; '); },
  };
}
async function fetchCerberus(chain, keep) {
  if (!chain.user) throw new Error('cerberus chain missing user');
  const jar = cookieJar();
  const get = async (u) => { const r = await fetch(u, { headers: { ...UA, Cookie: jar.header() } }); jar.absorb(r); return r; };
  const post = async (u, body) => {
    const r = await fetch(u, { method: 'POST', headers: { ...UA, Cookie: jar.header(), 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });
    jar.absorb(r); return r;
  };
  // 1) login page -> csrf, 2) submit login, 3) /file -> fresh csrf
  const csrf1 = (RX.csrf.exec(await (await get(`${CERB}/login`)).text()) || [, ''])[1];
  await post(`${CERB}/login/user`, { username: chain.user, password: '', csrftoken: csrf1 });
  const fileHtml = await (await get(`${CERB}/file`)).text();
  if (/name="username"/.test(fileHtml)) throw new Error(`login failed for ${chain.user}`);
  const csrf2 = (RX.csrf.exec(fileHtml) || [, ''])[1];
  // 4) list files (DataTables server-side)
  const dirRes = await post(`${CERB}/file/json/dir`, { sEcho: 1, iDisplayStart: 0, iDisplayLength: 100000, cd: '/', csrftoken: csrf2 });
  const rows = (JSON.parse(await dirRes.text()).aaData || []).map((r) => r.name).filter(Boolean);
  let pfs = rows.filter((n) => /^PriceFull/.test(n));
  if (chain.store) { const f = pfs.filter((n) => n.includes(`-${chain.store}-`)); if (f.length) pfs = f; }
  if (!pfs.length) throw new Error(`no PriceFull for ${chain.name}`);
  const name = pfs.sort().slice(-1)[0]; // newest by name (date suffix)
  return parsePrices(await gunzipUrl(`${CERB}/file/d/${name}`, { Cookie: jar.header() }), keep);
}

(async function main() {
  const t0 = Date.now();
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'chains.json'), 'utf8'));
  const tracked = JSON.parse(fs.readFileSync(path.join(__dirname, 'tracked-barcodes.json'), 'utf8')).barcodes;
  const keep = new Set(tracked);

  // Local mode: parse pre-downloaded files from $PRICES_CACHE/<chainId>.gz instead
  // of fetching (used by gen-prices-local.ps1 to work around Netspark TLS on dev).
  const cacheDir = process.env.PRICES_CACHE;
  const fromCache = (ch) => parsePrices(zlib.gunzipSync(fs.readFileSync(path.join(cacheDir, `${ch.chainId}.gz`))).toString('utf8'), keep);

  const chains = {};
  for (const ch of cfg.chains) {
    try {
      const res = cacheDir ? fromCache(ch)
        : ch.type === 'shufersal' ? await fetchShufersal(ch, keep) : await fetchCerberus(ch, keep);
      chains[ch.name] = { type: ch.type, store: res.store, prices: res.prices };
      console.log(`[prices] ${ch.name}: ${Object.keys(res.prices).length}/${tracked.length} tracked items (store ${res.store})`);
    } catch (e) {
      console.warn(`[prices] ${ch.name}: SKIPPED — ${e.message}`);
    }
  }

  const out = { updated: new Date().toISOString(), tracked, chains };
  const dest = path.join(__dirname, '..', 'prices.json');
  fs.writeFileSync(dest, JSON.stringify(out));
  console.log(`[prices] wrote ${dest} (${Object.keys(chains).length} chains) in ${Date.now() - t0}ms`);
  if (!Object.keys(chains).length) process.exit(1);
})().catch((e) => { console.error('[prices] FAILED:', e.message); process.exit(1); });
