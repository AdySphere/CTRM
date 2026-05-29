const router = require('express').Router();
const { query } = require('../db');

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
      JOIN commodities cm ON cm.code = c.commodity_code
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
    const { contract_no, contract_date, contract_type, deal_id, commodity_code,
      counterparty_id, qty_mt, incoterms, payment_pct = 90, currency = 'USD', notes } = req.body;
    const result = await query(`
      INSERT INTO contracts (contract_no, contract_date, contract_type, deal_id, commodity_code,
        counterparty_id, qty_mt, incoterms, payment_pct, currency, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'DRAFT')
      RETURNING *
    `, [contract_no, contract_date, contract_type, deal_id, commodity_code,
        counterparty_id, qty_mt, incoterms, payment_pct, currency, notes]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/contracts/:id/pricing-lines
router.post('/:id/pricing-lines', async (req, res) => {
  try {
    const { id } = req.params;
    const { source_item_code, benchmark_code, exchange_code, reporting_agency,
      index_pct, payable_pct, premium_discount = 0, pricing_rule, calc_method,
      pricing_option, qp_period_code, qp_start_date, qp_end_date, tc_usd_per_mt, rc_pct } = req.body;
    const result = await query(`
      INSERT INTO contract_pricing_lines
        (contract_id, source_item_code, benchmark_code, exchange_code, reporting_agency,
         index_pct, payable_pct, premium_discount, pricing_rule, calc_method,
         pricing_option, qp_period_code, qp_start_date, qp_end_date, tc_usd_per_mt, rc_pct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [id, source_item_code, benchmark_code, exchange_code, reporting_agency,
        index_pct, payable_pct, premium_discount, pricing_rule, calc_method,
        pricing_option, qp_period_code, qp_start_date, qp_end_date, tc_usd_per_mt, rc_pct]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
