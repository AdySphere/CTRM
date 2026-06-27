require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());

const { dealsRouter, logRouter, conRouter, fixRouter, hedgeRouter, allocRouter, ordersRouter, enquiriesRouter, quotationsRouter, buyLegsRouter, dealEnqRouter, adjLinesRouter, penaltiesRouter, rfqRouter, quoteResponseRouter, feasibilityRouter, budgetActualRouter, searchRouter, auditRouter, creditRouter, goodsReceiptRouter, qcResultsRouter, lotsRouter, adjCodesRouter, invoiceAdjRouter, pricingBenchmarksRouter, dateEventMasterRouter } = require('./routes/deals');
const { invoiceRouter, masterRouter } = require('./routes/invoices');

app.use('/api/market-prices',   require('./routes/marketPrices'));
app.use('/api/forward-curve',   require('./routes/forwardCurve'));
app.use('/api/contracts',       require('./routes/contracts'));
app.use('/api/deals',           dealsRouter);
app.use('/api/buy-legs',        buyLegsRouter);
app.use('/api/deal-enquiries',  dealEnqRouter);
app.use('/api/adj-lines',       adjLinesRouter);
app.use('/api/rfqs',            rfqRouter);
app.use('/api/quote-responses', quoteResponseRouter);
app.use('/api/feasibility',     feasibilityRouter);
app.use('/api/deals',           budgetActualRouter);
app.use('/api/search',          searchRouter);
app.use('/api/audit',           auditRouter);
app.use('/api/credit',          creditRouter);
app.use('/api/goods-receipts',  goodsReceiptRouter);
app.use('/api/qc-results',      qcResultsRouter);
app.use('/api/lots',            lotsRouter);
app.use('/api/adjustment-codes', adjCodesRouter);
app.use('/api/invoice-adj-lines', invoiceAdjRouter);
app.use('/api/pricing-benchmarks', pricingBenchmarksRouter);
app.use('/api/date-event-master', dateEventMasterRouter);
app.use('/api/penalties',       penaltiesRouter);
app.use('/api/enquiries',       enquiriesRouter);
app.use('/api/quotations',      quotationsRouter);
app.use('/api/logistics',       logRouter);
app.use('/api/containers',      conRouter);
app.use('/api/fixations',       fixRouter);
app.use('/api/hedges',          hedgeRouter);
app.use('/api/allocations',     allocRouter);
app.use('/api/exposure',        require('./routes/exposure'));
app.use('/api/invoices',        invoiceRouter);
app.use('/api/master',          masterRouter);
app.use('/api/orders',          ordersRouter);

app.get('/api/health', async (req, res) => {
  const { query } = require('./db');
  try {
    await query('SELECT 1');
    res.json({ status: 'ok', db: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', db: 'disconnected', error: err.message });
  }
});

app.use(express.static(path.join(__dirname, '../public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
app.get('/setup', (req, res) => res.sendFile(path.join(__dirname, '../public/setup.html')));

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`\nCTRM Platform running on http://localhost:${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health\n`);
});

module.exports = app;
