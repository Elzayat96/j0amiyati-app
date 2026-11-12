/* ===== DB ===== */
const db = new Dexie('JamiyatiDB');
db.version(1).stores({
  associations: '++id, name, createdAt',
  members: '++id, associationId, roleOrder',
  roles: '++id, associationId, order, status, [associationId+order]',
  payments: '++id, associationId, memberId, monthIndex, [memberId+monthIndex], [associationId+monthIndex]',
  payouts: '++id, associationId, roleOrder, [associationId+roleOrder]',
  auditLog: '++id, associationId, timestamp'
});
db.version(2).stores({ settings: 'key' });

/* ===== Settings ===== */
let settingsCache = { darkMode: false, pin: null, pinEnabled: false, lastBackup: null };
async function loadSettings() {
  const rows = await db.settings.toArray();
  settingsCache = { darkMode: false, pin: null, pinEnabled: false, lastBackup: null };
  rows.forEach(r => { settingsCache[r.key] = r.value; });
  applySettings();
}
async function saveSetting(key, value) {
  settingsCache[key] = value;
  await db.settings.put({ key, value });
  applySettings();
}
function applySettings() {
  document.body.classList.toggle('dark', !!settingsCache.darkMode);
}

/* ===== Utilities ===== */
function fmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function today() { return new Date().toISOString().slice(0, 10); }
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.textContent = msg;
  const bg = type === 'error' ? '#dc2626' : type === 'success' ? '#16a34a' : '#0d9488';
  el.style.cssText = `position:fixed;bottom:90px;left:50%;transform:translateX(-50%);
    background:${bg};color:white;padding:12px 24px;border-radius:12px;z-index:3000;
    font-size:0.9rem;font-weight:600;box-shadow:0 4px 12px rgba(0,0,0,0.25);
    max-width:90%;text-align:center;`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
async function log(action, details, assocId) {
  try {
    await db.auditLog.add({
      associationId: assocId === undefined ? currentAssocId : assocId,
      action, details, timestamp: new Date().toISOString()
    });
  } catch (e) { console.warn('log err', e); }
}

/* ===== WhatsApp ===== */
function waPhone(phone) {
  if (!phone) return '';
  let p = String(phone).replace(/\D/g, '');
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '20' + p.slice(1);
  else if (p.length === 10 && !p.startsWith('20')) p = '20' + p;
  return p;
}
function openWhatsApp(phone, message) {
  const p = waPhone(phone);
  if (!p) { toast('لا يوجد رقم هاتف لهذا الشخص', 'error'); return; }
  const url = `https://wa.me/${p}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}

/* ===== Calculations ===== */
function getStartedMonths(startDate, totalMonths) {
  const start = new Date(startDate);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth()) + 1;
  return Math.min(Math.max(0, months), totalMonths);
}
async function computeArrears(assoc, members, payments) {
  const started = getStartedMonths(assoc.startDate, assoc.months);
  let total = 0;
  for (const m of members) {
    const due = Number(m.monthlyContribution);
    for (let i = 0; i < started; i++) {
      const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === i);
      const paid = p ? Number(p.amountPaid || 0) : 0;
      if (paid < due) total += (due - paid);
    }
  }
  return total;
}
function getPersonSummary(assoc, allMembers, payments, payouts, personName) {
  const key = String(personName || '').trim();
  const personMembers = allMembers.filter(m => m.name.trim() === key);
  const started = getStartedMonths(assoc.startDate, assoc.months);
  const currentIdx = Math.max(0, started - 1);
  let totalMonthly = 0, totalDueAll = 0, totalPaidAll = 0, arrears = 0;
  let thisMonthDue = 0, thisMonthPaid = 0;
  const roles = [];
  for (const m of personMembers) {
    const monthly = Number(m.monthlyContribution);
    const memberDue = monthly * assoc.months;
    const memberPayments = payments.filter(p => Number(p.memberId) === Number(m.id));
    const memberPaid = memberPayments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    let memberArrears = 0;
    for (let i = 0; i < started; i++) {
      const p = memberPayments.find(x => Number(x.monthIndex) === i);
      const paid = p ? Number(p.amountPaid || 0) : 0;
      memberArrears += Math.max(0, monthly - paid);
    }
    let rTM = 0, rTP = 0;
    if (currentIdx < assoc.months) {
      const p = memberPayments.find(x => Number(x.monthIndex) === currentIdx);
      rTM = monthly; rTP = p ? Number(p.amountPaid || 0) : 0;
    }
    const roleMembers = allMembers.filter(x => Number(x.roleOrder) === Number(m.roleOrder));
    const roleTotal = roleMembers.reduce((s, x) => s + Number(x.monthlyContribution) * assoc.months, 0);
    const rolePayout = payouts.find(p => Number(p.roleOrder) === Number(m.roleOrder) && p.confirmed);
    const share = rolePayout && roleTotal > 0 ? (memberDue / roleTotal) * Number(rolePayout.totalAmount) : 0;
    totalMonthly += monthly; totalDueAll += memberDue; totalPaidAll += memberPaid;
    arrears += memberArrears; thisMonthDue += rTM; thisMonthPaid += rTP;
    roles.push({ memberId: m.id, roleOrder: m.roleOrder, monthly,
      due: memberDue, paid: memberPaid, remaining: memberDue - memberPaid,
      arrears: memberArrears, thisMonthDue: rTM, thisMonthPaid: rTP,
      hasReceived: !!rolePayout, payoutShare: share });
  }
  return { personName: key, roleCount: personMembers.length, totalMonthly, totalDueAll,
    totalPaidAll, totalRemaining: totalDueAll - totalPaidAll, arrears,
    thisMonthDue, thisMonthPaid, roles };
}
function getMonthStats(assoc, members, payments, monthIdx) {
  let due = 0, paid = 0;
  for (const m of members) {
    const d = Number(m.monthlyContribution);
    const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === monthIdx);
    due += d; paid += p ? Number(p.amountPaid || 0) : 0;
  }
  return { due, paid, remaining: due - paid };
}

/* ===== Navigation ===== */
let currentAssocId = null;
let currentView = 'home';
let currentMemberId = null;
let memberFilter = 'all';
let memberSearch = '';

function render() {
  const app = document.getElementById('app');
  if (currentView === 'assoc' && currentAssocId) return renderAssoc(app);
  if (currentView === 'member' && currentMemberId) return renderMemberDetails(app);
  if (currentView === 'reports' && currentAssocId) return renderReports(app);
  if (currentView === 'auditlog') return renderAuditLog(app);
  if (currentView === 'settings') return renderSettings(app);
  if (currentView === 'backup') return renderBackup(app);
  return renderHome(app);
}
function goHome() { currentView = 'home'; currentAssocId = null; currentMemberId = null; render(); }
function goReports() { if (!currentAssocId) { toast('اختر جمعية أولًا', 'error'); return; } currentView = 'reports'; render(); }
function goBackup() { currentView = 'backup'; render(); }
function goSettings() { currentView = 'settings'; render(); }
function goAuditLog() { currentView = 'auditlog'; render(); }
function openAssoc(id) { currentAssocId = id; currentView = 'assoc'; render(); }
function openMember(id) { currentMemberId = id; currentView = 'member'; render(); }

function bottomNav(active) {
  return `<div class="bottom-nav">
    <button class="${active === 'home' ? 'active' : ''}" onclick="goHome()">🏠<span>الرئيسية</span></button>
    <button class="${active === 'reports' ? 'active' : ''}" onclick="goReports()">📊<span>التقارير</span></button>
    <button class="${active === 'settings' ? 'active' : ''}" onclick="goSettings()">⚙️<span>الإعدادات</span></button>
  </div>`;
}

/* ===== PIN Lock ===== */
async function hashPin(pin) {
  try {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pin + 'jamiyati-salt'));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch (e) {
    let h = 0; for (let i = 0; i < pin.length; i++) { h = ((h << 5) - h) + pin.charCodeAt(i); h |= 0; }
    return 'fallback-' + Math.abs(h).toString(16);
  }
}
function showLockScreen(callback) {
  const lock = document.createElement('div');
  lock.id = 'lockScreen';
  lock.innerHTML = `<div class="lock-box">
    <h1>🔒 جمعيتي</h1>
    <p style="color:var(--muted);font-size:0.85rem;margin-bottom:12px">أدخل الرقم السري للمتابعة</p>
    <input id="pinInput" type="password" inputmode="numeric" maxlength="8" placeholder="••••">
    <p id="pinError" style="color:var(--danger);font-size:0.85rem;min-height:20px;margin-bottom:8px"></p>
    <button class="btn" onclick="tryUnlock()">دخول</button>
  </div>`;
  document.body.appendChild(lock);
  setTimeout(() => document.getElementById('pinInput').focus(), 200);
  document.getElementById('pinInput').addEventListener('keypress', e => { if (e.key === 'Enter') tryUnlock(); });
  window._pinCallback = callback;
}
async function tryUnlock() {
  const input = document.getElementById('pinInput');
  const err = document.getElementById('pinError');
  const pin = input.value.trim();
  if (!pin) return;
  const h = await hashPin(pin);
  if (h === settingsCache.pin) {
    document.getElementById('lockScreen').remove();
    if (window._pinCallback) window._pinCallback();
  } else {
    err.textContent = 'الرقم السري خطأ';
    input.value = '';
    input.focus();
  }
}

/* ===== Notifications ===== */
async function requestNotifPermission() {
  if (!('Notification' in window)) { toast('الإشعارات غير مدعومة في هذا المتصفح', 'error'); return; }
  const p = await Notification.requestPermission();
  if (p === 'granted') { toast('تم تفعيل الإشعارات', 'success'); new Notification('جمعيتي', { body: 'ستصلك التنبيهات عند فتح التطبيق' }); }
  else toast('لم يتم تفعيل الإشعارات', 'info');
}
async function checkAndNotify() {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const assocs = await db.associations.toArray();
    for (const a of assocs) {
      if (a.archived) continue;
      const members = await db.members.where('associationId').equals(a.id).toArray();
      const payments = await db.payments.where('associationId').equals(a.id).toArray();
      const started = getStartedMonths(a.startDate, a.months);
      let overdue = 0;
      for (const m of members) {
        let memberDue = 0;
        for (let i = 0; i < started; i++) {
          const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === i);
          const paid = p ? Number(p.amountPaid || 0) : 0;
          memberDue += Math.max(0, Number(m.monthlyContribution) - paid);
        }
        if (memberDue > 0) overdue++;
      }
      if (overdue > 0) {
        new Notification(`جمعية ${a.name}`, { body: `${overdue} متأخر عن السداد في هذه الجمعية` });
      }
    }
  } catch (e) { console.warn('notify err', e); }
}

/* ===== Home ===== */
async function renderHome(app) {
  const all = await db.associations.toArray();
  const active = all.filter(a => !a.archived);
  const archived = all.filter(a => a.archived);

  let html = `<header><h1>جمعيتي</h1><span style="font-size:0.8rem;opacity:0.9">إدارة الجمعيات الشهرية</span></header>`;

  // Backup reminder
  if (settingsCache.lastBackup) {
    const days = Math.floor((Date.now() - new Date(settingsCache.lastBackup).getTime()) / 86400000);
    if (days >= 7) {
      html += `<div class="alert warning">
        ⚠️ آخر نسخة احتياطية منذ ${days} يوم
        <button class="btn small" style="margin:0;margin-right:auto" onclick="goBackup()">نسخ الآن</button>
      </div>`;
    }
  } else if (all.length > 0) {
    html += `<div class="alert warning">
      ⚠️ لم تأخذ نسخة احتياطية بعد
      <button class="btn small" style="margin:0;margin-right:auto" onclick="goBackup()">نسخ الآن</button>
    </div>`;
  }

  if (active.length === 0 && archived.length === 0) {
    html += `<div class="empty"><p style="font-size:2.5rem">📋</p>
      <p style="margin-top:8px">لا توجد جمعيات بعد</p>
      <p style="font-size:0.85rem;margin-top:6px">ابدأ بإنشاء جمعيتك الأولى</p></div>`;
  } else {
    for (const a of active) {
      const members = await db.members.where('associationId').equals(a.id).toArray();
      const payments = await db.payments.where('associationId').equals(a.id).toArray();
      const roles = await db.roles.where('associationId').equals(a.id).toArray();
      const totalMonthly = members.reduce((s, m) => s + Number(m.monthlyContribution), 0);
      const started = getStartedMonths(a.startDate, a.months);
      const currIdx = Math.max(0, started - 1);
      const ms = getMonthStats(a, members, payments, currIdx);
      let overdueCount = 0;
      for (const m of members) {
        let d = 0;
        for (let i = 0; i < started; i++) {
          const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === i);
          d += Math.max(0, Number(m.monthlyContribution) - (p ? Number(p.amountPaid || 0) : 0));
        }
        if (d > 0) overdueCount++;
      }
      const nextRole = roles.filter(r => r.status !== 'paid').sort((x, y) => x.order - y.order)[0];
      let nextRoleNames = '';
      if (nextRole) {
        const roleMembers = members.filter(m => Number(m.roleOrder) === Number(nextRole.order));
        nextRoleNames = roleMembers.map(m => m.name).join('، ');
      }

      html += `<div class="card" onclick="openAssoc(${a.id})" style="cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">${escapeHtml(a.name)}</h3>
          <span class="badge gray">${members.length} مشترك</span>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;font-size:0.8rem">
          <div><span style="color:var(--muted)">الشهر الحالي:</span> <strong>${fmt(ms.paid)}</strong> / ${fmt(ms.due)} ج.م</div>
          <div><span style="color:var(--muted)">متأخرون:</span> <strong style="color:${overdueCount ? 'var(--danger)' : 'var(--success)'}">${overdueCount}</strong></div>
        </div>
        <p style="font-size:0.8rem;color:var(--muted);margin-top:6px">
          الدور القادم: ${nextRoleNames ? `${nextRole.order} — ${escapeHtml(nextRoleNames)}` : 'لا يوجد'}
        </p>
      </div>`;
    }
  }

  html += `<button class="btn" onclick="showCreateAssoc()">＋ إنشاء جمعية جديدة</button>`;

  // Archived section
  if (archived.length > 0) {
    html += `<div class="collapse-header" onclick="this.nextElementSibling.style.display = this.nextElementSibling.style.display === 'none' ? 'block' : 'none'">
      <span>📦 الجمعيات المؤرشفة (${archived.length})</span><span>▼</span>
    </div><div style="display:none">
      ${archived.map(a => `<div class="card" onclick="openAssoc(${a.id})" style="cursor:pointer;opacity:0.7">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">${escapeHtml(a.name)}</h3>
          <span class="badge gray">مؤرشفة</span>
        </div>
      </div>`).join('')}
    </div>`;
  }

  html += bottomNav('home');
  app.innerHTML = html;
}

/* ===== Create Assoc ===== */
function showCreateAssoc() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <h3 style="margin-bottom:12px">جمعية جديدة</h3>
    <label>اسم الجمعية</label>
    <input id="assocName" placeholder="مثال: جمعية الأصدقاء">
    <label>عدد الشهور</label>
    <input id="assocMonths" type="number" min="1" value="10">
    <label>الاشتراك الشهري الأساسي (ج.م)</label>
    <input id="assocBase" type="number" min="0" value="1000">
    <label>تاريخ البداية</label>
    <input id="assocStart" type="date" value="${today()}">
    <label>يوم التحصيل</label>
    <input id="assocDay" type="number" min="1" max="28" value="1">
    <label>ملاحظات</label>
    <textarea id="assocNotes" rows="2"></textarea>
    <button class="btn" onclick="createAssoc()">حفظ</button>
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
  </div>`;
  document.body.appendChild(overlay);
}
async function createAssoc() {
  const name = document.getElementById('assocName').value.trim();
  if (!name) { toast('أدخل اسم الجمعية', 'error'); return; }
  const id = await db.associations.add({
    name,
    months: Number(document.getElementById('assocMonths').value) || 10,
    baseContribution: Number(document.getElementById('assocBase').value) || 0,
    startDate: document.getElementById('assocStart').value || today(),
    collectionDay: Number(document.getElementById('assocDay').value) || 1,
    notes: document.getElementById('assocNotes').value.trim(),
    archived: false,
    createdAt: new Date().toISOString()
  });
  await log('إنشاء جمعية', `تم إنشاء الجمعية: ${name}`, id);
  document.querySelector('.modal-overlay').remove();
  toast('تم إنشاء الجمعية', 'success');
  openAssoc(id);
}

/* ===== Assoc View ===== */
async function renderAssoc(app) {
  const assoc = await db.associations.get(currentAssocId);
  if (!assoc) { goHome(); return; }
  const allMembers = await db.members.where('associationId').equals(currentAssocId).toArray();
  const roles = await db.roles.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();

  // Filter members
  let members = allMembers;
  if (memberSearch) {
    const q = memberSearch.toLowerCase();
    members = members.filter(m => m.name.toLowerCase().includes(q) || (m.phone || '').includes(memberSearch));
  }
  if (memberFilter === 'paid') {
    members = members.filter(m => {
      const started = getStartedMonths(assoc.startDate, assoc.months);
      for (let i = 0; i < started; i++) {
        const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === i);
        if (!p || Number(p.amountPaid || 0) < Number(m.monthlyContribution)) return false;
      }
      return true;
    });
  } else if (memberFilter === 'overdue') {
    members = members.filter(m => {
      const started = getStartedMonths(assoc.startDate, assoc.months);
      for (let i = 0; i < started; i++) {
        const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === i);
        if (!p || Number(p.amountPaid || 0) < Number(m.monthlyContribution)) return true;
      }
      return false;
    });
  } else if (memberFilter === 'multi') {
    const nameCounts = {};
    allMembers.forEach(m => { const k = m.name.trim(); nameCounts[k] = (nameCounts[k] || 0) + 1; });
    members = members.filter(m => nameCounts[m.name.trim()] > 1);
  }

  const totalMonthly = allMembers.reduce((s, m) => s + Number(m.monthlyContribution), 0);
  const totalCollected = payments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
  const totalDue = allMembers.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
  const arrears = await computeArrears(assoc, allMembers, payments);
  const totalPaidOut = payouts.filter(p => p.confirmed).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const available = totalCollected - totalPaidOut;
  const progress = totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0;

  const nextRole = roles.filter(r => r.status !== 'paid').sort((a, b) => a.order - b.order)[0];
  let nextRoleInfo = 'لا توجد أدوار متبقية 🎉';
  if (nextRole) {
    const rMembers = allMembers.filter(m => Number(m.roleOrder) === Number(nextRole.order));
    const rTotal = rMembers.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
    nextRoleInfo = `<strong>الدور ${nextRole.order}:</strong> ${rMembers.map(m => escapeHtml(m.name)).join('، ') || '—'} — <strong>${fmt(rTotal)}</strong> ج.م`;
  }

  let html = `<header>
    <div>
      <h1>${escapeHtml(assoc.name)} ${assoc.archived ? '<span class="badge gray">مؤرشفة</span>' : ''}</h1>
      <span style="font-size:0.8rem;opacity:0.9">${assoc.months} شهر · بداية ${assoc.startDate}</span>
    </div>
    <button class="btn small secondary" onclick="goHome()">← رجوع</button>
  </header>

  <div class="grid" style="margin-bottom:12px">
    <div class="stat"><div class="value">${fmt(totalMonthly)}</div><div class="label">التحصيل المتوقع شهريًا</div></div>
    <div class="stat"><div class="value" style="color:var(--success)">${fmt(totalCollected)}</div><div class="label">المحصّل فعليًا</div></div>
    <div class="stat"><div class="value" style="color:var(--danger)">${fmt(arrears)}</div><div class="label">المتأخرات</div></div>
    <div class="stat"><div class="value" style="color:var(--warning)">${fmt(available)}</div><div class="label">متاح للصرف</div></div>
  </div>

  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <h3 style="margin:0">نسبة الإنجاز</h3>
      <span style="font-weight:700;color:var(--primary)">${progress}%</span>
    </div>
    <div class="progress-bar"><div style="width:${progress}%"></div></div>
  </div>

  <div class="card"><h3>الدور القادم</h3><p style="font-size:0.9rem">${nextRoleInfo}</p></div>

  <div class="card">
    <h3>إدارة الجمعية</h3>
    <button class="btn" onclick="showAddMember()">＋ إضافة مشترك</button>
    <button class="btn secondary" onclick="showManageRoles()">⚙️ إدارة الأدوار</button>
    <button class="btn secondary" onclick="showPeopleAccounts()">👥 حساب الأشخاص</button>
    <button class="btn secondary" onclick="showMonthlyCollection()">💰 التحصيل الشهري</button>
    <button class="btn secondary" onclick="showPayout()">📤 صرف دور</button>
    <button class="btn secondary" onclick="goReports()">📊 التقارير</button>
    <button class="btn whatsapp" onclick="shareAssocSummary()">📱 مشاركة عبر واتساب</button>
    <button class="btn secondary" onclick="archiveAssoc(${assoc.id})">${assoc.archived ? '📂 إلغاء الأرشفة' : '📦 أرشفة'}</button>
    <button class="btn secondary" onclick="copyAsTemplate(${assoc.id})">📋 نسخ كقالب</button>
    <button class="btn danger" onclick="deleteAssoc(${assoc.id})">🗑️ حذف الجمعية</button>
  </div>

  <div class="card">
    <h3>المشتركون (${allMembers.length})</h3>
    <input placeholder="🔍 بحث بالاسم أو الهاتف" value="${escapeHtml(memberSearch)}" oninput="memberSearch=this.value; render()" style="margin-bottom:8px">
    <div class="chips">
      <button class="chip ${memberFilter==='all'?'active':''}" onclick="memberFilter='all'; render()">الكل</button>
      <button class="chip ${memberFilter==='overdue'?'active':''}" onclick="memberFilter='overdue'; render()">متأخرون</button>
      <button class="chip ${memberFilter==='paid'?'active':''}" onclick="memberFilter='paid'; render()">منتظمون</button>
      <button class="chip ${memberFilter==='multi'?'active':''}" onclick="memberFilter='multi'; render()">متعددو الأدوار</button>
    </div>
    ${members.length === 0 ? '<p class="empty">لا يوجد مشتركون مطابقون</p>' : `
    <div class="table-wrap"><table>
      <thead><tr><th>الاسم</th><th>المساهمة</th><th>الدور</th><th>الاستحقاق</th></tr></thead>
      <tbody>${members.map(m => `<tr class="clickable" onclick="openMember(${m.id})">
        <td>${escapeHtml(m.name)}</td>
        <td>${fmt(m.monthlyContribution)}</td>
        <td>${m.roleOrder}</td>
        <td>${fmt(Number(m.monthlyContribution) * assoc.months)}</td>
      </tr>`).join('')}</tbody>
    </table></div>`}
  </div>`;

  html += bottomNav('home');
  app.innerHTML = html;
}

async function shareAssocSummary() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const totalCollected = payments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
  const totalPaidOut = payouts.filter(p => p.confirmed).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const totalDue = members.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
  const msg = `📋 ملخص جمعية: ${assoc.name}\n\n` +
    `• عدد المشتركين: ${members.length}\n` +
    `• إجمالي الاستحقاق: ${fmt(totalDue)} ج.م\n` +
    `• المحصّل حتى الآن: ${fmt(totalCollected)} ج.م\n` +
    `• المصروف: ${fmt(totalPaidOut)} ج.م\n` +
    `• المتبقي للتحصيل: ${fmt(totalDue - totalCollected)} ج.م`;
  const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
  window.open(url, '_blank');
}
async function archiveAssoc(id) {
  const a = await db.associations.get(id);
  await db.associations.update(id, { archived: !a.archived });
  toast(a.archived ? 'تم إلغاء الأرشفة' : 'تم الأرشفة', 'success');
  render();
}
async function copyAsTemplate(id) {
  const assoc = await db.associations.get(id);
  const members = await db.members.where('associationId').equals(id).toArray();
  const name = prompt('اسم الجمعية الجديدة:', assoc.name + ' - نسخة');
  if (!name) return;
  const newId = await db.associations.add({
    name, months: assoc.months, baseContribution: assoc.baseContribution,
    startDate: today(), collectionDay: assoc.collectionDay,
    notes: assoc.notes, archived: false, createdAt: new Date().toISOString()
  });
  for (const m of members) {
    await db.members.add({
      associationId: newId, name: m.name, phone: m.phone,
      monthlyContribution: m.monthlyContribution, roleOrder: m.roleOrder, notes: m.notes
    });
    await ensureRole(newId, m.roleOrder);
  }
  await log('نسخ جمعية', `تم نسخ ${assoc.name} إلى ${name}`, newId);
  toast('تم إنشاء نسخة جديدة', 'success');
  openAssoc(newId);
}
async function deleteAssoc(id) {
  if (!confirm('حذف الجمعية سيحذف جميع البيانات نهائيًا. هل أنت متأكد؟')) return;
  await db.transaction('rw', db.associations, db.members, db.roles, db.payments, db.payouts, db.auditLog, async () => {
    await db.associations.delete(id);
    await db.members.where('associationId').equals(id).delete();
    await db.roles.where('associationId').equals(id).delete();
    await db.payments.where('associationId').equals(id).delete();
    await db.payouts.where('associationId').equals(id).delete();
    await db.auditLog.where('associationId').equals(id).delete();
  });
  toast('تم الحذف', 'success');
  goHome();
}

/* ===== Member Details ===== */
async function renderMemberDetails(app) {
  const m = await db.members.get(currentMemberId);
  if (!m) { goHome(); return; }
  currentAssocId = m.associationId;
  const assoc = await db.associations.get(currentAssocId);
  const allMembers = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const summary = getPersonSummary(assoc, allMembers, payments, payouts, m.name);

  let paymentsRows = '';
  const memberPayments = payments.filter(p => Number(p.memberId) === Number(m.id)).sort((a, b) => a.monthIndex - b.monthIndex);
  for (const p of memberPayments) {
    paymentsRows += `<tr>
      <td>الشهر ${Number(p.monthIndex) + 1}</td>
      <td>${fmt(p.amountDue)}</td>
      <td>${fmt(p.amountPaid)}</td>
      <td>${p.paidDate || '—'}</td>
    </tr>`;
  }
  if (!paymentsRows) paymentsRows = '<tr><td colspan="4" class="empty">لا توجد مدفوعات</td></tr>';

  const roleMembers = allMembers.filter(x => Number(x.roleOrder) === Number(m.roleOrder));
  const roleTotal = roleMembers.reduce((s, x) => s + Number(x.monthlyContribution) * assoc.months, 0);
  const rolePayout = payouts.find(p => Number(p.roleOrder) === Number(m.roleOrder) && p.confirmed);
  const payoutShare = rolePayout && roleTotal > 0
    ? (Number(m.monthlyContribution) * assoc.months / roleTotal) * Number(rolePayout.totalAmount) : 0;

  let html = `<header>
    <div>
      <h1>${escapeHtml(m.name)}</h1>
      <span style="font-size:0.8rem;opacity:0.9">${escapeHtml(assoc.name)} · دور ${m.roleOrder}</span>
    </div>
    <button class="btn small secondary" onclick="openAssoc(${assoc.id})">← رجوع</button>
  </header>

  <div class="grid" style="margin-bottom:12px">
    <div class="stat"><div class="value">${fmt(summary.totalMonthly)}</div><div class="label">مساهمة شهرية</div></div>
    <div class="stat"><div class="value" style="color:var(--success)">${fmt(summary.totalPaidAll)}</div><div class="label">إجمالي مدفوع</div></div>
    <div class="stat"><div class="value" style="color:var(--danger)">${fmt(summary.totalRemaining)}</div><div class="label">متبقي</div></div>
    <div class="stat"><div class="value" style="color:var(--warning)">${fmt(payoutShare)}</div><div class="label">${rolePayout ? 'قبض' : 'سيقبض'}</div></div>
  </div>

  ${m.phone ? `<div class="card">
    <p><strong>📞 الهاتف:</strong> ${escapeHtml(m.phone)}</p>
    <button class="btn whatsapp" onclick="openWhatsApp('${escapeHtml(m.phone)}', 'مرحبًا ${escapeHtml(m.name)}، تواصل معك بخصوص جمعية ${escapeHtml(assoc.name)}')">📱 تواصل عبر واتساب</button>
  </div>` : ''}

  <div class="card">
    <h3>سجل المدفوعات</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>الشهر</th><th>المطلوب</th><th>المدفوع</th><th>التاريخ</th></tr></thead>
      <tbody>${paymentsRows}</tbody>
    </table></div>
  </div>

  ${m.notes ? `<div class="card"><h3>ملاحظات</h3><p>${escapeHtml(m.notes)}</p></div>` : ''}

  <div class="card">
    <button class="btn" onclick="showEditMember(${m.id})">✏️ تعديل</button>
  </div>`;
  html += bottomNav('home');
  app.innerHTML = html;
}

/* ===== Add/Edit Member ===== */
async function showAddMember() {
  const assoc = await db.associations.get(currentAssocId);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <h3>إضافة مشترك</h3>
    <label>الاسم</label>
    <input id="mName" placeholder="الاسم الكامل">
    <label>رقم الهاتف (اختياري)</label>
    <input id="mPhone" type="tel" placeholder="01xxxxxxxxx">
    <label>المساهمة الشهرية (ج.م)</label>
    <input id="mContrib" type="number" min="0" value="${assoc ? assoc.baseContribution : 1000}">
    <label>رقم دور القبض</label>
    <input id="mRole" type="number" min="1" value="1">
    <label>ملاحظات</label>
    <textarea id="mNotes" rows="2"></textarea>
    <p style="font-size:0.8rem;color:var(--muted);margin-top:8px">
      💡 لو نفس الشخص في أكثر من دور، أضفه بنفس الاسم بالضبط.
    </p>
    <button class="btn" onclick="saveMember()">حفظ</button>
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
  </div>`;
  document.body.appendChild(overlay);
}
async function ensureRole(assocId, order) {
  const e = await db.roles.where({ associationId: assocId, order: Number(order) }).first();
  if (!e) await db.roles.add({ associationId: assocId, order: Number(order), status: 'pending', paidDate: null, paidAmount: 0 });
}
async function saveMember() {
  const name = document.getElementById('mName').value.trim();
  if (!name) { toast('أدخل اسم المشترك', 'error'); return; }
  const contrib = Number(document.getElementById('mContrib').value) || 0;
  const roleOrder = Number(document.getElementById('mRole').value) || 1;
  await db.members.add({
    associationId: currentAssocId, name,
    phone: document.getElementById('mPhone').value.trim(),
    monthlyContribution: contrib, roleOrder,
    notes: document.getElementById('mNotes').value.trim()
  });
  await ensureRole(currentAssocId, roleOrder);
  await log('إضافة مشترك', `تمت إضافة ${name} بمساهمة ${contrib} في الدور ${roleOrder}`);
  document.querySelector('.modal-overlay').remove();
  toast('تمت الإضافة', 'success');
  render();
}
async function showEditMember(id) {
  const m = await db.members.get(id);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal">
    <h3>تعديل المشترك</h3>
    <label>الاسم</label><input id="emName" value="${escapeHtml(m.name)}">
    <label>الهاتف</label><input id="emPhone" value="${escapeHtml(m.phone || '')}">
    <label>المساهمة</label><input id="emContrib" type="number" value="${m.monthlyContribution}">
    <label>الدور</label><input id="emRole" type="number" value="${m.roleOrder}">
    <button class="btn" onclick="updateMember(${id})">حفظ</button>
    <button class="btn danger" onclick="deleteMember(${id})">حذف</button>
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
  </div>`;
  document.body.appendChild(overlay);
}
async function updateMember(id) {
  const m = await db.members.get(id);
  const old = m.monthlyContribution;
  const newRole = Number(document.getElementById('emRole').value) || 1;
  await db.members.update(id, {
    name: document.getElementById('emName').value.trim(),
    phone: document.getElementById('emPhone').value.trim(),
    monthlyContribution: Number(document.getElementById('emContrib').value) || 0,
    roleOrder: newRole
  });
  await ensureRole(currentAssocId, newRole);
  await log('تعديل مشترك', `تم تعديل ${m.name} (من ${old} إلى ${document.getElementById('emContrib').value})`);
  document.querySelector('.modal-overlay').remove();
  toast('تم التعديل', 'success');
  render();
}
async function deleteMember(id) {
  if (!confirm('حذف هذا المشترك؟ سيتم حذف مدفوعاته.')) return;
  const m = await db.members.get(id);
  await db.members.delete(id);
  await db.payments.where('memberId').equals(id).delete();
  await log('حذف مشترك', `تم حذف ${m ? m.name : id}`);
  document.querySelector('.modal-overlay').remove();
  toast('تم الحذف', 'success');
  if (currentView === 'member') { currentMemberId = null; currentView = 'assoc'; }
  render();
}

/* ===== Roles & People ===== */
async function showManageRoles() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const roles = await db.roles.where('associationId').equals(currentAssocId).toArray();
  const orders = [...new Set([...roles.map(r => Number(r.order)), ...members.map(m => Number(m.roleOrder))])].sort((a, b) => a - b);
  let rows = '';
  for (const o of orders) {
    const rm = members.filter(m => Number(m.roleOrder) === o);
    const total = rm.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
    const role = roles.find(r => Number(r.order) === o);
    const st = role ? role.status : 'pending';
    const b = st === 'paid' ? '<span class="badge green">صُرف</span>' : st === 'due' ? '<span class="badge yellow">مستحق</span>' : '<span class="badge gray">لم يحن</span>';
    rows += `<tr><td>${o}</td><td>${rm.map(m => escapeHtml(m.name)).join('، ') || '—'}</td><td>${fmt(total)}</td><td>${b}</td></tr>`;
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:560px">
    <h3>أدوار القبض</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>الدور</th><th>المستحقون</th><th>الإجمالي</th><th>الحالة</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4" class="empty">لا توجد أدوار</td></tr>'}</tbody>
    </table></div>
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إغلاق</button>
  </div>`;
  document.body.appendChild(overlay);
}
async function showPeopleAccounts() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const names = [...new Set(members.map(m => m.name.trim()))];
  const summaries = names.map(n => getPersonSummary(assoc, members, payments, payouts, n))
    .filter(s => s.roleCount > 1).sort((a, b) => b.roleCount - a.roleCount);
  let html = '';
  if (summaries.length === 0) {
    html = '<p class="empty">لا يوجد أشخاص في أكثر من دور بهذه الجمعية</p>';
  } else {
    for (const s of summaries) {
      let roleRows = '';
      for (const r of s.roles) {
        roleRows += `<tr>
          <td>${r.roleOrder}</td><td>${fmt(r.monthly)}</td><td>${fmt(r.due)}</td>
          <td>${r.thisMonthPaid >= r.thisMonthDue ? '<span class="badge green">مدفوع</span>' : r.thisMonthPaid > 0 ? `<span class="badge yellow">جزئي</span>` : `<span class="badge red">متبقي ${fmt(r.thisMonthDue)}</span>`}</td>
          <td>${r.hasReceived ? `<span class="badge green">قبض ${fmt(r.payoutShare)}</span>` : '<span class="badge gray">لم يقبض</span>'}</td>
        </tr>`;
      }
      html += `<div class="card" style="border-right:4px solid var(--primary);margin-top:12px">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">${escapeHtml(s.personName)}</h3>
          <span class="badge yellow">${s.roleCount} أدوار</span>
        </div>
        <div class="grid" style="margin:10px 0;grid-template-columns:1fr 1fr 1fr">
          <div class="stat" style="padding:8px"><div class="value" style="font-size:0.9rem">${fmt(s.totalMonthly)}</div><div class="label">شهريًا</div></div>
          <div class="stat" style="padding:8px"><div class="value" style="font-size:0.9rem;color:var(--success)">${fmt(s.totalPaidAll)}</div><div class="label">مدفوع</div></div>
          <div class="stat" style="padding:8px"><div class="value" style="font-size:0.9rem;color:var(--danger)">${fmt(s.totalRemaining)}</div><div class="label">متبقي</div></div>
        </div>
        <div class="table-wrap"><table>
          <thead><tr><th>دور</th><th>مساهمة</th><th>استحقاق</th><th>حالة الشهر</th><th>قبض</th></tr></thead>
          <tbody>${roleRows}</tbody>
        </table></div>
      </div>`;
    }
  }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:640px">
    <h3>👥 الأشخاص متعددا الأدوار</h3>${html}
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إغلاق</button>
  </div>`;
  document.body.appendChild(overlay);
}

/* ===== Collection ===== */
async function showMonthlyCollection() {
  const assoc = await db.associations.get(currentAssocId);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal collection-modal" style="max-width:640px">
    <h3>💰 التحصيل الشهري</h3>
    <label>اختر الشهر</label>
    <select id="monthSelect" onchange="renderCollectionTable(this.value)">
      ${Array.from({ length: assoc.months }, (_, i) => `<option value="${i}">الشهر ${i + 1}</option>`).join('')}
    </select>
    <div id="collectionTable"></div>
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إغلاق</button>
  </div>`;
  document.body.appendChild(overlay);
  renderCollectionTable(0);
}
async function renderCollectionTable(monthIdx) {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const container = document.getElementById('collectionTable');
  if (!container) return;
  monthIdx = Number(monthIdx);
  const nameCounts = {};
  members.forEach(m => { const k = m.name.trim(); nameCounts[k] = (nameCounts[k] || 0) + 1; });

  let rows = '', mDue = 0, mPaid = 0;
  for (const m of members) {
    const due = Number(m.monthlyContribution);
    const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === monthIdx);
    const paid = p ? Number(p.amountPaid || 0) : 0;
    const rem = Math.max(0, due - paid);
    mDue += due; mPaid += paid;
    const badge = rem === 0 ? '<span class="badge green">✓</span>' : paid > 0 ? '<span class="badge yellow">جزئي</span>' : '<span class="badge red">لم يدفع</span>';
    const multi = nameCounts[m.name.trim()] > 1 ? ` <span class="badge blue" style="font-size:0.6rem">${nameCounts[m.name.trim()]}×</span>` : '';
    const lastDate = p && p.paidDate ? `<br><span style="font-size:0.7rem;color:var(--muted)">${p.paidDate}</span>` : '';
    let actions = '';
    if (rem > 0) {
      actions += `<button class="btn small" onclick="showPaymentModal(${m.id}, ${monthIdx})">دفع</button> `;
      if (m.phone) actions += `<button class="btn small whatsapp" onclick="sendReminder(${m.id}, ${monthIdx})">📱</button>`;
    }
    rows += `<tr>
      <td class="clickable" onclick="this.closest('.modal-overlay').remove(); openMember(${m.id})">${escapeHtml(m.name)}${multi}</td>
      <td>${fmt(due)}</td><td>${fmt(paid)}${lastDate}</td>
      <td style="color:${rem > 0 ? 'var(--danger)' : 'var(--success)'}">${fmt(rem)}</td>
      <td>${badge}</td>
      <td>${actions || '—'}</td>
    </tr>`;
  }
  const mRem = mDue - mPaid;
  const summary = `<div style="background:${mRem > 0 ? '#fef9c3' : '#dcfce7'};padding:10px;border-radius:8px;margin-bottom:10px;font-size:0.85rem;color:#000">
    <strong>ملخص الشهر ${monthIdx + 1}:</strong> مطلوب ${fmt(mDue)} · مدفوع ${fmt(mPaid)} · متبقي <strong style="color:${mRem > 0 ? '#dc2626' : '#16a34a'}">${fmt(mRem)}</strong>
  </div>`;
  container.innerHTML = summary + `<div class="table-wrap"><table>
    <thead><tr><th>المشترك</th><th>مطلوب</th><th>مدفوع</th><th>متبقي</th><th>حالة</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">لا يوجد مشتركون</td></tr>'}</tbody>
  </table></div>`;
}
async function sendReminder(memberId, monthIdx) {
  const m = await db.members.get(memberId);
  const assoc = await db.associations.get(currentAssocId);
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === Number(monthIdx));
  const paid = p ? Number(p.amountPaid || 0) : 0;
  const rem = Number(m.monthlyContribution) - paid;
  const msg = `السلام عليكم ${m.name} 👋\n\n` +
    `تذكير بمساهمة شهر ${Number(monthIdx) + 1} في جمعية "${assoc.name}"\n\n` +
    `المبلغ المطلوب: ${fmt(m.monthlyContribution)} ج.م\n` +
    `المدفوع: ${fmt(paid)} ج.م\n` +
    `المتبقي: ${fmt(rem)} ج.م\n\n` +
    `شكرًا لتعاونك 🌹`;
  openWhatsApp(m.phone, msg);
}
async function showPaymentModal(memberId, monthIdx) {
  const m = await db.members.get(memberId);
  const existing = await db.payments.where({ memberId, monthIndex: Number(monthIdx) }).first();
  const due = Number(m.monthlyContribution);
  const alreadyPaid = existing ? Number(existing.amountPaid || 0) : 0;
  const rem = due - alreadyPaid;
  if (rem <= 0) { toast('تم السداد', 'info'); return; }
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay payment-modal';
  overlay.innerHTML = `<div class="modal">
    <h3>دفع — ${escapeHtml(m.name)}</h3>
    <p style="font-size:0.85rem;margin-bottom:8px">
      الشهر ${Number(monthIdx) + 1} · المطلوب ${fmt(due)} · المدفوع ${fmt(alreadyPaid)} · المتبقي <strong style="color:var(--danger)">${fmt(rem)}</strong>
    </p>
    <label>المبلغ المدفوع</label>
    <input id="payAmount" type="number" min="0.01" max="${rem}" step="0.01" value="${rem}">
    <label>تاريخ الدفع</label>
    <input id="payDate" type="date" value="${today()}">
    <button class="btn" onclick="savePayment(${memberId}, ${monthIdx})">تأكيد</button>
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
  </div>`;
  document.body.appendChild(overlay);
}
async function savePayment(memberId, monthIdx) {
  monthIdx = Number(monthIdx);
  const amount = Number(document.getElementById('payAmount').value);
  const date = document.getElementById('payDate').value;
  if (!amount || amount <= 0) { toast('مبلغ غير صحيح', 'error'); return; }
  const m = await db.members.get(memberId);
  const existing = await db.payments.where({ memberId, monthIndex: monthIdx }).first();
  const old = existing ? Number(existing.amountPaid || 0) : 0;
  const total = old + amount;
  const due = Number(m.monthlyContribution);
  if (total > due) { toast('المبلغ يتجاوز المطلوب', 'error'); return; }
  if (existing) await db.payments.update(existing.id, { amountPaid: total, paidDate: date, status: total >= due ? 'paid' : 'partial' });
  else await db.payments.add({ associationId: currentAssocId, memberId, monthIndex: monthIdx, amountDue: due, amountPaid: amount, paidDate: date, status: amount >= due ? 'paid' : 'partial' });
  await log('تسجيل دفع', `دفع ${m.name} ${amount} للشهر ${monthIdx + 1}`);
  document.querySelector('.payment-modal').remove();
  toast('تم تسجيل الدفع', 'success');

  // WhatsApp confirmation
  if (m.phone) {
    const newRem = due - total;
    setTimeout(() => {
      if (confirm('هل تريد إرسال تأكيد الدفع عبر واتساب؟')) {
        const assoc = db.associations.get(currentAssocId);
        assoc.then(a => {
          const msg = `تم استلام ${fmt(amount)} ج.م من ${m.name} لشهر ${monthIdx + 1} في جمعية "${a.name}".\nالمتبقي: ${fmt(newRem)} ج.م.\nشكرًا! ✅`;
          openWhatsApp(m.phone, msg);
        });
      }
    }, 300);
  }

  renderCollectionTable(monthIdx);
  setTimeout(() => { if (currentView === 'assoc') render(); }, 400);
}

/* ===== Payout ===== */
async function showPayout() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const roles = await db.roles.where('associationId').equals(currentAssocId).toArray();
  const totalCollected = payments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
  const totalPaidOut = payouts.filter(p => p.confirmed).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const available = totalCollected - totalPaidOut;
  const pending = roles.filter(r => r.status !== 'paid').sort((a, b) => a.order - b.order);
  if (pending.length === 0) { toast('لا توجد أدوار للصرف', 'error'); return; }
  const opts = pending.map(r => {
    const rm = members.filter(m => Number(m.roleOrder) === Number(r.order));
    const total = rm.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
    return `<option value="${r.order}">الدور ${r.order} — ${rm.map(m => m.name).join('، ')} — ${fmt(total)}</option>`;
  }).join('');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal" style="max-width:640px">
    <h3>📤 صرف دور</h3>
    <p style="font-size:0.9rem;margin-bottom:8px">المتاح للصرف: <strong style="color:${available > 0 ? 'var(--success)' : 'var(--danger)'}">${fmt(available)}</strong> ج.م</p>
    <label>الدور</label>
    <select id="payoutRole" onchange="renderPayoutPreview()">${opts}</select>
    <div id="payoutPreview" style="margin-top:10px"></div>
    <label style="margin-top:10px">تاريخ الصرف</label>
    <input id="payoutDate" type="date" value="${today()}">
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px;font-size:0.85rem;font-weight:400">
      <input type="checkbox" id="deductArrears" style="width:auto;margin:0">
      خصم المتأخرات من مبلغ الصرف
    </label>
    <button class="btn" onclick="confirmPayout()">تأكيد الصرف</button>
    <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
  </div>`;
  document.body.appendChild(overlay);
  renderPayoutPreview();
}
async function renderPayoutPreview() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const sel = document.getElementById('payoutRole');
  const preview = document.getElementById('payoutPreview');
  if (!sel || !preview) return;
  const order = Number(sel.value);
  const rm = members.filter(m => Number(m.roleOrder) === order);
  const total = rm.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
  let rows = '', totalOut = 0;
  for (const m of rm) {
    const s = getPersonSummary(assoc, members, payments, payouts, m.name);
    const tr = s.roles.find(r => Number(r.roleOrder) === order);
    const tDue = tr ? tr.due : 0;
    totalOut += s.totalRemaining;
    rows += `<tr>
      <td>${escapeHtml(m.name)}${s.roleCount > 1 ? ' <span class="badge blue" style="font-size:0.6rem">' + s.roleCount + '×</span>' : ''}</td>
      <td>${fmt(tDue)}</td><td>${fmt(s.totalPaidAll)}</td>
      <td style="color:var(--danger);font-weight:700">${fmt(s.totalRemaining)}</td>
    </tr>`;
  }
  preview.innerHTML = `<div style="background:#f0f9ff;padding:10px;border-radius:8px;font-size:0.85rem;color:#1e40af;margin-bottom:6px">
    إجمالي الدور: <strong>${fmt(total)}</strong> ج.م
  </div>
  <div class="table-wrap"><table>
    <thead><tr><th>المشترك</th><th>استحقاق الدور</th><th>إجمالي مدفوعه</th><th>متبقي عليه</th></tr></thead>
    <tbody>${rows || '<tr><td colspan="4" class="empty">—</td></tr>'}</tbody>
  </table></div>
  <p style="font-size:0.8rem;color:var(--muted);margin-top:6px">إجمالي المتبقي على المستحقين: ${fmt(totalOut)} ج.م</p>`;
}
async function confirmPayout() {
  const order = Number(document.getElementById('payoutRole').value);
  const date = document.getElementById('payoutDate').value;
  const deduct = document.getElementById('deductArrears').checked;
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const rm = members.filter(m => Number(m.roleOrder) === order);
  const total = rm.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
  const totalCollected = payments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
  const totalPaidOut = payouts.filter(p => p.confirmed).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const available = totalCollected - totalPaidOut;
  if (total > available) { toast(`المطلوب ${fmt(total)} > المتاح ${fmt(available)}`, 'error'); return; }
  const ex = await db.payouts.where({ associationId: currentAssocId, roleOrder: order }).first();
  if (ex && ex.confirmed) { toast('تم صرف هذا الدور', 'error'); return; }

  await db.payouts.add({
    associationId: currentAssocId, roleOrder: order, memberIds: rm.map(m => m.id),
    totalAmount: total, paidDate: date, confirmed: true, deductArrears: deduct
  });
  const role = await db.roles.where({ associationId: currentAssocId, order }).first();
  if (role) await db.roles.update(role.id, { status: 'paid', paidDate: date, paidAmount: total });
  else await db.roles.add({ associationId: currentAssocId, order, status: 'paid', paidDate: date, paidAmount: total });

  await log('صرف دور', `صُرف الدور ${order} بمبلغ ${total} ج.م لـ ${rm.map(m => m.name).join('، ')}${deduct ? ' (مع خصم المتأخرات)' : ''}`);
  document.querySelector('.modal-overlay').remove();
  toast('تم الصرف بنجاح', 'success');
  render();
}

/* ===== Reports ===== */
async function renderReports(app) {
  const assoc = await db.associations.get(currentAssocId);
  if (!assoc) { goHome(); return; }
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  let rows = '';
  for (const m of members) {
    const totalDue = Number(m.monthlyContribution) * assoc.months;
    const paid = payments.filter(p => Number(p.memberId) === Number(m.id)).reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    const rm = members.filter(x => Number(x.roleOrder) === Number(m.roleOrder));
    const rt = rm.reduce((s, x) => s + Number(x.monthlyContribution) * assoc.months, 0);
    const rp = payouts.find(p => Number(p.roleOrder) === Number(m.roleOrder) && p.confirmed);
    const rec = rp && rt > 0 ? (totalDue / rt) * Number(rp.totalAmount) : 0;
    rows += `<tr>
      <td>${escapeHtml(m.name)}</td><td>${fmt(totalDue)}</td><td>${fmt(paid)}</td>
      <td style="color:${paid >= totalDue ? 'var(--success)' : 'var(--danger)'}">${fmt(totalDue - paid)}</td>
      <td>${fmt(rec)}</td>
    </tr>`;
  }
  let html = `<header><h1>📊 تقارير — ${escapeHtml(assoc.name)}</h1>
    <button class="btn small secondary" onclick="openAssoc(${assoc.id})">← رجوع</button></header>

  <div class="card">
    <h3>التحصيل الشهري</h3>
    <div class="chart-container"><canvas id="chartCanvas"></canvas></div>
  </div>

  <div class="card">
    <h3>كشف حساب</h3>
    <div class="table-wrap"><table>
      <thead><tr><th>المشترك</th><th>استحقاق</th><th>مدفوع</th><th>متبقي</th><th>مستلم</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty">لا يوجد مشتركون</td></tr>'}</tbody>
    </table></div>
  </div>

  <div class="card">
    <h3>تصدير</h3>
    <button class="btn" onclick="exportExcel()">📥 Excel</button>
    <button class="btn secondary" onclick="exportCSV()">📄 CSV</button>
    <button class="btn secondary" onclick="exportPDF()">🖨️ PDF (طباعة)</button>
  </div>

  <div class="card">
    <h3>سجل العمليات (آخر 20)</h3>
    <div id="auditLog"><p class="empty">تحميل...</p></div>
    <button class="btn secondary" onclick="goAuditLog()">📋 عرض كل السجل</button>
  </div>`;
  html += bottomNav('reports');
  app.innerHTML = html;
  loadAuditLog();
  setTimeout(() => renderChart(assoc, payments), 100);
}
function renderChart(assoc, payments) {
  const canvas = document.getElementById('chartCanvas');
  if (!canvas) return;
  const labels = [], data = [];
  for (let i = 0; i < assoc.months; i++) {
    labels.push(`ش${i + 1}`);
    const collected = payments.filter(p => Number(p.monthIndex) === i).reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    data.push(collected);
  }
  new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ label: 'المحصّل', data, backgroundColor: '#0d9488' }] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true } } }
  });
}
async function loadAuditLog() {
  const logs = await db.auditLog.where('associationId').equals(currentAssocId).reverse().limit(20).toArray();
  const el = document.getElementById('auditLog');
  if (!el) return;
  el.innerHTML = logs.map(l => `<p style="font-size:0.8rem;border-bottom:1px solid var(--border);padding:6px 0">
    <span class="badge gray">${escapeHtml(l.action)}</span> ${escapeHtml(l.details)}<br>
    <span style="color:var(--muted);font-size:0.7rem">${new Date(l.timestamp).toLocaleString('ar-EG')}</span>
  </p>`).join('') || '<p class="empty">لا توجد عمليات</p>';
}
async function exportExcel() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const data = members.map(m => {
    const due = Number(m.monthlyContribution) * assoc.months;
    const paid = payments.filter(p => Number(p.memberId) === Number(m.id)).reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    return { 'الاسم': m.name, 'الهاتف': m.phone || '', 'المساهمة': m.monthlyContribution, 'الدور': m.roleOrder, 'الاستحقاق': due, 'المدفوع': paid, 'المتبقي': due - paid };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'تقرير');
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.writeFile(wb, `تقرير_${assoc.name}_${today()}.xlsx`);
  toast('تم التصدير', 'success');
}
async function exportCSV() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const lines = ['الاسم,الهاتف,المساهمة,الدور,الاستحقاق,المدفوع,المتبقي'];
  for (const m of members) {
    const due = Number(m.monthlyContribution) * assoc.months;
    const paid = payments.filter(p => Number(p.memberId) === Number(m.id)).reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    lines.push(`"${m.name}","${m.phone || ''}",${m.monthlyContribution},${m.roleOrder},${due},${paid},${due - paid}`);
  }
  const blob = new Blob(['\ufeff' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `تقرير_${assoc.name}_${today()}.csv`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('تم تصدير CSV', 'success');
}
async function exportPDF() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const rows = members.map(m => {
    const due = Number(m.monthlyContribution) * assoc.months;
    const paid = payments.filter(p => Number(p.memberId) === Number(m.id)).reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    return `<tr><td>${escapeHtml(m.name)}</td><td>${m.monthlyContribution}</td><td>${m.roleOrder}</td><td>${due}</td><td>${paid}</td><td>${due - paid}</td></tr>`;
  }).join('');
  const w = window.open('', '_blank');
  if (!w) { toast('الرجاء السماح بالنوافذ', 'error'); return; }
  w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="UTF-8"><title>تقرير ${escapeHtml(assoc.name)}</title>
    <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700&display=swap" rel="stylesheet">
    <style>body{font-family:Cairo,sans-serif;padding:20px;color:#134e4a}h1{color:#0d9488}table{width:100%;border-collapse:collapse;margin-top:20px}th,td{border:1px solid #cbd5e1;padding:8px;text-align:right}th{background:#0d9488;color:white}@media print{.no-print{display:none}}</style>
    </head><body><h1>تقرير: ${escapeHtml(assoc.name)}</h1>
    <p style="color:#64748b">عدد الشهور: ${assoc.months} | المشتركون: ${members.length}</p>
    <table><thead><tr><th>الاسم</th><th>مساهمة</th><th>دور</th><th>استحقاق</th><th>مدفوع</th><th>متبقي</th></tr></thead><tbody>${rows}</tbody></table>
    <div class="no-print" style="text-align:center;margin-top:20px"><button onclick="window.print()" style="padding:10px 20px;background:#0d9488;color:white;border:none;border-radius:8px;font-family:Cairo">🖨️ طباعة</button></div>
    <script>window.onload=()=>setTimeout(()=>window.print(),600)</script></body></html>`);
  w.document.close();
}

/* ===== Full Audit Log ===== */
async function renderAuditLog(app) {
  const logs = await db.auditLog.reverse().limit(200).toArray();
  const assocs = await db.associations.toArray();
  const assocMap = {};
  assocs.forEach(a => assocMap[a.id] = a.name);
  let html = `<header><h1>📋 سجل العمليات</h1>
    <button class="btn small secondary" onclick="goHome()">← رجوع</button></header>
  <div class="card"><h3>آخر ${logs.length} عملية</h3>`;
  for (const l of logs) {
    const aName = assocMap[l.associationId] || '(غير محدد)';
    html += `<p style="font-size:0.8rem;border-bottom:1px solid var(--border);padding:8px 0">
      <span class="badge blue">${escapeHtml(aName)}</span>
      <span class="badge gray">${escapeHtml(l.action)}</span><br>
      ${escapeHtml(l.details)}<br>
      <span style="color:var(--muted);font-size:0.7rem">${new Date(l.timestamp).toLocaleString('ar-EG')}</span>
    </p>`;
  }
  html += '</div>' + bottomNav('');
  app.innerHTML = html;
}

/* ===== Settings ===== */
async function renderSettings(app) {
  const pinEnabled = !!settingsCache.pinEnabled;
  const darkMode = !!settingsCache.darkMode;
  let html = `<header><h1>⚙️ الإعدادات</h1></header>
  <div class="card">
    <h3>المظهر</h3>
    <div class="toggle-row">
      <span>🌙 الوضع الليلي</span>
      <button class="toggle ${darkMode ? 'active' : ''}" onclick="toggleDark()"></button>
    </div>
  </div>

  <div class="card">
    <h3>الأمان</h3>
    <div class="toggle-row">
      <span>🔒 قفل التطبيق بـ PIN</span>
      <button class="toggle ${pinEnabled ? 'active' : ''}" onclick="togglePinLock()"></button>
    </div>
    ${pinEnabled ? `<button class="btn secondary" onclick="changePin()">تغيير الرقم السري</button>` : ''}
  </div>

  <div class="card">
    <h3>الإشعارات</h3>
    <button class="btn" onclick="requestNotifPermission()">🔔 تفعيل إشعارات المتأخرات</button>
    <p style="font-size:0.75rem;color:var(--muted);margin-top:6px">
      تنبيهات عند فتح التطبيق. الإشعارات المجدولة تحتاج خدمة خارجية.
    </p>
  </div>

  <div class="card">
    <h3>النسخ الاحتياطي</h3>
    <p style="font-size:0.8rem;color:var(--muted)">
      آخر نسخة: ${settingsCache.lastBackup ? new Date(settingsCache.lastBackup).toLocaleString('ar-EG') : 'لا يوجد'}
    </p>
    <button class="btn" onclick="goBackup()">💾 إدارة النسخ الاحتياطي</button>
  </div>

  <div class="card">
    <h3>سجل العمليات</h3>
    <button class="btn secondary" onclick="goAuditLog()">📋 عرض السجل الكامل</button>
  </div>

  <div class="card">
    <h3 style="color:var(--danger)">منطقة الخطر</h3>
    <button class="btn danger" onclick="clearAllData()">🗑️ حذف جميع البيانات</button>
  </div>

  <div class="card" style="text-align:center;font-size:0.8rem;color:var(--muted)">
    جمعيتي — الإصدار 3.0
  </div>`;
  html += bottomNav('settings');
  app.innerHTML = html;
}
async function toggleDark() {
  await saveSetting('darkMode', !settingsCache.darkMode);
  render();
}
async function togglePinLock() {
  if (settingsCache.pinEnabled) {
    await saveSetting('pinEnabled', false);
    toast('تم تعطيل القفل', 'success');
  } else {
    const pin = prompt('أدخل رقمًا سريًا (4-8 أرقام):');
    if (!pin || pin.length < 4) { toast('رقم غير صالح (4 على الأقل)', 'error'); return; }
    const h = await hashPin(pin);
    await saveSetting('pin', h);
    await saveSetting('pinEnabled', true);
    toast('تم تفعيل القفل', 'success');
  }
  render();
}
async function changePin() {
  const pin = prompt('الرقم السري الجديد (4-8 أرقام):');
  if (!pin || pin.length < 4) { toast('رقم غير صالح', 'error'); return; }
  const h = await hashPin(pin);
  await saveSetting('pin', h);
  toast('تم التغيير', 'success');
}
async function clearAllData() {
  if (!confirm('سيتم حذف كل البيانات نهائيًا. هل أنت متأكد؟')) return;
  if (!confirm('تأكيد أخير: سيتم مسح كل الجمعيات والمشتركين والمدفوعات.')) return;
  await db.transaction('rw', db.associations, db.members, db.roles, db.payments, db.payouts, db.auditLog, async () => {
    await db.associations.clear(); await db.members.clear(); await db.roles.clear();
    await db.payments.clear(); await db.payouts.clear(); await db.auditLog.clear();
  });
  toast('تم مسح البيانات', 'success');
  goHome();
}

/* ===== Backup ===== */
async function renderBackup(app) {
  let html = `<header><h1>💾 النسخ الاحتياطي</h1></header>
  <div class="card">
    <h3>تصدير</h3>
    <p style="font-size:0.85rem;color:var(--muted);margin-bottom:8px">جميع البيانات كملف JSON.</p>
    <button class="btn" onclick="exportBackup()">⬇️ تصدير الآن</button>
    ${settingsCache.lastBackup ? `<p style="font-size:0.75rem;color:var(--muted);margin-top:6px">آخر نسخة: ${new Date(settingsCache.lastBackup).toLocaleString('ar-EG')}</p>` : ''}
  </div>
  <div class="card">
    <h3>استعادة</h3>
    <p style="font-size:0.85rem;color:var(--muted);margin-bottom:8px">⚠️ سيتم استبدال البيانات الحالية.</p>
    <input type="file" id="restoreFile" accept=".json,application/json">
    <button class="btn danger" onclick="restoreBackup()">⬆️ استعادة</button>
  </div>`;
  html += bottomNav('backup');
  app.innerHTML = html;
}
async function exportBackup() {
  const data = {
    associations: await db.associations.toArray(),
    members: await db.members.toArray(),
    roles: await db.roles.toArray(),
    payments: await db.payments.toArray(),
    payouts: await db.payouts.toArray(),
    auditLog: await db.auditLog.toArray(),
    exportedAt: new Date().toISOString(), version: 2
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `jamiyati_backup_${today()}.json`; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  await saveSetting('lastBackup', new Date().toISOString());
  toast('تم التصدير', 'success');
}
async function restoreBackup() {
  const file = document.getElementById('restoreFile').files[0];
  if (!file) { toast('اختر ملف', 'error'); return; }
  if (!confirm('سيتم استبدال البيانات. متأكد؟')) return;
  try {
    const data = JSON.parse(await file.text());
    await db.transaction('rw', db.associations, db.members, db.roles, db.payments, db.payouts, db.auditLog, async () => {
      await db.associations.clear(); await db.members.clear(); await db.roles.clear();
      await db.payments.clear(); await db.payouts.clear(); await db.auditLog.clear();
      if (data.associations) await db.associations.bulkAdd(data.associations);
      if (data.members) await db.members.bulkAdd(data.members);
      if (data.roles) await db.roles.bulkAdd(data.roles);
      if (data.payments) await db.payments.bulkAdd(data.payments);
      if (data.payouts) await db.payouts.bulkAdd(data.payouts);
      if (data.auditLog) await db.auditLog.bulkAdd(data.auditLog);
    });
    toast('تمت الاستعادة', 'success');
    goHome();
  } catch (e) { console.error(e); toast('ملف غير صالح', 'error'); }
}

/* ===== Init ===== */
async function init() {
  await loadSettings();
  if (settingsCache.pinEnabled && settingsCache.pin) {
    showLockScreen(() => {
      checkAndNotify();
      render();
    });
  } else {
    checkAndNotify();
    render();
  }
}
init();