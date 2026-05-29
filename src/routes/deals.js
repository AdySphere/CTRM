// ── DEALS ─────────────────────────────────────────────────────────
const dealsRouter = require('express').Router();
const { query } = require('../db');

dealsRouter.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT d.*, 
        s.name as supplier_name, c.name as customer_name, cm.name as commodity_name
      FROM deals d
      LEFT JOIN counterparties s ON s.id = d.supplier_id
      LEFT JOIN counterparties c ON c.id = d.customer_id
      LEFT JOIN commodities cm ON cm.code = d.commodity_code
      ORDER BY d.deal_date DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

dealsRouter.post('/', async (req, res) => {
  try {
    const { deal_no, deal_date, commodity_code, deal_type, qty_mt, supplier_id, customer_id, notes } = req.body;
    const result = await query(`
      INSERT INTO deals (deal_no, deal_date, commodity_code, deal_type, qty_mt, supplier_id, customer_id, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'DRAFT') RETURNING *
    `, [deal_no, deal_date, commodity_code, deal_type, qty_mt, supplier_id, customer_id, notes]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

dealsRouter.patch('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await query(`
      UPDATE deals SET confirmed=TRUE, confirmed_at=NOW(), status='CONFIRMED' WHERE id=$1 RETURNING *
    `, [id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.dealsRouter = dealsRouter;

// ── LOGISTICS ─────────────────────────────────────────────────────
const logRouter = require('express').Router();

logRouter.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT l.*, pol.name as pol_name, pod.name as pod_name,
        c.contract_no, d.deal_no
      FROM logistics l
      LEFT JOIN locations pol ON pol.id = l.pol_id
      LEFT JOIN locations pod ON pod.id = l.pod_id
      LEFT JOIN contracts c ON c.id = l.contract_id
      LEFT JOIN deals d ON d.id = l.deal_id
      ORDER BY l.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

logRouter.get('/:id', async (req, res) => {
  try {
    const [log, containers] = await Promise.all([
      query(`SELECT l.*, pol.name as pol_name, pod.name as pod_name FROM logistics l
             LEFT JOIN locations pol ON pol.id=l.pol_id LEFT JOIN locations pod ON pod.id=l.pod_id
             WHERE l.id=$1`, [req.params.id]),
      query(`SELECT con.*, 
               ROUND((con.gross_weight_mt - con.tare_mt)::numeric, 3) as net_weight_mt,
               ROUND((con.gross_weight_mt - con.tare_mt) * (1 - COALESCE(con.moisture_pct,0)/100)::numeric, 3) as dry_weight_mt
             FROM containers con WHERE con.logistics_id=$1 ORDER BY con.container_no`, [req.params.id]),
    ]);
    if (!log.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, data: { ...log.rows[0], containers: containers.rows } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

logRouter.post('/', async (req, res) => {
  try {
    const { log_no, contract_id, deal_id, shipment_type, vessel_name, carrier,
      pol_id, pod_id, incoterms, etd, bl_date, eta, freight_rate, freight_basis } = req.body;
    const result = await query(`
      INSERT INTO logistics (log_no, contract_id, deal_id, shipment_type, vessel_name, carrier,
        pol_id, pod_id, incoterms, etd, bl_date, eta, freight_rate, freight_basis, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'BOOKING-CONF') RETURNING *
    `, [log_no, contract_id, deal_id, shipment_type, vessel_name, carrier,
        pol_id, pod_id, incoterms, etd, bl_date, eta, freight_rate, freight_basis]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

logRouter.patch('/:id', async (req, res) => {
  try {
    const fields = req.body;
    const sets = Object.keys(fields).map((k, i) => `${k}=$${i+2}`).join(',');
    const result = await query(`UPDATE logistics SET ${sets}, updated_at=NOW() WHERE id=$1 RETURNING *`,
      [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.logRouter = logRouter;

// ── CONTAINERS ────────────────────────────────────────────────────
const conRouter = require('express').Router();

conRouter.get('/', async (req, res) => {
  try {
    const { logistics_id } = req.query;
    let sql = `SELECT c.*,
      ROUND((c.gross_weight_mt - c.tare_mt)::numeric, 3) as net_weight_mt,
      ROUND((c.gross_weight_mt - c.tare_mt) * (1 - COALESCE(c.moisture_pct,0)/100)::numeric, 3) as dry_weight_mt
      FROM containers c WHERE 1=1`;
    const params = [];
    if (logistics_id) { params.push(logistics_id); sql += ` AND c.logistics_id=$${params.length}`; }
    sql += ' ORDER BY c.container_no';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

conRouter.post('/', async (req, res) => {
  try {
    const { container_no, logistics_id, seal_no, size = '20FT', tare_mt,
      gross_weight_mt, moisture_pct, material_code, packaging } = req.body;
    const result = await query(`
      INSERT INTO containers (container_no, logistics_id, seal_no, size, tare_mt,
        gross_weight_mt, moisture_pct, material_code, packaging, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'PENDING') RETURNING *,
        ROUND((gross_weight_mt - tare_mt)::numeric,3) as net_weight_mt
    `, [container_no, logistics_id, seal_no, size, tare_mt, gross_weight_mt, moisture_pct, material_code, packaging]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

conRouter.patch('/:id', async (req, res) => {
  try {
    const fields = req.body;
    const sets = Object.keys(fields).map((k, i) => `${k}=$${i+2}`).join(',');
    const result = await query(`UPDATE containers SET ${sets} WHERE id=$1 RETURNING *`,
      [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.conRouter = conRouter;

// ── FIXATIONS ─────────────────────────────────────────────────────
const fixRouter = require('express').Router();

fixRouter.get('/', async (req, res) => {
  try {
    const { deal_id } = req.query;
    let sql = `SELECT * FROM fixation_lots WHERE 1=1`;
    const params = [];
    if (deal_id) { params.push(deal_id); sql += ` AND deal_id=$${params.length}`; }
    sql += ' ORDER BY fix_date DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/fixations — record a price fixation (Fix Today)
fixRouter.post('/', async (req, res) => {
  try {
    const { lot_ref, deal_id, fixed_price, fixed_qty_mt, fix_date, prompt_date, hedge_ref, contract_id } = req.body;
    if (!deal_id || !fixed_price || !fixed_qty_mt || !fix_date) {
      return res.status(400).json({ error: 'deal_id, fixed_price, fixed_qty_mt, fix_date required' });
    }
    const result = await query(`
      INSERT INTO fixation_lots (lot_ref, deal_id, fixed_price, fixed_qty_mt, fix_date, prompt_date, hedge_ref, contract_id, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'FIXED') RETURNING *
    `, [lot_ref || `FIX-${deal_id}-${fix_date.replace(/-/g,'')}`, deal_id, fixed_price, fixed_qty_mt, fix_date, prompt_date, hedge_ref, contract_id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.fixRouter = fixRouter;

// ── HEDGES ────────────────────────────────────────────────────────
const hedgeRouter = require('express').Router();

hedgeRouter.get('/', async (req, res) => {
  try {
    const { deal_id } = req.query;
    let sql = `SELECT h.*, c.name as commodity_name FROM hedges h
               LEFT JOIN commodities c ON c.code=h.commodity_code WHERE 1=1`;
    const params = [];
    if (deal_id) { params.push(deal_id); sql += ` AND h.deal_id=$${params.length}`; }
    sql += ' ORDER BY h.trade_date DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

hedgeRouter.post('/', async (req, res) => {
  try {
    const { req_ref, deal_id, trade_date, hedge_type, commodity_code, exchange_code,
      qty_mt, entry_price, prompt_date, order_type = 'MARKET', notes } = req.body;
    const result = await query(`
      INSERT INTO hedges (req_ref, deal_id, trade_date, hedge_type, commodity_code,
        exchange_code, qty_mt, entry_price, prompt_date, order_type, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'PENDING') RETURNING *
    `, [req_ref, deal_id, trade_date, hedge_type, commodity_code, exchange_code,
        qty_mt, entry_price, prompt_date, order_type, notes]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

hedgeRouter.patch('/:id/execute', async (req, res) => {
  try {
    const { execution_price, exec_date } = req.body;
    const result = await query(`
      UPDATE hedges SET status='EXECUTED', execution_price=$2, exec_date=$3 WHERE id=$1 RETURNING *
    `, [req.params.id, execution_price, exec_date]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.hedgeRouter = hedgeRouter;

// ── ALLOCATIONS ───────────────────────────────────────────────────
const allocRouter = require('express').Router();

allocRouter.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT a.*,
        con.container_no, con.gross_weight_mt as container_gross,
        bc.contract_no as buy_contract_no,
        sc.contract_no as sell_contract_no,
        ROUND((con.gross_weight_mt - con.tare_mt)::numeric,3) as net_weight_mt,
        ROUND((con.gross_weight_mt - con.tare_mt)*(1-COALESCE(con.moisture_pct,0)/100)::numeric,3) as dry_weight_mt
      FROM allocations a
      JOIN containers con ON con.id = a.container_id
      LEFT JOIN contracts bc ON bc.id = a.buy_contract_id
      LEFT JOIN contracts sc ON sc.id = a.sell_contract_id
      ORDER BY a.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

allocRouter.post('/', async (req, res) => {
  try {
    const { container_id, buy_contract_id, sell_contract_id, sell_order_id,
      payable_weight_mt, allocation_pct = 100, fixation_lot_ref } = req.body;

    // Auto-compute weights from container
    const conRes = await query(`SELECT tare_mt, gross_weight_mt, moisture_pct FROM containers WHERE id=$1`, [container_id]);
    if (!conRes.rows.length) return res.status(404).json({ error: 'Container not found' });
    const con = conRes.rows[0];
    const net = con.gross_weight_mt - con.tare_mt;
    const dry = net * (1 - (con.moisture_pct || 0) / 100);

    // Check if fixation exists for this → PRICED
    const priced_status = fixation_lot_ref ? 'PRICED' : 'UNPRICED';

    const result = await query(`
      INSERT INTO allocations (container_id, buy_contract_id, sell_contract_id, sell_order_id,
        gross_weight_mt, tare_mt, net_weight_mt, moisture_pct, dry_weight_mt,
        payable_weight_mt, allocation_pct, fixation_lot_ref, priced_status, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'ALLOCATED') RETURNING *
    `, [container_id, buy_contract_id, sell_contract_id, sell_order_id,
        con.gross_weight_mt, con.tare_mt, net, con.moisture_pct, dry,
        payable_weight_mt || dry, allocation_pct, fixation_lot_ref, priced_status]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.allocRouter = allocRouter;
