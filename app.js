/* ===== Smart Pantry — core brain (local-first) =====
 * localStorage is the source of truth in the browser. When Firebase is wired
 * (firebase-config.js), saveData() will also push to Firestore for household
 * real-time sync — same pattern as the finance-tracker app.
 */
(function (global) {
  'use strict';

  const LS_KEY = 'smartPantry_v1';

  // Store-route order — the shopping list is grouped & sorted by this so you
  // walk the supermarket once without backtracking.
  const CATEGORIES = [
    'ירקות ופירות',
    'מקרר (חלב, ביצים, גבינות)',
    'בשר ודגים',
    'קפואים',
    'יבשים ושימורים',
    'מאפים ולחם',
    'חטיפים ומתוקים',
    'משקאות',
    'ניקיון',
    'טואלטיקה',
    'אחר',
  ];

  const UNITS = ['יחידות', 'ק"ג', 'גרם', 'ליטר', 'מ"ל', 'חבילות', 'בקבוקים'];

  const CAT_EMOJI = {
    'ירקות ופירות': '🥬',
    'מקרר (חלב, ביצים, גבינות)': '🥛',
    'בשר ודגים': '🥩',
    'קפואים': '🧊',
    'יבשים ושימורים': '🥫',
    'מאפים ולחם': '🍞',
    'חטיפים ומתוקים': '🍫',
    'משקאות': '🧃',
    'ניקיון': '🧼',
    'טואלטיקה': '🧻',
    'אחר': '🛒',
  };
  // A few common items get their own icon; otherwise fall back to category.
  const NAME_EMOJI = [
    [/חלב/, '🥛'], [/ביצ/, '🥚'], [/לחם|פיתה/, '🍞'], [/עגבני/, '🍅'],
    [/מלפפון/, '🥒'], [/בננה/, '🍌'], [/תפוח/, '🍎'], [/גזר/, '🥕'],
    [/קפה/, '☕'], [/שמן/, '🫒'], [/אורז/, '🍚'], [/פסטה|מקרונ/, '🍝'],
    [/עוף|בשר/, '🍗'], [/דג/, '🐟'], [/גבינ/, '🧀'], [/יוגורט/, '🥣'],
    [/נייר טואלט/, '🧻'], [/סבון/, '🧼'], [/שוקולד/, '🍫'], [/מים/, '💧'],
  ];
  function itemEmoji(it) {
    for (const [re, e] of NAME_EMOJI) if (re.test(it.name)) return e;
    return CAT_EMOJI[it.category] || '🛒';
  }

  // Behavioral nudges surfaced contextually (from shopping-research).
  const TIPS = [
    { emoji: '🛒', text: 'עשו קנייה אחת מרוכזת בשבוע במקום הרבה קפיצות — פחות קניות אימפולסיביות.' },
    { emoji: '🍽️', text: 'אל תקנו כשאתם רעבים — זה מגדיל את הקניות המיותרות.' },
    { emoji: '🥕', text: 'קנו פירות וירקות "מכוערים" — אותו טעם, לרוב בזול.' },
    { emoji: '📦', text: 'קנו בכמות גדולה רק מה שבאמת תסיימו — אחרת זה בזבוז ולא חיסכון.' },
    { emoji: '♻️', text: 'פתחתם שקית גדולה? תכננו עוד שימוש לפני שהיא מתקלקלת.' },
    { emoji: '🧊', text: 'מה שלא תספיקו לאכול — הקפיאו במנות.' },
    { emoji: '📋', text: 'בדקו את המזווה לפני הקנייה — לא לקנות מה שכבר יש.' },
  ];

  let state = { items: [], updatedAt: null };
  const listeners = [];

  // ---------- persistence ----------
  function load() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        state = JSON.parse(raw);
        if (!Array.isArray(state.items)) state.items = [];
      } else {
        state = { items: seedItems(), updatedAt: new Date().toISOString() };
        persist();
      }
    } catch (e) {
      console.warn('[SmartPantry] load failed, starting fresh', e);
      state = { items: [], updatedAt: null };
    }
    return state;
  }

  function persist() {
    state.updatedAt = new Date().toISOString();
    repriceItems(); // keep prices fresh after add/update/qty changes (no-op until prices load)
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    // Firebase hook: if a cloud sync layer registered itself, push there too.
    if (typeof global.SP_cloudSave === 'function') {
      try { global.SP_cloudSave(state); } catch (e) { console.warn('[SmartPantry] cloud save failed', e); }
    }
    emit();
  }

  function onChange(fn) { listeners.push(fn); }
  function emit() { listeners.forEach((fn) => { try { fn(state); } catch (e) { console.error(e); } }); }

  /** Replace local state from an external source (e.g. Firestore listener). */
  function replaceState(next) {
    if (!next || !Array.isArray(next.items)) return;
    state = next;
    localStorage.setItem(LS_KEY, JSON.stringify(state));
    emit();
  }

  // ---------- item CRUD ----------
  function uid() { return 'i_' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4); }

  function getItems() { return state.items.slice(); }
  function getItem(id) { return state.items.find((x) => x.id === id) || null; }

  function addItem(data) {
    const item = {
      id: uid(),
      name: (data.name || '').trim(),
      category: data.category || 'אחר',
      unit: data.unit || 'יחידות',
      currentQty: num(data.currentQty, 0),
      minThreshold: num(data.minThreshold, 1),
      isStaple: !!data.isStaple,
      expiryDate: data.expiryDate || null,
      barcode: (data.barcode || '').trim(),
      neededManual: false,
      purchases: [],
      lastPrice: null,
      promo: false,
    };
    state.items.push(item);
    persist();
    return item;
  }

  function updateItem(id, patch) {
    const it = getItem(id);
    if (!it) return;
    Object.assign(it, patch);
    persist();
  }

  function removeItem(id) {
    state.items = state.items.filter((x) => x.id !== id);
    persist();
  }

  /** Mark "bought": set quantity, record a purchase (for prediction), clear manual flag. */
  function markPurchased(id, qty) {
    const it = getItem(id);
    if (!it) return;
    const buyQty = qty != null ? num(qty, it.minThreshold + 1) : Math.max(it.minThreshold + 1, it.currentQty);
    it.currentQty = buyQty;
    it.neededManual = false;
    it.purchases = it.purchases || [];
    it.purchases.push({ date: new Date().toISOString(), qty: buyQty });
    if (it.purchases.length > 24) it.purchases = it.purchases.slice(-24);
    persist();
  }

  /** Manually toggle "I need this" even if there's stock. */
  function toggleNeeded(id) {
    const it = getItem(id);
    if (!it) return;
    it.neededManual = !it.neededManual;
    persist();
  }

  function adjustQty(id, delta) {
    const it = getItem(id);
    if (!it) return;
    it.currentQty = Math.max(0, num(it.currentQty, 0) + delta);
    persist();
  }

  // ---------- derived smarts ----------
  function status(it) {
    const q = num(it.currentQty, 0);
    if (q <= 0) return 'out';
    if (q <= num(it.minThreshold, 0)) return 'low';
    return 'ok';
  }

  /** Is this on the shopping list? Below threshold OR manually flagged OR predicted to run out soon. */
  function isNeeded(it) {
    if (it.neededManual) return true;
    const s = status(it);
    if (s !== 'ok') return true;
    const d = predictedDaysLeft(it);
    return d != null && d <= 2;
  }

  /** Average days between purchases — the simple consumption-rate model. */
  function avgDaysBetween(it) {
    const p = (it.purchases || []).map((x) => new Date(x.date).getTime()).sort((a, b) => a - b);
    if (p.length < 2) return null;
    let sum = 0;
    for (let i = 1; i < p.length; i++) sum += (p[i] - p[i - 1]);
    const avgMs = sum / (p.length - 1);
    return avgMs / 86400000;
  }

  /** Predicted days until it runs out, based on last purchase + avg interval. */
  function predictedDaysLeft(it) {
    const avg = avgDaysBetween(it);
    if (avg == null) return null;
    const purchases = it.purchases || [];
    const last = new Date(purchases[purchases.length - 1].date).getTime();
    const runOut = last + avg * 86400000;
    return Math.round((runOut - Date.now()) / 86400000);
  }

  /** Days until expiry (null if no expiry set). */
  function daysToExpiry(it) {
    if (!it.expiryDate) return null;
    const d = new Date(it.expiryDate).getTime();
    return Math.ceil((d - Date.now()) / 86400000);
  }

  function isExpiringSoon(it, withinDays) {
    const d = daysToExpiry(it);
    return d != null && d <= (withinDays == null ? 3 : withinDays);
  }

  // ---------- shopping list (derived, grouped by store route) ----------
  function shoppingList() {
    const needed = state.items.filter(isNeeded);
    const byCat = {};
    needed.forEach((it) => { (byCat[it.category] = byCat[it.category] || []).push(it); });
    return CATEGORIES
      .filter((c) => byCat[c] && byCat[c].length)
      .map((c) => ({ category: c, items: byCat[c].sort((a, b) => rank(a) - rank(b)) }));
  }
  // out before low before predicted
  function rank(it) { const s = status(it); return s === 'out' ? 0 : s === 'low' ? 1 : 2; }

  // ---------- summary / tips ----------
  function summary() {
    const items = state.items;
    const ok = items.filter((i) => status(i) === 'ok').length;
    return {
      total: items.length,
      ok,
      // "How full is the house" — share of tracked items that are above threshold.
      fullnessPct: items.length ? Math.round((ok / items.length) * 100) : 100,
      out: items.filter((i) => status(i) === 'out').length,
      low: items.filter((i) => status(i) === 'low').length,
      expiring: items.filter((i) => isExpiringSoon(i)).length,
      promos: items.filter((i) => i.promo && isNeeded(i)).length,
      neededCount: items.filter(isNeeded).length,
    };
  }

  /** Savings & promo view for the insights screen. Real promo data arrives in
   *  Phase 1b (price XML); until then `amount` is whatever promo items carry. */
  function savingsSummary() {
    const promos = state.items.filter((i) => i.promo);
    let amount = 0;
    promos.forEach((i) => {
      if (i.regPrice != null && i.lastPrice != null) amount += Math.max(0, i.regPrice - i.lastPrice);
    });
    return { amount: Math.round(amount * 100) / 100, count: promos.length, items: promos };
  }

  // ---------- prices (Phase 1d — multi-chain, multi-store) ----------
  // prices.json v3: { updated, tracked, chains: { name: { stores:{id:{name}}, prices:{id:{bc:price}} } } }
  // Merged by barcode in memory only (never persisted). Each chain has a chosen
  // branch (user pick saved locally, else the first priced branch).
  let priceData = null;
  const STORE_SEL_KEY = 'sp_storeSel';
  let storeSel = {};
  try { storeSel = JSON.parse(localStorage.getItem(STORE_SEL_KEY)) || {}; } catch (e) { storeSel = {}; }

  function applyPrices(data) {
    if (!data || !data.chains) return;
    priceData = data;
    repriceItems();
    emit();
  }
  /** (Re)compute lastPrice/cheapestChain for every item from the loaded prices.
   *  Runs on price load AND after any item mutation (see persist), so a newly
   *  added item with a tracked barcode gets its price immediately. */
  function repriceItems() {
    if (!priceData) return;
    state.items.forEach((it) => {
      const c = cheapestFor(it.barcode);
      if (c) { it.lastPrice = c.price; it.cheapestChain = c.chain; it.onSale = !!c.onSale; it.saleWas = c.onSale ? c.regular : null; }
      else { it.lastPrice = null; it.cheapestChain = null; it.onSale = false; it.saleWas = null; }
    });
  }
  function priceInfo() {
    if (!priceData) return null;
    return { updated: priceData.updated, chains: Object.keys(priceData.chains) };
  }
  /** The branch used for a chain: the user's pick if it has prices, else the first priced branch. */
  function chainStoreId(name) {
    const c = priceData && priceData.chains[name];
    if (!c || !c.prices) return null;
    if (storeSel[name] && c.prices[storeSel[name]]) return storeSel[name];
    return Object.keys(c.prices)[0] || null;
  }
  function priceAt(name, bc) {
    const c = priceData && priceData.chains[name];
    const sid = chainStoreId(name);
    return c && sid && c.prices[sid] ? c.prices[sid][bc] : undefined;
  }
  /** Active sale {price, desc} for a barcode at a chain's branch, or null. */
  function promoAt(name, bc) {
    const c = priceData && priceData.chains[name];
    const sid = chainStoreId(name);
    const pm = c && sid && c.promos && c.promos[sid] ? c.promos[sid][bc] : undefined;
    return pm || null;
  }
  /** Effective unit price at a branch: the lower of regular and an active sale.
   *  Returns {price, regular, onSale, desc} or null when neither exists. */
  function effPriceAt(name, bc) {
    const reg = priceAt(name, bc);
    const pm = promoAt(name, bc);
    if (reg == null && !pm) return null;
    if (pm && (reg == null || pm.price < reg)) return { price: pm.price, regular: reg == null ? null : reg, onSale: true, desc: pm.desc };
    return { price: reg, regular: reg, onSale: false, desc: null };
  }
  /** Cheapest {chain, price, onSale, regular, desc} for a barcode across chains. */
  function cheapestFor(barcode) {
    const bc = (barcode || '').trim();
    if (!bc || !priceData) return null;
    let best = null;
    for (const name of Object.keys(priceData.chains)) {
      const e = effPriceAt(name, bc);
      if (e && e.price != null && (best == null || e.price < best.price)) best = { chain: name, ...e };
    }
    return best;
  }

  /** Compare the whole shopping basket across chains (at each chain's chosen branch):
   *  total + coverage per chain, cheapest fully-covering chain, saving vs priciest,
   *  and the "buy-each-where-cheapest" optimum. */
  function basketComparison() {
    if (!priceData) return null;
    const basket = [];
    state.items.filter(isNeeded).forEach((it) => {
      const bc = (it.barcode || '').trim();
      if (bc && cheapestFor(bc)) basket.push(bc);
    });
    if (!basket.length) return null;

    const rows = Object.keys(priceData.chains).map((name) => {
      let total = 0, covered = 0, sales = 0;
      basket.forEach((bc) => { const e = effPriceAt(name, bc); if (e && e.price != null) { total += e.price; covered++; if (e.onSale) sales++; } });
      return { name, total: Math.round(total * 100) / 100, covered, sales, store: currentStoreName(name) };
    }).sort((a, b) => (b.covered - a.covered) || (a.total - b.total));

    const full = rows.filter((r) => r.covered === basket.length);
    const ranked = (full.length ? full : rows).slice().sort((a, b) => a.total - b.total);
    const winner = ranked[0];
    const baseline = ranked[ranked.length - 1];
    const optimalTotal = Math.round(basket.reduce((s, bc) => s + cheapestFor(bc).price, 0) * 100) / 100;

    return {
      size: basket.length, rows, winner, baseline,
      saves: Math.round((baseline.total - winner.total) * 100) / 100,
      fullCoverage: full.length > 0, optimalTotal,
    };
  }

  // ---------- store selection (for the branch picker) ----------
  function chainNames() { return priceData ? Object.keys(priceData.chains) : []; }
  /** All branches of a chain: [{id, name, priced}] (priced = we have prices for it). */
  function storesFor(name) {
    const c = priceData && priceData.chains[name];
    if (!c) return [];
    return Object.entries(c.stores || {}).map(([id, s]) => ({ id, name: s.name, priced: !!(c.prices && c.prices[id]) }));
  }
  function currentStoreName(name) {
    const c = priceData && priceData.chains[name];
    const sid = chainStoreId(name);
    return c && sid && c.stores && c.stores[sid] ? c.stores[sid].name : null;
  }
  function getStoreSel() { return Object.assign({}, storeSel); }
  function setStore(name, id) {
    if (id) storeSel[name] = id; else delete storeSel[name];
    localStorage.setItem(STORE_SEL_KEY, JSON.stringify(storeSel));
    if (priceData) applyPrices(priceData);
  }

  function contextualTip() {
    const s = summary();
    if (s.expiring > 0) {
      return { emoji: '⏳', text: `יש ${s.expiring} מוצרים שמתקרבים לתפוגה — שווה לאכול אותם קודם כדי לא לזרוק.` };
    }
    // rotate by day-of-year so it feels fresh but stable within a day
    const day = Math.floor(Date.now() / 86400000);
    return TIPS[day % TIPS.length];
  }

  // ---------- utils ----------
  function num(v, d) { const n = parseFloat(v); return isNaN(n) ? d : n; }

  function seedItems() {
    const mk = (name, category, unit, currentQty, minThreshold, isStaple) => ({
      id: uid(), name, category, unit, currentQty, minThreshold, isStaple,
      expiryDate: null, barcode: '', neededManual: false, purchases: [], lastPrice: null, promo: false,
    });
    // Seed items carry real national-brand barcodes verified across all four
    // chains, so the multi-chain basket comparison works out of the box.
    const items = [
      mk('חלב טרי 2% דל לקטוז', 'מקרר (חלב, ביצים, גבינות)', 'ליטר', 0, 1, true),
      mk("קוטג'", 'מקרר (חלב, ביצים, גבינות)', 'יחידות', 1, 2, true),
      mk('שמן קנולה', 'יבשים ושימורים', 'בקבוקים', 0, 1, true),
      mk('במבה', 'חטיפים ומתוקים', 'יחידות', 0, 1, false),
      mk('קטשופ', 'יבשים ושימורים', 'בקבוקים', 0, 1, false),
      mk('קוקה קולה', 'משקאות', 'יחידות', 0, 2, false),
    ];
    const codes = ['7290000040974', '7290000041445', '7290000144474', '7290000066318', '7290000072623', '7290011018832'];
    items.forEach((it, i) => { it.barcode = codes[i]; });
    return items;
  }

  // ---------- public API ----------
  global.SP = {
    CATEGORIES, UNITS, TIPS, CAT_EMOJI, itemEmoji,
    load, persist, onChange, replaceState,
    getItems, getItem, addItem, updateItem, removeItem,
    markPurchased, toggleNeeded, adjustQty,
    status, isNeeded, avgDaysBetween, predictedDaysLeft, daysToExpiry, isExpiringSoon,
    shoppingList, summary, savingsSummary, contextualTip,
    applyPrices, priceInfo, cheapestFor, basketComparison,
    chainNames, storesFor, currentStoreName, getStoreSel, setStore,
  };
})(window);
