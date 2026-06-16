// ── DEALS ─────────────────────────────────────────────────────────
const dealsRouter = require('express').Router();
const { query } = require('../db');

dealsRouter.get('/', async (req, res) => {
  try {
    const result = await query(`
      SELECT 
        d.id, d.deal_no, d.deal_date, d.commodity_code, d.deal_type,
        d.qty_mt, d.supplier_id, d.customer_id, d.confirmed,
        d.confirmed_at, d.status, d.notes, d.created_at,
        s.name as supplier_name,
        c.name as customer_name,
        cm.name as commodity_name
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
    const { notes, confirmed_at } = req.body || {};
    const result = await query(`
      UPDATE deals SET confirmed=TRUE, confirmed_at=COALESCE($2::timestamptz, NOW()),
        status='CONFIRMED', notes=COALESCE($3, notes) WHERE id=$1 RETURNING *
    `, [id, confirmed_at || null, notes || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.dealsRouter = dealsRouter;

// ── LOGISTICS ─────────────────────────────────────────────────────
const logRouter = require('express').Router();

logRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
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
  res.set('Cache-Control', 'no-store');
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
  res.set('Cache-Control', 'no-store');
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
  res.set('Cache-Control', 'no-store');
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
  res.set('Cache-Control', 'no-store');
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

// ── ORDERS ────────────────────────────────────────────────────────
const ordersRouter = require('express').Router();

ordersRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { type, contract_id } = req.query;
    let sql = `SELECT o.*, c.contract_no, cp.name as counterparty_name
               FROM orders o
               LEFT JOIN contracts c ON c.id = o.contract_id
               LEFT JOIN counterparties cp ON cp.id = c.counterparty_id
               WHERE 1=1`;
    const params = [];
    if (type) { params.push(type); sql += ` AND o.order_type=$${params.length}`; }
    if (contract_id) { params.push(contract_id); sql += ` AND o.contract_id=$${params.length}`; }
    sql += ' ORDER BY o.order_date DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

ordersRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { order_no, order_type, contract_id, deal_id, order_date, qty_mt, erp_ref } = req.body;
    const result = await query(`
      INSERT INTO orders (order_no, order_type, contract_id, deal_id, order_date, qty_mt, erp_ref)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [order_no, order_type, contract_id, deal_id, order_date, qty_mt, erp_ref]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.ordersRouter = ordersRouter;

// ── ENQUIRIES ─────────────────────────────────────────────────────
const enquiriesRouter = require('express').Router();

enquiriesRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT e.*,
        s.name as supplier_name, s.code as supplier_code,
        c.name as customer_name, c.code as customer_code,
        cm.name as commodity_name,
        (SELECT COUNT(*) FROM quotations q WHERE q.enquiry_id = e.id) as quotation_count
      FROM enquiries e
      LEFT JOIN counterparties s ON s.id = e.supplier_id
      LEFT JOIN counterparties c ON c.id = e.customer_id
      LEFT JOIN commodities cm ON cm.code = e.commodity_code
      ORDER BY e.enquiry_date DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

enquiriesRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { enquiry_no, enquiry_date, commodity_code, deal_type, qty_mt,
      supplier_id, customer_id, incoterms, origin, destination,
      pricing_intent, status, created_by, notes } = req.body;
    // Auto-generate sequential enquiry number if not provided
    let enqNo = enquiry_no;
    if (!enqNo) {
      const yr = new Date().getFullYear();
      const cntRes = await query(
        `SELECT COUNT(*) FROM enquiries WHERE enquiry_no LIKE $1`, [`ENQ-${yr}-%`]
      );
      const nextNum = String(parseInt(cntRes.rows[0].count) + 1).padStart(3, '0');
      enqNo = `ENQ-${yr}-${nextNum}`;
      // Ensure unique (in case of race)
      const existRes = await query(`SELECT id FROM enquiries WHERE enquiry_no=$1`, [enqNo]);
      if (existRes.rows.length) {
        enqNo = `ENQ-${yr}-${String(parseInt(cntRes.rows[0].count) + 2).padStart(3,'0')}`;
      }
    }
    const result = await query(`
      INSERT INTO enquiries (enquiry_no, enquiry_date, commodity_code, deal_type, qty_mt,
        supplier_id, customer_id, incoterms, origin, destination,
        pricing_intent, status, created_by, notes)
      VALUES ($1,COALESCE($2::date,CURRENT_DATE),$3,$4,$5,$6,$7,$8,$9,$10,$11,
              COALESCE($12,'OPEN'),$13,$14) RETURNING *
    `, [enqNo, enquiry_date||null, commodity_code, deal_type||'BACK-TO-BACK', qty_mt,
        supplier_id||null, customer_id||null, incoterms||null,
        origin||null, destination||null, pricing_intent||null,
        status, created_by||null, notes||null]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

enquiriesRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const fields = req.body;
    const sets = Object.keys(fields).map((k, i) => `${k}=$${i+2}`).join(',');
    const result = await query(`UPDATE enquiries SET ${sets} WHERE id=$1 RETURNING *`,
      [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.enquiriesRouter = enquiriesRouter;

// ── QUOTATIONS ────────────────────────────────────────────────────
const quotationsRouter = require('express').Router();

quotationsRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT q.*,
        c.name as customer_name,
        cm.name as commodity_name, cm.uom as commodity_uom,
        e.enquiry_no, e.direction as enquiry_direction,
        d.deal_no,
        COALESCE(q.quote_type, CASE WHEN q.quotation_no LIKE 'PQ-%' THEN 'PQ' ELSE 'SQ' END) as quote_type_resolved
      FROM quotations q
      LEFT JOIN counterparties c ON c.id = q.customer_id
      LEFT JOIN commodities cm ON cm.code = q.commodity_code
      LEFT JOIN enquiries e ON e.id = q.enquiry_id
      LEFT JOIN deals d ON d.id = q.deal_id
      ORDER BY q.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

quotationsRouter.get('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT q.*,
        c.name as customer_name, c.code as customer_code,
        cm.name as commodity_name,
        e.enquiry_no, e.deal_type, e.supplier_id,
        d.deal_no
      FROM quotations q
      LEFT JOIN counterparties c ON c.id = q.customer_id
      LEFT JOIN commodities cm ON cm.code = q.commodity_code
      LEFT JOIN enquiries e ON e.id = q.enquiry_id
      LEFT JOIN deals d ON d.id = q.deal_id
      WHERE q.id=$1 OR q.quotation_no=$1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

quotationsRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { enquiry_id, quotation_date, commodity_code, customer_id, supplier_id, qty_mt,
      incoterms, port_of_discharge, delivery_from, delivery_to, validity_date,
      pricing_template, provisional_price, provisional_value, quoted_by, notes,
      quote_type = 'SQ' } = req.body;

    // Auto-generate quotation_no with separate series per type
    // PQ = Purchase Quote (buying), SQ = Sales Quote (selling)
    const prefix = quote_type === 'PQ' ? 'PQ' : 'SQ';
    const yr = new Date().getFullYear();
    const countRes = await query(
      `SELECT COUNT(*) FROM quotations WHERE quote_type=$1 AND quotation_no LIKE $2`,
      [prefix, prefix + '-' + yr + '-%']
    );
    const nextNum = String(parseInt(countRes.rows[0].count) + 1).padStart(3, '0');
    const nextNo = prefix + '-' + yr + '-' + nextNum;

    // For PQ, counterparty is supplier; for SQ, counterparty is customer
    const cpId = quote_type === 'PQ' ? (supplier_id || customer_id) : (customer_id || supplier_id);

    const result = await query(`
      INSERT INTO quotations (quotation_no, enquiry_id, quotation_date, commodity_code,
        customer_id, qty_mt, incoterms, port_of_discharge, delivery_from, delivery_to,
        validity_date, pricing_template, provisional_price, provisional_value,
        quoted_by, status, quote_type, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'OPEN',$16,$17) RETURNING *
    `, [nextNo, enquiry_id||null, quotation_date||new Date().toISOString().split('T')[0],
        commodity_code, cpId||null, qty_mt, incoterms, port_of_discharge,
        delivery_from, delivery_to, validity_date, pricing_template,
        provisional_price, provisional_value, quoted_by||'A. Mallick',
        prefix, notes]);

    // Mark enquiry as QUOTED if linked
    if (enquiry_id) {
      await query(`UPDATE enquiries SET status='QUOTED' WHERE id=$1 AND status='OPEN'`, [enquiry_id]);
    }

    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Accept quotation → creates a deal
quotationsRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const fields = req.body;
    const sets = Object.keys(fields).map((k, i) => `${k}=$${i+2}`).join(', ');
    const result = await query(
      `UPDATE quotations SET ${sets}, updated_at=NOW() WHERE id=$1 OR quotation_no=$1 RETURNING *`,
      [req.params.id, ...Object.values(fields)]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

quotationsRouter.post('/:id/accept', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const qtRes = await query(`
      SELECT q.*,
        e.supplier_id as enq_supplier_id, e.customer_id as enq_customer_id,
        e.deal_type, e.direction, e.incoterms as enq_incoterms,
        e.origin, e.destination, e.enquiry_no
      FROM quotations q LEFT JOIN enquiries e ON e.id=q.enquiry_id
      WHERE q.id=$1 OR q.quotation_no=$1
    `, [req.params.id]);
    if (!qtRes.rows.length) return res.status(404).json({ error: 'Quotation not found' });
    const qt = qtRes.rows[0];
    if (qt.status === 'CONVERTED') return res.status(400).json({ error: 'Already converted to a deal' });

    // Auto-generate deal number — sequential
    const yr = new Date().getFullYear();
    const dealCount = await query(`SELECT COUNT(*) FROM deals WHERE deal_no LIKE $1`, [`DL-${yr}-%`]);
    const dealNo = 'DL-' + yr + '-' + String(parseInt(dealCount.rows[0].count) + 1).padStart(3, '0');

    // Resolve fields — quotation values take priority over enquiry defaults
    const supplierId = qt.enq_supplier_id || null;
    const customerId = qt.customer_id || qt.enq_customer_id || null;
    const incoterms = qt.incoterms || qt.enq_incoterms || null;
    const direction = qt.direction || qt.quote_type === 'PQ' ? 'BUY' : 'SELL';

    const dealRes = await query(`
      INSERT INTO deals (deal_no, deal_date, enquiry_id, commodity_code, deal_type,
        qty_mt, supplier_id, customer_id, incoterms, origin, destination, direction,
        confirmed, confirmed_at, status)
      VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, NOW(), 'CONFIRMED') RETURNING *
    `, [dealNo, qt.enquiry_id, qt.commodity_code, qt.deal_type || 'BACK-TO-BACK',
        qt.qty_mt, qt.supplier_id||null, qt.customer_id]);

    const deal = dealRes.rows[0];

    // Update quotation status
    await query(`UPDATE quotations SET status='CONVERTED', deal_id=$1, updated_at=NOW() WHERE id=$2`,
      [deal.id, qt.id]);

    // Mark enquiry as CONVERTED
    if (qt.enquiry_id) {
      await query(`UPDATE enquiries SET status='CONVERTED' WHERE id=$1`, [qt.enquiry_id]);
    }

    res.json({ success: true, data: { quotation: qt, deal } });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.quotationsRouter = quotationsRouter;

// ── BUY LEGS ──────────────────────────────────────────────────────
const buyLegsRouter = require('express').Router();

buyLegsRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { deal_id } = req.query;
    let sql = `
      SELECT bl.*, cp.name as supplier_name
      FROM buy_legs bl
      LEFT JOIN counterparties cp ON cp.id = bl.supplier_id
      WHERE 1=1
    `;
    const params = [];
    if (deal_id) { params.push(deal_id); sql += ` AND bl.deal_id=$${params.length}`; }
    sql += ' ORDER BY bl.created_at ASC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

buyLegsRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { deal_id, supplier_id, commodity_code, qty_mt, incoterms,
      pricing_template, provisional_price, notes } = req.body;
    if (!deal_id || !commodity_code || !qty_mt) {
      return res.status(400).json({ error: 'deal_id, commodity_code and qty_mt required' });
    }
    // Auto-generate leg_ref
    const countRes = await query(`SELECT COUNT(*) FROM buy_legs WHERE deal_id=$1`, [deal_id]);
    const legNo = String(parseInt(countRes.rows[0].count) + 1).padStart(2, '0');
    const legRef = `BL-${legNo}`;
    const provCost = provisional_price && qty_mt ? (provisional_price * qty_mt).toFixed(2) : null;

    const result = await query(`
      INSERT INTO buy_legs (deal_id, leg_ref, supplier_id, commodity_code, qty_mt,
        incoterms, pricing_template, provisional_price, provisional_cost, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT') RETURNING *
    `, [deal_id, legRef, supplier_id||null, commodity_code, qty_mt,
        incoterms||'CIF', pricing_template||null, provisional_price||null, provCost, notes||null]);

    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

buyLegsRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const fields = req.body;
    const sets = Object.keys(fields).map((k, i) => `${k}=$${i+2}`).join(',');
    const result = await query(`UPDATE buy_legs SET ${sets} WHERE id=$1 RETURNING *`,
      [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.buyLegsRouter = buyLegsRouter;

// ── QUOTATION ADJUSTMENT LINES ─────────────────────────────────
const adjLinesRouter = require('express').Router();

adjLinesRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { quotation_id } = req.query;
    const result = await query(
      `SELECT * FROM quotation_adjustment_lines WHERE quotation_id=$1 ORDER BY line_no`,
      [quotation_id]
    );
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

adjLinesRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { quotation_id, adj_code, description, adj_type, basis, rate, uom, notes } = req.body;
    if (!quotation_id) return res.status(400).json({ error: 'quotation_id required' });
    const cntRes = await query(`SELECT COUNT(*) FROM quotation_adjustment_lines WHERE quotation_id=$1`, [quotation_id]);
    const lineNo = parseInt(cntRes.rows[0].count) + 1;
    const result = await query(
      `INSERT INTO quotation_adjustment_lines (quotation_id, line_no, adj_code, description, adj_type, basis, rate, uom, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [quotation_id, lineNo, adj_code||null, description||null, adj_type||'DEDUCTION', basis||'per-unit', rate||null, uom||'MT', notes||null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

adjLinesRouter.delete('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query(`DELETE FROM quotation_adjustment_lines WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.adjLinesRouter = adjLinesRouter;

// ── QUOTATION PENALTIES ────────────────────────────────────────
const penaltiesRouter = require('express').Router();

penaltiesRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { quotation_id } = req.query;
    const result = await query(
      `SELECT * FROM quotation_penalties WHERE quotation_id=$1 ORDER BY line_no`,
      [quotation_id]
    );
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

penaltiesRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { quotation_id, penalty_code, penalty_type, element, threshold, rate, direction, notes } = req.body;
    if (!quotation_id) return res.status(400).json({ error: 'quotation_id required' });
    const cntRes = await query(`SELECT COUNT(*) FROM quotation_penalties WHERE quotation_id=$1`, [quotation_id]);
    const lineNo = parseInt(cntRes.rows[0].count) + 1;
    const result = await query(
      `INSERT INTO quotation_penalties (quotation_id, line_no, penalty_code, penalty_type, element, threshold, rate, direction, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [quotation_id, lineNo, penalty_code||null, penalty_type||'FLAT-RATE', element||null, threshold||null, rate||null, direction||'OUT', notes||null]
    );
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

penaltiesRouter.delete('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query(`DELETE FROM quotation_penalties WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.penaltiesRouter = penaltiesRouter;
