// ── DEALS ─────────────────────────────────────────────────────────
const dealsRouter = require('express').Router();
const { query, logAudit } = require('../db');

dealsRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT 
        d.id, d.deal_no, d.deal_date, d.commodity_code, d.deal_type,
        d.qty_mt, d.supplier_id, d.customer_id, d.confirmed, d.incoterms,
        d.confirmed_at, d.status, d.notes, d.created_at,
        s.name as supplier_name,
        c.name as customer_name,
        cm.name as commodity_name,
        cm.uom as commodity_uom
      FROM deals d
      LEFT JOIN counterparties s ON s.id = d.supplier_id
      LEFT JOIN counterparties c ON c.id = d.customer_id
      LEFT JOIN commodities cm ON cm.code = d.commodity_code
      ORDER BY d.deal_date DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/deals — direct deal creation (Path B: known counterparty, repeat trade, no RFQ/Quote)
// Single-deal GET — was missing entirely; openDealDetail() relied on fetching the whole
// list and filtering client-side, which works for display fields but excludes budget_*
// since the list endpoint uses an explicit column list, not SELECT *.
dealsRouter.get('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT d.*, s.name as supplier_name, c.name as customer_name,
        cm.name as commodity_name, cm.uom as commodity_uom,
        lp.name as budget_loading_port_name, dp.name as budget_destination_port_name,
        dl.name as budget_delivery_location_name
      FROM deals d
      LEFT JOIN counterparties s ON s.id = d.supplier_id
      LEFT JOIN counterparties c ON c.id = d.customer_id
      LEFT JOIN commodities cm ON cm.code = d.commodity_code
      LEFT JOIN locations lp ON lp.id = d.budget_loading_port
      LEFT JOIN locations dp ON dp.id = d.budget_destination_port
      LEFT JOIN locations dl ON dl.id = d.budget_delivery_location
      WHERE d.id=$1 OR d.deal_no=$1
    `, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Deal not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

dealsRouter.post('/', async (req, res) => {
  try {
    const { commodity_code, qty_mt, supplier_id, customer_id, incoterms, origin, destination, notes } = req.body;
    if (!commodity_code || !qty_mt) {
      return res.status(400).json({ success: false, error: 'commodity_code and qty_mt are required' });
    }
    if (!supplier_id && !customer_id) {
      return res.status(400).json({ success: false, error: 'At least one counterparty (supplier or customer) is required — an open one-sided deal is allowed, but needs at least one leg' });
    }

    // Auto-generate deal number — same series as Deal Basket / Quotation accept
    const yr = new Date().getFullYear();
    const cnt = await query(`SELECT COUNT(*) FROM deals WHERE deal_no LIKE $1`, [`DL-${yr}-%`]);
    const dealNo = 'DL-' + yr + '-' + String(parseInt(cnt.rows[0].count)+1).padStart(3,'0');

    const direction = supplier_id && customer_id ? 'BOTH' : supplier_id ? 'BUY' : 'SELL';

    const result = await query(`
      INSERT INTO deals (deal_no, deal_date, commodity_code, qty_mt, supplier_id, customer_id,
        incoterms, origin, destination, direction, notes, status)
      VALUES ($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,$10,'DRAFT') RETURNING *
    `, [dealNo, commodity_code, qty_mt, supplier_id||null, customer_id||null,
        incoterms||null, origin||null, destination||null, direction, notes||null]);

    const deal = result.rows[0];
    await logAudit('deal', deal.id, deal.deal_no, 'CREATE', null, null, 'Created directly — known counterparty, no RFQ/Quote (Path B)');

    res.json({ success: true, data: deal });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// Group D (final) — Deal Budgeting: generic PATCH for budgeting parameters, plus the
// pre-existing simple budget_buy/sell fields that previously had no UI writing to them.
dealsRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = [
      'budget_buy_qty', 'budget_buy_price', 'budget_sell_qty', 'budget_sell_price', 'budget_margin', 'budget_locked_at',
      'budget_month_of_shipping', 'budget_shipment_term', 'budget_loading_port', 'budget_destination_port',
      'budget_shipment_cost', 'budget_clearance_cost', 'budget_process_type', 'budget_bom_notes',
      'budget_packing_type', 'budget_packing_cost', 'budget_delivery_location', 'budget_delivery_cost',
      'budget_payment_terms', 'budget_finance_cost', 'budget_hedging_cost',
      'commodity_code', 'qty_mt', 'supplier_id', 'customer_id', 'incoterms', 'origin', 'destination', 'notes'
    ];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 2); }).join(',');
    const result = await query(`UPDATE deals SET ${sets} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

dealsRouter.patch('/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes, confirmed_at } = req.body || {};
    const before = await query('SELECT status, deal_no FROM deals WHERE id=$1', [id]);
    const result = await query(`
      UPDATE deals SET confirmed=TRUE, confirmed_at=COALESCE($2::timestamptz, NOW()),
        status='CONFIRMED', notes=COALESCE($3, notes) WHERE id=$1 RETURNING *
    `, [id, confirmed_at || null, notes || null]);
    if (result.rows[0]) {
      await logAudit('deal', id, result.rows[0].deal_no, 'CONFIRM', 'status', before.rows[0]?.status, 'CONFIRMED');
    }
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
  res.set('Cache-Control', 'no-store');
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
  res.set('Cache-Control', 'no-store');
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
    const { deal_id, trade_date, hedge_type, commodity_code, exchange_code, instrument,
      qty_mt, entry_price, prompt_date, order_type = 'MARKET', counterparty_ref,
      broker_contract_note, notes } = req.body;
    if (!deal_id || !hedge_type || !commodity_code || !qty_mt || !entry_price) {
      return res.status(400).json({ error: 'deal_id, hedge_type, commodity_code, qty_mt and entry_price are required' });
    }

    // Auto-generate req_ref — same pattern as other entities
    const cnt = await query(`SELECT COUNT(*) FROM hedges WHERE req_ref LIKE 'REQ-%'`);
    const reqRef = 'REQ-' + String(parseInt(cnt.rows[0].count) + 1).padStart(3, '0');

    const result = await query(`
      INSERT INTO hedges (req_ref, deal_id, trade_date, hedge_type, commodity_code, instrument,
        exchange_code, qty_mt, entry_price, prompt_date, order_type, counterparty_ref,
        broker_contract_note, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'PENDING') RETURNING *
    `, [reqRef, deal_id, trade_date, hedge_type, commodity_code, instrument || 'FUTURES',
        exchange_code, qty_mt, entry_price, prompt_date, order_type, counterparty_ref || null,
        broker_contract_note || null, notes || null]);

    const hedge = result.rows[0];
    await logAudit('hedge', hedge.id, hedge.req_ref, 'CREATE', null, null,
      hedge_type + ' ' + qty_mt + ' MT ' + commodity_code + ' requisition sent to Treasury');

    res.json({ success: true, data: hedge });
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
      pricing_intent, status, created_by, notes, uom_override } = req.body;
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
        pricing_intent, status, created_by, notes, uom_override)
      VALUES ($1,COALESCE($2::date,CURRENT_DATE),$3,$4,$5,$6,$7,$8,$9,$10,$11,
              COALESCE($12,'OPEN'),$13,$14,$15) RETURNING *
    `, [enqNo, enquiry_date||null, commodity_code, deal_type||'BACK-TO-BACK', qty_mt,
        supplier_id||null, customer_id||null, incoterms||null,
        origin||null, destination||null, pricing_intent||null,
        status, created_by||null, notes||null, uom_override||null]);
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

// POST /api/quotations/:id/new-version — create v2/v3, mark old as SUPERSEDED
quotationsRouter.post('/:id/new-version', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const curRes = await query(`SELECT * FROM quotations WHERE id=$1 OR quotation_no=$1`, [req.params.id]);
    if (!curRes.rows.length) return res.status(404).json({ error: 'Quotation not found' });
    const q = curRes.rows[0];

    await query(`UPDATE quotations SET status='SUPERSEDED' WHERE id=$1`, [q.id]);

    const baseNo = q.quotation_no.replace(/-V\d+$/, '');
    const newVersion = (q.version || 1) + 1;
    const newNo = baseNo + '-V' + newVersion;

    const result = await query(`
      INSERT INTO quotations (
        quotation_no, enquiry_id, quotation_date, commodity_code, customer_id,
        qty_mt, incoterms, port_of_discharge, delivery_from, delivery_to,
        validity_date, pricing_template, provisional_price, provisional_value,
        quoted_by, status, version, parent_quotation_id, quote_type, notes
      )
      VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'OPEN',$15,$16,$17,$18)
      RETURNING *
    `, [
      newNo, q.enquiry_id, q.commodity_code, q.customer_id,
      q.qty_mt, q.incoterms, q.port_of_discharge, q.delivery_from, q.delivery_to,
      q.validity_date, q.pricing_template, q.provisional_price, q.provisional_value,
      q.quoted_by, newVersion, q.id, q.quote_type, req.body.notes || q.notes
    ]);

    await logAudit('quotation', q.id, q.quotation_no, 'NEW_VERSION', 'status', 'OPEN', 'SUPERSEDED');
    await logAudit('quotation', result.rows[0].id, newNo, 'CREATE', null, null, 'v'+newVersion+' created from '+q.quotation_no);

    res.json({ success: true, data: result.rows[0], superseded: q.quotation_no, new_version: newVersion });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// GET /api/quotations/:no/versions — all versions of a quotation chain
quotationsRouter.get('/:no/versions', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const baseNo = req.params.no.replace(/-V\d+$/, '');
    const result = await query(`
      SELECT q.*, cp.name as customer_name, cm.name as commodity_name
      FROM quotations q
      LEFT JOIN counterparties cp ON cp.id = q.customer_id
      LEFT JOIN commodities cm ON cm.code = q.commodity_code
      WHERE q.quotation_no LIKE $1 OR q.quotation_no = $2
      ORDER BY q.version ASC
    `, [baseNo + '-%', baseNo]);
    res.json({ success: true, data: result.rows });
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

    // ── CREDIT LIMIT CHECK — only relevant for Sales Quotes (customer exposure) ──
    if (qt.quote_type === 'SQ' && customerId && !req.body.override_credit) {
      const { getCreditExposure } = require('../db');
      const exposure = await getCreditExposure(customerId);
      if (exposure && exposure.limit_set) {
        const thisDealValue = parseFloat(qt.provisional_value) || (parseFloat(qt.qty_mt||0) * parseFloat(qt.provisional_price||0));
        const projectedUsed = exposure.credit_used + thisDealValue;
        if (projectedUsed > exposure.credit_limit) {
          return res.status(409).json({
            error: 'credit_limit_exceeded',
            message: exposure.counterparty_name + ' would exceed their credit limit by accepting this quotation',
            credit_issues: [{
              counterparty_id: customerId, counterparty_name: exposure.counterparty_name,
              credit_limit: exposure.credit_limit, credit_used: exposure.credit_used,
              this_deal_value: Math.round(thisDealValue*100)/100,
              projected_used: Math.round(projectedUsed*100)/100,
              over_by: Math.round((projectedUsed - exposure.credit_limit)*100)/100
            }]
          });
        }
      }
    }

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

    await logAudit('quotation', qt.id, qt.quotation_no, 'ACCEPT', 'status', qt.status, 'CONVERTED');
    await logAudit('deal', deal.id, deal.deal_no, 'CREATE', null, null, 'Created from quotation ' + qt.quotation_no);

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

// ── DEAL-ENQUIRY LINKS ─────────────────────────────────────────
const dealEnqRouter = require('express').Router();

dealEnqRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { deal_id } = req.query;
    const result = await query(`
      SELECT de.*, e.enquiry_no, e.direction, e.commodity_code, e.qty_mt,
        e.incoterms, e.status as enq_status,
        s.name as supplier_name, c.name as customer_name,
        cm.name as commodity_name, cm.uom
      FROM deal_enquiries de
      JOIN enquiries e ON e.id = de.enquiry_id
      LEFT JOIN counterparties s ON s.id = e.supplier_id
      LEFT JOIN counterparties c ON c.id = e.customer_id
      LEFT JOIN commodities cm ON cm.code = e.commodity_code
      WHERE de.deal_id = $1
      ORDER BY de.leg_role, de.added_at
    `, [deal_id]);
    res.json({ success: true, data: result.rows });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

dealEnqRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { deal_id, enquiry_id, leg_role } = req.body;
    if (!deal_id || !enquiry_id) return res.status(400).json({ error: 'deal_id and enquiry_id required' });
    const result = await query(`
      INSERT INTO deal_enquiries (deal_id, enquiry_id, leg_role)
      VALUES ($1, $2, $3)
      ON CONFLICT (deal_id, enquiry_id) DO UPDATE SET leg_role = $3
      RETURNING *
    `, [deal_id, enquiry_id, leg_role || 'BUY']);
    await query(`UPDATE enquiries SET status='CONVERTED' WHERE id=$1`, [enquiry_id]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

dealEnqRouter.delete('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query(`DELETE FROM deal_enquiries WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.dealEnqRouter = dealEnqRouter;

// ── RFQ ROUTER ─────────────────────────────────────────────────
const rfqRouter = require('express').Router();

rfqRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { enquiry_id, status, direction } = req.query;
    let sql = `
      SELECT r.*,
        cp.name as counterparty_name, cp.code as counterparty_code,
        cm.name as commodity_name, cm.uom,
        e.enquiry_no, e.direction as enquiry_direction
      FROM rfqs r
      LEFT JOIN counterparties cp ON cp.id = r.counterparty_id
      LEFT JOIN commodities cm ON cm.code = r.commodity_code
      LEFT JOIN enquiries e ON e.id = r.enquiry_id
      WHERE 1=1`;
    const params = [];
    if (enquiry_id) { params.push(enquiry_id); sql += ` AND r.enquiry_id=$${params.length}`; }
    if (status)     { params.push(status);     sql += ` AND r.status=$${params.length}`; }
    if (direction)  { params.push(direction);  sql += ` AND r.direction=$${params.length}`; }
    sql += ' ORDER BY r.created_at DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

rfqRouter.get('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT r.*,
        cp.name as counterparty_name, cp.code as counterparty_code,
        cm.name as commodity_name, cm.uom,
        e.enquiry_no, e.direction as enquiry_direction,
        (SELECT json_agg(qr.* ORDER BY qr.created_at)
         FROM quote_responses qr WHERE qr.rfq_id = r.id) as responses
      FROM rfqs r
      LEFT JOIN counterparties cp ON cp.id = r.counterparty_id
      LEFT JOIN commodities cm ON cm.code = r.commodity_code
      LEFT JOIN enquiries e ON e.id = r.enquiry_id
      WHERE r.id=$1 OR r.rfq_no=$1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'RFQ not found' });
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

rfqRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { enquiry_id, direction, counterparty_id, commodity_code, qty_mt,
      required_delivery, incoterms, origin, destination, pricing_basis,
      payment_terms, validity_date, notes } = req.body;
    if (!direction || !counterparty_id) return res.status(400).json({ error: 'direction and counterparty_id required' });
    const prefix = direction === 'CUSTOMER' ? 'RFQ-S' : 'RFQ-V';
    const yr = new Date().getFullYear();
    const cnt = await query(`SELECT COUNT(*) FROM rfqs WHERE rfq_no LIKE $1`, [`${prefix}-${yr}-%`]);
    const rfqNo = `${prefix}-${yr}-${String(parseInt(cnt.rows[0].count)+1).padStart(3,'0')}`;
    const result = await query(`
      INSERT INTO rfqs (rfq_no, enquiry_id, direction, counterparty_id, commodity_code,
        qty_mt, required_delivery, incoterms, origin, destination, pricing_basis,
        payment_terms, validity_date, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'DRAFT') RETURNING *`,
      [rfqNo, enquiry_id||null, direction, counterparty_id, commodity_code||null,
       qty_mt||null, required_delivery||null, incoterms||null, origin||null,
       destination||null, pricing_basis||null, payment_terms||null, validity_date||null, notes||null]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

rfqRouter.patch('/:id/send', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(
      `UPDATE rfqs SET status='SENT', sent_at=NOW() WHERE id=$1 OR rfq_no=$1 RETURNING *`,
      [req.params.id]);
    if (result.rows[0]) await logAudit('rfq', result.rows[0].id, result.rows[0].rfq_no, 'SEND', 'status', 'DRAFT', 'SENT');
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

rfqRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['status','notes','validity_date','pricing_basis','payment_terms',
      'incoterms','required_delivery','qty_mt','destination','origin'];
    const fields = {};
    Object.keys(req.body).forEach(k => { if(allowed.includes(k)) fields[k]=req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true });
    const sets = Object.keys(fields).map((k,i) => `${k}=$${i+2}`).join(',');
    const result = await query(
      `UPDATE rfqs SET ${sets} WHERE id=$1 OR rfq_no=$1 RETURNING *`,
      [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.rfqRouter = rfqRouter;

// ── QUOTE RESPONSES ROUTER ────────────────────────────────────
const quoteResponseRouter = require('express').Router();

quoteResponseRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { rfq_id, enquiry_id, quote_type } = req.query;
    let sql = `
      SELECT qr.*,
        cp.name as counterparty_name,
        cm.name as commodity_name, cm.uom,
        r.rfq_no, r.direction
      FROM quote_responses qr
      LEFT JOIN counterparties cp ON cp.id = qr.counterparty_id
      LEFT JOIN commodities cm ON cm.code = qr.commodity_code
      LEFT JOIN rfqs r ON r.id = qr.rfq_id
      WHERE 1=1`;
    const params = [];
    if (rfq_id)      { params.push(rfq_id);      sql += ` AND qr.rfq_id=$${params.length}`; }
    if (enquiry_id)  { params.push(enquiry_id);  sql += ` AND qr.enquiry_id=$${params.length}`; }
    if (quote_type)  { params.push(quote_type);  sql += ` AND qr.quote_type=$${params.length}`; }
    sql += ' ORDER BY qr.created_at DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

quoteResponseRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { rfq_id, enquiry_id, quote_type, counterparty_id, commodity_code,
      offered_qty, offered_price, price_basis, delivery_date, delivery_window,
      incoterms, payment_terms, validity_date, notes } = req.body;
    if (!quote_type || !counterparty_id) return res.status(400).json({ error: 'quote_type and counterparty_id required' });
    const prefix = quote_type === 'SQ' ? 'SQ' : 'PQ';
    const yr = new Date().getFullYear();
    const cnt = await query(`SELECT COUNT(*) FROM quote_responses WHERE quote_type=$1 AND response_no LIKE $2`,
      [quote_type, `${prefix}-${yr}-%`]);
    const respNo = `${prefix}-${yr}-${String(parseInt(cnt.rows[0].count)+1).padStart(3,'0')}`;
    const result = await query(`
      INSERT INTO quote_responses (response_no, rfq_id, enquiry_id, quote_type, counterparty_id,
        commodity_code, offered_qty, offered_price, price_basis, delivery_date, delivery_window,
        incoterms, payment_terms, validity_date, notes, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'RECEIVED') RETURNING *`,
      [respNo, rfq_id||null, enquiry_id||null, quote_type, counterparty_id,
       commodity_code||null, offered_qty||null, offered_price||null, price_basis||null,
       delivery_date||null, delivery_window||null, incoterms||null, payment_terms||null,
       validity_date||null, notes||null]);
    // Update RFQ status to RESPONDED
    if (rfq_id) await query(`UPDATE rfqs SET status='RESPONDED' WHERE id=$1 AND status='SENT'`, [rfq_id]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

quoteResponseRouter.patch('/:id/select', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(
      `UPDATE quote_responses SET status='SELECTED' WHERE id=$1 RETURNING *`, [req.params.id]);
    if (result.rows[0]) await logAudit('quote_response', result.rows[0].id, result.rows[0].response_no, 'SELECT', 'status', 'RECEIVED', 'SELECTED');
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

quoteResponseRouter.patch('/:id/decline', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(
      `UPDATE quote_responses SET status='DECLINED' WHERE id=$1 RETURNING *`, [req.params.id]);
    if (result.rows[0]) await logAudit('quote_response', result.rows[0].id, result.rows[0].response_no, 'DECLINE', 'status', 'RECEIVED', 'DECLINED');
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.quoteResponseRouter = quoteResponseRouter;

// ── DEAL BASKET → CREATE ONE DEAL FROM MULTIPLE ENQUIRIES/RESPONSES ──
const feasibilityRouter = require('express').Router();

// GET /api/feasibility/basket — ALL currently-selected, not-yet-converted responses
// across ANY enquiry. This is the global basket the trader builds before booking one deal.
feasibilityRouter.get('/basket', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const responsesRes = await query(`
      SELECT qr.*, cp.name as counterparty_name,
        r.rfq_no, r.direction as rfq_direction,
        e.enquiry_no, e.direction as enquiry_direction, e.commodity_code as enq_commodity_code,
        cm.name as commodity_name, cm.uom
      FROM quote_responses qr
      LEFT JOIN counterparties cp ON cp.id = qr.counterparty_id
      LEFT JOIN rfqs r ON r.id = qr.rfq_id
      LEFT JOIN enquiries e ON e.id = qr.enquiry_id
      LEFT JOIN commodities cm ON cm.code = qr.commodity_code
      WHERE qr.status = 'SELECTED' AND qr.deal_id IS NULL
      ORDER BY qr.quote_type, qr.offered_price ASC
    `);
    const responses = responsesRes.rows;
    const pqSelected = responses.filter(r => r.quote_type === 'PQ');
    const sqSelected = responses.filter(r => r.quote_type === 'SQ');

    const buyQty = pqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0), 0);
    const buyValue = pqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0) * (parseFloat(r.offered_price)||0), 0);
    const buyAvgPrice = buyQty > 0 ? buyValue / buyQty : 0;

    const sellQty = sqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0), 0);
    const sellValue = sqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0) * (parseFloat(r.offered_price)||0), 0);
    const sellAvgPrice = sellQty > 0 ? sellValue / sellQty : 0;

    const margin = sellValue - buyValue;

    // Distinct enquiries involved — these will all get linked to the deal on confirm
    const enquiryIds = [...new Set(responses.map(r => r.enquiry_id).filter(Boolean))];

    res.json({
      success: true,
      data: {
        all_responses: responses,
        selected_pq: pqSelected,
        selected_sq: sqSelected,
        enquiry_count: enquiryIds.length,
        summary: {
          buy_qty: buyQty, buy_value: buyValue, buy_avg_price: buyAvgPrice,
          sell_qty: sellQty, sell_value: sellValue, sell_avg_price: sellAvgPrice,
          margin: margin,
          qty_balanced: Math.abs(buyQty - sellQty) < 0.01
        }
      }
    });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/feasibility/basket/remove/:responseId — take one response out of the basket
feasibilityRouter.post('/basket/remove/:responseId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query(`UPDATE quote_responses SET status='RECEIVED' WHERE id=$1 AND deal_id IS NULL`, [req.params.responseId]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

// POST /api/feasibility/basket/confirm — create ONE deal from everything in the basket,
// linking every distinct enquiry involved (covers many-customers + many-vendors → one deal)
feasibilityRouter.post('/basket/confirm', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const responsesRes = await query(`
      SELECT qr.*, e.direction as enquiry_direction, e.incoterms as enq_incoterms
      FROM quote_responses qr
      LEFT JOIN enquiries e ON e.id = qr.enquiry_id
      WHERE qr.status = 'SELECTED' AND qr.deal_id IS NULL
    `);
    const selected = responsesRes.rows;
    if (!selected.length) return res.status(400).json({ error: 'Basket is empty — select at least one PQ and one SQ response first' });

    const pqSelected = selected.filter(r => r.quote_type === 'PQ');
    const sqSelected = selected.filter(r => r.quote_type === 'SQ');
    if (!pqSelected.length || !sqSelected.length) {
      return res.status(400).json({ error: 'Basket needs at least one Purchase Quote (PQ) and one Sales Quote (SQ) to form a deal' });
    }

    const buyQty = pqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0), 0);
    const buyValue = pqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0) * (parseFloat(r.offered_price)||0), 0);
    const buyAvgPrice = buyQty > 0 ? buyValue / buyQty : 0;
    const sellQty = sqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0), 0);
    const sellValue = sqSelected.reduce((s,r) => s + (parseFloat(r.offered_qty)||0) * (parseFloat(r.offered_price)||0), 0);
    const sellAvgPrice = sellQty > 0 ? sellValue / sellQty : 0;
    const margin = sellValue - buyValue;

    // ── CREDIT LIMIT CHECK — block if any customer in the SELL side is over their limit ──
    if (!req.body.override_credit) {
      const { getCreditExposure } = require('../db');
      const customerIds = [...new Set(sqSelected.map(r => r.counterparty_id).filter(Boolean))];
      const creditIssues = [];
      for (const cid of customerIds) {
        const custSellValue = sqSelected.filter(r => r.counterparty_id === cid)
          .reduce((s,r) => s + (parseFloat(r.offered_qty)||0) * (parseFloat(r.offered_price)||0), 0);
        const exposure = await getCreditExposure(cid);
        if (exposure && exposure.limit_set) {
          const projectedUsed = exposure.credit_used + custSellValue;
          if (projectedUsed > exposure.credit_limit) {
            creditIssues.push({
              counterparty_id: cid,
              counterparty_name: exposure.counterparty_name,
              credit_limit: exposure.credit_limit,
              credit_used: exposure.credit_used,
              this_deal_value: Math.round(custSellValue*100)/100,
              projected_used: Math.round(projectedUsed*100)/100,
              over_by: Math.round((projectedUsed - exposure.credit_limit)*100)/100
            });
          }
        }
      }
      if (creditIssues.length) {
        return res.status(409).json({
          error: 'credit_limit_exceeded',
          message: 'This deal would exceed the credit limit for ' + creditIssues.length + ' customer(s)',
          credit_issues: creditIssues
        });
      }
    }

    // Use the commodity from the first PQ (all basket items should typically be same commodity)
    const commodityCode = pqSelected[0]?.commodity_code || sqSelected[0]?.commodity_code;
    const incoterms = sqSelected[0]?.enq_incoterms || pqSelected[0]?.enq_incoterms || null;

    const yr = new Date().getFullYear();
    const cnt = await query(`SELECT COUNT(*) FROM deals WHERE deal_no LIKE $1`, [`DL-${yr}-%`]);
    const dealNo = 'DL-' + yr + '-' + String(parseInt(cnt.rows[0].count)+1).padStart(3,'0');

    const dealRes = await query(`
      INSERT INTO deals (deal_no, deal_date, commodity_code, qty_mt,
        incoterms, budget_buy_qty, budget_buy_price, budget_sell_qty,
        budget_sell_price, budget_margin, budget_locked_at, confirmed, confirmed_at, status)
      VALUES ($1,NOW(),$2,$3,$4,$5,$6,$7,$8,$9,NOW(),TRUE,NOW(),'CONFIRMED')
      RETURNING *
    `, [dealNo, commodityCode, sellQty||buyQty, incoterms,
        buyQty, buyAvgPrice, sellQty, sellAvgPrice, margin]);

    const deal = dealRes.rows[0];

    // Link EVERY distinct enquiry involved — covers 2 customers + 3 vendors → 1 deal
    const enquiryIds = [...new Set(selected.map(r => r.enquiry_id).filter(Boolean))];
    for (const eid of enquiryIds) {
      const enqResponses = selected.filter(r => r.enquiry_id === eid);
      const legRole = enqResponses[0]?.enquiry_direction === 'SELL' ? 'SELL' : 'BUY';
      await query(`
        INSERT INTO deal_enquiries (deal_id, enquiry_id, leg_role)
        VALUES ($1,$2,$3) ON CONFLICT DO NOTHING
      `, [deal.id, eid, legRole]);
      await query(`UPDATE enquiries SET status='CONVERTED' WHERE id=$1`, [eid]);
    }

    // Mark every response in the basket as CONVERTED and tag with this deal
    for (const r of selected) {
      await query(`UPDATE quote_responses SET status='CONVERTED', deal_id=$1 WHERE id=$2`, [deal.id, r.id]);
    }

    await logAudit('deal', deal.id, deal.deal_no, 'CREATE', null, null,
      'Created from Deal Basket: '+enquiryIds.length+' enquiries, '+pqSelected.length+' PQ, '+sqSelected.length+' SQ');

    res.json({
      success: true,
      data: deal,
      summary: { buyQty, buyAvgPrice, sellQty, sellAvgPrice, margin },
      enquiries_linked: enquiryIds.length,
      legs: { buy: pqSelected.length, sell: sqSelected.length }
    });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.feasibilityRouter = feasibilityRouter;

// GET /api/deals/:id/budget-actual — budget (locked) vs actual (computed live)
const budgetActualRouter = require('express').Router();
budgetActualRouter.get('/:id/budget-actual', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const dealRes = await query(`SELECT * FROM deals WHERE id=$1 OR deal_no=$1`, [req.params.id]);
    if (!dealRes.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const deal = dealRes.rows[0];

    // Actual = from confirmed contracts linked to this deal
    const contractsRes = await query(`
      SELECT contract_type, qty_mt, provisional_price
      FROM contracts WHERE deal_id=$1 AND status IN ('CONTRACTED','CONFIRMED')
    `, [deal.id]);
    const contracts = contractsRes.rows;
    const pcs = contracts.filter(c => c.contract_type === 'PC');
    const scs = contracts.filter(c => c.contract_type === 'SC');

    const actualBuyQty = pcs.reduce((s,c) => s + (parseFloat(c.qty_mt)||0), 0);
    const actualBuyValue = pcs.reduce((s,c) => s + (parseFloat(c.qty_mt)||0) * (parseFloat(c.provisional_price)||0), 0);
    const actualBuyPrice = actualBuyQty > 0 ? actualBuyValue / actualBuyQty : 0;

    const actualSellQty = scs.reduce((s,c) => s + (parseFloat(c.qty_mt)||0), 0);
    const actualSellValue = scs.reduce((s,c) => s + (parseFloat(c.qty_mt)||0) * (parseFloat(c.provisional_price)||0), 0);
    const actualSellPrice = actualSellQty > 0 ? actualSellValue / actualSellQty : 0;

    const actualMargin = actualSellValue - actualBuyValue;

    res.json({
      success: true,
      data: {
        budget: {
          buy_qty: deal.budget_buy_qty, buy_price: deal.budget_buy_price,
          sell_qty: deal.budget_sell_qty, sell_price: deal.budget_sell_price,
          margin: deal.budget_margin, locked_at: deal.budget_locked_at
        },
        actual: {
          buy_qty: actualBuyQty, buy_price: actualBuyPrice,
          sell_qty: actualSellQty, sell_price: actualSellPrice,
          margin: actualMargin
        }
      }
    });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.budgetActualRouter = budgetActualRouter;

// ── GLOBAL SEARCH ────────────────────────────────────────────────
const searchRouter = require('express').Router();
searchRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json({ success: true, data: [] });
  const like = '%' + q + '%';
  try {
    const [enq, rfq, quot, deal, pc, sc] = await Promise.all([
      query(`SELECT id, enquiry_no, direction, commodity_code, status FROM enquiries
             WHERE enquiry_no ILIKE $1 LIMIT 8`, [like]),
      query(`SELECT r.id, r.rfq_no, r.direction, r.status, cp.name as counterparty_name
             FROM rfqs r LEFT JOIN counterparties cp ON cp.id=r.counterparty_id
             WHERE r.rfq_no ILIKE $1 LIMIT 8`, [like]),
      query(`SELECT id, quotation_no, quote_type, status FROM quotations
             WHERE quotation_no ILIKE $1 LIMIT 8`, [like]),
      query(`SELECT id, deal_no, status, commodity_code FROM deals
             WHERE deal_no ILIKE $1 LIMIT 8`, [like]),
      query(`SELECT c.id, c.contract_no, c.status, cp.name as counterparty_name
             FROM contracts c LEFT JOIN counterparties cp ON cp.id=c.counterparty_id
             WHERE c.contract_type='PC' AND c.contract_no ILIKE $1 LIMIT 8`, [like]),
      query(`SELECT c.id, c.contract_no, c.status, cp.name as counterparty_name
             FROM contracts c LEFT JOIN counterparties cp ON cp.id=c.counterparty_id
             WHERE c.contract_type='SC' AND c.contract_no ILIKE $1 LIMIT 8`, [like]),
    ]);

    const results = [];
    enq.rows.forEach(r => results.push({ type: 'Enquiry', id: r.id, no: r.enquiry_no, label: r.enquiry_no, sub: (r.direction||'') + ' · ' + (r.commodity_code||'') + ' · ' + (r.status||'') }));
    rfq.rows.forEach(r => results.push({ type: 'RFQ', id: r.id, no: r.rfq_no, label: r.rfq_no, sub: (r.direction||'') + ' · ' + (r.counterparty_name||'') + ' · ' + (r.status||'') }));
    quot.rows.forEach(r => results.push({ type: 'Quotation', id: r.id, no: r.quotation_no, label: r.quotation_no, sub: (r.quote_type||'') + ' · ' + (r.status||'') }));
    deal.rows.forEach(r => results.push({ type: 'Deal', id: r.id, no: r.deal_no, label: r.deal_no, sub: (r.commodity_code||'') + ' · ' + (r.status||'') }));
    pc.rows.forEach(r => results.push({ type: 'Purchase Contract', id: r.id, no: r.contract_no, label: r.contract_no, sub: (r.counterparty_name||'') + ' · ' + (r.status||'') }));
    sc.rows.forEach(r => results.push({ type: 'Sales Contract', id: r.id, no: r.contract_no, label: r.contract_no, sub: (r.counterparty_name||'') + ' · ' + (r.status||'') }));

    res.json({ success: true, data: results });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.searchRouter = searchRouter;

// ── AUDIT LOG ────────────────────────────────────────────────────
const auditRouter = require('express').Router();
auditRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { entity_type, entity_id, limit } = req.query;
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params = [];
    if (entity_type) { params.push(entity_type); sql += ` AND entity_type=$${params.length}`; }
    if (entity_id)   { params.push(entity_id);   sql += ` AND entity_id=$${params.length}`; }
    sql += ' ORDER BY changed_at DESC';
    params.push(parseInt(limit) || 50);
    sql += ` LIMIT $${params.length}`;
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.auditRouter = auditRouter;

// GET /api/credit/:counterpartyId — credit exposure check
const creditRouter = require('express').Router();
creditRouter.get('/:counterpartyId', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { getCreditExposure } = require('../db');
    const data = await getCreditExposure(req.params.counterpartyId);
    if (!data) return res.status(404).json({ error: 'Counterparty not found' });
    res.json({ success: true, data });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.creditRouter = creditRouter;

// ── GOODS RECEIPTS (Provisional / Final) ─────────────────────────
const goodsReceiptRouter = require('express').Router();

goodsReceiptRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { stage } = req.query;
    let sql = `
      SELECT gr.*, l.log_no, l.vessel_name, c.contract_no, w.name as warehouse_name,
        (SELECT COUNT(*) FROM lots lo WHERE lo.receipt_id = gr.id) as lot_count
      FROM goods_receipts gr
      LEFT JOIN logistics l ON l.id = gr.logistics_id
      LEFT JOIN contracts c ON c.id = l.contract_id
      LEFT JOIN locations w ON w.id = gr.warehouse_id
      WHERE 1=1`;
    const params = [];
    if (stage) { params.push(stage); sql += ` AND gr.receipt_stage=$${params.length}`; }
    sql += ' ORDER BY gr.created_at DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

goodsReceiptRouter.get('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const grRes = await query(`
      SELECT gr.*, l.log_no, l.vessel_name, l.contract_id, c.contract_no, w.name as warehouse_name
      FROM goods_receipts gr
      LEFT JOIN logistics l ON l.id = gr.logistics_id
      LEFT JOIN contracts c ON c.id = l.contract_id
      LEFT JOIN locations w ON w.id = gr.warehouse_id
      WHERE gr.id=$1 OR gr.receipt_no=$1
    `, [req.params.id]);
    if (!grRes.rows.length) return res.status(404).json({ error: 'Receipt not found' });
    const lotsRes = await query(`SELECT * FROM lots WHERE receipt_id=$1 ORDER BY lot_no`, [grRes.rows[0].id]);
    res.json({ success: true, data: { ...grRes.rows[0], lots: lotsRes.rows } });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

goodsReceiptRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { logistics_id, receipt_stage, receipt_date, arrived_qty_mt, warehouse_id, notes } = req.body;
    if (!logistics_id) return res.status(400).json({ error: 'logistics_id is required — link to the shipment this receipt is for' });
    const stage = receipt_stage || 'PROVISIONAL';
    const prefix = stage === 'FINAL' ? 'GRN' : 'PR';
    const yr = new Date().getFullYear();
    const cnt = await query(`SELECT COUNT(*) FROM goods_receipts WHERE receipt_no LIKE $1`, [`${prefix}-%`]);
    const receiptNo = prefix + '-' + String(parseInt(cnt.rows[0].count) + 1).padStart(3, '0');
    const result = await query(`
      INSERT INTO goods_receipts (receipt_no, logistics_id, receipt_stage, receipt_date, arrived_qty_mt, warehouse_id, status, notes)
      VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING *
    `, [receiptNo, logistics_id, stage, receipt_date || new Date().toISOString().split('T')[0], arrived_qty_mt || null, warehouse_id || null, notes || null]);
    const receipt = result.rows[0];
    await logAudit('goods_receipt', receipt.id, receipt.receipt_no, 'CREATE', null, null, stage + ' receipt created');
    res.json({ success: true, data: receipt });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

goodsReceiptRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['receipt_date', 'arrived_qty_mt', 'warehouse_id', 'status', 'notes'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 2); }).join(',');
    const result = await query(`UPDATE goods_receipts SET ${sets} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.goodsReceiptRouter = goodsReceiptRouter;

// ── QC RESULTS / ASSAY ────────────────────────────────────────────
const qcResultsRouter = require('express').Router();

qcResultsRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT qr.*, lo.lot_no, lo.mrn_no, lo.commodity_code, cm.name as commodity_name
      FROM qc_results qr
      LEFT JOIN lots lo ON lo.id = qr.lot_id
      LEFT JOIN commodities cm ON cm.code = lo.commodity_code
      ORDER BY qr.created_at DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

qcResultsRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { lot_id, element, actual_value, unit, assay_date, lab_ref } = req.body;
    if (!lot_id || !element) return res.status(400).json({ error: 'lot_id and element are required' });
    const result = await query(`
      INSERT INTO qc_results (lot_id, element, actual_value, unit, assay_date, lab_ref, status)
      VALUES ($1,$2,$3,$4,$5,$6,'PENDING') RETURNING *
    `, [lot_id, element, actual_value || null, unit || '%', assay_date || new Date().toISOString().split('T')[0], lab_ref || null]);
    const qc = result.rows[0];
    await logAudit('qc_result', qc.id, element, 'CREATE', null, null, 'Assay entry created for lot ' + lot_id);
    res.json({ success: true, data: qc });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

qcResultsRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['actual_value', 'status', 'lab_ref', 'assay_date'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 2); }).join(',');
    const result = await query(`UPDATE qc_results SET ${sets} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

module.exports.qcResultsRouter = qcResultsRouter;

// ── LOTS (MRN lots — minimal lookup support for QC) ──────────────
const lotsRouter = require('express').Router();
lotsRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { lot_no, contract_id } = req.query;
    // Item 7 fix: support filtering lots by contract — joins through logistics since
    // lots link to logistics_id, and logistics links to contract_id. Needed to surface
    // real gross/tare/net weight on the PC/SC contract screens instead of nowhere.
    let sql = `
      SELECT lo.*, l.log_no, l.contract_id
      FROM lots lo
      LEFT JOIN logistics l ON l.id = lo.logistics_id
      WHERE 1=1`;
    const params = [];
    if (lot_no) { params.push(lot_no); sql += ` AND lo.lot_no=$${params.length}`; }
    if (contract_id) { params.push(contract_id); sql += ` AND l.contract_id=$${params.length}`; }
    sql += ' ORDER BY lo.id DESC';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.lotsRouter = lotsRouter;

// ── ADJUSTMENT CODES MASTER ───────────────────────────────────────
const adjCodesRouter = require('express').Router();
adjCodesRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`SELECT * FROM adjustment_codes WHERE active=TRUE ORDER BY category, code`);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
adjCodesRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { code, description, category, calc_type, default_direction, gl_account } = req.body;
    if (!code || !description) return res.status(400).json({ error: 'code and description are required' });
    const result = await query(`
      INSERT INTO adjustment_codes (code, description, category, calc_type, default_direction, gl_account)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [code, description, category || 'OTHER', calc_type || 'PCT_OF_VALUE', default_direction || 'DEDUCTION', gl_account || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
adjCodesRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['description', 'category', 'calc_type', 'default_direction', 'gl_account', 'active'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 2); }).join(',');
    const result = await query(`UPDATE adjustment_codes SET ${sets} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.adjCodesRouter = adjCodesRouter;

// ── INVOICE ADJUSTMENT LINES ──────────────────────────────────────
const invoiceAdjRouter = require('express').Router();
invoiceAdjRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { invoice_id } = req.query;
    const result = await query(`
      SELECT ial.*, ac.description as code_description, ac.category
      FROM invoice_adjustment_lines ial
      LEFT JOIN adjustment_codes ac ON ac.code = ial.adjustment_code
      WHERE ial.invoice_id=$1 ORDER BY ial.id
    `, [invoice_id]);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
invoiceAdjRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { invoice_id, adjustment_code, payable_component, calc_value, calc_unit, qty_basis, computed_amount, direction, notes } = req.body;
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id is required' });
    const result = await query(`
      INSERT INTO invoice_adjustment_lines (invoice_id, adjustment_code, payable_component, calc_value, calc_unit, qty_basis, computed_amount, direction, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [invoice_id, adjustment_code || null, payable_component || null, calc_value || null, calc_unit || null, qty_basis || null, computed_amount || null, direction || 'DEDUCTION', notes || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
invoiceAdjRouter.delete('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    await query(`DELETE FROM invoice_adjustment_lines WHERE id=$1`, [req.params.id]);
    res.json({ success: true });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.invoiceAdjRouter = invoiceAdjRouter;

// ── PRICING BENCHMARKS MASTER ─────────────────────────────────────
const pricingBenchmarksRouter = require('express').Router();
pricingBenchmarksRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { commodity_code } = req.query;
    let sql = `
      SELECT pb.*, cm.name as commodity_name
      FROM pricing_benchmarks pb
      LEFT JOIN commodities cm ON cm.code = pb.commodity_code
      WHERE pb.active=TRUE`;
    const params = [];
    if (commodity_code) { params.push(commodity_code); sql += ` AND pb.commodity_code=$${params.length}`; }
    sql += ' ORDER BY pb.code';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
pricingBenchmarksRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { code, description, commodity_code, exchange_code, reporting_agency,
      instrument_code, default_index_pct, default_payable_pct } = req.body;
    if (!code || !description || !exchange_code) {
      return res.status(400).json({ error: 'code, description and exchange_code are required' });
    }
    const result = await query(`
      INSERT INTO pricing_benchmarks (code, description, commodity_code, exchange_code,
        reporting_agency, instrument_code, default_index_pct, default_payable_pct)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *
    `, [code, description, commodity_code || null, exchange_code, reporting_agency || null,
        instrument_code || null, default_index_pct || 100, default_payable_pct || 100]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
pricingBenchmarksRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['description', 'commodity_code', 'exchange_code', 'reporting_agency',
      'instrument_code', 'default_index_pct', 'default_payable_pct', 'active'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 2); }).join(',');
    const result = await query(`UPDATE pricing_benchmarks SET ${sets} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.pricingBenchmarksRouter = pricingBenchmarksRouter;

// ── DATE EVENT MASTER (Group B) ──────────────────────────────────────
const dateEventMasterRouter = require('express').Router();
dateEventMasterRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query('SELECT * FROM date_event_master WHERE active=TRUE ORDER BY id');
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
dateEventMasterRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { code, name, source_system, offset_applicable } = req.body;
    if (!code || !name || !source_system) {
      return res.status(400).json({ error: 'code, name and source_system are required' });
    }
    const result = await query(`
      INSERT INTO date_event_master (code, name, source_system, offset_applicable)
      VALUES ($1,$2,$3,$4) RETURNING *
    `, [code, name, source_system, offset_applicable !== false]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
dateEventMasterRouter.patch('/:id', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const allowed = ['name', 'source_system', 'offset_applicable', 'active'];
    const fields = {};
    Object.keys(req.body).forEach(function(k) { if (allowed.includes(k)) fields[k] = req.body[k]; });
    if (!Object.keys(fields).length) return res.json({ success: true, data: null });
    const sets = Object.keys(fields).map(function(k, i) { return k + '=$' + (i + 2); }).join(',');
    const result = await query(`UPDATE date_event_master SET ${sets} WHERE id=$1 RETURNING *`, [req.params.id, ...Object.values(fields)]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.dateEventMasterRouter = dateEventMasterRouter;

// ── CURRENCY / UOM / TAX MASTER (A5 fix) ──────────────────────────────
const currencyMasterRouter = require('express').Router();
currencyMasterRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query('SELECT * FROM currencies ORDER BY is_base DESC, code');
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
currencyMasterRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { code, name, symbol, decimals } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const result = await query(`
      INSERT INTO currencies (code, name, symbol, decimals) VALUES ($1,$2,$3,$4) RETURNING *
    `, [code.toUpperCase(), name, symbol || null, decimals != null ? decimals : 2]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.currencyMasterRouter = currencyMasterRouter;

const uomMasterRouter = require('express').Router();
uomMasterRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query('SELECT * FROM uom_master WHERE active=TRUE ORDER BY category, code');
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
uomMasterRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { code, name, category, conversion } = req.body;
    if (!code || !name) return res.status(400).json({ error: 'code and name are required' });
    const result = await query(`
      INSERT INTO uom_master (code, name, category, conversion) VALUES ($1,$2,$3,$4) RETURNING *
    `, [code.toUpperCase(), name, category || null, conversion || '—']);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.uomMasterRouter = uomMasterRouter;

const taxCodeRouter = require('express').Router();
taxCodeRouter.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query('SELECT * FROM tax_codes WHERE active=TRUE ORDER BY code');
    res.json({ success: true, data: result.rows });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
taxCodeRouter.post('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { code, description, rate_pct, jurisdiction, applies_to } = req.body;
    if (!code || !description) return res.status(400).json({ error: 'code and description are required' });
    const result = await query(`
      INSERT INTO tax_codes (code, description, rate_pct, jurisdiction, applies_to) VALUES ($1,$2,$3,$4,$5) RETURNING *
    `, [code.toUpperCase(), description, rate_pct || 0, jurisdiction || null, applies_to || null]);
    res.json({ success: true, data: result.rows[0] });
  } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});
module.exports.taxCodeRouter = taxCodeRouter;
