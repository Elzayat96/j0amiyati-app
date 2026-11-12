/* ============================================================
   جمعيتي — إدارة الجمعيات الشهرية
   قاعدة البيانات: IndexedDB عبر Dexie.js
   ============================================================ */

const db = new Dexie('JamiyatiDB');
db.version(1).stores({
  associations: '++id, name, createdAt',
  members: '++id, associationId, roleOrder',
  roles: '++id, associationId, order, status, [associationId+order]',
  payments: '++id, associationId, memberId, monthIndex, [memberId+monthIndex], [associationId+monthIndex]',
  payouts: '++id, associationId, roleOrder, [associationId+roleOrder]',
  auditLog: '++id, associationId, timestamp'
});

let currentAssocId = null;
let currentView = 'home';

/* ---------- أدوات ---------- */
function fmt(n) {
  const v = Number(n || 0);
  return v.toLocaleString('ar-EG', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function today() { return new Date().toISOString().slice(0, 10); }
function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function toast(msg, type) {
  type = type || 'info';
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
      action, details,
      timestamp: new Date().toISOString()
    });
  } catch (e) { console.warn('log err', e); }
}

/* حساب عدد الأشهر التي بدأت من تاريخ البداية حتى اليوم */
function getStartedMonthsCount(startDate, totalMonths) {
  const start = new Date(startDate);
  const now = new Date();
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  months = months + 1; // الشهر الحالي محسوب
  return Math.min(Math.max(0, months), totalMonths);
}

/* حساب المتأخرات الفعلية (للأشهر التي بدأت ولم تُسدَّد) */
async function computeArrears(assoc, members, payments) {
  const startedMonths = getStartedMonthsCount(assoc.startDate, assoc.months);
  let total = 0;
  for (const m of members) {
    const due = Number(m.monthlyContribution);
    for (let i = 0; i < startedMonths; i++) {
      const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === i);
      const paid = p ? Number(p.amountPaid || 0) : 0;
      if (paid < due) total += (due - paid);
    }
  }
  return total;
}

/* ---------- التنقل ---------- */
function render() {
  const app = document.getElementById('app');
  if (currentView === 'assoc' && currentAssocId) return renderAssoc(app);
  if (currentView === 'reports' && currentAssocId) return renderReports(app);
  if (currentView === 'backup') return renderBackup(app);
  return renderHome(app);
}

function goHome() { currentView = 'home'; currentAssocId = null; render(); }
function goReports() {
  if (!currentAssocId) { toast('اختر جمعية أولًا', 'error'); return; }
  currentView = 'reports'; render();
}
function goBackup() { currentView = 'backup'; render(); }
function openAssoc(id) { currentAssocId = id; currentView = 'assoc'; render(); }

function bottomNav(active) {
  return `<div class="bottom-nav">
    <button class="${active === 'home' ? 'active' : ''}" onclick="goHome()">🏠<span>الرئيسية</span></button>
    <button class="${active === 'reports' ? 'active' : ''}" onclick="goReports()">📊<span>التقارير</span></button>
    <button class="${active === 'backup' ? 'active' : ''}" onclick="goBackup()">💾<span>النسخ الاحتياطي</span></button>
  </div>`;
}

/* ============================================================
   1. الصفحة الرئيسية
   ============================================================ */
async function renderHome(app) {
  const assocs = await db.associations.toArray();
  let html = `<header><h1>جمعيتي</h1><span style="font-size:0.8rem;opacity:0.9">إدارة الجمعيات الشهرية</span></header>`;

  if (assocs.length === 0) {
    html += `<div class="empty">
      <p style="font-size:2.5rem">📋</p>
      <p style="margin-top:8px">لا توجد جمعيات بعد</p>
      <p style="font-size:0.85rem;margin-top:6px">ابدأ بإنشاء جمعيتك الأولى</p>
    </div>`;
  } else {
    for (const a of assocs) {
      const members = await db.members.where('associationId').equals(a.id).toArray();
      const totalMonthly = members.reduce((s, m) => s + Number(m.monthlyContribution), 0);
      html += `<div class="card" onclick="openAssoc(${a.id})" style="cursor:pointer">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <h3 style="margin:0">${escapeHtml(a.name)}</h3>
          <span class="badge gray">${members.length} مشترك</span>
        </div>
        <p style="color:var(--muted);font-size:0.85rem;margin-top:6px">
          ${a.months} شهر · التحصيل الشهري المتوقع: <strong>${fmt(totalMonthly)}</strong> ج.م
        </p>
      </div>`;
    }
  }

  html += `<button class="btn" onclick="showCreateAssoc()">＋ إنشاء جمعية جديدة</button>`;
  html += bottomNav('home');
  app.innerHTML = html;
}

/* ============================================================
   2. إنشاء جمعية
   ============================================================ */
function showCreateAssoc() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3 style="margin-bottom:12px">جمعية جديدة</h3>
      <label>اسم الجمعية</label>
      <input id="assocName" placeholder="مثال: جمعية الأصدقاء">
      <label>عدد الشهور</label>
      <input id="assocMonths" type="number" min="1" value="10">
      <label>الاشتراك الشهري الأساسي (ج.م)</label>
      <input id="assocBase" type="number" min="0" value="1000">
      <label>تاريخ البداية</label>
      <input id="assocStart" type="date" value="${today()}">
      <label>يوم التحصيل الشهري</label>
      <input id="assocDay" type="number" min="1" max="28" value="1">
      <label>ملاحظات</label>
      <textarea id="assocNotes" rows="2"></textarea>
      <button class="btn" onclick="createAssoc()">حفظ الجمعية</button>
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
    createdAt: new Date().toISOString()
  });
  await log('إنشاء جمعية', `تم إنشاء الجمعية: ${name}`, id);
  document.querySelector('.modal-overlay').remove();
  toast('تم إنشاء الجمعية', 'success');
  openAssoc(id);
}

/* ============================================================
   3. صفحة الجمعية
   ============================================================ */
async function renderAssoc(app) {
  const assoc = await db.associations.get(currentAssocId);
  if (!assoc) { goHome(); return; }
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const roles = await db.roles.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();

  const totalMonthlyExpected = members.reduce((s, m) => s + Number(m.monthlyContribution), 0);
  const totalCollected = payments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
  const totalDue = members.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
  const totalRemaining = totalDue - totalCollected;
  const actualArrears = await computeArrears(assoc, members, payments);
  const totalPaidOut = payouts.filter(p => p.confirmed).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const availableForPayout = totalCollected - totalPaidOut;

  const nextRole = roles.filter(r => r.status !== 'paid').sort((a, b) => a.order - b.order)[0];
  let nextRoleInfo = 'لا توجد أدوار متبقية 🎉';
  if (nextRole) {
    const roleMembers = members.filter(m => Number(m.roleOrder) === Number(nextRole.order));
    const roleTotal = roleMembers.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
    nextRoleInfo = `<strong>الدور ${nextRole.order}:</strong> ${roleMembers.map(m => escapeHtml(m.name)).join('، ') || '—'} — <strong>${fmt(roleTotal)}</strong> ج.م`;
  }

  // المتأخرون
  const startedMonths = getStartedMonthsCount(assoc.startDate, assoc.months);
  const overdueMembers = [];
  for (const m of members) {
    let memberDue = 0;
    for (let i = 0; i < startedMonths; i++) {
      const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === i);
      const paid = p ? Number(p.amountPaid || 0) : 0;
      memberDue += Math.max(0, Number(m.monthlyContribution) - paid);
    }
    if (memberDue > 0) overdueMembers.push({ name: m.name, amount: memberDue });
  }

  const progress = totalDue > 0 ? Math.round((totalCollected / totalDue) * 100) : 0;

  let html = `
    <header>
      <div>
        <h1>${escapeHtml(assoc.name)}</h1>
        <span style="font-size:0.8rem;opacity:0.9">${assoc.months} شهر · بداية ${assoc.startDate}</span>
      </div>
      <button class="btn small secondary" onclick="goHome()">← رجوع</button>
    </header>

    <div class="grid" style="margin-bottom:12px">
      <div class="stat"><div class="value">${fmt(totalMonthlyExpected)}</div><div class="label">التحصيل الشهري المتوقع</div></div>
      <div class="stat"><div class="value" style="color:var(--success)">${fmt(totalCollected)}</div><div class="label">المحصّل فعليًا</div></div>
      <div class="stat"><div class="value" style="color:var(--danger)">${fmt(actualArrears)}</div><div class="label">المتأخرات</div></div>
      <div class="stat"><div class="value" style="color:var(--warning)">${fmt(availableForPayout)}</div><div class="label">متاح للصرف</div></div>
    </div>

    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <h3 style="margin:0">نسبة إنجاز الجمعية</h3>
        <span style="font-weight:700;color:var(--primary)">${progress}%</span>
      </div>
      <div class="progress-bar"><div style="width:${progress}%"></div></div>
      <p style="font-size:0.8rem;color:var(--muted);margin-top:8px">
        المتبقي للتحصيل الكلي: ${fmt(totalRemaining)} ج.م
      </p>
    </div>

    <div class="card">
      <h3>الدور القادم</h3>
      <p style="font-size:0.9rem">${nextRoleInfo}</p>
    </div>

    ${overdueMembers.length ? `<div class="card">
      <h3>متأخرون في السداد (${overdueMembers.length})</h3>
      ${overdueMembers.map(o => `<p style="font-size:0.85rem;margin-top:4px;border-bottom:1px solid #f1f5f9;padding:4px 0">
        • ${escapeHtml(o.name)} — متبقي <strong style="color:var(--danger)">${fmt(o.amount)}</strong> ج.م
      </p>`).join('')}
    </div>` : ''}

    <div class="card">
      <h3>إدارة الجمعية</h3>
      <button class="btn" onclick="showAddMember()">＋ إضافة مشترك</button>
      <button class="btn secondary" onclick="showManageRoles()">⚙️ إدارة الأدوار</button>
      <button class="btn secondary" onclick="showMonthlyCollection()">💰 التحصيل الشهري</button>
      <button class="btn secondary" onclick="showPayout()">📤 صرف دور</button>
      <button class="btn secondary" onclick="goReports()">📊 التقارير</button>
      <button class="btn danger" onclick="deleteAssociation(${assoc.id})">🗑️ حذف الجمعية</button>
    </div>

    <div class="card">
      <h3>المشتركون (${members.length})</h3>
      ${members.length === 0 ? '<p class="empty">لم يُضف مشتركون بعد</p>' : `
      <div class="table-wrap"><table>
        <thead><tr><th>الاسم</th><th>المساهمة</th><th>الدور</th><th>الاستحقاق</th><th></th></tr></thead>
        <tbody>${members.map(m => `<tr>
          <td>${escapeHtml(m.name)}</td>
          <td>${fmt(m.monthlyContribution)}</td>
          <td>${m.roleOrder}</td>
          <td>${fmt(Number(m.monthlyContribution) * assoc.months)}</td>
          <td><button class="btn small secondary" onclick="showEditMember(${m.id})">تعديل</button></td>
        </tr>`).join('')}</tbody>
      </table></div>`}
    </div>
  `;
  html += bottomNav('home');
  app.innerHTML = html;
}

async function deleteAssociation(id) {
  if (!confirm('حذف الجمعية سيحذف جميع المشتركين والمدفوعات والأدوار نهائيًا. هل أنت متأكد؟')) return;
  await db.transaction('rw',
    db.associations, db.members, db.roles, db.payments, db.payouts, db.auditLog,
    async () => {
      await db.associations.delete(id);
      await db.members.where('associationId').equals(id).delete();
      await db.roles.where('associationId').equals(id).delete();
      await db.payments.where('associationId').equals(id).delete();
      await db.payouts.where('associationId').equals(id).delete();
      await db.auditLog.where('associationId').equals(id).delete();
    });
  toast('تم حذف الجمعية', 'success');
  goHome();
}

/* ============================================================
   4. المشتركون
   ============================================================ */
async function showAddMember() {
  const assoc = await db.associations.get(currentAssocId);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>إضافة مشترك</h3>
      <label>اسم المشترك</label>
      <input id="mName" placeholder="الاسم الكامل">
      <label>رقم الهاتف (اختياري)</label>
      <input id="mPhone" type="tel" placeholder="01xxxxxxxxx">
      <label>المساهمة الشهرية (ج.م) — مبلغ مخصص</label>
      <input id="mContrib" type="number" min="0" value="${assoc ? assoc.baseContribution : 1000}">
      <label>رقم دور القبض</label>
      <input id="mRole" type="number" min="1" value="1">
      <label>ملاحظات</label>
      <textarea id="mNotes" rows="2"></textarea>
      <button class="btn" onclick="saveMember()">حفظ</button>
      <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
    </div>`;
  document.body.appendChild(overlay);
}

async function ensureRole(assocId, order) {
  const existing = await db.roles.where({ associationId: assocId, order: Number(order) }).first();
  if (!existing) {
    await db.roles.add({
      associationId: assocId, order: Number(order),
      status: 'pending', paidDate: null, paidAmount: 0
    });
  }
}

async function saveMember() {
  const name = document.getElementById('mName').value.trim();
  if (!name) { toast('أدخل اسم المشترك', 'error'); return; }
  const contrib = Number(document.getElementById('mContrib').value) || 0;
  const roleOrder = Number(document.getElementById('mRole').value) || 1;
  await db.members.add({
    associationId: currentAssocId,
    name,
    phone: document.getElementById('mPhone').value.trim(),
    monthlyContribution: contrib,
    roleOrder,
    notes: document.getElementById('mNotes').value.trim()
  });
  await ensureRole(currentAssocId, roleOrder);
  await log('إضافة مشترك', `تمت إضافة ${name} بمساهمة ${contrib} في الدور ${roleOrder}`);
  document.querySelector('.modal-overlay').remove();
  toast('تمت إضافة المشترك', 'success');
  render();
}

async function showEditMember(id) {
  const m = await db.members.get(id);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>تعديل المشترك</h3>
      <label>الاسم</label>
      <input id="emName" value="${escapeHtml(m.name)}">
      <label>الهاتف</label>
      <input id="emPhone" value="${escapeHtml(m.phone || '')}">
      <label>المساهمة الشهرية</label>
      <input id="emContrib" type="number" value="${m.monthlyContribution}">
      <label>الدور</label>
      <input id="emRole" type="number" value="${m.roleOrder}">
      <button class="btn" onclick="updateMember(${id})">حفظ التعديل</button>
      <button class="btn danger" onclick="deleteMember(${id})">حذف المشترك</button>
      <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
    </div>`;
  document.body.appendChild(overlay);
}

async function updateMember(id) {
  const m = await db.members.get(id);
  const oldContrib = m.monthlyContribution;
  const newRole = Number(document.getElementById('emRole').value) || 1;
  await db.members.update(id, {
    name: document.getElementById('emName').value.trim(),
    phone: document.getElementById('emPhone').value.trim(),
    monthlyContribution: Number(document.getElementById('emContrib').value) || 0,
    roleOrder: newRole
  });
  await ensureRole(currentAssocId, newRole);
  await log('تعديل مشترك', `تم تعديل المشترك ${m.name} (المساهمة من ${oldContrib} إلى ${document.getElementById('emContrib').value})`);
  document.querySelector('.modal-overlay').remove();
  toast('تم التعديل', 'success');
  render();
}

async function deleteMember(id) {
  if (!confirm('حذف هذا المشترك؟ سيتم حذف مدفوعاته أيضًا.')) return;
  const m = await db.members.get(id);
  await db.members.delete(id);
  await db.payments.where('memberId').equals(id).delete();
  await log('حذف مشترك', `تم حذف المشترك ${m ? m.name : id}`);
  document.querySelector('.modal-overlay').remove();
  toast('تم الحذف', 'success');
  render();
}

/* ============================================================
   5. إدارة الأدوار
   ============================================================ */
async function showManageRoles() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const roles = await db.roles.where('associationId').equals(currentAssocId).toArray();
  const orders = [...new Set([...roles.map(r => Number(r.order)), ...members.map(m => Number(m.roleOrder))])].sort((a, b) => a - b);

  let rows = '';
  for (const o of orders) {
    const roleMembers = members.filter(m => Number(m.roleOrder) === o);
    const total = roleMembers.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
    const role = roles.find(r => Number(r.order) === o);
    const status = role ? role.status : 'pending';
    const badge = status === 'paid' ? '<span class="badge green">تم الصرف</span>' :
                  status === 'due' ? '<span class="badge yellow">مستحق</span>' :
                  '<span class="badge gray">لم يحن</span>';
    rows += `<tr>
      <td>${o}</td>
      <td>${roleMembers.map(m => escapeHtml(m.name)).join('، ') || '—'}</td>
      <td>${fmt(total)}</td>
      <td>${badge}</td>
    </tr>`;
  }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" style="max-width:560px">
      <h3>أدوار القبض</h3>
      <p style="font-size:0.85rem;color:var(--muted);margin-bottom:10px">
        يمكنك وضع أكثر من مشترك في نفس الدور. إجمالي الدور يُحسب تلقائيًا.
      </p>
      <div class="table-wrap"><table>
        <thead><tr><th>الدور</th><th>المستحقون</th><th>الإجمالي</th><th>الحالة</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="empty">لا توجد أدوار</td></tr>'}</tbody>
      </table></div>
      <button class="btn" onclick="this.closest('.modal-overlay').remove(); showAddMember()">＋ إضافة مشترك</button>
      <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إغلاق</button>
    </div>`;
  document.body.appendChild(overlay);
}

/* ============================================================
   6. التحصيل الشهري
   ============================================================ */
async function showMonthlyCollection() {
  const assoc = await db.associations.get(currentAssocId);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal collection-modal" style="max-width:560px">
      <h3>التحصيل الشهري</h3>
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

async function renderCollectionTable(monthIndex) {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const container = document.getElementById('collectionTable');
  if (!container) return;
  monthIndex = Number(monthIndex);

  let rows = '';
  for (const m of members) {
    const due = Number(m.monthlyContribution);
    const p = payments.find(x => Number(x.memberId) === Number(m.id) && Number(x.monthIndex) === monthIndex);
    const paid = p ? Number(p.amountPaid || 0) : 0;
    const remaining = Math.max(0, due - paid);
    const badge = remaining === 0 ? '<span class="badge green">مكتمل</span>' :
                  paid > 0 ? '<span class="badge yellow">جزئي</span>' :
                  '<span class="badge red">لم يدفع</span>';
    rows += `<tr>
      <td>${escapeHtml(m.name)}</td>
      <td>${fmt(due)}</td>
      <td>${fmt(paid)}</td>
      <td style="color:${remaining > 0 ? 'var(--danger)' : 'var(--success)'}">${fmt(remaining)}</td>
      <td>${badge}</td>
      <td>${remaining > 0 ? `<button class="btn small" onclick="showPaymentModal(${m.id}, ${monthIndex})">دفع</button>` : '—'}</td>
    </tr>`;
  }
  container.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>المشترك</th><th>المطلوب</th><th>المدفوع</th><th>المتبقي</th><th>الحالة</th><th></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="6" class="empty">لا يوجد مشتركون</td></tr>'}</tbody>
  </table></div>`;
}

async function showPaymentModal(memberId, monthIndex) {
  const member = await db.members.get(memberId);
  const existing = await db.payments.where({ memberId, monthIndex: Number(monthIndex) }).first();
  const due = Number(member.monthlyContribution);
  const alreadyPaid = existing ? Number(existing.amountPaid || 0) : 0;
  const remaining = due - alreadyPaid;
  if (remaining <= 0) { toast('تم سداد هذا الشهر بالكامل مسبقًا', 'info'); return; }

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay payment-modal';
  overlay.innerHTML = `
    <div class="modal">
      <h3>تسجيل دفع — ${escapeHtml(member.name)}</h3>
      <p style="font-size:0.85rem;margin-bottom:8px">
        المطلوب: <strong>${fmt(due)}</strong> · المدفوع سابقًا: <strong>${fmt(alreadyPaid)}</strong> · المتبقي: <strong style="color:var(--danger)">${fmt(remaining)}</strong>
      </p>
      <label>المبلغ المدفوع الآن</label>
      <input id="payAmount" type="number" min="0.01" max="${remaining}" step="0.01" value="${remaining}">
      <label>تاريخ الدفع</label>
      <input id="payDate" type="date" value="${today()}">
      <button class="btn" onclick="savePayment(${memberId}, ${monthIndex})">تأكيد الدفع</button>
      <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
    </div>`;
  document.body.appendChild(overlay);
}

async function savePayment(memberId, monthIndex) {
  monthIndex = Number(monthIndex);
  const amount = Number(document.getElementById('payAmount').value);
  const date = document.getElementById('payDate').value;
  if (!amount || amount <= 0) { toast('أدخل مبلغًا صحيحًا', 'error'); return; }

  const member = await db.members.get(memberId);
  const existing = await db.payments.where({ memberId, monthIndex }).first();
  const oldPaid = existing ? Number(existing.amountPaid || 0) : 0;
  const totalPaid = oldPaid + amount;
  const due = Number(member.monthlyContribution);

  if (totalPaid > due) { toast('المبلغ يتجاوز المطلوب', 'error'); return; }

  if (existing) {
    await db.payments.update(existing.id, {
      amountPaid: totalPaid, paidDate: date,
      status: totalPaid >= due ? 'paid' : 'partial'
    });
  } else {
    await db.payments.add({
      associationId: currentAssocId, memberId, monthIndex,
      amountDue: due, amountPaid: amount, paidDate: date,
      status: amount >= due ? 'paid' : 'partial'
    });
  }

  await log('تسجيل دفع', `دفع ${member.name} مبلغ ${amount} للشهر ${monthIndex + 1}`);
  document.querySelector('.payment-modal').remove();
  toast('تم تسجيل الدفع', 'success');
  // إعادة تحديث جدول التحصيل داخل نفس المودال
  renderCollectionTable(monthIndex);
  // تحديث الصفحة خلف الكواليس
  setTimeout(() => { if (currentView === 'assoc') render(); }, 300);
}

/* ============================================================
   7. صرف دور
   ============================================================ */
async function showPayout() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const roles = await db.roles.where('associationId').equals(currentAssocId).toArray();

  const totalCollected = payments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
  const totalPaidOut = payouts.filter(p => p.confirmed).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const available = totalCollected - totalPaidOut;

  const pendingRoles = roles.filter(r => r.status !== 'paid').sort((a, b) => a.order - b.order);
  if (pendingRoles.length === 0) { toast('لا توجد أدوار معلقة للصرف', 'error'); return; }

  const options = pendingRoles.map(r => {
    const roleMembers = members.filter(m => Number(m.roleOrder) === Number(r.order));
    const total = roleMembers.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
    return `<option value="${r.order}">الدور ${r.order} — ${roleMembers.map(m => m.name).join('، ')} — ${fmt(total)} ج.م</option>`;
  }).join('');

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>صرف دور</h3>
      <p style="font-size:0.9rem;margin-bottom:8px">
        الرصيد المتاح للصرف: <strong style="color:${available > 0 ? 'var(--success)' : 'var(--danger)'}">${fmt(available)}</strong> ج.م
      </p>
      <label>اختر الدور</label>
      <select id="payoutRole">${options}</select>
      <label>تاريخ الصرف</label>
      <input id="payoutDate" type="date" value="${today()}">
      <button class="btn" onclick="confirmPayout()">تأكيد الصرف</button>
      <button class="btn secondary" onclick="this.closest('.modal-overlay').remove()">إلغاء</button>
    </div>`;
  document.body.appendChild(overlay);
}

async function confirmPayout() {
  const order = Number(document.getElementById('payoutRole').value);
  const date = document.getElementById('payoutDate').value;
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();
  const payouts = await db.payouts.where('associationId').equals(currentAssocId).toArray();
  const roleMembers = members.filter(m => Number(m.roleOrder) === order);
  const total = roleMembers.reduce((s, m) => s + Number(m.monthlyContribution) * assoc.months, 0);
  const totalCollected = payments.reduce((s, p) => s + Number(p.amountPaid || 0), 0);
  const totalPaidOut = payouts.filter(p => p.confirmed).reduce((s, p) => s + Number(p.totalAmount || 0), 0);
  const available = totalCollected - totalPaidOut;

  if (total > available) {
    toast(`المطلوب (${fmt(total)}) أكبر من المتاح (${fmt(available)})`, 'error');
    return;
  }

  const existingPayout = await db.payouts.where({ associationId: currentAssocId, roleOrder: order }).first();
  if (existingPayout && existingPayout.confirmed) {
    toast('تم صرف هذا الدور مسبقًا', 'error');
    return;
  }

  await db.payouts.add({
    associationId: currentAssocId, roleOrder: order,
    memberIds: roleMembers.map(m => m.id),
    totalAmount: total, paidDate: date, confirmed: true
  });
  const role = await db.roles.where({ associationId: currentAssocId, order }).first();
  if (role) {
    await db.roles.update(role.id, { status: 'paid', paidDate: date, paidAmount: total });
  } else {
    await db.roles.add({ associationId: currentAssocId, order, status: 'paid', paidDate: date, paidAmount: total });
  }

  await log('صرف دور', `تم صرف الدور ${order} بمبلغ ${total} ج.م لـ ${roleMembers.map(m => m.name).join('، ')}`);
  document.querySelector('.modal-overlay').remove();
  toast('تم الصرف بنجاح', 'success');
  render();
}

/* ============================================================
   8. التقارير
   ============================================================ */
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
    const roleMembers = members.filter(x => Number(x.roleOrder) === Number(m.roleOrder));
    const roleTotal = roleMembers.reduce((s, x) => s + Number(x.monthlyContribution) * assoc.months, 0);
    const rolePayout = payouts.find(p => Number(p.roleOrder) === Number(m.roleOrder) && p.confirmed);
    const received = rolePayout && roleTotal > 0 ? (totalDue / roleTotal) * Number(rolePayout.totalAmount) : 0;
    rows += `<tr>
      <td>${escapeHtml(m.name)}</td>
      <td>${fmt(totalDue)}</td>
      <td>${fmt(paid)}</td>
      <td style="color:${paid >= totalDue ? 'var(--success)' : 'var(--danger)'}">${fmt(totalDue - paid)}</td>
      <td>${fmt(received)}</td>
    </tr>`;
  }

  let html = `
    <header>
      <h1>تقارير — ${escapeHtml(assoc.name)}</h1>
      <button class="btn small secondary" onclick="openAssoc(${assoc.id})">← رجوع</button>
    </header>
    <div class="card">
      <h3>كشف حساب المشتركين</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>المشترك</th><th>الاستحقاق</th><th>المدفوع</th><th>المتبقي</th><th>المستلم</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="empty">لا يوجد مشتركون</td></tr>'}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h3>تصدير</h3>
      <button class="btn" onclick="exportExcel()">📥 تصدير Excel</button>
      <button class="btn secondary" onclick="exportPDF()">📄 تصدير PDF (طباعة)</button>
    </div>
    <div class="card">
      <h3>سجل العمليات (آخر 20)</h3>
      <div id="auditLog"><p class="empty">جاري التحميل...</p></div>
    </div>
  `;
  html += bottomNav('reports');
  app.innerHTML = html;
  loadAuditLog();
}

async function loadAuditLog() {
  const logs = await db.auditLog.where('associationId').equals(currentAssocId).reverse().limit(20).toArray();
  const el = document.getElementById('auditLog');
  if (!el) return;
  el.innerHTML = logs.map(l => `<p style="font-size:0.8rem;border-bottom:1px solid #eee;padding:6px 0">
    <span class="badge gray">${escapeHtml(l.action)}</span> ${escapeHtml(l.details)}<br>
    <span style="color:var(--muted);font-size:0.7rem">${new Date(l.timestamp).toLocaleString('ar-EG')}</span>
  </p>`).join('') || '<p class="empty">لا توجد عمليات مسجلة</p>';
}

async function exportExcel() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();

  const data = members.map(m => {
    const totalDue = Number(m.monthlyContribution) * assoc.months;
    const paid = payments.filter(p => Number(p.memberId) === Number(m.id)).reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    return {
      'الاسم': m.name,
      'الهاتف': m.phone || '',
      'المساهمة الشهرية': m.monthlyContribution,
      'الدور': m.roleOrder,
      'إجمالي الاستحقاق': totalDue,
      'إجمالي المدفوع': paid,
      'المتبقي': totalDue - paid
    };
  });

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'تقرير');
  wb.Workbook = { Views: [{ RTL: true }] };
  XLSX.writeFile(wb, `تقرير_${assoc.name}_${today()}.xlsx`);
  toast('تم تصدير ملف Excel', 'success');
}

async function exportPDF() {
  const assoc = await db.associations.get(currentAssocId);
  const members = await db.members.where('associationId').equals(currentAssocId).toArray();
  const payments = await db.payments.where('associationId').equals(currentAssocId).toArray();

  const rows = members.map(m => {
    const totalDue = Number(m.monthlyContribution) * assoc.months;
    const paid = payments.filter(p => Number(p.memberId) === Number(m.id)).reduce((s, p) => s + Number(p.amountPaid || 0), 0);
    return `<tr>
      <td>${escapeHtml(m.name)}</td>
      <td>${m.monthlyContribution}</td>
      <td>${m.roleOrder}</td>
      <td>${totalDue}</td>
      <td>${paid}</td>
      <td>${totalDue - paid}</td>
    </tr>`;
  }).join('');

  const w = window.open('', '_blank');
  if (!w) { toast('الرجاء السماح بالنوافذ المنبثقة', 'error'); return; }
  w.document.write(`<!DOCTYPE html>
    <html lang="ar" dir="rtl">
    <head>
      <meta charset="UTF-8">
      <title>تقرير ${escapeHtml(assoc.name)}</title>
      <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;700&display=swap" rel="stylesheet">
      <style>
        body { font-family: 'Cairo', sans-serif; padding: 20px; color: #134e4a; }
        h1 { color: #0d9488; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; }
        th, td { border: 1px solid #cbd5e1; padding: 8px; text-align: right; }
        th { background: #0d9488; color: white; }
        .meta { color: #64748b; font-size: 0.9rem; }
        @media print { body { padding: 0; } .no-print { display: none; } }
      </style>
    </head>
    <body>
      <h1>تقرير الجمعية: ${escapeHtml(assoc.name)}</h1>
      <p class="meta">عدد الشهور: ${assoc.months} | تاريخ البداية: ${assoc.startDate} | عدد المشتركين: ${members.length}</p>
      <table>
        <thead><tr>
          <th>الاسم</th><th>المساهمة</th><th>الدور</th>
          <th>الاستحقاق</th><th>المدفوع</th><th>المتبقي</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <p style="margin-top:20px;text-align:center;color:#64748b;font-size:0.85rem">
        تم التصدير في: ${new Date().toLocaleString('ar-EG')}
      </p>
      <div class="no-print" style="text-align:center;margin-top:24px">
        <button onclick="window.print()" style="padding:12px 24px;background:#0d9488;color:white;border:none;border-radius:10px;font-family:Cairo;font-size:1rem;cursor:pointer">
          🖨️ طباعة / حفظ PDF
        </button>
        <p style="color:#64748b;font-size:0.8rem;margin-top:8px">اختر "حفظ كـ PDF" من نافذة الطباعة</p>
      </div>
      <script>
        window.onload = () => setTimeout(() => { try { window.print(); } catch(e) {} }, 800);
      </script>
    </body>
    </html>`);
  w.document.close();
  toast('تم فتح صفحة الطباعة — اختر "حفظ كـ PDF"', 'success');
}

/* ============================================================
   9. النسخ الاحتياطي
   ============================================================ */
async function renderBackup(app) {
  let html = `
    <header><h1>النسخ الاحتياطي</h1></header>
    <div class="card">
      <h3>تصدير نسخة احتياطية</h3>
      <p style="font-size:0.85rem;color:var(--muted);margin-bottom:8px">
        تصدير جميع البيانات كملف JSON قابل للنقل.
      </p>
      <button class="btn" onclick="exportBackup()">⬇️ تصدير نسخة احتياطية</button>
    </div>
    <div class="card">
      <h3>استعادة نسخة احتياطية</h3>
      <p style="font-size:0.85rem;color:var(--muted);margin-bottom:8px">
        ⚠️ سيتم استبدال جميع البيانات الحالية.
      </p>
      <input type="file" id="restoreFile" accept=".json,application/json">
      <button class="btn danger" onclick="restoreBackup()">⬆️ استعادة البيانات</button>
    </div>
    <div class="card">
      <h3>نقل البيانات لهاتف آخر</h3>
      <p style="font-size:0.85rem;color:var(--muted)">
        صدّر النسخة الاحتياطية → أرسل الملف لنفسك عبر واتساب/Drive → افتح التطبيق على الهاتف الآخر → استعد الملف.
      </p>
    </div>
  `;
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
    exportedAt: new Date().toISOString(),
    version: 1
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `jamiyati_backup_${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('تم تصدير النسخة الاحتياطية', 'success');
}

async function restoreBackup() {
  const fileInput = document.getElementById('restoreFile');
  const file = fileInput.files[0];
  if (!file) { toast('اختر ملف النسخة الاحتياطية', 'error'); return; }
  if (!confirm('سيتم استبدال جميع البيانات الحالية. هل أنت متأكد؟')) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await db.transaction('rw',
      db.associations, db.members, db.roles, db.payments, db.payouts, db.auditLog,
      async () => {
        await db.associations.clear();
        await db.members.clear();
        await db.roles.clear();
        await db.payments.clear();
        await db.payouts.clear();
        await db.auditLog.clear();
        if (data.associations) await db.associations.bulkAdd(data.associations);
        if (data.members) await db.members.bulkAdd(data.members);
        if (data.roles) await db.roles.bulkAdd(data.roles);
        if (data.payments) await db.payments.bulkAdd(data.payments);
        if (data.payouts) await db.payouts.bulkAdd(data.payouts);
        if (data.auditLog) await db.auditLog.bulkAdd(data.auditLog);
      });
    toast('تمت استعادة البيانات', 'success');
    goHome();
  } catch (e) {
    console.error(e);
    toast('الملف غير صالح أو حدث خطأ', 'error');
  }
}

/* ============================================================
   تشغيل
   ============================================================ */
render();