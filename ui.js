/* ===== Smart Pantry — SPA UI controller (premium redesign) ===== */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const VIEWS = ['home', 'list', 'pantry', 'insights'];
  let tab = 'home';
  const pf = { search: '', cat: '', lowOnly: false };

  const HEB_MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
  function greeting() { const h = new Date().getHours(); return h < 12 ? 'בוקר טוב ☀️' : h < 18 ? 'צהריים טובים ☀️' : 'ערב טוב 🌙'; }
  function hebMonthYear() { const d = new Date(); return `${HEB_MONTHS[d.getMonth()]} ${d.getFullYear()}`; }
  function shortCat(c) { return String(c).split(' ')[0]; }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1700);
  }

  // ---------- shared bits ----------
  function badgeClass(it) {
    const s = SP.status(it);
    if (s === 'out') return 'out';
    if (s === 'low') return 'low';
    if (SP.isExpiringSoon(it)) return 'expiry';
    if (it.isStaple) return 'ok';
    return '';
  }
  // right-side status pill on a list row
  function rightPill(it) {
    const s = SP.status(it);
    if (s === 'out') return '<span class="badge out status-pill">נגמר</span>';
    if (s === 'low') return '<span class="badge low status-pill">עומד להיגמר</span>';
    if (SP.isExpiringSoon(it)) { const d = SP.daysToExpiry(it); return `<span class="badge expiry status-pill">⏳ ${d <= 0 ? 'פג תוקף' : 'תפוגה ' + d + ' י׳'}</span>`; }
    const pd = SP.predictedDaysLeft(it);
    if (pd != null && pd <= 2) return '<span class="badge predict status-pill">חיזוי</span>';
    return '';
  }
  // inline meta badges next to a name (pantry)
  function metaBadges(it) {
    let b = '';
    if (it.isStaple) b += '<span class="badge staple">קבוע</span>';
    if (SP.status(it) === 'out') b += '<span class="badge out">נגמר</span>';
    else if (SP.status(it) === 'low') b += '<span class="badge low">חסר</span>';
    if (SP.isExpiringSoon(it)) { const d = SP.daysToExpiry(it); b += `<span class="badge expiry">⏳ ${d <= 0 ? 'פג' : 'תפוגה ' + d + ' י׳'}</span>`; }
    return b;
  }
  function gaugeSvg(pct) {
    const dash = Math.round(691 * (1 - Math.max(0, Math.min(100, pct)) / 100));
    return `<div class="gauge">
      <svg viewBox="0 0 260 260"><circle class="track" cx="130" cy="130" r="110"/><circle class="prog" cx="130" cy="130" r="110" style="--dash:${dash}px"/></svg>
      <div class="center"><span class="pct">${pct}<small>%</small></span><span class="gl">הבית מלא</span></div>
    </div>`;
  }
  function previewRow(it) {
    return `<div class="item" data-go="list">
      <div class="emoji-badge ${badgeClass(it)}">${SP.itemEmoji(it)}</div>
      <div class="item-main"><div class="item-name">${esc(it.name)}</div><div class="item-sub">${subText(it)}</div></div>
      ${rightPill(it)}
    </div>`;
  }
  function subText(it) {
    let s = `יש: ${it.currentQty} ${esc(it.unit)}`;
    if (it.lastPrice != null) {
      s += it.promo
        ? ` · <span class="promo-price">₪${it.lastPrice} במבצע</span>`
        : ` · <span class="price-tag">₪${it.lastPrice}</span>`;
    }
    return s;
  }

  // ---------- view: HOME ----------
  function renderHome() {
    const s = SP.summary();
    const sav = SP.savingsSummary();
    const pct = s.fullnessPct;
    const title = pct >= 80 ? 'מצב מלא 👌' : pct >= 55 ? 'מצב טוב 👌' : pct >= 30 ? 'כדאי להשלים 🛒' : 'המזווה מתרוקן 🛒';
    const desc = `רוב הבסיס ${pct >= 55 ? 'קיים' : 'חסר'}. <b>${s.out} מוצרים</b> נגמרו ו־<b>${s.low}</b> עומדים להיגמר.`;

    const flat = [];
    SP.shoppingList().forEach((g) => g.items.forEach((it) => flat.push(it)));
    const preview = flat.slice(0, 3);

    const savAmt = sav.amount > 0 ? `₪${sav.amount}` : '₪0';
    const savGo = sav.count > 0 ? `${sav.count} מבצעים →` : 'מחירים בקרוב →';

    const previewBlock = preview.length
      ? `<div class="row-head"><span class="h">צריך לקנות</span><span class="link" data-go="list">לרשימה המלאה →</span></div>
         <div class="items" style="margin-top:10px">${preview.map(previewRow).join('')}</div>`
      : `<div class="row-head"><span class="h">צריך לקנות</span></div>
         <div class="empty" style="padding:30px 10px"><div class="big">🎉</div><div class="t">הכול מלא — אין מה לקנות כרגע</div></div>`;

    $('#view-home').innerHTML = `
      <div class="home-grid">
        <div class="home-main">
          <div class="gauge-card">
            ${gaugeSvg(pct)}
            <div class="gauge-info">
              <div class="title">${title}</div>
              <div class="desc">${desc}</div>
              <div class="trend">📈 ${s.neededCount} ברשימה</div>
            </div>
          </div>
          <div class="stat-chips">
            <div class="stat-chip"><div class="n c-out">${s.out}</div><div class="t">נגמרו</div></div>
            <div class="stat-chip"><div class="n c-low">${s.low}</div><div class="t">עומדים להיגמר</div></div>
            <div class="stat-chip"><div class="n c-exp">${s.expiring}</div><div class="t">לקראת תפוגה</div></div>
          </div>
          <div class="savings-banner" data-go="insights">
            <div class="ic">💰</div>
            <div><div class="lbl">חסכת החודש</div><div class="amt">${savAmt}</div></div>
            <div class="go">${savGo}</div>
          </div>
        </div>
        <div class="home-side">
          ${previewBlock}
          <button class="btn home-side-cta" data-go="list">לרשימה המלאה →</button>
        </div>
      </div>`;
  }

  // ---------- view: SHOPPING LIST ----------
  function renderList() {
    const s = SP.summary();
    const groups = SP.shoppingList();
    const tip = SP.contextualTip();

    let body;
    if (!groups.length) {
      body = '<div class="empty"><div class="big">🎉</div><div class="t">הכול מלא — אין מה לקנות כרגע</div></div>';
      $('#view-list').innerHTML = body;
      return;
    }
    body = groups.map((g) => `
      <div class="section-title"><span>${SP.CAT_EMOJI[g.category] || ''} ${g.category}</span><span class="line"></span></div>
      <div class="items">
        ${g.items.map((it) => `
          <div class="item">
            <button class="check" data-buy="${it.id}" aria-label="קניתי"></button>
            <div class="emoji-badge ${badgeClass(it)}">${SP.itemEmoji(it)}</div>
            <div class="item-main">
              <div class="item-name">${esc(it.name)}</div>
              <div class="item-sub">${subText(it)}</div>
            </div>
            ${rightPill(it)}
          </div>`).join('')}
      </div>`).join('');

    $('#view-list').innerHTML = `
      <div class="list-head"><span></span><span class="count">${s.neededCount} פריטים</span></div>
      <button class="btn list-cta" id="enterShop"><span style="font-size:20px">🛒</span> צא לקנייה במצב חכם <span>←</span></button>
      <div class="tip"><span class="emoji">${tip.emoji}</span><span>${tip.text}</span></div>
      ${body}`;
  }

  // ---------- view: PANTRY ----------
  function renderPantry() {
    let items = SP.getItems();
    if (pf.search) items = items.filter((i) => i.name.includes(pf.search.trim()));
    if (pf.cat) items = items.filter((i) => i.category === pf.cat);
    if (pf.lowOnly) items = items.filter((i) => SP.isNeeded(i));

    const chips = `
      <input class="search" id="search" type="text" placeholder="🔍 חיפוש מוצר…" value="${esc(pf.search)}" />
      <div class="filters">
        <span class="chip warn ${pf.lowOnly ? 'on' : ''}" data-filter="low">⚠ רק מה שחסר</span>
        <span class="chip ${pf.cat === '' && !pf.lowOnly ? 'on' : ''}" data-cat="">הכול</span>
        ${SP.CATEGORIES.map((c) => `<span class="chip ${pf.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${SP.CAT_EMOJI[c]}</span>`).join('')}
      </div>`;

    let body;
    if (!items.length) {
      body = '<div class="empty"><div class="big">🥫</div><div class="t">אין מוצרים להצגה</div></div>';
    } else {
      const byCat = {};
      items.forEach((it) => { (byCat[it.category] = byCat[it.category] || []).push(it); });
      body = SP.CATEGORIES.filter((c) => byCat[c]).map((c) => `
        <div class="section-title"><span>${SP.CAT_EMOJI[c]} ${c}</span><span class="line"></span></div>
        <div class="items">
          ${byCat[c].map((it) => `
            <div class="item">
              <div class="emoji-badge ${badgeClass(it)}">${SP.itemEmoji(it)}</div>
              <div class="item-main" data-edit="${it.id}">
                <div class="item-name">${esc(it.name)} ${metaBadges(it)}</div>
                <div class="item-sub">סף: ${it.minThreshold} ${esc(it.unit)}</div>
              </div>
              <div class="stepper ${SP.status(it) === 'out' ? 'is-out' : ''}">
                <button data-dec="${it.id}">−</button>
                <span class="val">${it.currentQty}</span>
                <button data-inc="${it.id}">＋</button>
              </div>
            </div>`).join('')}
        </div>`).join('');
    }
    $('#view-pantry').innerHTML = chips + body;
  }

  // ---------- view: INSIGHTS (savings & prices) ----------
  function purchasesByMonth() {
    // real data: count purchases per month across all items, last 6 months
    const now = new Date();
    const buckets = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      buckets.push({ y: d.getFullYear(), m: d.getMonth(), label: HEB_MONTHS[d.getMonth()].slice(0, 3), count: 0 });
    }
    SP.getItems().forEach((it) => (it.purchases || []).forEach((p) => {
      const d = new Date(p.date);
      const b = buckets.find((x) => x.y === d.getFullYear() && x.m === d.getMonth());
      if (b) b.count++;
    }));
    return buckets;
  }
  function renderInsights() {
    const sav = SP.savingsSummary();
    const amt = sav.amount;
    const heroAmt = amt > 0 ? `₪${Math.floor(amt)}<small>.${String(Math.round((amt % 1) * 100)).padStart(2, '0')}</small>` : '₪0';
    const heroDelta = amt > 0 ? '<div class="delta">↑ חיסכון פעיל החודש</div>' : '';
    const heroLbl = amt > 0 ? 'חסכת החודש בזכות מבצעים' : 'החיסכון יצטבר כשנחבר מחירי הרשתות';

    const buckets = purchasesByMonth();
    const max = Math.max(1, ...buckets.map((b) => b.count));
    const bars = buckets.map((b, i) => {
      const h = Math.max(8, Math.round((b.count / max) * 80));
      const now = i === buckets.length - 1;
      return `<div class="col ${now ? 'now' : ''}"><div class="bar" style="height:${h}px"></div><span class="m">${b.label}</span></div>`;
    }).join('');

    const promos = sav.items;
    let promoBlock;
    if (promos.length) {
      promoBlock = `<div class="items" style="margin-top:10px">${promos.map((it) => `
        <div class="item promo-card">
          <div class="emoji-badge ${badgeClass(it)}">${SP.itemEmoji(it)}</div>
          <div class="item-main"><div class="item-name">${esc(it.name)}</div><div class="item-sub">${esc(shortCat(it.category))}</div></div>
          <div class="price"><div class="now">${it.lastPrice != null ? '₪' + it.lastPrice : 'מבצע'}</div>${it.regPrice != null ? `<div class="was">₪${it.regPrice}</div>` : ''}</div>
        </div>`).join('')}</div>`;
    } else {
      promoBlock = `<div class="empty" style="padding:30px 10px"><div class="big">🔥</div><div class="t">אין מבצעים פעילים כרגע<br><span style="font-size:13px">מחירים ומבצעים יתווספו אוטומטית כשנחבר את נתוני הרשתות</span></div></div>`;
    }

    $('#view-insights').innerHTML = `
      <div class="savings-hero">
        <div class="ghost">💰</div>
        <div class="lbl">${heroLbl}</div>
        <div class="amt">${heroAmt}</div>
        ${heroDelta}
      </div>
      <div class="panel">
        <div class="panel-head"><span class="h">פעילות קנייה</span><span class="s">6 חודשים</span></div>
        <div class="barchart">${bars}</div>
      </div>
      <div class="row-head"><span class="h">🔥 מבצעים על מה שחסר</span>${promos.length ? `<span class="promo-count">${promos.length}</span>` : ''}</div>
      ${promoBlock}
      ${priceSourceLine()}`;
  }
  function priceSourceLine() {
    const m = SP.priceInfo && SP.priceInfo();
    if (!m) return '';
    const when = m.updated ? new Date(m.updated).toLocaleDateString('he-IL') : '';
    return `<div class="price-source">💲 מחירים מ־<b>${esc(m.chain)}${m.storeName ? ' · ' + esc(m.storeName) : ''}</b>${when ? ' · עודכן ' + when : ''}</div>`;
  }

  // ---------- SHOPPING MODE (full-screen) ----------
  const shop = { ids: [], collected: {} };
  function enterShop() {
    const flat = [];
    SP.shoppingList().forEach((g) => g.items.forEach((it) => flat.push(it.id)));
    if (!flat.length) { toast('הרשימה ריקה 🎉'); return; }
    shop.ids = flat; shop.collected = {};
    $('#shopmode').hidden = false;
    document.body.style.overflow = 'hidden';
    renderShop();
  }
  function exitShop() {
    $('#shopmode').hidden = true;
    document.body.style.overflow = '';
    removeConfetti();
  }
  function renderShop() {
    const items = shop.ids.map((id) => SP.getItem(id)).filter(Boolean);
    const total = items.length;
    const done = items.filter((it) => shop.collected[it.id]).length;
    const pct = total ? Math.round((done / total) * 100) : 0;
    const allDone = total > 0 && done === total;

    let cart = 0, hasPrice = false;
    items.forEach((it) => { if (shop.collected[it.id] && it.lastPrice != null) { cart += it.lastPrice; hasPrice = true; } });

    // collected items sink to the bottom
    const ordered = items.slice().sort((a, b) => (shop.collected[a.id] ? 1 : 0) - (shop.collected[b.id] ? 1 : 0));
    const rows = ordered.map((it) => {
      const d = !!shop.collected[it.id];
      let price = '';
      if (it.lastPrice != null) price = it.promo ? `<span class="sm-price promo">₪${it.lastPrice} 🔥</span>` : `<span class="sm-price">₪${it.lastPrice}</span>`;
      return `<div class="sm-item ${d ? 'done' : ''}">
        <button class="sm-check" data-collect="${it.id}" aria-label="נאסף"></button>
        <div class="sm-emoji">${SP.itemEmoji(it)}</div>
        <div class="sm-main"><div class="sm-name">${esc(it.name)}</div><div class="sm-meta">${d ? 'בעגלה' : esc(it.unit) + ' · ' + esc(shortCat(it.category))}</div></div>
        ${price}
      </div>`;
    }).join('');

    const celebrate = allDone
      ? `<div class="sm-celebrate"><div class="em">🎉</div><div class="h">סיימת את הקנייה!</div><div class="s">כל הכבוד — לחצו לעדכן את המזווה.</div></div>`
      : '';

    $('#shopmode').innerHTML = `
      <div class="sm-header">
        <div class="sm-top"><button class="sm-close" id="exitShop">✕ סיום קנייה</button><span class="sm-store">מצב קנייה חכם</span></div>
        <div class="sm-progress-num">${done} מתוך ${total} נאספו</div>
        <div class="sm-bar"><i style="width:${pct}%"></i></div>
        <div class="sm-sub">עוד ${total - done} פריטים${hasPrice ? ' · בערך ₪' + Math.round(cart) + ' בעגלה' : ''}</div>
      </div>
      <div class="sm-list">
        ${rows}
        ${celebrate}
        <div class="sm-finish"><button class="btn ${allDone ? '' : 'dark'}" id="finishShop">${allDone ? '🎉 סיימתי — עדכן את המזווה' : 'סיימתי — עדכן את המזווה'}</button></div>
      </div>`;

    if (allDone) launchConfetti();
  }
  function finishShop() {
    const collected = shop.ids.filter((id) => shop.collected[id]);
    collected.forEach((id) => SP.markPurchased(id));
    exitShop();
    toast(collected.length ? `✓ עודכנו ${collected.length} מוצרים במזווה` : 'לא נאסף כלום');
  }

  // confetti
  const CONFETTI_COLORS = ['#FFC53D', '#FF7A3D', '#23A85F', '#E0518A'];
  function launchConfetti() {
    if (document.getElementById('confetti')) return;
    const wrap = document.createElement('div');
    wrap.className = 'confetti'; wrap.id = 'confetti';
    let html = '';
    for (let i = 0; i < 14; i++) {
      const left = Math.round(Math.random() * 92) + 3;
      const dur = (2.2 + Math.random() * 1.4).toFixed(2);
      const delay = (Math.random() * 1.6).toFixed(2);
      const color = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      const shape = i % 2 ? 'c' : 'r';
      html += `<i class="${shape}" style="left:${left}%;background:${color};animation:confettiFall ${dur}s linear ${delay}s infinite"></i>`;
    }
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
  }
  function removeConfetti() { const c = document.getElementById('confetti'); if (c) c.remove(); }

  // ---------- sheets ----------
  function openSheet(html) {
    $('#sheet').innerHTML = '<div class="grabber"></div>' + html;
    $('#sheet').classList.add('open'); $('#backdrop').classList.add('open');
  }
  function closeSheet() { $('#sheet').classList.remove('open'); $('#backdrop').classList.remove('open'); }

  function catOptions(sel) { return SP.CATEGORIES.map((c) => `<option ${c === sel ? 'selected' : ''}>${c}</option>`).join(''); }
  function unitOptions(sel) { return SP.UNITS.map((u) => `<option ${u === sel ? 'selected' : ''}>${u}</option>`).join(''); }

  function formFields(it) {
    it = it || { name: '', category: 'אחר', unit: 'יחידות', currentQty: 1, minThreshold: 1, expiryDate: '', barcode: '', isStaple: false };
    return `
      <div class="field"><label>שם המוצר</label><input type="text" id="s-name" value="${esc(it.name)}" placeholder="למשל: יוגורט" /></div>
      <div class="field-row">
        <div class="field"><label>קטגוריה</label><select id="s-cat">${catOptions(it.category)}</select></div>
        <div class="field"><label>יחידה</label><select id="s-unit">${unitOptions(it.unit)}</select></div>
      </div>
      <div class="field-row">
        <div class="field"><label>כמות נוכחית</label><input type="number" id="s-qty" value="${it.currentQty}" min="0" step="0.5" /></div>
        <div class="field"><label>סף מינימום</label><input type="number" id="s-min" value="${it.minThreshold}" min="0" step="0.5" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>תפוגה (לא חובה)</label><input type="date" id="s-exp" value="${it.expiryDate ? String(it.expiryDate).slice(0, 10) : ''}" /></div>
        <div class="field"><label>ברקוד (לא חובה)</label><input type="text" id="s-barcode" value="${esc(it.barcode || '')}" placeholder="למחירים" /></div>
      </div>
      <div class="switch-row"><span>מוצר קבוע (תמיד שיהיה בבית)</span>
        <span class="switch"><input type="checkbox" id="s-staple" ${it.isStaple ? 'checked' : ''} /></span></div>`;
  }
  function readForm() {
    return {
      name: $('#s-name').value.trim(), category: $('#s-cat').value, unit: $('#s-unit').value,
      currentQty: parseFloat($('#s-qty').value) || 0, minThreshold: parseFloat($('#s-min').value) || 0,
      expiryDate: $('#s-exp').value || null, barcode: $('#s-barcode').value.trim(), isStaple: $('#s-staple').checked,
    };
  }
  function addSheet() {
    openSheet(`<h2>הוספת מוצר</h2>${formFields()}<button class="btn" id="s-add">הוסף למזווה</button>`);
    setTimeout(() => $('#s-name') && $('#s-name').focus(), 250);
  }
  function editSheet(id) {
    const it = SP.getItem(id); if (!it) return;
    openSheet(`<h2>עריכת מוצר</h2>${formFields(it)}
      <button class="btn" id="s-save" data-id="${id}">שמירה</button>
      <button class="btn danger" id="s-del" data-id="${id}" style="margin-top:10px">מחיקת מוצר</button>`);
  }

  // settings sheet (opened from header avatar)
  let deferredInstall = null;
  function installHintHtml() {
    if (deferredInstall) return '<div class="install-hint"><span style="font-size:20px">📲</span><div>אפשר להתקין את האפליקציה למסך הבית — <a href="#" id="installBtn">התקנה</a></div></div>';
    return '<div class="install-hint"><span style="font-size:20px">📲</span><div>הוסיפו למסך הבית (שיתוף → הוסף למסך הבית) כדי שירוץ כמו אפליקציה.</div></div>';
  }
  function settingsSheet() {
    const s = SP.summary();
    const fbStatus = (window.SP_cloudSave) ? 'פעיל ✓' : 'כבוי (מקומי בלבד)';
    openSheet(`
      <h2>הגדרות</h2>
      ${installHintHtml()}
      <div class="menu-item"><div class="h">📊 סטטיסטיקה</div>
        <div class="item-sub">${s.total} מוצרים במעקב · ${s.neededCount} ברשימה · ${s.expiring} לקראת תפוגה · הבית מלא ${s.fullnessPct}%</div></div>
      <div class="menu-item"><div class="h">☁️ סנכרון בית</div>
        <div class="item-sub">${fbStatus} — למלא את firebase-config.js כדי לסנכרן בין כל המכשירים בבית בזמן אמת.</div></div>
      <div class="menu-item"><div class="h">💡 איך זה עובד</div>
        <div class="item-sub">לכל מוצר יש סף מינימום. כשהכמות יורדת מתחת לסף הוא קופץ אוטומטית לרשימה. המערכת לומדת את קצב הצריכה ומזכירה עוד לפני שנגמר.</div></div>
      <button class="btn danger sm" id="resetBtn" style="margin-top:8px">איפוס נתונים</button>`);
  }

  // ---------- tab switching ----------
  function setHeader(name) {
    const eb = { home: greeting(), list: 'נבנתה אוטומטית · ממוינת לפי מסלול הסופר', pantry: `${SP.summary().total} מוצרים במעקב`, insights: hebMonthYear() }[name];
    const t = { home: 'המזווה שלך', list: 'רשימת קניות', pantry: 'המזווה', insights: 'חיסכון ומחירים' }[name];
    $('#eyebrow').textContent = eb; $('#title').textContent = t;
  }
  function switchTab(name) {
    if (!VIEWS.includes(name)) return;
    tab = name;
    setHeader(name);
    document.querySelectorAll('[data-tab]').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    VIEWS.forEach((v) => { $('#view-' + v).hidden = (v !== name); });
    $('#content').scrollTop = 0;
    renderActive();
  }
  function renderActive() {
    if (tab === 'home') renderHome();
    else if (tab === 'list') renderList();
    else if (tab === 'pantry') renderPantry();
    else if (tab === 'insights') renderInsights();
    if (!$('#shopmode').hidden) renderShop();
    updateChrome();
  }
  // desktop sidebar: list badge + sync-card status (kept honest)
  function updateChrome() {
    const n = SP.summary().neededCount;
    const badge = $('#snavListBadge');
    if (badge) { if (n > 0) { badge.textContent = n; badge.hidden = false; } else badge.hidden = true; }
    const on = !!window.SP_cloudSave;
    const st = $('#syncTitle'), su = $('#syncSub');
    if (st) st.textContent = on ? 'סנכרון בית פעיל' : 'סנכרון מקומי';
    if (su) su.textContent = on ? 'מחובר — מסונכרן בזמן אמת' : 'לחצו להגדרת סנכרון בית';
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;

    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }
    if (t.closest('#fab') || t.closest('#topAdd')) { addSheet(); return; }
    if (t.closest('#avatar') || t.closest('[data-settings]')) { settingsSheet(); return; }
    if (t === $('#backdrop')) { closeSheet(); return; }

    const go = t.closest('[data-go]');
    if (go) { switchTab(go.dataset.go); return; }

    // shopping mode triggers
    if (t.closest('#enterShop')) { enterShop(); return; }
    if (t.closest('#exitShop')) { exitShop(); return; }
    if (t.closest('#finishShop')) { finishShop(); return; }
    const collect = t.closest('[data-collect]');
    if (collect) { const id = collect.dataset.collect; shop.collected[id] = !shop.collected[id]; renderShop(); return; }

    // shopping list: mark purchased
    const buy = t.closest('[data-buy]');
    if (buy) {
      const it = SP.getItem(buy.dataset.buy);
      buy.classList.add('done');
      setTimeout(() => { SP.markPurchased(buy.dataset.buy); toast(`✓ ${it ? it.name : ''} נקנה`); }, 200);
      return;
    }

    // pantry: stepper
    const inc = t.closest('[data-inc]'); const dec = t.closest('[data-dec]');
    if (inc) { SP.adjustQty(inc.dataset.inc, 1); return; }
    if (dec) { SP.adjustQty(dec.dataset.dec, -1); return; }

    // pantry: open edit
    const edit = t.closest('[data-edit]');
    if (edit) { editSheet(edit.dataset.edit); return; }

    // sheet actions
    if (t.id === 's-add') {
      const d = readForm();
      if (!d.name) { toast('צריך שם מוצר'); return; }
      SP.addItem(d); closeSheet(); toast(`נוסף: ${d.name}`);
      if (tab !== 'pantry') switchTab('pantry');
      return;
    }
    if (t.id === 's-save') {
      const d = readForm();
      if (!d.name) { toast('צריך שם מוצר'); return; }
      SP.updateItem(t.dataset.id, d); closeSheet(); toast('נשמר');
      return;
    }
    if (t.id === 's-del') {
      const it = SP.getItem(t.dataset.id);
      if (confirm(`למחוק את "${it ? it.name : ''}"?`)) { SP.removeItem(t.dataset.id); closeSheet(); toast('נמחק'); }
      return;
    }

    // pantry filter chips
    const fcat = t.closest('[data-cat]');
    if (fcat) { pf.cat = fcat.dataset.cat; pf.lowOnly = false; renderPantry(); return; }
    const flow = t.closest('[data-filter="low"]');
    if (flow) { pf.lowOnly = !pf.lowOnly; if (pf.lowOnly) pf.cat = ''; renderPantry(); return; }

    // settings
    if (t.id === 'resetBtn') {
      if (confirm('לאפס את כל הנתונים? פעולה זו אינה הפיכה.')) { localStorage.removeItem('smartPantry_v1'); location.reload(); }
      return;
    }
    if (t.id === 'installBtn' && deferredInstall) { e.preventDefault(); deferredInstall.prompt(); deferredInstall = null; return; }
  });

  // pantry search (input delegation)
  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') { pf.search = e.target.value; renderPantry(); }
    else if (e.target.id === 'topSearch') {
      pf.search = e.target.value;
      if (tab !== 'pantry') switchTab('pantry'); else renderPantry();
      const s = $('#search'); if (s) s.value = e.target.value; // keep in-view search in sync
    }
  });

  // header shadow on scroll
  $('#content').addEventListener('scroll', () => {
    $('#header').classList.toggle('scrolled', $('#content').scrollTop > 4);
  });

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstall = e; });

  // ---------- deep links (#home / #list / #pantry / #insights / #add) ----------
  function applyHash() {
    const h = (location.hash || '').replace('#', '');
    if (h === 'add') { switchTab('pantry'); addSheet(); }
    else if (h === 'shop') { switchTab('list'); enterShop(); }
    else if (VIEWS.includes(h)) switchTab(h);
  }
  window.addEventListener('hashchange', applyHash);

  // ---------- boot ----------
  SP.load();
  SP.onChange(() => renderActive());
  switchTab('home');
  applyHash();
})();
