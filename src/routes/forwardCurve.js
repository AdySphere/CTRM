const router = require('express').Router();
const { query } = require('../db');

// GET /api/forward-curve?commodity=LME-CU-BENCH&curve_date=2026-05-09
router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { commodity, curve_date } = req.query;
    let sql = `
      SELECT fc.*, c.name as commodity_name
      FROM forward_curve fc
      JOIN commodities c ON c.code = fc.commodity_code
      WHERE fc.status = 'Active'
    `;
    const params = [];
    if (commodity)   { params.push(commodity);   sql += ` AND fc.commodity_code = $${params.length}`; }
    if (curve_date)  { params.push(curve_date);  sql += ` AND fc.curve_date = $${params.length}`; }
    else {
      // Default: latest curve date per commodity
      sql += ` AND fc.curve_date = (
        SELECT MAX(curve_date) FROM forward_curve
        WHERE commodity_code = fc.commodity_code AND status = 'Active'
      )`;
    }
    sql += ' ORDER BY fc.commodity_code, fc.prompt_date';
    const result = await query(sql, params);
    res.json({ success: true, data: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/forward-curve/price?commodity=LME-CU-BENCH&prompt_date=2026-07-15
// Returns settlement price for a specific prompt — interpolates if needed
router.get('/price', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { commodity, prompt_date, curve_date } = req.query;
    if (!commodity || !prompt_date) return res.status(400).json({ error: 'commodity and prompt_date required' });

    const cd = curve_date || 'CURRENT_DATE';
    // Try exact match first
    const exact = await query(`
      SELECT settlement, interpolated FROM forward_curve
      WHERE commodity_code=$1 AND prompt_date=$2
        AND curve_date = (SELECT MAX(curve_date) FROM forward_curve WHERE commodity_code=$1 AND status='Active')
        AND status='Active'
    `, [commodity, prompt_date]);

    if (exact.rows.length > 0) {
      return res.json({ success: true, settlement: exact.rows[0].settlement, interpolated: false });
    }

    // Interpolate between nearest dates
    const neighbours = await query(`
      SELECT prompt_date, settlement FROM forward_curve
      WHERE commodity_code=$1 AND status='Active'
        AND curve_date = (SELECT MAX(curve_date) FROM forward_curve WHERE commodity_code=$1 AND status='Active')
      ORDER BY prompt_date
    `, [commodity]);

    const rows = neighbours.rows;
    if (!rows.length) return res.json({ success: false, settlement: null });

    const target = new Date(prompt_date).getTime();
    const before = rows.filter(r => new Date(r.prompt_date).getTime() <= target).pop();
    const after  = rows.find(r  => new Date(r.prompt_date).getTime() >  target);

    if (!before) return res.json({ success: true, settlement: parseFloat(rows[0].settlement), interpolated: true });
    if (!after)  return res.json({ success: true, settlement: parseFloat(rows[rows.length-1].settlement), interpolated: true });

    const d1 = new Date(before.prompt_date).getTime();
    const d2 = new Date(after.prompt_date).getTime();
    const ratio = (target - d1) / (d2 - d1);
    const settlement = parseFloat(before.settlement) + (parseFloat(after.settlement) - parseFloat(before.settlement)) * ratio;
    res.json({ success: true, settlement: Math.round(settlement * 100) / 100, interpolated: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/forward-curve — save curve row
router.post('/', async (req, res) => {
  try {
    const { curve_date, commodity_code, prompt_date, bid, ask, settlement, prompt_label, prompt_type = 'Daily', source_feed = 'Manual' } = req.body;
    if (!curve_date || !commodity_code || !prompt_date) {
      return res.status(400).json({ error: 'curve_date, commodity_code, prompt_date required' });
    }
    const result = await query(`
      INSERT INTO forward_curve (curve_date, commodity_code, prompt_date, bid, ask, settlement, prompt_label, prompt_type, source_feed)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (curve_date, commodity_code, prompt_date)
      DO UPDATE SET bid=$4, ask=$5, settlement=$6, prompt_label=$7, prompt_type=$8, source_feed=$9
      RETURNING *
    `, [curve_date, commodity_code, prompt_date, bid, ask, settlement, prompt_label, prompt_type, source_feed]);
    res.json({ success: true, data: result.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
