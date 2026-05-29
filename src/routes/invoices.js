// ── INVOICES ─────────────────────────────────────────────────────
const invoiceRouter = require('express').Router();
const { query } = require('../db');
const { getSettlement, getQPAverage } = require('./exposure');

// GET /api/invoices
invoiceRouter.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT i.*, cp.name as counterparty_name, c.contract_no
      FROM invoices i
      LEFT JOIN counterparties cp ON cp.id = i.counterparty_id
      LEFT JOIN contracts c ON c.id = i.contract_id
      ORDER BY i.invoice_date DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/invoices/compute — compute invoice amounts without saving
invoiceRouter.post('/compute', async (req, res) => {
  try {
    const { deal_no, invoice_type = 'PROVISIONAL', as_of_date } = req.body;
    const today = as_of_date || new Date().toISOString().split('T')[0];

    // Get contract and pricing line
    const plRes = await query(`
      SELECT c.id as contract_id, c.qty_mt, c.payment_pct, c.counterparty_id,
        c.deal_id, d.deal_no, cp.name as counterparty_name,
        pl.index_pct, pl.payable_pct, pl.premium_discount,
        pl.pricing_rule, pl.calc_method, pl.qp_start_date, pl.qp_end_date,
        pl.benchmark_code, pl.qp_period_code
      FROM contracts c
      JOIN contract_pricing_lines pl ON pl.contract_id = c.id
      JOIN deals d ON d.id = c.deal_id
      JOIN counterparties cp ON cp.id = c.counterparty_id
      WHERE d.deal_no = $1 LIMIT 1
    `, [deal_no]);

    if (!plRes.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const pl = plRes.rows[0];

    let refPrice = null;

    if (pl.pricing_rule === 'average') {
      const qp = await getQPAverage(pl, today);
      refPrice = qp.average;
    } else {
      // Event/Specific: use weighted average of all fixation lots
      const fixRes = await query(`
        SELECT SUM(fixed_price * fixed_qty_mt) / SUM(fixed_qty_mt) as wavg
        FROM fixation_lots WHERE deal_id = $1
      `, [deal_no]);
      refPrice = fixRes.rows[0]?.wavg ? parseFloat(fixRes.rows[0].wavg) : await getSettlement(pl.benchmark_code, today);
    }

    if (refPrice === null) return res.json({ success: false, error: 'No price available' });

    const payablePct   = parseFloat(pl.payable_pct);
    const premDisc     = parseFloat(pl.premium_discount || 0);
    const qty          = parseFloat(pl.qty_mt);
    const paymentPct   = parseFloat(pl.payment_pct);

    const payablePrice   = refPrice * (payablePct / 100) + premDisc;
    const grossAmount    = payablePrice * qty;
    const provisionalAmt = grossAmount * (paymentPct / 100);
    const balanceDue     = grossAmount - provisionalAmt;

    // Payment due = BL date + 5 WD
    const logRes = await query(`
      SELECT bl_date FROM logistics WHERE contract_id=$1 ORDER BY created_at DESC LIMIT 1
    `, [pl.contract_id]);
    const blDate = logRes.rows[0]?.bl_date;

    res.json({
      success: true,
      data: {
        deal_no,
        counterparty: pl.counterparty_name,
        ref_price: refPrice,
        payable_pct: payablePct,
        payable_price: Math.round(payablePrice * 100) / 100,
        qty_mt: qty,
        gross_amount: Math.round(grossAmount * 100) / 100,
        payment_pct: paymentPct,
        provisional_amount: Math.round(provisionalAmt * 100) / 100,
        balance_due: Math.round(balanceDue * 100) / 100,
        bl_date: blDate,
        pricing_rule: pl.pricing_rule,
        as_of_date: today,
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/invoices — create invoice
invoiceRouter.post('/', async (req, res) => {
  try {
    const { invoice_no, invoice_type, invoice_date, deal_no, contract_id,
      counterparty_id, ref_price, payable_price, qty_mt, gross_amount,
      net_amount, provisional_pct, provisional_amount, payment_due_date,
      linked_provisional_id, delta_amount, balance_due, currency = 'USD' } = req.body;

    const result = await query(`
      INSERT INTO invoices (invoice_no, invoice_type, invoice_date, deal_id, contract_id,
        counterparty_id, ref_price, payable_price, qty_mt, gross_amount, net_amount,
        provisional_pct, provisional_amount, payment_due_date,
        linked_provisional_id, delta_amount, balance_due, currency, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,'DRAFT')
      RETURNING *
    `, [invoice_no, invoice_type, invoice_date, deal_no, contract_id,
        counterparty_id, ref_price, payable_price, qty_mt, gross_amount,
        net_amount, provisional_pct, provisional_amount, payment_due_date,
        linked_provisional_id, delta_amount, balance_due, currency]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.invoiceRouter = invoiceRouter;

// ── MASTER DATA ───────────────────────────────────────────────────
const masterRouter = require('express').Router();

masterRouter.get('/commodities', async (req, res) => {
  try {
    const result = await query('SELECT * FROM commodities WHERE active=TRUE ORDER BY name');
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

masterRouter.get('/counterparties', async (req, res) => {
  try {
    const { type } = req.query;
    let sql = 'SELECT * FROM counterparties WHERE active=TRUE';
    const params = [];
    if (type) { params.push(type); sql += ` AND type=$${params.length}`; }
    sql += ' ORDER BY name';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

masterRouter.get('/locations', async (req, res) => {
  try {
    const result = await query('SELECT * FROM locations WHERE active=TRUE ORDER BY name');
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

masterRouter.get('/qp-periods', async (req, res) => {
  try {
    const result = await query('SELECT * FROM qp_period_master WHERE active=TRUE ORDER BY code');
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.masterRouter = masterRouter;
