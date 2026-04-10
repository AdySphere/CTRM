/* ============================================================
   CTRM — RFQ MODULE JS
   ============================================================ */
'use strict';

const RFQ_SEED = {
  rfqs: [{
    no:'RFQ-2026-005', date:'2026-03-20', dealNo:'DL-2026-040',
    commodity:'STEEL-HMS1', targetMin:1500, targetMax:2500, uom:'MT',
    status:'RESPONSES-RECEIVED', altGrades:true, deadline:'2026-03-28',
    vendors:[
      {no:'V-001',name:'Glencore AG',status:'RESPONDED',score:88},
      {no:'V-002',name:'Trafigura PTE Ltd',status:'RESPONDED',score:74},
      {no:'V-003',name:'Noble Resources Ltd',status:'RESPONDED',score:91},
      {no:'V-006',name:'New Vendor (Pending)',status:'NO-RESPONSE',score:0},
    ],
    responses:[
      {vendor:'Glencore AG',vendorNo:'V-001',seq:1,status:'SHORTLISTED',commodity:'STEEL-HMS1',grade:'HMS 1&2 (80:20)',qty:1000,uom:'MT',pricingType:'FIXED',price:420,currency:'USD',incoterms:'CFR',port:'Nhava Sheva',shipFrom:'2026-04-15',shipTo:'2026-05-15',paymentBasis:'LC-SIGHT',paymentTerms:'NET30',advance:0,score:88,validity:'2026-04-05',
        penalties:[{code:'PEN-PB',calc:'THRESHOLD',element:'Pb%',threshold:'0.5%',rate:'$8/MT/0.1%',dir:'INBOUND-PENALTY'},{code:'PEN-LATE-DEL',calc:'FLAT-RATE',element:'Days Late',threshold:'—',rate:'$5/MT/day',dir:'INBOUND-PENALTY'}]},
      {vendor:'Trafigura PTE Ltd',vendorNo:'V-002',seq:1,status:'RECEIVED',commodity:'STEEL-HMS1',grade:'HMS 1 Only',qty:1500,uom:'MT',pricingType:'QP-AVERAGE',price:415,currency:'USD',incoterms:'FOB',port:'Hamburg',shipFrom:'2026-04-20',shipTo:'2026-05-20',paymentBasis:'TT-AGAINST-DOCS',paymentTerms:'NET60',advance:10,score:74,validity:'2026-04-03',
        penalties:[{code:'PEN-MOIST',calc:'TIERED',element:'Moisture%',threshold:'8%',rate:'See Tiers',dir:'INBOUND-PENALTY'}]},
      {vendor:'Noble Resources Ltd',vendorNo:'V-003',seq:1,status:'SHORTLISTED',commodity:'STEEL-HMS1',grade:'HMS 1&2 (70:30)',qty:2000,uom:'MT',pricingType:'FIXED',price:418,currency:'USD',incoterms:'CFR',port:'Nhava Sheva',shipFrom:'2026-04-10',shipTo:'2026-05-10',paymentBasis:'LC-SIGHT',paymentTerms:'NET30',advance:0,score:91,validity:'2026-04-10',
        penalties:[{code:'PEN-PB',calc:'THRESHOLD',element:'Pb%',threshold:'0.3%',rate:'$10/MT/0.1%',dir:'INBOUND-PENALTY'},{code:'PREM-FE',calc:'THRESHOLD',element:'Fe%',threshold:'96%',rate:'$1.2/MT/0.1%',dir:'INBOUND-BONUS'}]},
    ]
  }]
};

function renderRFQList() {
  const tbody = document.getElementById('rfq-list-body');
  if (!tbody) return;
  tbody.innerHTML = RFQ_SEED.rfqs.map(r => `
    <tr onclick="openRFQDetail('${r.no}')" style="cursor:pointer">
      <td class="mono text-accent">${r.no}</td>
      <td>${commodityChip(r.commodity)}</td>
      <td class="mono">${r.targetMin}–${r.targetMax} ${r.uom}</td>
      <td class="fs-12">${r.dealNo}</td>
      <td class="fs-12">${r.vendors.length} invited · ${r.vendors.filter(v=>v.status==='RESPONDED').length} responded</td>
      <td>${statusBadge(r.status)}</td>
      <td class="mono fs-11">${r.deadline}</td>
      <td><button class="btn btn-ghost btn-xs" onclick="event.stopPropagation();openRFQDetail('${r.no}')">Open</button></td>
    </tr>`).join('');
}

function openRFQDetail(rfqNo) {
  CTRM.currentRFQ = rfqNo;
  const rfq = RFQ_SEED.rfqs.find(r=>r.no===rfqNo);
  if (!rfq) return;
  renderRFQHeader(rfq); renderVendorDist(rfq); renderResponses(rfq); renderCompare(rfq);
  navigate('rfq-detail');
}

function renderRFQHeader(rfq) {
  const el = document.getElementById('rfq-detail-header');
  if (!el) return;
  el.innerHTML = `
    <div class="flex align-center gap-12 mb-16">
      <div><div class="page-title">${rfq.no}</div><div class="page-subtitle">${rfq.dealNo} · ${rfq.commodity} · ${rfq.targetMin}–${rfq.targetMax} ${rfq.uom}</div></div>
      <div style="margin-left:auto" class="btn-row gap-8">
        ${statusBadge(rfq.status)}
        <button class="btn btn-primary btn-sm" onclick="toast('RFQ Issued','Invitations sent to ${rfq.vendors.length} vendors','success')">Issue / Reissue</button>
      </div>
    </div>
    <div class="stat-row">
      <div class="stat-chip"><div class="stat-chip-label">Vendors Invited</div><div class="stat-chip-value">${rfq.vendors.length}</div></div>
      <div class="stat-chip"><div class="stat-chip-label">Responses Received</div><div class="stat-chip-value text-green">${rfq.vendors.filter(v=>v.status==='RESPONDED').length}</div></div>
      <div class="stat-chip"><div class="stat-chip-label">Response Deadline</div><div class="stat-chip-value fs-13 mono">${rfq.deadline}</div></div>
      <div class="stat-chip"><div class="stat-chip-label">Alt. Grades Accepted</div><div class="stat-chip-value ${rfq.altGrades?'text-green':'text-danger'}">${rfq.altGrades?'YES':'NO'}</div></div>
    </div>`;
}

function renderVendorDist(rfq) {
  const el = document.getElementById('rfq-vendor-dist');
  if (!el) return;
  el.innerHTML = rfq.vendors.map(v=>`
    <tr>
      <td class="mono fs-11">${v.no}</td>
      <td class="fs-12 fw-600">${v.name}</td>
      <td>${statusBadge(v.status)}</td>
      <td>${v.score>0?`<div class="score-bar-wrap"><div class="score-bar-bg"><div class="score-bar-fill" style="width:${v.score}%"></div></div><div class="score-val">${v.score}</div></div>`:'<span class="text-dim fs-11">—</span>'}</td>
      <td><button class="btn btn-ghost btn-xs" onclick="toast('Reminder Sent','Email sent to ${v.name}','info')">Remind</button></td>
    </tr>`).join('');
}

function renderResponses(rfq) {
  const el = document.getElementById('rfq-responses-body');
  if (!el) return;
  el.innerHTML = rfq.responses.map((r,i)=>`
    <tr>
      <td>${statusBadge(r.status)}</td>
      <td class="fs-12 fw-600">${r.vendor}</td>
      <td><span class="commodity-chip"><span class="commodity-pip pip-fe"></span>${r.grade}</span></td>
      <td class="mono">${fmtQty(r.qty,r.uom)}</td>
      <td class="mono fw-600 ${i===2?'text-green':''}">${r.price} ${r.currency}/MT</td>
      <td class="fs-11">${r.pricingType}</td>
      <td class="fs-11">${r.incoterms} · ${r.port}</td>
      <td class="fs-11">${r.paymentBasis}</td>
      <td><div class="score-bar-wrap"><div class="score-bar-bg"><div class="score-bar-fill" style="width:${r.score}%"></div></div><div class="score-val">${r.score}</div></div></td>
      <td class="btn-row gap-8">
        <button class="btn btn-ghost btn-xs" onclick="openRespDetail(${i})">Detail</button>
        <button class="btn btn-primary btn-xs" onclick="acceptResp(${i},'${rfq.no}')">Accept</button>
      </td>
    </tr>`).join('');
}

function renderCompare(rfq) {
  const el = document.getElementById('rfq-compare-grid');
  if (!el) return;
  const r = rfq.responses;
  const minP = Math.min(...r.map(x=>x.price));
  const maxS = Math.max(...r.map(x=>x.score));
  el.innerHTML = `
    <div class="compare-grid">
      <div class="compare-row"><div class="compare-label">Vendor</div>${r.map(x=>`<div class="compare-cell fw-600">${x.vendor}</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Grade Offered</div>${r.map(x=>`<div class="compare-cell fs-11">${x.grade}</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Quantity</div>${r.map(x=>`<div class="compare-cell mono">${fmtQty(x.qty,x.uom)}</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Price (USD/MT)</div>${r.map(x=>`<div class="compare-cell mono ${x.price===minP?'best':''}">${x.price} USD</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Pricing Type</div>${r.map(x=>`<div class="compare-cell fs-11">${x.pricingType}</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Incoterms</div>${r.map(x=>`<div class="compare-cell fs-11">${x.incoterms}</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Payment Basis</div>${r.map(x=>`<div class="compare-cell fs-11">${x.paymentBasis}</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Advance Required</div>${r.map(x=>`<div class="compare-cell mono">${x.advance}%</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Penalty Lines</div>${r.map(x=>`<div class="compare-cell mono">${x.penalties.length} lines</div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Eval. Score</div>${r.map(x=>`<div class="compare-cell ${x.score===maxS?'best':''}"><div class="score-bar-wrap"><div class="score-bar-bg"><div class="score-bar-fill" style="width:${x.score}%"></div></div><div class="score-val">${x.score}</div></div></div>`).join('')}</div>
      <div class="compare-row"><div class="compare-label">Action</div>${r.map((x,i)=>`<div class="compare-cell"><button class="btn btn-${x.status==='SHORTLISTED'?'primary':'ghost'} btn-xs" onclick="acceptResp(${i},'${rfq.no}')">Accept → Buy Leg</button></div>`).join('')}</div>
    </div>`;
}

function acceptResp(idx, rfqNo) {
  const rfq = RFQ_SEED.rfqs.find(r=>r.no===rfqNo);
  if (!rfq) return;
  const resp = rfq.responses[idx];
  const ln = `BL-${String(CTRM.nextBuyLegSeq++).padStart(2,'0')}`;
  toast(`Response Accepted`,`${resp.vendor} → Buy Leg ${ln} created on ${rfq.dealNo}`,'success');
  setTimeout(()=>toast('Penalty Terms Transferred',`${resp.penalties.length} lines copied to ${ln}`,'info'),700);
}

function openRespDetail(idx) {
  const rfq = RFQ_SEED.rfqs.find(r=>r.no===CTRM.currentRFQ);
  if (!rfq) return;
  const r = rfq.responses[idx];
  document.getElementById('response-detail-body').innerHTML = `
    <div class="form-grid mb-16">
      <div class="field"><div class="field-label">Vendor</div><div class="field-value">${r.vendor}</div></div>
      <div class="field"><div class="field-label">Status</div><div class="field-value">${statusBadge(r.status)}</div></div>
      <div class="field"><div class="field-label">Grade</div><div class="field-value">${r.grade}</div></div>
      <div class="field"><div class="field-label">Quantity</div><div class="field-value mono">${fmtQty(r.qty,r.uom)}</div></div>
      <div class="field"><div class="field-label">Price</div><div class="field-value mono text-accent">${r.price} ${r.currency}/MT</div></div>
      <div class="field"><div class="field-label">Pricing Type</div><div class="field-value">${r.pricingType}</div></div>
      <div class="field"><div class="field-label">Incoterms / Port</div><div class="field-value">${r.incoterms} · ${r.port}</div></div>
      <div class="field"><div class="field-label">Payment Basis</div><div class="field-value">${r.paymentBasis}</div></div>
      <div class="field"><div class="field-label">Validity</div><div class="field-value mono">${r.validity}</div></div>
      <div class="field"><div class="field-label">Eval. Score</div><div class="field-value text-green fw-700">${r.score}/100</div></div>
    </div>
    <div class="divider-label">Proposed Penalty / Bonus Terms</div>
    <table class="line-table">
      <thead><tr><th>Code</th><th>Calc Type</th><th>Element</th><th>Threshold</th><th>Rate</th><th>Direction</th></tr></thead>
      <tbody>${r.penalties.map(p=>`
        <tr>
          <td class="mono fs-11 text-accent2">${p.code}</td>
          <td><span class="calc-type-pill ct-${p.calc.replace(/-/g,'').toLowerCase()}">${p.calc}</span></td>
          <td class="mono fs-11">${p.element}</td>
          <td class="mono fs-11">${p.threshold}</td>
          <td class="mono fs-11">${p.rate}</td>
          <td><span class="badge badge-danger" style="font-size:8px">${p.dir}</span></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="btn-row right mt-16">
      <button class="btn btn-primary" onclick="closeModal('modal-response-detail');acceptResp(${idx},'${CTRM.currentRFQ}')">Accept → Create Buy Leg</button>
    </div>`;
  openModal('modal-response-detail');
}

document.addEventListener('DOMContentLoaded', () => { renderRFQList(); });
