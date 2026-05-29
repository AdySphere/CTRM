require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// ── ROUTES ────────────────────────────────────────────────────────
const { dealsRouter }   = require('./routes/deals');
const { logRouter }     = require('./routes/deals');
const { conRouter }     = require('./routes/deals');
const { fixRouter }     = require('./routes/deals');
const { hedgeRouter }   = require('./routes/deals');
const { allocRouter }   = require('./routes/deals');
const { invoiceRouter } = require('./routes/invoices');
const { masterRouter }  = require('./routes/invoices');

app.use('/api/market-prices',   require('./routes/marketPrices'));
app.use('/api/forward-curve',   require('./routes/forwardCurve'));
app.use('/api/contracts',       require('./routes/contracts'));
app.use('/api/deals',           dealsRouter);
app.use('/api/logistics',       logRouter);
app.use('/api/containers',      conRouter);
app.use('/api/fixations',       fixRouter);
app.use('/api/hedges',          hedgeRouter);
app.use('/api/allocations',     allocRouter);
app.use('/api/exposure',        require('./routes/exposure'));
app.use('/api/invoices',        invoiceRouter);
app.use('/api/master',          masterRouter);

// ── HEALTH CHECK ─────────────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  const { query } = require('./db');
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

// ── SERVE FRONTEND ────────────────────────────────────────────────
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, '../public/setup.html')));

// ── ERROR HANDLER ─────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\nCTRM Platform running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
