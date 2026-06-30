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

  // ---------- prices (Phase 1e — full catalog, representative branch) ----------
  // prices.json v4: { updated, version:4, chains: { name: { store:{id,name},
  //   prices:{bc:price}, promos:{bc:{price,desc}} } } }. Every national product
  // is priced at one representative branch per chain, so ANY item the user adds
  // gets a price. Merged by barcode in memory only (never persisted).
  let priceData = null;

  function applyPrices(data) {
    if (!data || !data.chains) return;
    priceData = data;
    repriceItems();
    emit();
  }
  /** (Re)compute lastPrice/cheapestChain for every item from the loaded prices.
   *  Runs on price load AND after any item mutation (see persist), so a newly
   *  added item with a known barcode gets its price immediately. */
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
  function priceAt(name, bc) {
    const c = priceData && priceData.chains[name];
    return c && c.prices ? c.prices[bc] : undefined;
  }
  /** Active sale {price, desc} for a barcode at a chain, or null. */
  function promoAt(name, bc) {
    const c = priceData && priceData.chains[name];
    return (c && c.promos && c.promos[bc]) || null;
  }
  /** Effective unit price: the lower of regular and an active sale.
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

  /** Compare the basket across chains. Because each chain is priced at one
   *  representative branch and branches carry different SKUs, coverage varies —
   *  so the winner is ranked on the COMMON basket (items priced in EVERY chain),
   *  an apples-to-apples figure. Also returns each chain's full covered total +
   *  the split-shopping optimum (each item at its cheapest chain). */
  function basketComparison() {
    if (!priceData) return null;
    const chains = Object.keys(priceData.chains);
    const round2 = (x) => Math.round(x * 100) / 100;
    const basket = [];
    state.items.filter(isNeeded).forEach((it) => {
      const bc = (it.barcode || '').trim();
      if (bc && cheapestFor(bc)) basket.push(bc);
    });
    if (!basket.length) return null;

    // common = priced in every chain → comparable head-to-head
    const common = basket.filter((bc) => chains.every((name) => effPriceAt(name, bc)));

    const rows = chains.map((name) => {
      let total = 0, covered = 0, sales = 0, commonTotal = 0;
      basket.forEach((bc) => {
        const e = effPriceAt(name, bc);
        if (e && e.price != null) { total += e.price; covered++; if (e.onSale) sales++; if (common.includes(bc)) commonTotal += e.price; }
      });
      return { name, total: round2(total), covered, sales, commonTotal: round2(commonTotal), store: currentStoreName(name) };
    });

    const optimalTotal = round2(basket.reduce((s, bc) => s + cheapestFor(bc).price, 0));

    // rank by the common-basket total (only meaningful when there's a common set)
    const ranked = rows.slice().sort((a, b) => a.commonTotal - b.commonTotal);
    const winner = common.length ? ranked[0] : null;
    const baseline = common.length ? ranked[ranked.length - 1] : null;
    const rowsByCov = rows.slice().sort((a, b) => (b.covered - a.covered) || (a.total - b.total));

    return {
      size: basket.length, commonSize: common.length,
      rows: rowsByCov, winner, baseline,
      saves: winner ? round2(baseline.commonTotal - winner.commonTotal) : 0,
      optimalTotal,
    };
  }

  // ---------- chains / representative branches ----------
  function chainNames() { return priceData ? Object.keys(priceData.chains) : []; }
  /** The representative branch a chain's prices come from: {id, name} or null. */
  function chainStore(name) {
    const c = priceData && priceData.chains[name];
    return c && c.store ? c.store : null;
  }
  function currentStoreName(name) {
    const s = chainStore(name);
    return s ? s.name : null;
  }

  // ---------- name → barcode catalog ----------
  let catalog = []; // [[barcode, name], ...]
  function applyCatalog(data) { catalog = (data && Array.isArray(data.items)) ? data.items : []; }
  const normName = (s) => (s || '').toLowerCase()
    .replace(/[֑-ׇ]/g, '')          // strip Hebrew nikud/cantillation
    .replace(/["'`׳״.,()\/\-]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  /** Fuzzy name→product search over the catalog. Returns [{barcode, name}]. */
  function findByName(query, limit = 6) {
    const nq = normName(query);
    if (nq.length < 2 || !catalog.length) return [];
    const toks = nq.split(' ').filter((t) => t.length >= 2);
    if (!toks.length) return [];
    const out = [];
    for (let i = 0; i < catalog.length; i++) {
      const name = catalog[i][1];
      const nn = normName(name);
      const words = nn.split(' ');
      let score = 0, matched = 0;
      for (const t of toks) {
        if (words.includes(t)) { score += 3; matched++; }
        else if (nn.includes(t)) { score += 1; matched++; }
      }
      if (matched < toks.length) continue;       // require all query tokens to appear
      if (nn.startsWith(toks[0])) score += 2;     // prefer name starting with the query
      out.push({ barcode: catalog[i][0], name, score, len: name.length });
    }
    out.sort((a, b) => (b.score - a.score) || (a.len - b.len));
    return out.slice(0, limit).map(({ barcode, name }) => ({ barcode, name }));
  }
  function catalogSize() { return catalog.length; }

  // ---------- auto category (hybrid: instant keyword guess + optional AI) ----------
  // Instant, offline, no-key heuristic. Keyed first-match-wins; order matters
  // (fish before dry so "טונה טריה" → בשר ודגים but plain "טונה" → שימורים).
  const CAT_KEYWORDS = [
    ['בשר ודגים', /עוף|הודו|בשר|בקר|כבש|המבורגר|קבב|נקני|שניצל|פרגי|כנפי|שוקיים|חזה עוף|סלמון|דג |דגים|טונה טרי|פילה|לברק|דניס|אמנון|בורי|סינטה|אנטריקוט|צלי/],
    ['ירקות ופירות', /עגבני|מלפפון|גזר|בצל|תפוח אדמה|תפו"א|תפוח|בננה|לימון|פלפל|חסה|כרוב|בטטה|אבוקדו|תות|ענב|אבטיח|מלון|תפוז|קלמנטינ|שום|זנגביל|פטרוזיל|כוסבר|שמיר|נענע|סלק|דלעת|קישוא|חציל|פטריו|ברוקולי|כרובית|רימון|אגס|אפרסק|נקטרינ|שזיף|דובדבן|אננס|מנגו|קיווי|תאנ|תמר|רוקט|תרד|פטרוזי/],
    ['מקרר (חלב, ביצים, גבינות)', /חלב|גבינ|קוטג|יוגורט|שמנת|חמאה|ביצי|ביצה|לבן|אשל|מעדן|דנונה|מילקי|פודינג|טופו|לברנה|נפוליאון|פרש|גיל|יופלה|אקטימל|דניאלה/],
    ['קפואים', /קפוא|גליד|ארטיק|שלגון|מקלות קרח|פיצה קפוא|מלאווח|בצק עלים/],
    ['מאפים ולחם', /לחם|פיתה|לחמני|באגט|בגט|חלה|קרואסון|רוגלך|עוגת|עוגה|מאפה|בורקס|טורטיה|מצה|לאפה|כעך|דחיסה|ג'בטה/],
    ['חטיפים ומתוקים', /במבה|ביסלי|חטיף|שוקולד|סוכרי|ופל|עוגי|ביסקוויט|תפוצ|דגני בוקר|קורנפלקס|מסטיק|סוכריות|טופי|מרשמלו|פיצוחים|בוטנים|חטיפי|קליק|פסק זמן|כיף כף/],
    ['משקאות', /קולה|מיץ|משקה|סודה|בירה|יין|תה |נס קפה|אנרגי|ספרינג|שתיה|תרכיז|פריגת|נביעות|מים מינרל|מי עדן|איס טי|נביעה|מאלט/],
    ['ניקיון', /סבון כלים|אקונומיקה|ניקוי|מנקה|מטהר|אבקת כביסה|מרכך כביסה|ג'ל כביסה|ספוג|שקיות אשפה|שקית זבל|ניילון נצמד|כלור|סנו|מטליות|מגבוני רצפ|ריחן|בד טף/],
    ['טואלטיקה', /נייר טואלט|טואלט|מגבונ|שמפו|מרכך שיער|דאודורנט|משחת שיניים|מברשת שיניים|תחבושת|חיתול|טמפון|סבון רחצה|אפטר שייב|קרם גוף|ג'ל רחצה|מי פה|אביזרי גילוח/],
    ['יבשים ושימורים', /אורז|פסטה|מקרונ|ספגטי|קמח|סוכר|שמן|מלח|תבלי|שימור|טונה|רסק|קטשופ|מיונז|חומוס|טחינה|קטניו|עדש|שעועי|חומ|קוסקוס|פתית|דבש|ריבה|חומץ|רוטב|אבקת מרק|שקדי מרק|קורנפלור|סולת|בורגול|גריסים|אבקת אפי|שמרים|וניל|קקאו|נוטל/],
  ];
  function guessCategory(name) {
    const s = name || '';
    for (const [cat, re] of CAT_KEYWORDS) if (re.test(s)) return cat;
    return null;
  }

  // Optional AI refinement using the user's OWN Anthropic key, stored only in
  // this browser (never committed/sent anywhere but Anthropic) — same pattern
  // as finance-tracker's ai-assistant.js. Results cached per name to save calls.
  const AI_KEY_LS = 'sp_aiKey';
  const AI_CAT_CACHE = 'sp_catCache';
  const AI_MODEL = 'claude-haiku-4-5-20251001'; // fast + cheap for one-word classification
  function getAiKey() { try { return localStorage.getItem(AI_KEY_LS) || ''; } catch (e) { return ''; } }
  function setAiKey(k) { try { const v = (k || '').trim(); if (v) localStorage.setItem(AI_KEY_LS, v); else localStorage.removeItem(AI_KEY_LS); } catch (e) {} }
  function hasAiKey() { return !!getAiKey(); }
  let catCache = {};
  try { catCache = JSON.parse(localStorage.getItem(AI_CAT_CACHE)) || {}; } catch (e) { catCache = {}; }
  function cacheCat(name, cat) { catCache[normName(name)] = cat; try { localStorage.setItem(AI_CAT_CACHE, JSON.stringify(catCache)); } catch (e) {} }
  /** Classify a product name into one of CATEGORIES. Returns null when no key
   *  is set or the call fails (caller falls back to the heuristic / manual). */
  async function classifyCategory(name) {
    const q = (name || '').trim();
    if (q.length < 2) return null;
    const nn = normName(q);
    if (catCache[nn]) return catCache[nn];
    const key = getAiKey();
    if (!key) return null;
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: AI_MODEL,
          max_tokens: 24,
          system: 'סווג מוצר ישראלי (מזון/בית) לאחת מהקטגוריות הבאות בלבד. החזר אך ורק את שם הקטגוריה המדויק כפי שמופיע ברשימה, ללא הסבר וללא טקסט נוסף.\nהקטגוריות:\n' + CATEGORIES.join('\n'),
          messages: [{ role: 'user', content: q }],
        }),
      });
      if (!res.ok) { console.warn('[SmartPantry] AI classify HTTP', res.status); return null; }
      const j = await res.json();
      const out = ((j.content && j.content[0] && j.content[0].text) || '').trim();
      const match = CATEGORIES.find((c) => c === out)
        || CATEGORIES.find((c) => out.includes(c) || c.includes(out));
      if (match) { cacheCat(q, match); return match; }
      return null;
    } catch (e) { console.warn('[SmartPantry] AI classify failed', e); return null; }
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
    chainNames, chainStore, currentStoreName,
    applyCatalog, findByName, catalogSize,
    guessCategory, classifyCategory, getAiKey, setAiKey, hasAiKey, AI_MODEL,
  };
})(window);
