const router = require('express').Router();
const { query } = require('../db');

// GET /api/market-prices?commodity=LME_CU&date=2026-05-09
// Returns latest prices for a commodity (or all if no filter)
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { commodity, date, days = 30 } = req.query;
    let sql = `
      SELECT mp.*, c.name as commodity_name
      FROM market_prices mp
      JOIN commodities c ON c.code = mp.commodity_code
      WHERE mp.status = 'Active'
    `;
    const params = [];
    if (commodity) { params.push(commodity); sql += ` AND mp.commodity_code = $${params.length}`; }
    if (date)      { params.push(date);      sql += ` AND mp.quote_date = $${params.length}`; }
    else           { const d = parseInt(days) || 30; sql += ` AND mp.quote_date >= CURRENT_DATE - INTERVAL '${d} days'`; }
    sql += ' ORDER BY mp.quote_date DESC, mp.commodity_code';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows, count: result.rowCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/market-prices/latest — one row per commodity, most recent date
router.get('/latest', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await query(`
      SELECT DISTINCT ON (commodity_code)
        mp.*, c.name as commodity_name
      FROM market_prices mp
      JOIN commodities c ON c.code = mp.commodity_code
      WHERE mp.status = 'Active'
      ORDER BY commodity_code, quote_date DESC
    `);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/market-prices — save new price entry
router.post('/', async (req, res) => {
  try {
    const { quote_date, commodity_code, cash_bid, cash_ask, bid_3m, ask_3m, settlement, open_price, high_price, low_price, source_feed = 'Manual' } = req.body;
    if (!quote_date || !commodity_code || !settlement) {
      return res.status(400).json({ success: false, error: 'quote_date, commodity_code and settlement are required' });
    }
    // Supersede any existing active row for this date+commodity
    await query(`UPDATE market_prices SET status='Superseded' WHERE quote_date=$1 AND commodity_code=$2 AND status='Active'`, [quote_date, commodity_code]);
    // Insert new row
    const result = await query(`
      INSERT INTO market_prices
        (quote_date, commodity_code, cash_bid, cash_ask, bid_3m, ask_3m, settlement,
         open_price, high_price, low_price, source_feed, status)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'Active')
      RETURNING *
    `, [quote_date, commodity_code, cash_bid, cash_ask, bid_3m, ask_3m, settlement, open_price, high_price, low_price, source_feed]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
