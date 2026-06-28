/* ===== Smart Pantry — SPA UI controller ===== */
(function () {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const TITLES = { list: 'רשימת קניות', pantry: 'המזווה', menu: 'עוד' };
  let tab = 'list';
  const pf = { search: '', cat: '', lowOnly: false };

  // ---------- toast ----------
  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 1700);
  }

  // ---------- badges ----------
  function statusBadge(it) {
    const s = SP.status(it);
    if (s === 'out') return '<span class="badge out">נגמר</span>';
    if (s === 'low') return '<span class="badge low">עומד להיגמר</span>';
    return '';
  }
  function metaBadges(it) {
    let b = '';
    if (it.isStaple) b += '<span class="badge staple">קבוע</span>';
    if (SP.isExpiringSoon(it)) {
      const d = SP.daysToExpiry(it);
      b += `<span class="badge expiry">⏳ ${d <= 0 ? 'פג תוקף' : 'תפוגה ' + d + ' י׳'}</span>`;
    }
    const pd = SP.predictedDaysLeft(it);
    if (pd != null && pd <= 7) b += `<span class="badge predict">צפוי להיגמר ~${Math.max(0, pd)} י׳</span>`;
    if (it.promo) b += '<span class="badge promo">במבצע</span>';
    return b;
  }

  // ---------- view: shopping list ----------
  function renderList() {
    const s = SP.summary();
    const groups = SP.shoppingList();
    const tip = SP.contextualTip();
    const kpis = `
      <div class="kpis">
        <div class="kpi out"><div class="num">${s.out}</div><div class="lbl">נגמרו</div></div>
        <div class="kpi low"><div class="num">${s.low}</div><div class="lbl">עומדים להיגמר</div></div>
        <div class="kpi exp"><div class="num">${s.expiring}</div><div class="lbl">לקראת תפוגה</div></div>
        <div class="kpi ok"><div class="num">${s.total}</div><div class="lbl">במעקב</div></div>
      </div>`;
    const tipHtml = `<div class="tip"><span class="emoji">${tip.emoji}</span><span>${tip.text}</span></div>`;

    let body;
    if (!groups.length) {
      body = '<div class="empty"><div class="big">🎉</div><div class="t">הכול מלא — אין מה לקנות כרגע</div></div>';
    } else {
      body = groups.map((g) => `
        <div class="section-title"><span>${SP.CAT_EMOJI[g.category] || ''} ${g.category}</span><span class="line"></span></div>
        <div class="items">
          ${g.items.map((it) => `
            <div class="item">
              <button class="check" data-buy="${it.id}" aria-label="קניתי"></button>
              <div class="emoji-badge">${SP.itemEmoji(it)}</div>
              <div class="item-main">
                <div class="item-name">${esc(it.name)} ${statusBadge(it)}</div>
                <div class="item-sub"><span>יש: ${it.currentQty} ${esc(it.unit)}</span>${metaBadges(it)}</div>
              </div>
            </div>`).join('')}
        </div>`).join('');
    }
    $('#view-list').innerHTML = kpis + tipHtml + body;
  }

  // ---------- view: pantry ----------
  function renderPantry() {
    let items = SP.getItems();
    const all = items.length;
    if (pf.search) items = items.filter((i) => i.name.includes(pf.search.trim()));
    if (pf.cat) items = items.filter((i) => i.category === pf.cat);
    if (pf.lowOnly) items = items.filter((i) => SP.isNeeded(i));

    const chips = `
      <input class="search" id="search" type="text" placeholder="🔍 חיפוש מוצר..." value="${esc(pf.search)}" />
      <div class="filters">
        <span class="chip ${pf.lowOnly ? 'on' : ''}" data-filter="low">רק מה שחסר</span>
        <span class="chip ${pf.cat === '' ? 'on' : ''}" data-cat="">הכול</span>
        ${SP.CATEGORIES.map((c) => `<span class="chip ${pf.cat === c ? 'on' : ''}" data-cat="${esc(c)}">${SP.CAT_EMOJI[c]} </span>`).join('')}
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
              <div class="emoji-badge">${SP.itemEmoji(it)}</div>
              <div class="item-main" data-edit="${it.id}">
                <div class="item-name">${esc(it.name)} ${statusBadge(it)}</div>
                <div class="item-sub"><span>סף: ${it.minThreshold} ${esc(it.unit)}</span>${metaBadges(it)}</div>
              </div>
              <div class="stepper">
                <button data-dec="${it.id}">−</button>
                <span class="val">${it.currentQty}</span>
                <button data-inc="${it.id}">+</button>
              </div>
            </div>`).join('')}
        </div>`).join('');
    }
    $('#view-pantry').innerHTML = chips + body;
  }

  // ---------- view: menu ----------
  function renderMenu() {
    const s = SP.summary();
    const fbStatus = (window.SP_cloudSave) ? 'פעיל ✓' : 'כבוי (מקומי בלבד)';
    $('#view-menu').innerHTML = `
      ${installHintHtml()}
      <div class="menu-item"><div class="h">📊 סטטיסטיקה</div>
        <div class="item-sub">${s.total} מוצרים במעקב · ${s.neededCount} ברשימה · ${s.expiring} לקראת תפוגה</div></div>
      <div class="menu-item"><div class="h">☁️ סנכרון בית</div>
        <div class="item-sub">${fbStatus} — למלא את firebase-config.js כדי לסנכרן בין כל המכשירים בבית בזמן אמת.</div></div>
      <div class="menu-item"><div class="h">💡 איך זה עובד</div>
        <div class="item-sub">לכל מוצר יש סף מינימום. כשהכמות יורדת מתחת לסף הוא קופץ אוטומטית לרשימה. המערכת לומדת את קצב הצריכה ומזכירה עוד לפני שנגמר.</div></div>
      <button class="btn danger sm" id="resetBtn" style="margin-top:8px">איפוס נתונים</button>`;
  }

  let deferredInstall = null;
  function installHintHtml() {
    if (deferredInstall) {
      return '<div class="install-hint"><span style="font-size:20px">📲</span><div>אפשר להתקין את האפליקציה למסך הבית — <a href="#" id="installBtn">התקנה</a></div></div>';
    }
    return '<div class="install-hint"><span style="font-size:20px">📲</span><div>הוסיפו למסך הבית (שיתוף → הוסף למסך הבית) כדי שירוץ כמו אפליקציה.</div></div>';
  }

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

  // ---------- tab switching ----------
  function switchTab(name) {
    tab = name;
    $('#title').textContent = TITLES[name];
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    ['list', 'pantry', 'menu'].forEach((v) => { $('#view-' + v).hidden = (v !== name); });
    $('#content').scrollTop = 0;
    renderActive();
  }
  function renderActive() {
    if (tab === 'list') renderList();
    else if (tab === 'pantry') renderPantry();
    else renderMenu();
  }

  // ---------- events ----------
  document.addEventListener('click', (e) => {
    const t = e.target;
    const tabBtn = t.closest('[data-tab]');
    if (tabBtn) { switchTab(tabBtn.dataset.tab); return; }
    if (t.closest('#fab')) { addSheet(); return; }
    if (t === $('#backdrop')) { closeSheet(); return; }

    // shopping list: mark purchased
    const buy = t.closest('[data-buy]');
    if (buy) {
      const it = SP.getItem(buy.dataset.buy);
      buy.classList.add('done');
      setTimeout(() => { SP.markPurchased(buy.dataset.buy); toast(`✓ ${it ? it.name : ''} נקנה`); }, 180);
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
    if (fcat) { pf.cat = fcat.dataset.cat; renderPantry(); return; }
    const flow = t.closest('[data-filter="low"]');
    if (flow) { pf.lowOnly = !pf.lowOnly; renderPantry(); return; }

    // menu
    if (t.id === 'resetBtn') {
      if (confirm('לאפס את כל הנתונים? פעולה זו אינה הפיכה.')) {
        localStorage.removeItem('smartPantry_v1'); location.reload();
      }
      return;
    }
    if (t.id === 'installBtn' && deferredInstall) {
      e.preventDefault(); deferredInstall.prompt(); deferredInstall = null;
      return;
    }
  });

  // pantry search (input event — delegation)
  document.addEventListener('input', (e) => {
    if (e.target.id === 'search') { pf.search = e.target.value; renderPantry(); }
  });

  // header shadow on scroll
  $('#content').addEventListener('scroll', () => {
    $('#header').classList.toggle('scrolled', $('#content').scrollTop > 4);
  });

  // PWA install prompt
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); deferredInstall = e;
    if (tab === 'menu') renderMenu();
  });

  // ---------- boot ----------
  SP.load();
  SP.onChange(() => renderActive());
  switchTab('list');
})();
