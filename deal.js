/* ============================================================
   CTRM — DEAL MANAGEMENT MODULE JS
   ============================================================ */
'use strict';

function renderDealList() {
  const tbody = document.getElementById('deal-list-body');
  if (!tbody) return;
  tbody.innerHTML = SEED.deals.map(d => `
    <tr onclick="openDealDetail('${d.no}')" style="cursor:pointer">
      <td><span class="mono text-accent">${d.no}</span></td>
      <td>${commodityChip(d.commodity)}</td>
      <td class="fs-11">${d.type.replace(/-/g,' ')}</td>
      <td class="mono">${fmtQty(d.targetQty, d.uom)}</td>
      <td class="fs-12">${d.sellCustomer}</td>
      <td>${statusBadge(d.status)}</td>
      <td class="mono ${d.provMargin > 0 ? 'text-green' : 'text-dim'}">${d.provMargin ? fmtMoney(d.provMargin) : '—'}</td>
      <td class="fs-11 text-muted">${d.desk}</td>
      <td><button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();openDealDetail('${d.no}')">Open</button></td>
    </tr>`).join('');
}

function openDealDetail(dealNo) {
  CTRM.currentDeal = dealNo;
  const deal = SEED.deals.find(d => d.no === dealNo);
  if (!deal) return;
  document.getElementById('dd-title').textContent = dealNo;
  document.getElementById('dd-status').innerHTML = statusBadge(deal.status);
  document.getElementById('dd-commodity').innerHTML = commodityChip(deal.commodity);
  document.getElementById('dd-type').textContent = deal.type.replace(/-/g,' ');
  document.getElementById('dd-qty').textContent = fmtQty(deal.targetQty, deal.uom);
  document.getElementById('dd-desk').textContent = deal.desk;
  document.getElementById('dd-trader').textContent = deal.trader;
  document.getElementById('dd-buy-legs').textContent = deal.buyLegs;
  document.getElementById('dd-margin').textContent = deal.provMargin ? fmtMoney(deal.provMargin) : '—';
  navigate('deal-detail');
}

// ── WIZARD ────────────────────────────────────────────────────
let wizardStep = 1;
const WIZARD_TOTAL = 4;

function initNewDeal() {
  wizardStep = 1;
  buyLegSeq = 1;
  document.getElementById('buy-legs-container').innerHTML = '';
  renderWizardStep(1);
  navigate('new-deal');
}

function renderWizardStep(step) {
  for (let i = 1; i <= WIZARD_TOTAL; i++) {
    const item = document.getElementById(`wstep-item-${i}`);
    const node = document.getElementById(`wstep-${i}`);
    if (!item || !node) continue;
    item.className = 'step-item ' + (i < step ? 'done' : i === step ? 'active' : 'future');
    node.textContent = i < step ? '✓' : String(i);
  }
  for (let i = 1; i <= WIZARD_TOTAL; i++) {
    const el = document.getElementById(`ws-${i}`);
    if (el) el.classList.toggle('hidden', i !== step);
  }
  const prev = document.getElementById('w-prev');
  const next = document.getElementById('w-next');
  const save = document.getElementById('w-save');
  if (prev) prev.classList.toggle('hidden', step === 1);
  if (next) next.classList.toggle('hidden', step === WIZARD_TOTAL);
  if (save) save.classList.toggle('hidden', step !== WIZARD_TOTAL);
}

function wNext() { if (wizardStep < WIZARD_TOTAL) { wizardStep++; renderWizardStep(wizardStep); } }
function wPrev() { if (wizardStep > 1) { wizardStep--; renderWizardStep(wizardStep); } }

function saveDeal() {
  const no = genDealNo();
  toast('Deal Created', `${no} saved as DRAFT`, 'success');
  setTimeout(() => navigate('deals'), 400);
}

function confirmDeal() {
  toast('Deal Confirmed', `${CTRM.currentDeal} → CONFIRMED. Contracts reserved.`, 'success');
  setTimeout(() => toast('D365 BC Sync', 'Customer/Vendor sync queued', 'info'), 900);
}

// ── BUY LEGS ──────────────────────────────────────────────────
let buyLegSeq = 1;
let penLineSeq = 1;
let payLineSeq = 1;

function addBuyLeg() {
  const container = document.getElementById('buy-legs-container');
  if (!container) return;
  const id = `BL${String(buyLegSeq++).padStart(2,'0')}`;
  const div = document.createElement('div');
  div.className = 'card mt-16';
  div.id = `leg-${id}`;
  div.innerHTML = buyLegHTML(id);
  container.appendChild(div);
  populateSelect(div.querySelector('.sel-vendor'), SEED.vendors, v=>v.no, v=>`${v.no} · ${v.name}`, '— Vendor (optional) —');
  populateSelect(div.querySelector('.sel-commodity'), SEED.commodities, c=>c.code, c=>`${c.code} — ${c.name}`, '— Commodity —');
  populateSelect(div.querySelector('.sel-template'), SEED.pricingTemplates, t=>t.code, t=>`${t.code} · ${t.name}`, '— Template —');
  toast(`Buy Leg ${id} Added`, 'Configure independently per vendor', 'info');
}

function removeLeg(id) {
  const el = document.getElementById(id);
  if (el) { el.remove(); toast('Buy Leg Removed','','warning'); }
}

function switchLegTab(el, id, tab) {
  const card = document.getElementById(`leg-${id}`);
  if (!card) return;
  card.querySelectorAll('.fasttab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['vendor','commodity','pricing','payment','penalties'].forEach(t => {
    const c = document.getElementById(`${id}-${t}`);
    if (c) { c.classList.toggle('active', t===tab); c.classList.toggle('hidden', t!==tab); }
  });
}

function toggleLC(sel, id) {
  const el = document.getElementById(`${id}-lc`);
  if (el) el.classList.toggle('hidden', sel.value !== 'YES');
}

function addPayLine(tbodyId) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.querySelector('.table-empty')?.closest('tr')?.remove();
  const seq = payLineSeq++;
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="mono fs-11">${seq}</td>
    <td><input type="number" class="field-input" style="width:65px;font-size:11px" value="100" placeholder="%"></td>
    <td><select class="field-select" style="font-size:11px">
      <option>ADVANCE</option><option>ON-SHIPMENT</option><option>AGAINST-BL</option>
      <option>ON-ARRIVAL</option><option>NET-30</option><option>NET-60</option>
    </select></td>
    <td><input type="date" class="field-input" style="width:128px;font-size:11px"></td>
    <td><span class="badge badge-draft">PENDING</span></td>
    <td><button class="btn btn-danger btn-xs" onclick="this.closest('tr').remove()">✕</button></td>`;
  tbody.appendChild(tr);
}

function addPenLine(tbodyId, leg) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.querySelector('.table-empty')?.closest('tr')?.remove();
  const seq = penLineSeq++;
  const dir = leg==='BUY' ? 'INBOUND-PENALTY' : 'OUTBOUND-PENALTY';
  const tr = document.createElement('tr');
  tr.id = `pln-${seq}`;
  tr.innerHTML = `
    <td class="mono fs-11">${seq}</td>
    <td><select class="field-select sel-adj-code" style="font-size:10px;min-width:140px"></select></td>
    <td><select class="field-select pen-ct" style="font-size:10px" onchange="onPCT(this,${seq})">
      <option>FLAT-RATE</option><option>THRESHOLD</option><option>TIERED</option>
      <option>FORMULA-REF</option><option>REJECTION</option>
    </select></td>
    <td><input type="text" class="field-input" style="width:72px;font-size:11px" placeholder="e.g. Pb%"></td>
    <td id="pct-thresh-${seq}"><input type="number" class="field-input" style="width:65px;font-size:11px" placeholder="e.g. 0.5"></td>
    <td id="pct-rate-${seq}"><input type="number" class="field-input" style="width:65px;font-size:11px" placeholder="Rate"></td>
    <td><span class="badge badge-danger" style="font-size:8px">${dir}</span></td>
    <td><span class="badge badge-open">ACTIVE</span></td>
    <td><button class="btn btn-danger btn-xs" onclick="document.getElementById('pln-${seq}').remove()">✕</button></td>`;
  tbody.appendChild(tr);
  populateSelect(tr.querySelector('.sel-adj-code'), SEED.adjustmentCodes, a=>a.code, a=>`${a.code} — ${a.name}`, '— Select —');
}

function onPCT(sel, seq) {
  const v = sel.value;
  const th = document.getElementById(`pct-thresh-${seq}`);
  const rt = document.getElementById(`pct-rate-${seq}`);
  if (th) th.innerHTML = (v==='FLAT-RATE'||v==='FORMULA-REF') ? '<span class="text-dim fs-11">N/A</span>' :
    `<input type="number" class="field-input" style="width:65px;font-size:11px" placeholder="${v==='REJECTION'?'Rej.limit':'Threshold'}">`;
  if (rt) rt.innerHTML = v==='TIERED' ? `<button class="btn btn-ghost btn-xs" onclick="openTierModal(${seq})">Edit Tiers</button>` :
    v==='FORMULA-REF' ? '<input type="text" class="field-input" style="width:130px;font-size:10px" placeholder="Expression">' :
    v==='REJECTION' ? '<span class="badge badge-danger">REJECT</span>' :
    '<input type="number" class="field-input" style="width:65px;font-size:11px" placeholder="Rate">';
}

function loadFromTemplate(tbodyId, leg) {
  const tbody = document.getElementById(tbodyId);
  if (!tbody) return;
  tbody.querySelector('.table-empty')?.closest('tr')?.remove();
  const lines = [
    {code:'TC',ct:'FLAT-RATE',el:'—',th:'—',rate:'180',dir:'INBOUND-PENALTY'},
    {code:'PEN-PB',ct:'THRESHOLD',el:'Pb%',th:'0.5%',rate:'$8/MT/0.1%',dir:'INBOUND-PENALTY'},
    {code:'PEN-AS',ct:'THRESHOLD',el:'As%',th:'0.1%',rate:'$10/MT/0.01%',dir:'INBOUND-PENALTY'},
    {code:'PEN-MOIST',ct:'TIERED',el:'Moisture%',th:'8%',rate:'See Tiers',dir:'INBOUND-PENALTY'},
  ];
  lines.forEach((l,i) => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="mono fs-11">${penLineSeq++}</td>
      <td class="mono fs-11 text-accent2">${l.code}</td>
      <td><span class="calc-type-pill ct-${l.ct.replace('-','').replace('-','').toLowerCase()}">${l.ct}</span></td>
      <td class="mono fs-11">${l.el}</td>
      <td class="mono fs-11">${l.th}</td>
      <td class="mono fs-11">${l.rate}</td>
      <td><span class="badge badge-danger" style="font-size:8px">${l.dir}</span></td>
      <td><span class="badge badge-rfq">TEMPLATE</span></td>
      <td><button class="btn btn-danger btn-xs" onclick="this.closest('tr').remove()">✕</button></td>`;
    tbody.appendChild(tr);
  });
  toast('Template Lines Loaded','4 default adjustment lines added','success');
}

// ── TIER MODAL ────────────────────────────────────────────────
function openTierModal(seq) {
  document.getElementById('tier-modal-body').innerHTML = `
    <tr>
      <td><input type="number" class="field-input" style="width:65px" value="0"></td>
      <td><input type="number" class="field-input" style="width:65px" value="8"></td>
      <td><input type="number" class="field-input" style="width:65px" value="0"></td>
      <td><select class="field-select" style="font-size:11px"><option>CALCULATE</option><option>REJECT</option></select></td>
      <td class="fs-11 text-dim">No penalty (below 8%)</td>
      <td><button class="btn btn-danger btn-xs" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>
    <tr>
      <td><input type="number" class="field-input" style="width:65px" value="8"></td>
      <td><input type="number" class="field-input" style="width:65px" value="10"></td>
      <td><input type="number" class="field-input" style="width:65px" value="2"></td>
      <td><select class="field-select" style="font-size:11px"><option>CALCULATE</option><option>REJECT</option></select></td>
      <td class="mono fs-11 text-accent2">$2/MT per 1% above 8</td>
      <td><button class="btn btn-danger btn-xs" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>
    <tr>
      <td><input type="number" class="field-input" style="width:65px" value="10"></td>
      <td><input type="number" class="field-input" style="width:65px" value="12"></td>
      <td><input type="number" class="field-input" style="width:65px" value="4"></td>
      <td><select class="field-select" style="font-size:11px"><option>CALCULATE</option><option>REJECT</option></select></td>
      <td class="mono fs-11 text-accent2">$4/MT per 1% above 10</td>
      <td><button class="btn btn-danger btn-xs" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>
    <tr>
      <td><input type="number" class="field-input" style="width:65px" value="12"></td>
      <td><input type="text" class="field-input" style="width:65px" placeholder="∞"></td>
      <td class="text-dim fs-11">—</td>
      <td><select class="field-select" style="font-size:11px"><option>REJECT</option><option>CALCULATE</option></select></td>
      <td class="mono fs-11 text-danger">Cargo rejection trigger</td>
      <td><button class="btn btn-danger btn-xs" onclick="this.closest('tr').remove()">✕</button></td>
    </tr>`;
  openModal('modal-tier');
}

function addTierRow() {
  const tbody = document.getElementById('tier-modal-body');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td><input type="number" class="field-input" style="width:65px"></td>
    <td><input type="number" class="field-input" style="width:65px"></td>
    <td><input type="number" class="field-input" style="width:65px"></td>
    <td><select class="field-select" style="font-size:11px"><option>CALCULATE</option><option>REJECT</option></select></td>
    <td></td>
    <td><button class="btn btn-danger btn-xs" onclick="this.closest('tr').remove()">✕</button></td>`;
  tbody.appendChild(tr);
}

function saveTiers() {
  closeModal('modal-tier');
  toast('Tier Table Saved', `${document.querySelectorAll('#tier-modal-body tr').length} tiers configured`, 'success');
}

function buyLegHTML(id) {
  return `
  <div class="leg-header">
    <div class="leg-indicator leg-buy">B</div>
    <div class="leg-title">Buy Leg ${id}</div>
    <div class="leg-meta">Independent per vendor · PC auto-generated on confirmation</div>
    <button class="btn btn-danger btn-xs" onclick="removeLeg('leg-${id}')">Remove Leg</button>
  </div>
  <div class="fasttabs" style="padding:0 18px">
    <div class="fasttab active" onclick="switchLegTab(this,'${id}','vendor')">Vendor</div>
    <div class="fasttab" onclick="switchLegTab(this,'${id}','commodity')">Commodity & Qty</div>
    <div class="fasttab" onclick="switchLegTab(this,'${id}','pricing')">Pricing</div>
    <div class="fasttab" onclick="switchLegTab(this,'${id}','payment')">Payment Terms</div>
    <div class="fasttab" onclick="switchLegTab(this,'${id}','penalties')">Penalties / Bonuses</div>
  </div>
  <div id="${id}-vendor" class="fasttab-content active" style="padding:18px">
    <div class="form-grid">
      <div class="field"><div class="field-label">Vendor <span class="optional">(optional at creation)</span></div><select class="field-select sel-vendor"></select></div>
      <div class="field"><div class="field-label">Onboarding Status</div><select class="field-select"><option>APPROVED</option><option>PENDING</option><option>IN-PROGRESS</option></select></div>
      <div class="field"><div class="field-label">Source</div><select class="field-select"><option>FROM-RFQ</option><option>DIRECT</option><option>SPOT</option></select></div>
      <div class="field"><div class="field-label">Broker</div><input type="text" class="field-input" placeholder="Broker name if applicable"></div>
      <div class="field"><div class="field-label">Brokerage Rate</div><input type="number" class="field-input" placeholder="USD/MT or %"></div>
      <div class="field"><div class="field-label">Brokerage Basis</div><select class="field-select"><option>PER-MT</option><option>PERCENTAGE</option><option>FIXED</option></select></div>
    </div>
  </div>
  <div id="${id}-commodity" class="fasttab-content hidden" style="padding:18px">
    <div class="banner banner-info"><span class="banner-icon">ℹ</span>Commodity and grade are fully independent from the deal header and other buy legs.</div>
    <div class="form-grid">
      <div class="field col-span-2"><div class="field-label">Commodity <span class="required">*</span></div><select class="field-select sel-commodity"></select></div>
      <div class="field"><div class="field-label">Grade / Specification <span class="required">*</span></div><input type="text" class="field-input" placeholder="e.g. Grade A, HMS 80:20, API 2"></div>
      <div class="field"><div class="field-label">Quantity (MT) <span class="required">*</span></div><input type="number" class="field-input" placeholder="e.g. 500"></div>
      <div class="field"><div class="field-label">Tolerance %</div><input type="number" class="field-input" placeholder="e.g. 5"></div>
      <div class="field"><div class="field-label">Tolerance Type</div><select class="field-select"><option>MOLOO</option><option>MOLCHOPT</option><option>FIXED</option></select></div>
      <div class="field"><div class="field-label">Partial Shipment</div><select class="field-select"><option>NOT ALLOWED</option><option>ALLOWED</option></select></div>
      <div class="field"><div class="field-label">Weight Basis</div><select class="field-select"><option>SHIPPED-WEIGHT</option><option>OUTTURN-WEIGHT</option><option>DRAFT-SURVEY</option></select></div>
      <div class="field"><div class="field-label">Incoterms <span class="required">*</span></div><select class="field-select"><option>CIF</option><option>FOB</option><option>CFR</option><option>DDP</option><option>EXW</option></select></div>
      <div class="field"><div class="field-label">Port of Loading</div><input type="text" class="field-input" placeholder="e.g. Shanghai, Antwerp"></div>
      <div class="field"><div class="field-label">Port of Discharge</div><input type="text" class="field-input" placeholder="e.g. Nhava Sheva, Rotterdam"></div>
      <div class="field"><div class="field-label">Shipment Window From <span class="required">*</span></div><input type="date" class="field-input"></div>
      <div class="field"><div class="field-label">Shipment Window To <span class="required">*</span></div><input type="date" class="field-input"></div>
      <div class="field"><div class="field-label">Origin Country</div><input type="text" class="field-input" placeholder="e.g. Chile, Indonesia"></div>
      <div class="field"><div class="field-label">Manufacturing Required</div><select class="field-select"><option>NO</option><option>YES — Check Profile</option></select></div>
    </div>
  </div>
  <div id="${id}-pricing" class="fasttab-content hidden" style="padding:18px">
    <div class="banner banner-info"><span class="banner-icon">◆</span>Pricing template is fully independent per buy leg. Different vendors can have entirely different pricing bases.</div>
    <div class="form-grid">
      <div class="field col-span-2"><div class="field-label">Pricing Template <span class="required">*</span></div><select class="field-select sel-template"></select></div>
      <div class="field"><div class="field-label">Price Currency</div><select class="field-select"><option>USD</option><option>EUR</option><option>GBP</option><option>CNY</option></select></div>
      <div class="field"><div class="field-label">Invoice Currency</div><select class="field-select"><option>USD</option><option>EUR</option><option>GBP</option><option>INR</option></select></div>
      <div class="field"><div class="field-label">Fixed Price (if FIXED template)</div><input type="number" class="field-input" placeholder="USD/MT"></div>
      <div class="field"><div class="field-label">QP Period Override</div><select class="field-select"><option>— Use Template Default —</option><option>M (Month of BL)</option><option>M+1</option><option>M-1</option><option>Custom Window</option></select></div>
      <div class="field"><div class="field-label">TC — Treatment Charge USD/dmt</div><input type="number" class="field-input" placeholder="e.g. 180 (concentrates)"></div>
      <div class="field"><div class="field-label">RC — Refining Charge USc/lb</div><input type="number" class="field-input" placeholder="e.g. 18 (concentrates)"></div>
      <div class="field"><div class="field-label">Provisional Price</div><div class="field-calc">— pending market data —</div></div>
      <div class="field"><div class="field-label">Provisional Total Value</div><div class="field-calc">—</div></div>
    </div>
  </div>
  <div id="${id}-payment" class="fasttab-content hidden" style="padding:18px">
    <div class="banner banner-warn"><span class="banner-icon">⚠</span>Payment terms are fully independent from sell leg and other buy legs. Everything here is negotiated per vendor.</div>
    <div class="form-grid">
      <div class="field"><div class="field-label">Payment Basis <span class="required">*</span></div><select class="field-select"><option>ADVANCE</option><option>LC-SIGHT</option><option>LC-USANCE</option><option>CAD</option><option>TT-AGAINST-DOCS</option><option>OPEN-ACCOUNT</option></select></div>
      <div class="field"><div class="field-label">BC Payment Terms Code</div><select class="field-select"><option>NET30</option><option>NET60</option><option>NET90</option><option>CAD</option><option>IMMEDIATE</option></select></div>
      <div class="field"><div class="field-label">Advance Required %</div><input type="number" class="field-input" placeholder="0" value="0"></div>
      <div class="field"><div class="field-label">Retention %</div><input type="number" class="field-input" placeholder="0" value="0"></div>
      <div class="field"><div class="field-label">Retention Release Trigger</div><select class="field-select"><option>ASSAY-FINALISED</option><option>OUTTURN-CONFIRMED</option><option>INVOICE-SETTLED</option><option>CUSTOM</option></select></div>
      <div class="field"><div class="field-label">LC Required</div><select class="field-select" onchange="toggleLC(this,'${id}')"><option value="NO">NO</option><option value="YES">YES</option></select></div>
    </div>
    <div id="${id}-lc" class="hidden mt-12">
      <div class="divider-label">LC Details</div>
      <div class="form-grid">
        <div class="field"><div class="field-label">LC No.</div><input type="text" class="field-input"></div>
        <div class="field"><div class="field-label">Issuing Bank</div><input type="text" class="field-input"></div>
        <div class="field"><div class="field-label">LC Amount (USD)</div><input type="number" class="field-input"></div>
        <div class="field"><div class="field-label">LC Expiry Date</div><input type="date" class="field-input"></div>
      </div>
    </div>
    <div class="divider-label mt-16">Payment Schedule Lines</div>
    <table class="line-table">
      <thead><tr><th>#</th><th>% Amount</th><th>Trigger Event</th><th>Due Date</th><th>Status</th><th></th></tr></thead>
      <tbody id="${id}-pay-body"><tr><td colspan="6" class="table-empty">No lines — add below</td></tr></tbody>
    </table>
    <div class="line-add-row"><button class="btn btn-ghost btn-sm" onclick="addPayLine('${id}-pay-body')">+ Add Payment Line</button></div>
  </div>
  <div id="${id}-penalties" class="fasttab-content hidden" style="padding:18px">
    <div class="banner banner-warn"><span class="banner-icon">⚠</span>These penalties are applied to the vendor (inbound). INBOUND-PENALTY = deducted from vendor invoice. INBOUND-BONUS = added to vendor invoice for over-spec delivery.</div>
    <table class="line-table">
      <thead><tr><th>#</th><th>Adj. Code</th><th>Calc Type</th><th>Element</th><th>Threshold</th><th>Rate / Value</th><th>Direction</th><th>Status</th><th></th></tr></thead>
      <tbody id="${id}-pen-body"><tr><td colspan="9" class="table-empty">No lines — add manually or load from template</td></tr></tbody>
    </table>
    <div class="line-add-row btn-row gap-8">
      <button class="btn btn-ghost btn-sm" onclick="addPenLine('${id}-pen-body','BUY')">+ Add Line</button>
      <button class="btn btn-secondary btn-sm" onclick="loadFromTemplate('${id}-pen-body','BUY')">Load from Template</button>
    </div>
  </div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  renderDealList();
});
