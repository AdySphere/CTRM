const router = require('express').Router();
const { query, logAudit } = require('../db');

// GET /api/contracts
router.get('/', async (req, res) => {
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

router.get('/:id', async (req, res) => {
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
    const result = await query(
      'SELECT * FROM payment_schedule_lines WHERE contract_id=$1 ORDER BY line_no',
      [req.params.id]
    );
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

module.exports = router;
