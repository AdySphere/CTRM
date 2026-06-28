const router = require('express').Router();
const { query, logAudit } = require('../db');

// GET /api/contracts
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store'); // was missing on the main contract LIST endpoint —
  // the single most likely cause of two simultaneous users seeing inconsistent/stale data,
  // since this populates the entire PC/SC list table.
  try {
    const { type, status, deal_id } = req.query;
    let sql = `
      SELECT c.*, 
        cp.name as counterparty_name,
        cm.name as commodity_name,
        pol.name as pol_name,
        pod.name as pod_name,
        d.deal_no
      FROM contracts c
      JOIN counterparties cp ON cp.id = c.counterparty_id
      LEFT JOIN commodities cm ON cm.code = c.commodity_code
      LEFT JOIN locations pol ON pol.id = c.pol_id
      LEFT JOIN locations pod ON pod.id = c.pod_id
      LEFT JOIN deals d ON d.id = c.deal_id
      WHERE 1=1
    `;
    const params = [];
    if (type)    { params.push(type);    sql += ` AND c.contract_type = $${params.length}`; }
    if (status)  { params.push(status);  sql += ` AND c.status = $${params.length}`; }
    if (deal_id) { params.push(deal_id); sql += ` AND c.deal_id = $${params.length}`; }
    sql += ' ORDER BY c.contract_date DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/contracts/:id — with pricing lines and QC specs
// PATCH /api/contracts/:id — generic field update (deal_id, incoterms, notes, etc.)
router.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['deal_id', 'incoterms', 'origin', 'destination', 'pricing_formula', 'notes', 'qty_mt'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) {
      if (allowed.includes(k)) fields[k] = req.body[k];
    });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const before = await query('SELECT deal_no, contract_no FROM contracts c LEFT JOIN deals d ON d.id=c.deal_id WHERE c.id=$1', [req.params.id]);
    const sets = Object.keys(fields).map(function(k,i){ return k + '=$' + (i+2); }).join(',');
    const result = await query(
      'UPDATE contracts SET ' + sets + ', updated_at=NOW() WHERE id=$1 RETURNING *',
      [req.params.id, ...Object.values(fields)]
    );
    const contract = result.rows[0];
    if (contract && 'deal_id' in fields) {
      const dealRes = await query('SELECT deal_no FROM deals WHERE id=$1', [fields.deal_id]);
      await logAudit('contract', contract.id, contract.contract_no, 'DEAL_LINK_CHANGED', 'deal_id',
        before.rows[0]?.deal_no || 'none', dealRes.rows[0]?.deal_no || 'none (unlinked)');
    }
    res.json({ success: true, data: contract });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── H3: QP LIST VIEW — per Veridian spec, Tab 1 of the QP & Rollover Window. Shows
// ALL open contracts at once, grouped by urgency (Rollover Required, QP Open, Pre-QP,
// Fully Priced) instead of requiring a contract to be selected first. Contract qty here
// is the GROSS contract quantity, not the payable (index-adjusted) qty used elsewhere —
// per the spec: 'Only CONTRACT QTY shown here. Payable qty calculated by backend.'
router.get('/qp-list', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const today = new Date().toISOString().split('T')[0];

    const contractsRes = await query(`
      SELECT c.id, c.contract_no, c.contract_type, c.commodity_code, c.qty_mt, c.status,
        cp.name as counterparty_name, cm.name as commodity_name,
        pl.id as pricing_line_id, pl.index_pct, pl.qp_start_date, pl.qp_end_date,
        CASE WHEN c.contract_type = 'PC' THEN 'Buy' ELSE 'Sell' END as direction
      FROM contracts c
      JOIN counterparties cp ON cp.id = c.counterparty_id
      LEFT JOIN commodities cm ON cm.code = c.commodity_code
      LEFT JOIN contract_pricing_lines pl ON pl.contract_id = c.id
      WHERE c.status NOT IN ('CANCELLED', 'CLOSED')
      ORDER BY c.contract_date DESC
    `);

    const rows = [];
    for (const c of contractsRes.rows) {
      const qtyMt = parseFloat(c.qty_mt) || 0;
      const indexPct = parseFloat(c.index_pct) || 100;
      const payableQty = qtyMt * (indexPct / 100);

      const fixRes = await query(
        'SELECT COALESCE(SUM(fixed_qty_mt),0) as priced_qty FROM fixation_lots WHERE contract_id=$1',
        [c.id]
      );
      const pricedQty = parseFloat(fixRes.rows[0].priced_qty) || 0;
      const unpricedQty = Math.max(0, payableQty - pricedQty);
      const pctFixed = payableQty > 0 ? Math.round((pricedQty / payableQty) * 100) : 0;

      const qpStart = c.qp_start_date ? c.qp_start_date.toISOString().split('T')[0] : null;
      const qpEnd = c.qp_end_date ? c.qp_end_date.toISOString().split('T')[0] : null;

      // H3 state groups, per the spec — distinct from the simpler exposure-endpoint
      // states since this view needs to separately flag 'expired with unpriced qty'.
      let state, daysLeft;
      if (!c.pricing_line_id || !qpStart) {
        state = 'Pre-QP'; daysLeft = null;
      } else if (today < qpStart) {
        state = 'Pre-QP';
        daysLeft = Math.ceil((new Date(qpStart) - new Date(today)) / 86400000) + ' (to open)';
      } else if (qpEnd && today > qpEnd && unpricedQty > 0.001) {
        state = unpricedQty >= payableQty - 0.001 ? 'Unpriced' : 'Partial';
        daysLeft = 'EXPIRED';
      } else if (unpricedQty <= 0.001) {
        state = 'Priced'; daysLeft = 'Closed';
      } else {
        state = unpricedQty >= payableQty - 0.001 ? 'Unpriced' : 'Partial';
        daysLeft = qpEnd ? Math.max(0, Math.ceil((new Date(qpEnd) - new Date(today)) / 86400000)) + ' days' : '—';
      }

      const rolloverRequired = qpEnd && today > qpEnd && unpricedQty > 0.001;
      const group = rolloverRequired ? 'ROLLOVER_REQUIRED'
        : (!c.pricing_line_id || !qpStart || today < qpStart) ? 'PRE_QP'
        : (unpricedQty <= 0.001) ? 'FULLY_PRICED'
        : 'QP_OPEN';

      rows.push({
        id: c.id, contract_no: c.contract_no, direction: c.direction,
        counterparty: c.counterparty_name, commodity: c.commodity_name || c.commodity_code,
        contract_qty: qtyMt, unpriced_qty: Math.round(unpricedQty * 1000) / 1000,
        qp_start: qpStart, qp_end: qpEnd, pct_fixed: pctFixed,
        days_left: daysLeft, state, group
      });
    }

    // Sort: Rollover Required first, then QP Open (soonest-closing first), then Pre-QP, then Fully Priced.
    const groupOrder = { ROLLOVER_REQUIRED: 0, QP_OPEN: 1, PRE_QP: 2, FULLY_PRICED: 3 };
    rows.sort(function(a, b){
      if (groupOrder[a.group] !== groupOrder[b.group]) return groupOrder[a.group] - groupOrder[b.group];
      if (a.qp_end && b.qp_end) return new Date(a.qp_end) - new Date(b.qp_end);
      return 0;
    });

    res.json({ success: true, data: rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.get('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store'); // was missing — browser could silently serve a stale
  // cached copy of a contract, especially visible when two people are on the same contract
  // and one just saved a change the other's browser hadn't fetched fresh yet.
  try {
    const { id } = req.params;
    const [contract, pricingLines, qcSpecs] = await Promise.all([
      query(`SELECT c.*, cp.name as counterparty_name, cm.name as commodity_name FROM contracts c
             JOIN counterparties cp ON cp.id=c.counterparty_id
             JOIN commodities cm ON cm.code=c.commodity_code
             WHERE c.id=$1`, [id]),
      query(`SELECT * FROM contract_pricing_lines WHERE contract_id=$1 ORDER BY line_no`, [id]),
      query(`SELECT * FROM contract_qc_specs WHERE contract_id=$1`, [id]),
    ]);
    if (!contract.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, data: { ...contract.rows[0], pricing_lines: pricingLines.rows, qc_specs: qcSpecs.rows } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/contracts
router.post('/', async (req, res) => {
  try {
    let { contract_no, contract_date, contract_type, deal_id, commodity_code,
      counterparty_id, qty_mt, incoterms, payment_pct = 90, currency = 'USD', pricing_formula, notes } = req.body;
    // Auto-generate contract_no if not provided
    if (!contract_no) {
      const prefix = contract_type === 'SC' ? 'SC' : 'PC';
      const countRes = await query(`SELECT COUNT(*) FROM contracts WHERE contract_type=$1`, [contract_type]);
      const num = String(parseInt(countRes.rows[0].count) + 1).padStart(3, '0');
      contract_no = prefix + '-' + new Date().getFullYear() + '-' + num;
    }
    // Validate commodity_code exists (or set null if free-text)
    let validCommodity = null;
    if (commodity_code) {
      const cmRes = await query(`SELECT code FROM commodities WHERE code=$1`, [commodity_code]);
      validCommodity = cmRes.rows.length ? commodity_code : null;
    }
    const result = await query(`
      INSERT INTO contracts (contract_no, contract_date, contract_type, deal_id, commodity_code,
        counterparty_id, qty_mt, incoterms, payment_pct, currency, pricing_formula, notes, status)
      VALUES ($1,COALESCE($2::date,CURRENT_DATE),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'DRAFT')
      RETURNING *
    `, [contract_no, contract_date||null, contract_type, deal_id||null, validCommodity,
        counterparty_id, qty_mt, incoterms, payment_pct, currency, pricing_formula||null, notes]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/contracts/:id/pricing-lines
router.post('/:id/pricing-lines', async (req, res) => {
  try {
    const { id } = req.params;
    const { source_item_code, benchmark_code, exchange_code, reporting_agency, instrument_code,
      index_pct, payable_pct, premium_discount = 0, pricing_rule, calc_method,
      pricing_option, qp_period_code, shipment_month, qp_offset_months, qp_start_date, qp_end_date,
      tc_usd_per_mt, rc_pct } = req.body;
    const result = await query(`
      INSERT INTO contract_pricing_lines
        (contract_id, source_item_code, benchmark_code, exchange_code, reporting_agency, instrument_code,
         index_pct, payable_pct, premium_discount, pricing_rule, calc_method,
         pricing_option, qp_period_code, shipment_month, qp_offset_months, qp_start_date, qp_end_date, tc_usd_per_mt, rc_pct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
      RETURNING *
    `, [id, source_item_code, benchmark_code, exchange_code, reporting_agency, instrument_code,
        index_pct, payable_pct, premium_discount, pricing_rule, calc_method,
        pricing_option, qp_period_code, shipment_month||null, qp_offset_months||0, qp_start_date, qp_end_date, tc_usd_per_mt, rc_pct]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/contracts/:id/confirm — mark as CONTRACTED + auto-generate PO/SO
router.patch("/:id/confirm", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    // Item 2 — R2 from the Payment Term Tranches spec: 'Every contract must have at least
    // one payment term tranche before it can be confirmed.' Was genuinely never enforced.
    const trancheCheck = await query('SELECT COUNT(*) FROM payment_term_tranches WHERE contract_id=$1', [req.params.id]);
    if (parseInt(trancheCheck.rows[0].count) === 0) {
      return res.status(400).json({ error: 'Cannot confirm — at least one payment term tranche is required first' });
    }

    const before = await query('SELECT status, contract_no FROM contracts WHERE id=$1', [req.params.id]);
    const result = await query(
      "UPDATE contracts SET status='CONTRACTED', updated_at=NOW() WHERE id=$1 RETURNING *",
      [req.params.id]
    );
    const contract = result.rows[0];
    if (contract) {
      await logAudit('contract', contract.id, contract.contract_no, 'CONFIRM', 'status', before.rows[0]?.status, 'CONTRACTED');
      const orderType = contract.contract_type === 'PC' ? 'PO' : 'SO';
      const yr = new Date().getFullYear();
      const cntRes = await query("SELECT COUNT(*) FROM orders WHERE order_type=$1", [orderType]);
      const orderNo = orderType + '-' + yr + '-' + String(parseInt(cntRes.rows[0].count)+1).padStart(5,'0');
      await query("INSERT INTO orders (order_no, order_type, contract_id, deal_id, order_date, qty_mt, status) VALUES ($1,$2,$3,$4,CURRENT_DATE,$5,'OPEN') ON CONFLICT DO NOTHING",
        [orderNo, orderType, contract.id, contract.deal_id||null, contract.qty_mt]);
    }
    res.json({ success: true, data: contract });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/contracts/:id/pricing-lines
router.get('/:id/pricing-lines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT pl.*, cm.name as source_item_name, bm.name as benchmark_name
      FROM contract_pricing_lines pl
      LEFT JOIN commodities cm ON cm.code = pl.source_item_code
      LEFT JOIN commodities bm ON bm.code = pl.benchmark_code
      WHERE pl.contract_id = $1
      ORDER BY pl.line_no
    `, [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── ROLLOVER EVENTS (Fix 3 — multi-instance, append-only, per-contract) ────
// GET /api/contracts/:id/rollover-events
router.get('/:id/rollover-events', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(
      'SELECT * FROM rollover_events WHERE contract_id=$1 ORDER BY rollover_no',
      [req.params.id]
    );
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/contracts/:id/rollover-events — creates rollover #N, extends QP on the
// contract's pricing line, generates a debit note number. Deliberately append-only:
// no PATCH or DELETE route exists for this resource at all — matches "Immutable once
// created" and "we cannot lose the audit trail" from the 23 June call.
router.post('/:id/rollover-events', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { period_from, period_to, unfixed_qty, rate_basis, rate_value,
      derived_rate_per_mt, amount_usd, new_qp_start_date, new_qp_end_date } = req.body;

    if (!period_from || !period_to || !unfixed_qty || !rate_basis || rate_value == null || amount_usd == null) {
      return res.status(400).json({ error: 'period_from, period_to, unfixed_qty, rate_basis, rate_value and amount_usd are required' });
    }

    // Rollover must not be allowed to be created before the QP window has actually
    // expired — confirmed as a hard validation rule, genuinely missing until now. period_to
    // is the missed window's trigger (end) date; today must be strictly after it.
    const today = new Date().toISOString().split('T')[0];
    if (period_to >= today) {
      return res.status(400).json({ error: 'Cannot create a rollover before the QP window has closed (QP ends ' + period_to + ', today is ' + today + ')' });
    }

    const contractRes = await query('SELECT contract_no FROM contracts WHERE id=$1', [id]);
    if (!contractRes.rows.length) return res.status(404).json({ error: 'Contract not found' });
    const contractNo = contractRes.rows[0].contract_no;

    // Sequential rollover number, scoped to this contract only
    const cntRes = await query('SELECT COUNT(*) FROM rollover_events WHERE contract_id=$1', [id]);
    const rolloverNo = parseInt(cntRes.rows[0].count) + 1;

    // Auto-generate debit note number
    const yr = new Date().getFullYear();
    const dnCntRes = await query(`SELECT COUNT(*) FROM rollover_events WHERE debit_note_no LIKE 'DN-%'`);
    const debitNoteNo = 'DN-' + yr + '-' + String(parseInt(dnCntRes.rows[0].count) + 1).padStart(4, '0');

    const result = await query(`
      INSERT INTO rollover_events
        (contract_id, rollover_no, period_from, period_to, unfixed_qty, rate_basis,
         rate_value, derived_rate_per_mt, amount_usd, new_qp_start_date, new_qp_end_date,
         debit_note_no, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PENDING')
      RETURNING *
    `, [id, rolloverNo, period_from, period_to, unfixed_qty, rate_basis,
        rate_value, derived_rate_per_mt || null, amount_usd, new_qp_start_date || null,
        new_qp_end_date || null, debitNoteNo]);

    const rollover = result.rows[0];

    // Extend the contract's QP window to the new period, if provided
    if (new_qp_start_date && new_qp_end_date) {
      await query(
        'UPDATE contract_pricing_lines SET qp_start_date=$1, qp_end_date=$2 WHERE contract_id=$3',
        [new_qp_start_date, new_qp_end_date, id]
      );
    }

    await logAudit('contract', id, contractNo, 'ROLLOVER', null, null,
      'Rollover #' + rolloverNo + ' — ' + unfixed_qty + ' MT unfixed, ' + amount_usd + ' USD charged, debit note ' + debitNoteNo +
      (new_qp_start_date ? ', QP extended to ' + new_qp_start_date + ' - ' + new_qp_end_date : ''));

    res.json({ success: true, data: rollover });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PAYMENT SCHEDULE LINES ──────────────────────────────────────────
router.get('/:id/payment-lines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT psl.*, dem.name as trigger_event_name, dem.source_system as trigger_event_source
      FROM payment_schedule_lines psl
      LEFT JOIN date_event_master dem ON dem.code = psl.trigger_event
      WHERE psl.contract_id=$1 ORDER BY psl.line_no
    `, [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/:id/payment-lines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { pct, trigger_event, offset_days, offset_type, basis, required_documents, due_date } = req.body;
    if (!pct || !trigger_event) {
      return res.status(400).json({ error: 'pct and trigger_event are required' });
    }
    const cntRes = await query('SELECT COUNT(*) FROM payment_schedule_lines WHERE contract_id=$1', [id]);
    const lineNo = parseInt(cntRes.rows[0].count) + 1;
    const result = await query(`
      INSERT INTO payment_schedule_lines
        (contract_id, line_no, pct, trigger_event, offset_days, offset_type, basis, required_documents, due_date, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING')
      RETURNING *
    `, [id, lineNo, pct, trigger_event, offset_days || 0, offset_type || 'WORKING DAYS',
        basis || null, required_documents || null, due_date || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/:id/payment-lines/:lineId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query('DELETE FROM payment_schedule_lines WHERE id=$1 AND contract_id=$2', [req.params.lineId, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── QC SPECIFICATIONS — shared by PC and SC, contract_id-keyed already ──
router.get('/:id/qc-specs', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query('SELECT * FROM contract_qc_specs WHERE contract_id=$1 ORDER BY id', [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/:id/qc-specs', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { element, spec_min, spec_max, spec_ref_avg, is_percentage,
      penalty_type, penalty_rate, penalty_unit } = req.body;
    if (!element) return res.status(400).json({ error: 'element is required' });
    // Per the QC spec: a fixed Standard Value and a Min/Max range are mutually exclusive
    // for a given element — if a target is filled, min/max should not also be filled.
    if (spec_ref_avg != null && (spec_min != null || spec_max != null)) {
      return res.status(400).json({ error: 'Define either a Min/Max range or a Standard Value, not both' });
    }
    const result = await query(`
      INSERT INTO contract_qc_specs
        (contract_id, element, spec_min, spec_max, spec_ref_avg, is_percentage, penalty_type, penalty_rate, penalty_unit)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *
    `, [id, element, spec_min || null, spec_max || null, spec_ref_avg || null,
        is_percentage !== false, penalty_type || null, penalty_rate || null, penalty_unit || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/:id/qc-specs/:specId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query('DELETE FROM contract_qc_specs WHERE id=$1 AND contract_id=$2', [req.params.specId, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Group C: surfaces unfixed (still-not-priced) quantity for a contract, so the rollover
// form can pre-fill instead of relying purely on the trader to type a number that may not
// match reality — answers Prashant's 'and if the price is not fixed' note directly.
router.get('/:id/unfixed-qty', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const cRes = await query('SELECT qty_mt, index_pct FROM contracts c LEFT JOIN contract_pricing_lines pl ON pl.contract_id = c.id WHERE c.id=$1 LIMIT 1', [id]);
    if (!cRes.rows.length) return res.status(404).json({ error: 'Contract not found' });
    const qtyMt = parseFloat(cRes.rows[0].qty_mt) || 0;
    const indexPct = parseFloat(cRes.rows[0].index_pct) || 100;
    const payableQty = qtyMt * (indexPct / 100);

    const fixRes = await query(
      'SELECT COALESCE(SUM(fixed_qty_mt),0) as priced_qty FROM fixation_lots WHERE contract_id=$1',
      [id]
    );
    const pricedQty = parseFloat(fixRes.rows[0].priced_qty) || 0;
    const unfixedQty = Math.max(0, payableQty - pricedQty);

    res.json({ success: true, data: { payable_qty: payableQty, priced_qty: pricedQty, unfixed_qty: unfixedQty } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── CHARGE ITEMS (Group D) — commission, freight, insurance etc. per contract ──
router.get('/:id/charge-lines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT cl.*, ac.description as charge_description, ac.category as charge_category,
        ac.gl_account, cp.name as counterparty_name
      FROM contract_charge_lines cl
      LEFT JOIN adjustment_codes ac ON ac.code = cl.charge_code
      LEFT JOIN counterparties cp ON cp.id = cl.counterparty_id
      WHERE cl.contract_id=$1 ORDER BY cl.id
    `, [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/:id/charge-lines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { charge_code, description, calc_basis, calc_value, computed_amount,
      qty_or_days, actual_amount, currency, counterparty_id, accrual_trigger_event,
      accrual_reversal_event, notes } = req.body;
    if (!calc_basis || calc_value == null) {
      return res.status(400).json({ error: 'calc_basis and calc_value are required' });
    }
    // H1/H2: variance is the actual penalty/adjustment mechanism — computed here whenever
    // both estimated (computed_amount) and actual_amount are known, not a separate record.
    const variance = (computed_amount != null && actual_amount != null)
      ? (parseFloat(actual_amount) - parseFloat(computed_amount)) : null;
    const result = await query(`
      INSERT INTO contract_charge_lines
        (contract_id, charge_code, description, calc_basis, calc_value, computed_amount,
         qty_or_days, actual_amount, variance, currency, counterparty_id, accrual_status,
         accrual_trigger_event, accrual_reversal_event, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'NOT_ACCRUED',$12,$13,$14)
      RETURNING *
    `, [id, charge_code || null, description || null, calc_basis, calc_value,
        computed_amount || null, qty_or_days || null, actual_amount || null, variance,
        currency || 'USD', counterparty_id || null, accrual_trigger_event || null,
        accrual_reversal_event || null, notes || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/:id/charge-lines/:lineId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['accrual_status', 'computed_amount', 'actual_amount', 'qty_or_days',
      'accrual_trigger_event', 'accrual_reversal_event', 'notes'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (fields.accrual_status === 'ACCRUED') fields.accrued_at = new Date().toISOString();

    // H1: recompute variance whenever actual_amount changes — this IS the penalty line,
    // not a separate record. Need the current computed_amount if it isn't part of this update.
    if ('actual_amount' in fields) {
      const estAmount = ('computed_amount' in fields)
        ? fields.computed_amount
        : (await query('SELECT computed_amount FROM contract_charge_lines WHERE id=$1', [req.params.lineId])).rows[0]?.computed_amount;
      fields.variance = (estAmount != null && fields.actual_amount != null)
        ? (parseFloat(fields.actual_amount) - parseFloat(estAmount)) : null;
    }

    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 3); }).join(',');
    const result = await query(`UPDATE contract_charge_lines SET ${sets} WHERE id=$1 AND contract_id=$2 RETURNING *`,
      [req.params.lineId, req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/:id/charge-lines/:lineId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query('DELETE FROM contract_charge_lines WHERE id=$1 AND contract_id=$2', [req.params.lineId, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// #7: persists rollover configuration to the first pricing line on this contract —
// previously these fields existed only in the DOM with no save path at all.
router.patch('/:id/rollover-config', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { rollover_applicable, rollover_rate_basis, rollover_rate_value } = req.body;
    const result = await query(`
      UPDATE contract_pricing_lines
      SET rollover_applicable = $1, rollover_rate_basis = $2, rollover_rate_value = $3
      WHERE contract_id = $4
      RETURNING *
    `, [rollover_applicable === true, rollover_rate_basis || 'PER-MT', rollover_rate_value || null, id]);
    if (!result.rows.length) return res.status(404).json({ error: 'No pricing line found on this contract — add one first' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// #7 (core): automatic rollover check, per the 23 June call — "in case on so and so date,
// if my QP end date has reached and the price is not fixed, then automatically a debit
// note should be generated." No scheduler exists in this app, so this runs on demand —
// called when the QP & Rollover page loads, and via an explicit button — rather than as a
// genuine background job, which would need real infrastructure this app does not have.
// Idempotent: skips any contract that already has a rollover recorded for its current QP
// end date, so calling this repeatedly does not create duplicate rollovers.
router.post('/rollover-check', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const today = new Date().toISOString().split('T')[0];

    const dueRes = await query(`
      SELECT c.id as contract_id, c.contract_no, c.qty_mt, c.provisional_price,
        pl.index_pct, pl.qp_end_date, pl.qp_start_date,
        pl.rollover_rate_basis, pl.rollover_rate_value
      FROM contracts c
      JOIN contract_pricing_lines pl ON pl.contract_id = c.id
      WHERE pl.rollover_applicable = TRUE
        AND pl.qp_end_date IS NOT NULL
        AND pl.qp_end_date < $1
        AND c.status NOT IN ('CANCELLED', 'CLOSED')
    `, [today]);

    const created = [];
    const skipped = [];

    for (const row of dueRes.rows) {
      // Idempotency: has a rollover already been recorded for this exact QP end date?
      const existingRes = await query(
        'SELECT id FROM rollover_events WHERE contract_id=$1 AND period_to=$2',
        [row.contract_id, row.qp_end_date]
      );
      if (existingRes.rows.length) { skipped.push({ contract_no: row.contract_no, reason: 'already rolled over for this period' }); continue; }

      // Real unfixed quantity, same calculation as /unfixed-qty
      const qtyMt = parseFloat(row.qty_mt) || 0;
      const indexPct = parseFloat(row.index_pct) || 100;
      const payableQty = qtyMt * (indexPct / 100);
      const fixRes = await query('SELECT COALESCE(SUM(fixed_qty_mt),0) as priced_qty FROM fixation_lots WHERE contract_id=$1', [row.contract_id]);
      const pricedQty = parseFloat(fixRes.rows[0].priced_qty) || 0;
      const unfixedQty = Math.max(0, payableQty - pricedQty);

      if (unfixedQty <= 0) { skipped.push({ contract_no: row.contract_no, reason: 'fully priced, no rollover needed' }); continue; }
      if (!row.rollover_rate_value) { skipped.push({ contract_no: row.contract_no, reason: 'no rollover rate configured — cannot compute amount automatically' }); continue; }

      const rateBasis = row.rollover_rate_basis || 'PER-MT';
      const rateValue = parseFloat(row.rollover_rate_value);
      let amount;
      if (rateBasis === 'FIXED-TOTAL') amount = rateValue;
      else if (rateBasis === 'PERCENTAGE') amount = (parseFloat(row.provisional_price) || 0) * unfixedQty * (rateValue / 100);
      else amount = rateValue * unfixedQty; // PER-MT

      // New QP simply continues from the day after the missed window's end date — same
      // one-month convention as the manual rollover flow, since no explicit new end date
      // can be known automatically; the trader can adjust afterward if needed.
      const newStart = new Date(row.qp_end_date);
      newStart.setDate(newStart.getDate() + 1);
      const newEnd = new Date(newStart);
      newEnd.setMonth(newEnd.getMonth() + 1);
      newEnd.setDate(newEnd.getDate() - 1);

      const cntRes = await query('SELECT COUNT(*) FROM rollover_events WHERE contract_id=$1', [row.contract_id]);
      const rolloverNo = parseInt(cntRes.rows[0].count) + 1;
      const yr = new Date().getFullYear();
      const dnCntRes = await query(`SELECT COUNT(*) FROM rollover_events WHERE debit_note_no LIKE 'DN-%'`);
      const debitNoteNo = 'DN-' + yr + '-' + String(parseInt(dnCntRes.rows[0].count) + 1).padStart(4, '0');

      const insertRes = await query(`
        INSERT INTO rollover_events
          (contract_id, rollover_no, period_from, period_to, unfixed_qty, rate_basis,
           rate_value, amount_usd, new_qp_start_date, new_qp_end_date, debit_note_no, status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING')
        RETURNING *
      `, [row.contract_id, rolloverNo, row.qp_start_date, row.qp_end_date, unfixedQty,
          rateBasis, rateValue, amount, newStart.toISOString().split('T')[0],
          newEnd.toISOString().split('T')[0], debitNoteNo]);

      await query('UPDATE contract_pricing_lines SET qp_start_date=$1, qp_end_date=$2 WHERE contract_id=$3',
        [newStart.toISOString().split('T')[0], newEnd.toISOString().split('T')[0], row.contract_id]);

      await logAudit('contract', row.contract_id, row.contract_no, 'AUTO_ROLLOVER', null, null,
        'Automatic rollover #' + rolloverNo + ' — QP ended ' + row.qp_end_date + ' with ' + unfixedQty +
        ' MT unfixed — ' + amount.toFixed(2) + ' USD charged, debit note ' + debitNoteNo + ' generated automatically');

      created.push(insertRes.rows[0]);
    }

    res.json({ success: true, created, skipped, checked_at: today });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── CONTRACT EVENT DATES (A1) — per Veridian Event Date Master spec ──────────
router.get('/:id/event-dates', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query('SELECT * FROM contract_event_dates WHERE contract_id=$1', [req.params.id]);
    res.json({ success: true, data: result.rows[0] || null });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/:id/event-dates', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const existing = await query('SELECT id FROM contract_event_dates WHERE contract_id=$1', [id]);
    if (existing.rows.length) {
      return res.status(409).json({ error: 'Event dates record already exists for this contract — use PATCH to update' });
    }
    const result = await query('INSERT INTO contract_event_dates (contract_id) VALUES ($1) RETURNING *', [id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/:id/event-dates', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const allowed = [
      'contract_date', 'etd_estimated', 'etd_actual', 'bl_date', 'bl_number',
      'eta_estimated', 'eta_actual', 'nor_tendered_at', 'pr_date', 'pr_reference',
      'grn_date', 'grn_reference', 'grn_erp_posted', 'assay_date', 'assay_confirmed',
      'qp_start_date', 'qp_end_date', 'qp_close_confirmed', 'payment_due_date',
      'payment_anchor_event', 'payment_terms_days', 'settlement_date', 'updated_by'
    ];

    const currentRes = await query('SELECT * FROM contract_event_dates WHERE contract_id=$1', [id]);
    if (!currentRes.rows.length) return res.status(404).json({ error: 'No event dates record for this contract — create one first' });
    const current = currentRes.rows[0];

    // THE single most important rule in the whole spec: once bl_date_locked = TRUE,
    // bl_date and bl_number become immutable. Any attempt to change them is rejected
    // server-side, not just hidden client-side, so this can never be bypassed by a
    // direct API call.
    if (current.bl_date_locked && (('bl_date' in req.body) || ('bl_number' in req.body))) {
      return res.status(403).json({ error: 'BL date is locked and cannot be changed once confirmed. Requires an approval workflow to override.' });
    }

    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: current });
    fields.updated_at = new Date().toISOString();
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 2); }).join(',');
    const result = await query(`UPDATE contract_event_dates SET ${sets} WHERE contract_id=$1 RETURNING *`, [id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Locking the BL date is a separate, deliberate action — not just another field update —
// since it triggers automatic recalculation of QP window, payment due date, and accruals.
router.post('/:id/event-dates/lock-bl-date', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { locked_by } = req.body;
    const currentRes = await query('SELECT * FROM contract_event_dates WHERE contract_id=$1', [id]);
    if (!currentRes.rows.length) return res.status(404).json({ error: 'No event dates record for this contract' });
    const current = currentRes.rows[0];
    if (current.bl_date_locked) return res.status(409).json({ error: 'BL date is already locked' });
    if (!current.bl_date) return res.status(400).json({ error: 'Cannot lock — no BL date has been entered yet' });

    const result = await query(`
      UPDATE contract_event_dates
      SET bl_date_locked = TRUE, bl_date_locked_by = $2, bl_date_locked_at = NOW()
      WHERE contract_id = $1 RETURNING *
    `, [id, locked_by || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── PAYMENT TERM TRANCHES (A2) ────────────────────────────────────────────────
router.get('/:id/payment-tranches', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query('SELECT * FROM payment_term_tranches WHERE contract_id=$1 ORDER BY tranche_number', [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/:id/payment-tranches', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { tranche_name, percentage, amount_basis, anchor_event, offset_days,
      offset_direction, fixed_date, currency, invoice_type, notes } = req.body;
    if (!tranche_name || percentage == null || !anchor_event) {
      return res.status(400).json({ error: 'tranche_name, percentage and anchor_event are required' });
    }

    // R1: tranches must sum to 100% — check existing + this new one before allowing it.
    const existingRes = await query('SELECT COALESCE(SUM(percentage),0) as total FROM payment_term_tranches WHERE contract_id=$1', [id]);
    const existingTotal = parseFloat(existingRes.rows[0].total) || 0;
    const newTotal = existingTotal + parseFloat(percentage);
    if (amount_basis !== 'balance_remaining' && newTotal > 100.001) {
      return res.status(400).json({ error: 'Tranches would total ' + newTotal.toFixed(2) + '% — cannot exceed 100%. Use balance_remaining for the final tranche instead.' });
    }

    const cntRes = await query('SELECT COUNT(*) FROM payment_term_tranches WHERE contract_id=$1', [id]);
    const trancheNo = parseInt(cntRes.rows[0].count) + 1;

    // Item 2 fix: calculated_amount was never computed at all — per the spec's worked
    // examples (e.g. 90% of $920,000 = $828,000), this should derive from the contract's
    // provisional value the same way calculated_due_date derives from the anchor event.
    let calcAmount = null;
    const contractRes = await query('SELECT provisional_value FROM contracts WHERE id=$1', [id]);
    const contractValue = contractRes.rows.length ? parseFloat(contractRes.rows[0].provisional_value) : null;
    if (contractValue != null && amount_basis !== 'balance_remaining' && amount_basis !== 'fixed_amount') {
      calcAmount = contractValue * (parseFloat(percentage) / 100);
    } else if (amount_basis === 'balance_remaining' && contractValue != null) {
      const remainingPct = Math.max(0, 100 - existingTotal);
      calcAmount = contractValue * (remainingPct / 100);
    }

    // Calculate due date now if the anchor event date is already known.
    const edRes = await query('SELECT * FROM contract_event_dates WHERE contract_id=$1', [id]);
    let dueDate = null;
    const anchorFieldMap = {
      contract_date: 'contract_date', etd_date: 'etd_actual', bl_date: 'bl_date',
      eta_date: 'eta_actual', pr_date: 'pr_date', grn_date: 'grn_date',
      assay_date: 'assay_date', qp_close_date: 'qp_end_date'
    };
    if (anchor_event === 'fixed_date' && fixed_date) {
      dueDate = fixed_date;
    } else if (edRes.rows.length && anchorFieldMap[anchor_event]) {
      const anchorDate = edRes.rows[0][anchorFieldMap[anchor_event]];
      if (anchorDate) {
        const d = new Date(anchorDate);
        const sign = (offset_direction || 'after') === 'before' ? -1 : 1;
        d.setDate(d.getDate() + sign * (offset_days || 0));
        dueDate = d.toISOString().split('T')[0];
      }
    }

    const result = await query(`
      INSERT INTO payment_term_tranches
        (contract_id, tranche_number, tranche_name, percentage, amount_basis, anchor_event,
         offset_days, offset_direction, fixed_date, calculated_due_date, calculated_amount,
         currency, invoice_type, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      RETURNING *
    `, [id, trancheNo, tranche_name, percentage, amount_basis || 'pct_of_contract', anchor_event,
        offset_days || 0, offset_direction || 'after', fixed_date || null, dueDate, calcAmount,
        currency || 'USD', invoice_type || 'provisional',
        dueDate ? 'due_date_calc' : 'pending_anchor', notes || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/:id/payment-tranches/:trancheId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query('DELETE FROM payment_term_tranches WHERE id=$1 AND contract_id=$2', [req.params.trancheId, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ── MATERIAL LINES (H2) — was client-side only, never persisted ──────────────
router.get('/:id/material-lines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT ml.*, cm.name as commodity_name, cp.name as counterparty_name
      FROM contract_material_lines ml
      LEFT JOIN commodities cm ON cm.code = ml.commodity_code
      LEFT JOIN counterparties cp ON cp.id = ml.counterparty_id
      WHERE ml.contract_id=$1 ORDER BY ml.line_no
    `, [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.post('/:id/material-lines', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { id } = req.params;
    const { commodity_code, grade, hs_code, origin, qty_gross, tolerance_pct, uom,
      unit_price, price_basis, counterparty_id, incoterms } = req.body;
    if (!qty_gross) return res.status(400).json({ error: 'qty_gross is required' });

    const cntRes = await query('SELECT COUNT(*) FROM contract_material_lines WHERE contract_id=$1', [id]);
    const lineNo = parseInt(cntRes.rows[0].count) + 1;
    const provValue = (unit_price && qty_gross) ? (parseFloat(unit_price) * parseFloat(qty_gross)) : null;

    const result = await query(`
      INSERT INTO contract_material_lines
        (contract_id, line_no, commodity_code, grade, hs_code, origin, qty_gross,
         tolerance_pct, uom, unit_price, price_basis, provisional_value, counterparty_id, incoterms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      RETURNING *
    `, [id, lineNo, commodity_code || null, grade || null, hs_code || null, origin || null,
        qty_gross, tolerance_pct || null, uom || 'MT', unit_price || null, price_basis || null,
        provValue, counterparty_id || null, incoterms || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.patch('/:id/material-lines/:lineId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['commodity_code', 'grade', 'hs_code', 'origin', 'qty_gross',
      'tolerance_pct', 'uom', 'unit_price', 'price_basis', 'counterparty_id', 'incoterms'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });

    // Recompute provisional value if either price or qty changed
    if ('unit_price' in fields || 'qty_gross' in fields) {
      const currentRes = await query('SELECT unit_price, qty_gross FROM contract_material_lines WHERE id=$1', [req.params.lineId]);
      const current = currentRes.rows[0] || {};
      const price = 'unit_price' in fields ? fields.unit_price : current.unit_price;
      const qty = 'qty_gross' in fields ? fields.qty_gross : current.qty_gross;
      fields.provisional_value = (price && qty) ? (parseFloat(price) * parseFloat(qty)) : null;
    }

    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 3); }).join(',');
    const result = await query(`UPDATE contract_material_lines SET ${sets} WHERE id=$1 AND contract_id=$2 RETURNING *`,
      [req.params.lineId, req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

router.delete('/:id/material-lines/:lineId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query('DELETE FROM contract_material_lines WHERE id=$1 AND contract_id=$2', [req.params.lineId, req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// H4: containers for a contract — joins through logistics since containers don't have
// a direct contract_id (containers.logistics_id -> logistics.contract_id). Always shown
// in Fix Today whenever this list is non-empty, for both full and partial fixes, per spec.
router.get('/:id/containers', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT ct.id, ct.container_no, ct.seal_no, ct.size, ct.gross_weight_mt, ct.tare_mt,
        (ct.gross_weight_mt - ct.tare_mt) as net_weight_mt, ct.status,
        COALESCE(SUM(flc.qty_covered_mt), 0) as already_fixed_mt
      FROM containers ct
      JOIN logistics l ON l.id = ct.logistics_id
      LEFT JOIN fixation_lot_containers flc ON flc.container_id = ct.id
      WHERE l.contract_id = $1
      GROUP BY ct.id, ct.container_no, ct.seal_no, ct.size, ct.gross_weight_mt, ct.tare_mt, ct.status
      ORDER BY ct.container_no
    `, [req.params.id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports = router;
