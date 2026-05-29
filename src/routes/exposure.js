const router = require('express').Router();
const { query } = require('../db');

// Helper: get latest market price for a commodity
async function getSettlement(commodityCode, date = null) {
  const result = await query(`
    SELECT settlement FROM market_prices
    WHERE commodity_code = $1 AND status = 'Active'
    ${date ? 'AND quote_date <= $2' : ''}
    ORDER BY quote_date DESC LIMIT 1
  `, date ? [commodityCode, date] : [commodityCode]);
  return result.rows[0]?.settlement ? parseFloat(result.rows[0].settlement) : null;
}

// Helper: get forward curve settlement for a prompt date
async function getForwardSettlement(commodityCode, promptDate) {
  const result = await query(`
    SELECT settlement FROM forward_curve
    WHERE commodity_code = $1 AND prompt_date = $2 AND status = 'Active'
    ORDER BY curve_date DESC LIMIT 1
  `, [commodityCode, promptDate]);
  if (result.rows.length) return parseFloat(result.rows[0].settlement);

  // Interpolate
  const neighbours = await query(`
    SELECT prompt_date, settlement FROM forward_curve
    WHERE commodity_code = $1 AND status = 'Active'
    ORDER BY curve_date DESC, prompt_date
    LIMIT 40
  `, [commodityCode]);

  const rows = neighbours.rows;
  if (!rows.length) return null;
  const target = new Date(promptDate).getTime();
  const before = rows.filter(r => new Date(r.prompt_date).getTime() <= target).pop();
  const after  = rows.find(r  => new Date(r.prompt_date).getTime() >  target);
  if (!before) return parseFloat(rows[0].settlement);
  if (!after)  return parseFloat(rows[rows.length-1].settlement);
  const d1 = new Date(before.prompt_date).getTime();
  const d2 = new Date(after.prompt_date).getTime();
  const ratio = (target - d1) / (d2 - d1);
  return parseFloat(before.settlement) + (parseFloat(after.settlement) - parseFloat(before.settlement)) * ratio;
}

// Helper: get QP running average for a contract pricing line up to a date
async function getQPAverage(pricingLine, upToDate) {
  const today = upToDate || new Date().toISOString().split('T')[0];
  const qpStart = pricingLine.qp_start_date?.toISOString?.().split('T')[0] || pricingLine.qp_start_date;
  const qpEnd   = pricingLine.qp_end_date?.toISOString?.().split('T')[0]   || pricingLine.qp_end_date;

  if (!qpStart || today < qpStart) return { average: null, status: 'PRE_QP', days: 0 };

  const endDate = today > qpEnd ? qpEnd : today;

  // Get all prices in the QP window
  const prices = await query(`
    SELECT quote_date,
      CASE $1
        WHEN 'lowest4'    THEN LEAST(cash_bid, cash_ask, bid_3m, ask_3m)
        WHEN 'highest4'   THEN GREATEST(cash_bid, cash_ask, bid_3m, ask_3m)
        WHEN 'cashAsk'    THEN cash_ask
        WHEN 'cashBid'    THEN cash_bid
        WHEN 'settlement' THEN settlement
        ELSE cash_ask
      END as ref_price
    FROM market_prices
    WHERE commodity_code = $2
      AND quote_date >= $3 AND quote_date <= $4
      AND status = 'Active'
      AND EXTRACT(DOW FROM quote_date) NOT IN (0,6)
    ORDER BY quote_date
  `, [pricingLine.calc_method, pricingLine.benchmark_code || pricingLine.commodity_code, qpStart, endDate]);

  const validPrices = prices.rows.filter(r => r.ref_price !== null);
  const sum = validPrices.reduce((s, r) => s + parseFloat(r.ref_price), 0);
  const average = validPrices.length > 0 ? sum / validPrices.length : null;

  // Total business days in full window
  const totalDays = await query(`
    SELECT COUNT(*) as total FROM generate_series($1::date, $2::date, '1 day') d
    WHERE EXTRACT(DOW FROM d) NOT IN (0,6)
  `, [qpStart, qpEnd]);

  return {
    average,
    status: today > qpEnd ? 'CLOSED' : 'OPEN',
    days: validPrices.length,
    total: parseInt(totalDays.rows[0].total),
    prices: validPrices,
  };
}

// GET /api/exposure — compute full exposure for all deals
router.get('/', async (req, res) => {
  try {
    const { deal_id, as_of_date } = req.query;
    const today = as_of_date || new Date().toISOString().split('T')[0];

    // Get all contracts with pricing lines
    const contractsRes = await query(`
      SELECT c.id, c.contract_no, c.contract_type, c.commodity_code,
        c.qty_mt, c.payment_pct, c.deal_id as contract_deal_id,
        d.deal_no,
        cp.code as counterparty_code, cp.name as counterparty_name,
        pl.id as pricing_line_id, pl.index_pct, pl.payable_pct, pl.premium_discount,
        pl.pricing_rule, pl.calc_method, pl.qp_start_date, pl.qp_end_date,
        pl.benchmark_code, pl.source_item_code,
        CASE WHEN c.contract_type = 'PC' THEN 'BUY' ELSE 'SELL' END as direction
      FROM contracts c
      JOIN counterparties cp ON cp.id = c.counterparty_id
      JOIN contract_pricing_lines pl ON pl.contract_id = c.id
      LEFT JOIN deals d ON d.id = c.deal_id
      WHERE c.status NOT IN ('CANCELLED', 'CLOSED')
      ${deal_id ? "AND d.deal_no = $1" : ""}
      ORDER BY c.contract_date DESC
    `, deal_id ? [deal_id] : []);

    const rows = [];

    for (const contract of contractsRes.rows) {
      const commodityCode = contract.benchmark_code || contract.commodity_code;
      const dealNo = contract.deal_no;

      // D — total payable qty
      const D = parseFloat(contract.qty_mt) * (parseFloat(contract.index_pct) / 100);

      // Get fixations for this deal
      const fixRes = await query(`
        SELECT SUM(fixed_qty_mt) as priced_qty,
          SUM(fixed_price * fixed_qty_mt) / NULLIF(SUM(fixed_qty_mt),0) as wavg_price
        FROM fixation_lots WHERE deal_id=$1
      `, [dealNo]);

      const E = parseFloat(fixRes.rows[0]?.priced_qty || 0);
      const F = Math.max(0, D - E);
      const I = fixRes.rows[0]?.wavg_price ? parseFloat(fixRes.rows[0].wavg_price) : null;

      // Determine state
      const qpStart = contract.qp_start_date?.toISOString?.().split('T')[0] || contract.qp_start_date;
      const qpEnd   = contract.qp_end_date?.toISOString?.().split('T')[0]   || contract.qp_end_date;
      let state;
      if (today < qpStart)       state = 'PRE_QP';
      else if (E === 0)          state = 'UNPRICED';
      else if (F > 0.01)         state = 'PARTIAL';
      else                       state = 'PRICED';

      // Get hedges for this deal
      const hedgeRes = await query(`
        SELECT SUM(qty_mt) as total_qty, hedge_type, entry_price, prompt_date
        FROM hedges WHERE deal_id=$1 AND status='EXECUTED'
        GROUP BY hedge_type, entry_price, prompt_date
      `, [dealNo]);

      const G = hedgeRes.rows.reduce((s, h) => s + parseFloat(h.total_qty || 0), 0);
      const H = E > 0 ? G / E : (F > 0 ? G / F : 0);
      const M = hedgeRes.rows[0]?.entry_price ? parseFloat(hedgeRes.rows[0].entry_price) : null;

      // J — today's settlement from market prices
      const J = await getSettlement(commodityCode, today);

      // K — physical MTM
      let K = null;
      if (state !== 'PRE_QP' && state !== 'UNPRICED' && I !== null && J !== null) {
        const dir = contract.direction === 'BUY' ? 1 : -1;
        K = (J - I) * dir * E;
      }

      const L = K; // Phase 1: L = K

      // N — futures MTM
      let N = 0;
      for (const h of hedgeRes.rows) {
        const fwdPx = await getForwardSettlement(commodityCode, h.prompt_date) || J;
        if (fwdPx === null) continue;
        const qty = parseFloat(h.total_qty);
        const m = parseFloat(h.entry_price);
        N += h.hedge_type === 'SHORT' ? (m - fwdPx) * qty : (fwdPx - m) * qty;
      }

      const O = (L !== null ? L : 0) + N;

      // Effectiveness
      let P = null, Q = '—';
      if (K !== null && K !== 0) {
        P = Math.abs(N / K);
        if (P >= 0.80 && P <= 1.25)      Q = '✓ Effective';
        else if (P > 1.25 && P <= 1.35)  Q = '△ Partial';
        else                              Q = '✗ Ineffective';
      }

      rows.push({
        deal_no: dealNo,
        contract_no: contract.contract_no,
        contract_type: contract.contract_type,
        direction: contract.direction,
        counterparty: contract.counterparty_name,
        commodity: contract.commodity_code,
        state,
        D: Math.round(D * 1000) / 1000,
        E: Math.round(E * 1000) / 1000,
        F: Math.round(F * 1000) / 1000,
        G: Math.round(G * 1000) / 1000,
        H: Math.round(H * 10000) / 10000,
        I,
        J,
        K: K !== null ? Math.round(K * 100) / 100 : null,
        L: L !== null ? Math.round(L * 100) / 100 : null,
        M,
        N: Math.round(N * 100) / 100,
        O: Math.round(O * 100) / 100,
        P: P !== null ? Math.round(P * 10000) / 10000 : null,
        Q,
        qp_start: qpStart,
        qp_end: qpEnd,
        as_of_date: today,
      });
    }

    // Totals
    const totals = rows.reduce((acc, r) => ({
      D: acc.D + r.D,
      E: acc.E + r.E,
      F: acc.F + r.F,
      K: acc.K + (r.K || 0),
      N: acc.N + r.N,
      O: acc.O + r.O,
    }), { D:0, E:0, F:0, K:0, N:0, O:0 });

    res.json({ success: true, data: rows, totals, as_of_date: today });
  } catch (err) {
    console.error('Exposure calculation error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/exposure/qp/:deal_no — QP running average for a specific deal
router.get('/qp/:deal_no', async (req, res) => {
  try {
    const { deal_no } = req.params;
    const { as_of_date } = req.query;

    const plRes = await query(`
      SELECT pl.*, c.deal_id, d.deal_no FROM contract_pricing_lines pl
      JOIN contracts c ON c.id = pl.contract_id
      JOIN deals d ON d.id = c.deal_id
      WHERE d.deal_no = $1 LIMIT 1
    `, [deal_no]);

    if (!plRes.rows.length) return res.status(404).json({ error: 'Deal not found' });
    const pl = plRes.rows[0];
    const qp = await getQPAverage(pl, as_of_date);
    res.json({ success: true, deal_no, data: qp });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
module.exports.getSettlement = getSettlement;
module.exports.getQPAverage = getQPAverage;
