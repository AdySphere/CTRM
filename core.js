/* ============================================================
   CTRM PLATFORM — CORE JS
   State management, utilities, navigation, UI primitives
   ============================================================ */

'use strict';

// ── GLOBAL STATE ─────────────────────────────────────────────
const CTRM = {
  currentPage: 'deals',
  currentDeal: null,
  currentBuyLeg: null,
  deals: [],
  rfqs: [],
  nextDealSeq: 42,
  nextRFQSeq: 8,
  nextBuyLegSeq: 1,
};

// ── SEED DATA ─────────────────────────────────────────────────
const SEED = {
  commodities: [
    { code: 'CU-CATHODE-A', name: 'Copper Cathode Grade A', group: 'BASE-METAL', exchange: 'LME', uom: 'MT', pip: 'pip-cu' },
    { code: 'ZN-SHG-995',   name: 'Zinc SHG 99.995%',       group: 'BASE-METAL', exchange: 'LME', uom: 'MT', pip: 'pip-zn' },
    { code: 'AL-P1020',     name: 'Aluminium Ingot P1020A',  group: 'BASE-METAL', exchange: 'LME', uom: 'MT', pip: 'pip-al' },
    { code: 'NI-FULL-PLATE',name: 'Nickel Full Plate',       group: 'BASE-METAL', exchange: 'LME', uom: 'MT', pip: 'pip-ni' },
    { code: 'STEEL-HMS1',   name: 'Steel Scrap HMS 1&2',     group: 'FERROUS',    exchange: 'CFR', uom: 'MT', pip: 'pip-fe' },
    { code: 'COAL-NAR5500', name: 'Thermal Coal NAR 5500',   group: 'BULK',       exchange: 'PLATTS', uom: 'MT', pip: 'pip-coal' },
    { code: 'CRUDE-DUBAI',  name: 'Crude Oil Dubai',         group: 'ENERGY',     exchange: 'PLATTS', uom: 'BBL', pip: 'pip-oil' },
    { code: 'WHEAT-CBOT',   name: 'Wheat Hard Red Winter',   group: 'AGRI',       exchange: 'CBOT',   uom: 'MT', pip: 'pip-agri' },
  ],

  pricingTemplates: [
    { code: 'LME-CU-QP-M1',      name: 'LME Copper QP M+1',         type: 'QP-AVERAGE',   exchange: 'LME' },
    { code: 'LME-ZN-QP-M',       name: 'LME Zinc QP Month of BL',   type: 'QP-AVERAGE',   exchange: 'LME' },
    { code: 'LME-AL-QP-M1',      name: 'LME Aluminium QP M+1',      type: 'QP-AVERAGE',   exchange: 'LME' },
    { code: 'FIXED-USD-MT',       name: 'Fixed Price USD/MT',         type: 'FIXED',        exchange: 'NONE' },
    { code: 'PLATTS-DUBAI-DIFF',  name: 'Platts Dubai Differential',  type: 'BENCHMARK',    exchange: 'PLATTS' },
    { code: 'COAL-PLATTS-5500',   name: 'Platts Newcastle 5500 NAR',  type: 'BENCHMARK',    exchange: 'PLATTS' },
    { code: 'QUAL-ADJ-HMS',       name: 'Quality Adjusted HMS Scrap', type: 'QUALITY-ADJ',  exchange: 'CFR' },
  ],

  adjustmentCodes: [
    { code: 'PREM-BRAND',   name: 'Brand Premium',          category: 'PREMIUM',  calcType: 'FLAT-RATE',   sign: '+', default: 60,   unit: 'USD/MT' },
    { code: 'TC',           name: 'Treatment Charge',        category: 'TC',       calcType: 'FLAT-RATE',   sign: '-', default: 180,  unit: 'USD/dmt' },
    { code: 'RC',           name: 'Refining Charge',         category: 'RC',       calcType: 'FORMULA-REF', sign: '-', default: 0,    unit: 'USc/lb' },
    { code: 'PEN-PB',       name: 'Lead Penalty',           category: 'QUALITY',  calcType: 'THRESHOLD',   sign: '-', default: 8,    unit: 'USD/MT per 0.1%' },
    { code: 'PEN-AS',       name: 'Arsenic Penalty',        category: 'QUALITY',  calcType: 'THRESHOLD',   sign: '-', default: 10,   unit: 'USD/MT per 0.01%' },
    { code: 'PEN-MOIST',    name: 'Moisture Penalty',       category: 'QUALITY',  calcType: 'TIERED',      sign: '-', default: 0,    unit: 'USD/MT' },
    { code: 'PEN-LATE-DEL', name: 'Late Delivery Penalty',  category: 'PENALTY',  calcType: 'FLAT-RATE',   sign: '-', default: 5,    unit: 'USD/MT/day' },
    { code: 'PREM-FE',      name: 'Fe Content Bonus',       category: 'QUALITY',  calcType: 'THRESHOLD',   sign: '+', default: 1.2,  unit: 'USD/MT per 0.1%' },
    { code: 'FREIGHT-CFR',  name: 'Freight Deduction CFR',  category: 'FREIGHT',  calcType: 'FLAT-RATE',   sign: '-', default: 22,   unit: 'USD/MT' },
    { code: 'CV-ADJ',       name: 'CV Adjustment',          category: 'QUALITY',  calcType: 'FORMULA-REF', sign: '±', default: 0,    unit: 'USD/MT per 100kcal' },
    { code: 'PEN-REJECT',   name: 'Rejection Trigger',      category: 'QUALITY',  calcType: 'REJECTION',   sign: '-', default: 0,    unit: 'N/A' },
  ],

  vendors: [
    { no: 'V-001', name: 'Glencore AG',            country: 'CH', kyc: 'APPROVED' },
    { no: 'V-002', name: 'Trafigura PTE Ltd',       country: 'SG', kyc: 'APPROVED' },
    { no: 'V-003', name: 'Noble Resources Ltd',     country: 'HK', kyc: 'APPROVED' },
    { no: 'V-004', name: 'Codelco Trading SA',      country: 'CL', kyc: 'APPROVED' },
    { no: 'V-005', name: 'Hindalco Industries',     country: 'IN', kyc: 'APPROVED' },
    { no: 'V-006', name: 'New Vendor (Pending)',     country: '--', kyc: 'PENDING' },
  ],

  customers: [
    { no: 'C-001', name: 'Tata Metals Ltd',         country: 'IN', kyc: 'APPROVED' },
    { no: 'C-002', name: 'JSW Steel Ltd',            country: 'IN', kyc: 'APPROVED' },
    { no: 'C-003', name: 'Vedanta Resources',        country: 'IN', kyc: 'APPROVED' },
    { no: 'C-004', name: 'ArcelorMittal SA',         country: 'LU', kyc: 'APPROVED' },
  ],

  deals: [
    {
      no: 'DL-2026-039', date: '2026-03-15', status: 'IN-EXECUTION', type: 'BACK-TO-BACK',
      commodity: 'CU-CATHODE-A', targetQty: 500, uom: 'MT', desk: 'BASE-METALS', trader: 'A. Mallick',
      sellCustomer: 'Tata Metals Ltd', sellQty: 500, sellTemplate: 'LME-CU-QP-M1',
      buyLegs: 1, provMargin: 42000, estMargin: 1.28,
    },
    {
      no: 'DL-2026-040', date: '2026-03-22', status: 'CONFIRMED', type: 'CONSOLIDATION',
      commodity: 'STEEL-HMS1', targetQty: 2000, uom: 'MT', desk: 'FERROUS', trader: 'P. Malpani',
      sellCustomer: 'ArcelorMittal SA', sellQty: 2000, sellTemplate: 'QUAL-ADJ-HMS',
      buyLegs: 3, provMargin: 0, estMargin: 0,
    },
    {
      no: 'DL-2026-041', date: '2026-04-01', status: 'DRAFT', type: 'OPEN-BUY',
      commodity: 'COAL-NAR5500', targetQty: 50000, uom: 'MT', desk: 'BULK', trader: 'A. Mallick',
      sellCustomer: '—', sellQty: 0, sellTemplate: '—',
      buyLegs: 0, provMargin: 0, estMargin: 0,
    },
  ],
};

// ── NAVIGATION ────────────────────────────────────────────────
function navigate(pageId, navEl) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pg = document.getElementById('page-' + pageId);
  if (pg) pg.classList.add('active');
  if (navEl) navEl.classList.add('active');
  else {
    const auto = document.querySelector(`.nav-item[data-page="${pageId}"]`);
    if (auto) auto.classList.add('active');
  }
  CTRM.currentPage = pageId;
  updateBreadcrumb(pageId);
}

function updateBreadcrumb(pageId) {
  const labels = {
    deals: 'Deal Management',
    'new-deal': 'New Deal',
    'deal-detail': 'Deal Detail',
    rfq: 'RFQ Management',
    penalties: 'Penalty Engine',
  };
  const el = document.getElementById('bc-current');
  if (el) el.textContent = labels[pageId] || pageId;
}

// ── MODAL ─────────────────────────────────────────────────────
function openModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.add('open'); document.body.style.overflow = 'hidden'; }
}
function closeModal(id) {
  const m = document.getElementById(id);
  if (m) { m.classList.remove('open'); document.body.style.overflow = ''; }
}
function closeModalOnBg(event, id) {
  if (event.target === document.getElementById(id)) closeModal(id);
}

// ── FASTTAB SWITCHING ─────────────────────────────────────────
function switchTab(tabEl, contentId, groupClass) {
  const group = tabEl.closest(groupClass || '.fasttabs-group');
  if (!group) return;
  group.querySelectorAll('.fasttab').forEach(t => t.classList.remove('active'));
  tabEl.classList.add('active');
  const prefix = contentId.replace(/-\w+$/, '-');
  const container = group.nextElementSibling || group.closest('.card');
  if (!container) return;
  container.querySelectorAll('.fasttab-content').forEach(c => c.classList.remove('active'));
  const target = document.getElementById(contentId);
  if (target) target.classList.add('active');
}

// ── TOAST ─────────────────────────────────────────────────────
function toast(title, msg, type = 'success') {
  const icons = { success: '✓', warning: '⚠', error: '✕', info: 'ℹ' };
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `
    <div class="toast-icon">${icons[type]}</div>
    <div class="toast-text">
      <div class="toast-title">${title}</div>
      ${msg ? `<div class="toast-msg">${msg}</div>` : ''}
    </div>`;
  container.appendChild(el);
  requestAnimationFrame(() => { requestAnimationFrame(() => el.classList.add('show')); });
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

// ── TOGGLE ────────────────────────────────────────────────────
function toggleSwitch(el) {
  el.classList.toggle('on');
  const hiddenTarget = el.dataset.shows;
  if (hiddenTarget) {
    const targets = document.querySelectorAll(`.${hiddenTarget}`);
    targets.forEach(t => t.classList.toggle('hidden', !el.classList.contains('on')));
  }
}

// ── FIELD SHOW/HIDE ───────────────────────────────────────────
function showFieldGroup(groupId) {
  const el = document.getElementById(groupId);
  if (el) el.classList.remove('hidden');
}
function hideFieldGroup(groupId) {
  const el = document.getElementById(groupId);
  if (el) el.classList.add('hidden');
}
function conditionalShow(selectEl, map) {
  const val = selectEl.value;
  Object.entries(map).forEach(([key, ids]) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      el.classList.toggle('hidden', key !== val && key !== '*');
    });
  });
}

// ── CALC HELPERS ──────────────────────────────────────────────
function calcProvValue(price, qty) {
  if (!price || !qty) return '—';
  return '$' + (price * qty).toLocaleString('en-US', { maximumFractionDigits: 0 });
}

function calcPenaltyFlat(rate, qty) {
  return rate * qty;
}

function calcPenaltyThreshold(actual, threshold, rate, qty) {
  if (actual <= threshold) return 0;
  return (actual - threshold) * rate * qty;
}

function calcPenaltyTiered(actual, tiers, qty) {
  let total = 0;
  for (const tier of tiers) {
    if (actual <= tier.from) break;
    if (tier.action === 'REJECT') return 'REJECT';
    const within = Math.min(actual, tier.to || actual) - tier.from;
    total += within * tier.rate * qty;
  }
  return total;
}

function penaltyCalcDisplay(line) {
  switch (line.calcType) {
    case 'FLAT-RATE':
      return `${line.rate} × ${line.qty} ${line.rateUnit}`;
    case 'THRESHOLD':
      return `(${line.actual} − ${line.threshold}) × ${line.rate} × ${line.qty}`;
    case 'TIERED':
      return `Bracket lookup on ${line.actual}% → ${line.tiers?.length || 0} tiers`;
    case 'FORMULA-REF':
      return line.formula || 'Formula expression';
    case 'REJECTION':
      return `Trigger if ${line.element} ${line.operator} ${line.rejectionLimit}`;
    default:
      return '—';
  }
}

// ── COMMODITY CHIP HTML ───────────────────────────────────────
function commodityChip(code) {
  const c = SEED.commodities.find(x => x.code === code);
  if (!c) return code;
  return `<span class="commodity-chip"><span class="commodity-pip ${c.pip}"></span>${c.name}</span>`;
}

// ── STATUS BADGE HTML ─────────────────────────────────────────
function statusBadge(status) {
  const map = {
    'DRAFT':         'badge-draft',
    'OPEN':          'badge-open',
    'CONFIRMED':     'badge-confirmed',
    'IN-EXECUTION':  'badge-contracted',
    'RFQ-PENDING':   'badge-rfq',
    'CONTRACTED':    'badge-contracted',
    'SHIPPED':       'badge-shipped',
    'INVOICED':      'badge-invoiced',
    'CLOSED':        'badge-closed',
    'CANCELLED':     'badge-danger',
    'SHORTLISTED':   'badge-open',
    'ACCEPTED':      'badge-confirmed',
    'REJECTED':      'badge-danger',
    'RESPONDED':     'badge-rfq',
    'SENT':          'badge-open',
    'ISSUED':        'badge-open',
  };
  const cls = map[status] || 'badge-draft';
  return `<span class="badge ${cls}">${status}</span>`;
}

// ── POPULATE SELECT ───────────────────────────────────────────
function populateSelect(selectEl, items, valueFn, labelFn, placeholder) {
  selectEl.innerHTML = placeholder ? `<option value="">${placeholder}</option>` : '';
  items.forEach(item => {
    const opt = document.createElement('option');
    opt.value = valueFn(item);
    opt.textContent = labelFn(item);
    selectEl.appendChild(opt);
  });
}

// ── FORMAT ────────────────────────────────────────────────────
function fmtMoney(val, currency = 'USD') {
  if (val === null || val === undefined) return '—';
  return currency + ' ' + Number(val).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function fmtQty(val, uom = 'MT') {
  if (!val) return '—';
  return Number(val).toLocaleString('en-US') + ' ' + uom;
}
function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtPct(val) {
  if (val === null || val === undefined) return '—';
  return Number(val).toFixed(2) + '%';
}

// ── GENERATE NO. ─────────────────────────────────────────────
function genDealNo()   { return `DL-2026-0${String(CTRM.nextDealSeq++).padStart(2,'0')}`; }
function genRFQNo()    { return `RFQ-2026-0${String(CTRM.nextRFQSeq++).padStart(2,'0')}`; }
function genBuyLegNo(dealNo) {
  return `${dealNo}-BL${String(CTRM.nextBuyLegSeq++).padStart(2,'0')}`;
}
function genPCNo(dealNo, seq) { return `PC-2026-${dealNo.split('-')[2]}-${String(seq).padStart(2,'0')}`; }

// ── INIT ──────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  navigate('deals');
  // Populate commodity selects
  document.querySelectorAll('.sel-commodity').forEach(el => {
    populateSelect(el, SEED.commodities,
      c => c.code, c => `${c.code} — ${c.name}`, '— Select Commodity —');
  });
  // Populate template selects
  document.querySelectorAll('.sel-template').forEach(el => {
    populateSelect(el, SEED.pricingTemplates,
      t => t.code, t => `${t.code} · ${t.name}`, '— Select Template —');
  });
  // Populate vendor selects
  document.querySelectorAll('.sel-vendor').forEach(el => {
    populateSelect(el, SEED.vendors,
      v => v.no, v => `${v.no} · ${v.name} [${v.kyc}]`, '— Select Vendor —');
  });
  // Populate customer selects
  document.querySelectorAll('.sel-customer').forEach(el => {
    populateSelect(el, SEED.customers,
      c => c.no, c => `${c.no} · ${c.name}`, '— Select Customer —');
  });
  // Populate adj code selects
  document.querySelectorAll('.sel-adj-code').forEach(el => {
    populateSelect(el, SEED.adjustmentCodes,
      a => a.code, a => `${a.code} — ${a.name}`, '— Select Adjustment —');
  });
});
