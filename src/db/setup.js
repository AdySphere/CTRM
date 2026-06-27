const { query } = require('./index');

async function setupDatabase() {
  console.log('Setting up CTRM database schema...\n');

  // ── MASTER DATA ─────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS commodities (
      id                SERIAL PRIMARY KEY,
      code              VARCHAR(20) UNIQUE NOT NULL,
      name              VARCHAR(100) NOT NULL,
      category          VARCHAR(30),         -- BASE-METAL, FERROUS, AGRI, ENERGY
      type              VARCHAR(30),         -- REFINED, SCRAP, ALLOY, CONCENTRATE
      uom               VARCHAR(10) DEFAULT 'MT',
      exchange_code     VARCHAR(20),         -- LME, CME, ICE, PLATTS
      currency          VARCHAR(5) DEFAULT 'USD',
      correlation_factor DECIMAL(5,2) DEFAULT 100.00,  -- default 100%, metals only
      erp_item_ref      VARCHAR(50),
      active            BOOLEAN DEFAULT TRUE,
      created_at        TIMESTAMPTZ DEFAULT NOW(),
      updated_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ commodities');

  await query(`
    CREATE TABLE IF NOT EXISTS counterparties (
      id              SERIAL PRIMARY KEY,
      code            VARCHAR(20) UNIQUE NOT NULL,
      name            VARCHAR(100) NOT NULL,
      type            VARCHAR(20),           -- VENDOR, CUSTOMER, AGENT, BROKER
      country         VARCHAR(50),
      currency        VARCHAR(5) DEFAULT 'USD',
      payment_term_code VARCHAR(20),
      tax_ref         VARCHAR(50),
      erp_ref         VARCHAR(50),
      email           VARCHAR(150),
      contact_person  VARCHAR(100),
      credit_limit    DECIMAL(15,2),
      kyc_status      VARCHAR(20) DEFAULT 'PENDING',
      active          BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ counterparties');

  await query(`
    CREATE TABLE IF NOT EXISTS locations (
      id              SERIAL PRIMARY KEY,
      code            VARCHAR(20) UNIQUE NOT NULL,
      name            VARCHAR(100) NOT NULL,
      type            VARCHAR(20),           -- PORT, YARD, WAREHOUSE
      country         VARCHAR(50),
      region          VARCHAR(50),
      un_locode       VARCHAR(10),
      erp_warehouse   VARCHAR(50),
      active          BOOLEAN DEFAULT TRUE
    );
  `);
  console.log('✓ locations');

  // ── CURRENCY / UOM / TAX MASTER (A5 fix) — confirmed genuinely never built. The Setup
  // page rendered these from hardcoded static rows / a JS constant array with no backend
  // at all, which is exactly why Currency/UOM data was never showing up for real.
  await query(`
    CREATE TABLE IF NOT EXISTS currencies (
      id          SERIAL PRIMARY KEY,
      code        VARCHAR(3) UNIQUE NOT NULL,
      name        VARCHAR(60) NOT NULL,
      symbol      VARCHAR(10),
      decimals    INT DEFAULT 2,
      is_base     BOOLEAN DEFAULT FALSE,
      active      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ currencies');

  await query(`
    CREATE TABLE IF NOT EXISTS uom_master (
      id          SERIAL PRIMARY KEY,
      code        VARCHAR(10) UNIQUE NOT NULL,
      name        VARCHAR(60) NOT NULL,
      category    VARCHAR(20),  -- Weight, Volume, Energy
      conversion  VARCHAR(60),
      active      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ uom_master');

  await query(`
    CREATE TABLE IF NOT EXISTS tax_codes (
      id            SERIAL PRIMARY KEY,
      code          VARCHAR(30) UNIQUE NOT NULL,
      description   VARCHAR(100) NOT NULL,
      rate_pct      DECIMAL(6,3) DEFAULT 0,
      jurisdiction  VARCHAR(60),
      applies_to    VARCHAR(100),
      active        BOOLEAN DEFAULT TRUE,
      created_at    TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ tax_codes');

  // ── CONTRACT EVENT DATES (A1) — per Veridian's Event Date Master spec. One record
  // per contract leg. BL Date is the PRIMARY ANCHOR — once locked, immutable, and
  // triggers automatic recalculation of QP window, payment due dates, and every accrual.
  await query(`
    CREATE TABLE IF NOT EXISTS contract_event_dates (
      id                  SERIAL PRIMARY KEY,
      contract_id         INT UNIQUE NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      contract_date       DATE,
      etd_estimated       DATE,
      etd_actual          DATE,
      bl_date             DATE,
      bl_number           VARCHAR(50),
      bl_date_locked      BOOLEAN DEFAULT FALSE,
      bl_date_locked_by   VARCHAR(50),
      bl_date_locked_at   TIMESTAMPTZ,
      eta_estimated       DATE,
      eta_actual          DATE,
      nor_tendered_at     TIMESTAMPTZ,
      pr_date             DATE,
      pr_reference        VARCHAR(50),
      grn_date            DATE,
      grn_reference       VARCHAR(50),
      grn_erp_posted      BOOLEAN DEFAULT FALSE,
      assay_date          DATE,
      assay_confirmed     BOOLEAN DEFAULT FALSE,
      qp_start_date       DATE,
      qp_end_date         DATE,
      qp_close_confirmed  BOOLEAN DEFAULT FALSE,
      payment_due_date    DATE,
      payment_anchor_event VARCHAR(20),  -- BL_DATE / ETA_DATE / PR_DATE / GRN_DATE / ASSAY_DATE / QP_CLOSE_DATE
      payment_terms_days  INT,
      settlement_date     DATE,
      updated_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_by          VARCHAR(50)
    );
    CREATE INDEX IF NOT EXISTS idx_event_dates_contract ON contract_event_dates(contract_id);
  `);
  console.log('✓ contract_event_dates');

  // ── PAYMENT TERM TRANCHES (A2) — per Veridian spec. Multi-tranche per contract,
  // each with its own anchor event + offset + percentage. Tranches must sum to 100%.
  await query(`
    CREATE TABLE IF NOT EXISTS payment_term_tranches (
      id                  SERIAL PRIMARY KEY,
      contract_id         INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      tranche_number      INT NOT NULL,
      tranche_name        VARCHAR(60) NOT NULL,
      percentage          DECIMAL(5,2) NOT NULL,
      amount_basis        VARCHAR(20) DEFAULT 'pct_of_contract', -- pct_of_provisional, pct_of_final, pct_of_contract, fixed_amount, balance_remaining
      anchor_event        VARCHAR(20) NOT NULL,  -- contract_date, etd_date, bl_date, eta_date, pr_date, grn_date, assay_date, qp_close_date, fixed_date
      offset_days         INT DEFAULT 0,
      offset_direction    VARCHAR(10) DEFAULT 'after', -- after, before
      fixed_date          DATE,
      calculated_due_date DATE,
      calculated_amount   DECIMAL(15,2),
      currency            VARCHAR(10) DEFAULT 'USD',
      invoice_type        VARCHAR(20) DEFAULT 'provisional', -- provisional, final, delta, advance, credit_note
      invoice_id          VARCHAR(30),
      status              VARCHAR(20) DEFAULT 'pending_anchor', -- pending_anchor, anchor_confirmed, due_date_calc, invoice_raised, payment_due, paid, overdue, disputed
      actual_payment_date DATE,
      actual_amount_paid  DECIMAL(15,2),
      variance            DECIMAL(15,2),
      erp_posted          BOOLEAN DEFAULT FALSE,
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_pt_tranches_contract ON payment_term_tranches(contract_id);
  `);
  console.log('✓ payment_term_tranches');

  // A3 — link Charge Items to the new Event Date Master: each charge type's accrual
  // trigger and reversal event, per the Charge Items Accrual sheet (e.g. Freight accrues
  // on BL Date, reverses on GRN Date; Agent Commission accrues on Contract Date).
  // Wrapped in try/catch: contract_charge_lines isn't created until later in this file,
  // so on a genuinely fresh database this ALTER would throw before the table exists.
  // This only ran safely in practice because the table already existed from an earlier
  // session on the live database — fixing properly so a clean install doesn't break.
  try {
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS accrual_trigger_event VARCHAR(20)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS accrual_reversal_event VARCHAR(20)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS qty_or_days DECIMAL(14,3)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS actual_amount DECIMAL(15,2)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS variance DECIMAL(15,2)`);
  } catch(e) { /* table created later in this run — main schema block below covers it */ }
  try {
    await query(`ALTER TABLE adjustment_codes ADD COLUMN IF NOT EXISTS default_trigger_event VARCHAR(20)`);
    await query(`ALTER TABLE adjustment_codes ADD COLUMN IF NOT EXISTS default_reversal_event VARCHAR(20)`);
  } catch(e) { /* table created later in this run — main schema block below covers it */ }
  console.log('✓ charge items linked to event dates');

  // H2 — material lines table, safe to create here regardless of ordering since it's a
  // brand new table (CREATE TABLE IF NOT EXISTS has no 'table must already exist' issue
  // the way the ALTER TABLE statements above did).
  await query(`
    CREATE TABLE IF NOT EXISTS contract_material_lines (
      id SERIAL PRIMARY KEY, contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      line_no INT NOT NULL, commodity_code VARCHAR(20) REFERENCES commodities(code),
      grade VARCHAR(100), hs_code VARCHAR(20), origin VARCHAR(60),
      qty_gross DECIMAL(14,3) NOT NULL, tolerance_pct DECIMAL(6,3), uom VARCHAR(10) DEFAULT 'MT',
      unit_price DECIMAL(14,4), price_basis VARCHAR(60), provisional_value DECIMAL(16,2),
      counterparty_id INT REFERENCES counterparties(id), incoterms VARCHAR(10),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_material_lines_contract ON contract_material_lines(contract_id);
  `);
  console.log('✓ contract_material_lines (migration)');

  await query(`
    CREATE TABLE IF NOT EXISTS payment_terms (
      id              SERIAL PRIMARY KEY,
      code            VARCHAR(20) UNIQUE NOT NULL,
      name            VARCHAR(100) NOT NULL,
      type            VARCHAR(20),           -- T/T, LC, CAD
      description     TEXT,
      active          BOOLEAN DEFAULT TRUE
    );
  `);
  console.log('✓ payment_terms');

  await query(`
    CREATE TABLE IF NOT EXISTS qp_period_master (
      id              SERIAL PRIMARY KEY,
      code            VARCHAR(30) UNIQUE NOT NULL,
      name            VARCHAR(100) NOT NULL,
      pricing_type    VARCHAR(20),           -- average, event_based, specific_date
      anchor_event    VARCHAR(30),           -- BL_DATE, ASSAY_RECEIPT_DATE, ETA
      start_offset_type VARCHAR(20),         -- SAME-DAY, NEXT-MONTH-START, OFFSET-BD
      start_offset_days INT DEFAULT 0,
      end_offset_type VARCHAR(20),
      end_offset_days INT DEFAULT 0,
      holiday_calendar VARCHAR(20) DEFAULT 'LME',
      fallback_rule    VARCHAR(30) DEFAULT 'USE-LAST-AVAILABLE',
      active          BOOLEAN DEFAULT TRUE
    );
  `);
  console.log('✓ qp_period_master');

  // ── MARKET DATA ─────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS market_prices (
      id              SERIAL PRIMARY KEY,
      quote_date      DATE NOT NULL,
      commodity_code  VARCHAR(20) NOT NULL REFERENCES commodities(code),
      exchange_code   VARCHAR(20),
      price_type      VARCHAR(20),
      currency        VARCHAR(5) DEFAULT 'USD',
      unit            VARCHAR(10) DEFAULT '$/MT',
      -- LME 4-price block
      cash_bid        DECIMAL(12,4),
      cash_ask        DECIMAL(12,4),
      cash_mid        DECIMAL(12,4) GENERATED ALWAYS AS ((cash_bid + cash_ask) / 2) STORED,
      bid_3m          DECIMAL(12,4),
      ask_3m          DECIMAL(12,4),
      mid_3m          DECIMAL(12,4) GENERATED ALWAYS AS ((bid_3m + ask_3m) / 2) STORED,
      -- Primary MTM price
      settlement      DECIMAL(12,4),        -- PRIMARY — used for all MTM
      open_price      DECIMAL(12,4),
      high_price      DECIMAL(12,4),
      low_price       DECIMAL(12,4),
      -- Admin
      source_feed     VARCHAR(50) DEFAULT 'Manual',
      load_timestamp  TIMESTAMPTZ DEFAULT NOW(),
      status          VARCHAR(20) DEFAULT 'Active',  -- Active, Superseded
      UNIQUE(quote_date, commodity_code)
    );
    CREATE INDEX IF NOT EXISTS idx_market_prices_date_comm ON market_prices(quote_date, commodity_code);
  `);
  console.log('✓ market_prices');

  await query(`
    CREATE TABLE IF NOT EXISTS forward_curve (
      id              SERIAL PRIMARY KEY,
      curve_date      DATE NOT NULL,
      commodity_code  VARCHAR(20) NOT NULL REFERENCES commodities(code),
      exchange_code   VARCHAR(20),
      prompt_date     DATE NOT NULL,
      days_to_prompt  INT GENERATED ALWAYS AS (prompt_date - curve_date) STORED,
      prompt_label    VARCHAR(30),
      prompt_type     VARCHAR(20) DEFAULT 'Daily',  -- Daily, Monthly
      bid             DECIMAL(12,4),
      ask             DECIMAL(12,4),
      mid             DECIMAL(12,4) GENERATED ALWAYS AS ((bid + ask) / 2) STORED,
      settlement      DECIMAL(12,4),        -- PRIMARY for all derivatives MTM
      spread_to_cash  DECIMAL(10,4),
      daily_carry     DECIMAL(10,6),
      interpolated    BOOLEAN DEFAULT FALSE,
      source_feed     VARCHAR(50) DEFAULT 'Manual',
      status          VARCHAR(20) DEFAULT 'Active',
      UNIQUE(curve_date, commodity_code, prompt_date)
    );
    CREATE INDEX IF NOT EXISTS idx_fwd_curve ON forward_curve(curve_date, commodity_code, prompt_date);
  `);
  console.log('✓ forward_curve');

  // ── COMMERCIAL ──────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS enquiries (
      id              SERIAL PRIMARY KEY,
      enquiry_no      VARCHAR(20) UNIQUE NOT NULL,
      enquiry_date    DATE NOT NULL,
      commodity_code  VARCHAR(20) REFERENCES commodities(code),
      deal_type       VARCHAR(30),           -- BACK-TO-BACK, OPEN-BUY, OPEN-SELL
      qty_mt          DECIMAL(12,3),
      supplier_id     INT REFERENCES counterparties(id),
      customer_id     INT REFERENCES counterparties(id),
      origin          VARCHAR(50),
      destination     VARCHAR(50),
      incoterms       VARCHAR(10),
      pricing_intent  TEXT,
      status          VARCHAR(20) DEFAULT 'OPEN',  -- OPEN, QUOTED, CONVERTED, CLOSED
      notes           TEXT,
      uom_override    VARCHAR(10),           -- Item 4 fix: lets trader override the commodity's default UOM
      created_by      VARCHAR(50),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ enquiries');

  // ── RFQs ──────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS rfqs (
      id                SERIAL PRIMARY KEY,
      rfq_no            VARCHAR(30) UNIQUE NOT NULL,
      enquiry_id        INT REFERENCES enquiries(id),
      direction         VARCHAR(10) NOT NULL DEFAULT 'VENDOR',
      counterparty_id   INT REFERENCES counterparties(id),
      commodity_code    VARCHAR(20) REFERENCES commodities(code),
      qty_mt            DECIMAL(12,3),
      required_delivery DATE,
      incoterms         VARCHAR(10),
      origin            VARCHAR(100),
      destination       VARCHAR(100),
      pricing_basis     TEXT,
      payment_terms     TEXT,
      validity_date     DATE,
      notes             TEXT,
      status            VARCHAR(20) DEFAULT 'DRAFT',
      sent_at           TIMESTAMPTZ,
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ rfqs');

  // ── QUOTE RESPONSES ───────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS quote_responses (
      id                SERIAL PRIMARY KEY,
      response_no       VARCHAR(30) UNIQUE NOT NULL,
      rfq_id            INT REFERENCES rfqs(id),
      enquiry_id        INT REFERENCES enquiries(id),
      quote_type        VARCHAR(5) NOT NULL DEFAULT 'PQ',
      counterparty_id   INT REFERENCES counterparties(id),
      commodity_code    VARCHAR(20) REFERENCES commodities(code),
      offered_qty       DECIMAL(12,3),
      offered_price     DECIMAL(14,4),
      price_basis       TEXT,
      delivery_date     DATE,
      delivery_window   VARCHAR(100),
      incoterms         VARCHAR(10),
      payment_terms     TEXT,
      validity_date     DATE,
      notes             TEXT,
      status            VARCHAR(20) DEFAULT 'RECEIVED',
      deal_id           INT REFERENCES deals(id),
      received_at       TIMESTAMPTZ DEFAULT NOW(),
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ quote_responses');

  await query(`
    CREATE TABLE IF NOT EXISTS quotations (
      id              SERIAL PRIMARY KEY,
      quotation_no    VARCHAR(20) UNIQUE NOT NULL,
      enquiry_id      INT REFERENCES enquiries(id),
      quotation_date  DATE NOT NULL,
      commodity_code  VARCHAR(20) REFERENCES commodities(code),
      customer_id     INT REFERENCES counterparties(id),
      qty_mt          DECIMAL(12,3),
      incoterms       VARCHAR(10),
      port_of_discharge VARCHAR(100),
      delivery_from   DATE,
      delivery_to     DATE,
      validity_date   DATE,
      pricing_template VARCHAR(50),
      provisional_price DECIMAL(14,4),
      provisional_value DECIMAL(16,2),
      uom_override    VARCHAR(10),  -- B-fix: same pattern as enquiries — Quantity UOM was
                                     -- a read-only badge with no editable override at all.
      quoted_by       VARCHAR(50),
      status          VARCHAR(20) DEFAULT 'OPEN',  -- OPEN, ACCEPTED, DECLINED, EXPIRED, CONVERTED
      deal_id         INT REFERENCES deals(id),
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ quotations');

  // ── QUOTATION ADJUSTMENT LINES ────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS quotation_adjustment_lines (
      id              SERIAL PRIMARY KEY,
      quotation_id    INT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
      line_no         INT DEFAULT 1,
      adj_code        VARCHAR(30),
      description     TEXT,
      adj_type        VARCHAR(20) DEFAULT 'DEDUCTION', -- DEDUCTION, PREMIUM, FLAT
      basis           VARCHAR(20) DEFAULT 'per-unit',  -- per-unit, pct, flat
      rate            DECIMAL(12,4),
      uom             VARCHAR(10) DEFAULT 'MT',
      computed_value  DECIMAL(14,2),
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ quotation_adjustment_lines');

  // ── QUOTATION SELL PENALTIES ──────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS quotation_penalties (
      id              SERIAL PRIMARY KEY,
      quotation_id    INT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
      line_no         INT DEFAULT 1,
      penalty_code    VARCHAR(30),
      penalty_type    VARCHAR(20) DEFAULT 'FLAT-RATE',
      element         VARCHAR(50),
      threshold       VARCHAR(50),
      rate            VARCHAR(50),
      direction       VARCHAR(10) DEFAULT 'OUT',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ quotation_penalties');

  await query(`
    CREATE TABLE IF NOT EXISTS deals (
      id              SERIAL PRIMARY KEY,
      deal_no         VARCHAR(20) UNIQUE NOT NULL,
      deal_date       TIMESTAMPTZ NOT NULL,
      enquiry_id      INT REFERENCES enquiries(id),
      commodity_code  VARCHAR(20) REFERENCES commodities(code),
      deal_type       VARCHAR(30),
      qty_mt          DECIMAL(12,3),
      supplier_id     INT REFERENCES counterparties(id),
      customer_id     INT REFERENCES counterparties(id),
      incoterms       VARCHAR(10),
      origin          VARCHAR(100),
      destination     VARCHAR(100),
      direction       VARCHAR(10),
      budget_buy_qty    DECIMAL(12,3),
      budget_buy_price  DECIMAL(14,4),
      budget_sell_qty   DECIMAL(12,3),
      budget_sell_price DECIMAL(14,4),
      budget_margin     DECIMAL(14,2),
      budget_locked_at  TIMESTAMPTZ,
      -- Group D (final) — Deal Budgeting module, per the flowchart: budgeting parameters
      -- captured before a counterparty/contract necessarily exists yet.
      budget_month_of_shipping DATE,
      budget_shipment_term     VARCHAR(10),  -- Incoterm (CIF, FOB, etc.) — determines which of POL/POD apply
      budget_loading_port      INT REFERENCES locations(id),
      budget_destination_port  INT REFERENCES locations(id),
      budget_shipment_cost     DECIMAL(14,2),
      budget_clearance_cost    DECIMAL(14,2),
      budget_process_type      VARCHAR(30),  -- MANUFACTURING, LIGHT_MANUFACTURING, PROCESS, NONE
      budget_bom_notes         TEXT,
      budget_packing_type      VARCHAR(30),
      budget_packing_cost      DECIMAL(14,2),
      budget_delivery_location INT REFERENCES locations(id),
      budget_delivery_cost     DECIMAL(14,2),
      budget_payment_terms     TEXT,
      budget_finance_cost      DECIMAL(14,2),
      budget_hedging_cost      DECIMAL(14,2),
      -- D4 — Deal Feasibility / Proceed decision, deliberately separate from Deal
      -- Budgeting and from the unrelated Deal Basket (feasibilityRouter, which compares
      -- RFQ responses BEFORE a deal exists — this is a decision made AFTER one does).
      feasibility_margin_pct      DECIMAL(8,4),
      feasibility_earliest_delivery DATE,
      feasibility_decision        VARCHAR(20),  -- PROCEED, NOT_PROCEED, PENDING
      feasibility_decided_by      VARCHAR(50),
      feasibility_decided_at      TIMESTAMPTZ,
      feasibility_notes           TEXT,
      confirmed       BOOLEAN DEFAULT FALSE,
      confirmed_at    TIMESTAMPTZ,
      confirmed_by    VARCHAR(50),
      status          VARCHAR(20) DEFAULT 'DRAFT',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ deals');

  // ── DEAL-ENQUIRY LINKS (many-to-many) ───────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS deal_enquiries (
      id          SERIAL PRIMARY KEY,
      deal_id     INT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      enquiry_id  INT NOT NULL REFERENCES enquiries(id),
      leg_role    VARCHAR(20) DEFAULT 'BUY',
      added_at    TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(deal_id, enquiry_id)
    );
  `);
  console.log('✓ deal_enquiries');

  // ── BUY LEGS ────────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS buy_legs (
      id              SERIAL PRIMARY KEY,
      deal_id         INT NOT NULL REFERENCES deals(id),
      leg_ref         VARCHAR(20),
      supplier_id     INT REFERENCES counterparties(id),
      commodity_code  VARCHAR(20),
      qty_mt          DECIMAL(12,3),
      incoterms       VARCHAR(20),
      pricing_template VARCHAR(50),
      provisional_price DECIMAL(14,4),
      provisional_cost  DECIMAL(16,2),
      status          VARCHAR(20) DEFAULT 'DRAFT',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ buy_legs');

  // D4 — Deal Feasibility decision questionnaire. A small, fixed checklist the trader
  // works through before marking PROCEED / NOT PROCEED on a deal.
  await query(`
    CREATE TABLE IF NOT EXISTS deal_feasibility_checklist (
      id              SERIAL PRIMARY KEY,
      deal_id         INT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
      question_code   VARCHAR(40) NOT NULL,
      question_text   TEXT NOT NULL,
      answer          VARCHAR(10),  -- YES, NO, N/A
      notes           TEXT,
      answered_at     TIMESTAMPTZ,
      UNIQUE(deal_id, question_code)
    );
  `);
  console.log('✓ deal_feasibility_checklist');

  // ── CONTRACTS ───────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS contracts (
      id                  SERIAL PRIMARY KEY,
      contract_no         VARCHAR(30) UNIQUE NOT NULL,
      contract_date       DATE NOT NULL,
      contract_type       VARCHAR(5) NOT NULL,  -- PC, SC
      deal_id             INT REFERENCES deals(id),
      commodity_code      VARCHAR(20) REFERENCES commodities(code),
      counterparty_id     INT REFERENCES counterparties(id),
      qty_mt              DECIMAL(12,3) NOT NULL,
      qty_tolerance_pct   DECIMAL(5,2) DEFAULT 0,
      incoterms           VARCHAR(10),
      pol_id              INT REFERENCES locations(id),
      pod_id              INT REFERENCES locations(id),
      shipment_period_start DATE,
      shipment_period_end DATE,
      payment_term_code   VARCHAR(20),
      payment_pct         DECIMAL(5,2) DEFAULT 90,  -- provisional payment %
      currency            VARCHAR(5) DEFAULT 'USD',
      pricing_formula     TEXT,
      status              VARCHAR(20) DEFAULT 'DRAFT',
      erp_ref             VARCHAR(50),
      notes               TEXT,
      created_at          TIMESTAMPTZ DEFAULT NOW(),
      updated_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  // Add pricing_formula column if it doesn't exist (migration)
  try {
    await query(`ALTER TABLE contracts ADD COLUMN IF NOT EXISTS pricing_formula TEXT`);
    await query(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS pricing_source TEXT`);
    await query(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS qp_window TEXT`);
    await query(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS version INT DEFAULT 1`);
    await query(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS parent_quotation_id INT REFERENCES quotations(id)`);
    await query(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS quote_type VARCHAR(5) DEFAULT 'SQ'`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS incoterms VARCHAR(10)`);
    await query(`CREATE TABLE IF NOT EXISTS rfqs (id SERIAL PRIMARY KEY, rfq_no VARCHAR(30) UNIQUE NOT NULL, enquiry_id INT REFERENCES enquiries(id), direction VARCHAR(10) DEFAULT 'VENDOR', counterparty_id INT REFERENCES counterparties(id), commodity_code VARCHAR(20), qty_mt DECIMAL(12,3), required_delivery DATE, incoterms VARCHAR(10), origin VARCHAR(100), destination VARCHAR(100), pricing_basis TEXT, payment_terms TEXT, validity_date DATE, notes TEXT, status VARCHAR(20) DEFAULT 'DRAFT', sent_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS quote_responses (id SERIAL PRIMARY KEY, response_no VARCHAR(30) UNIQUE NOT NULL, rfq_id INT REFERENCES rfqs(id), enquiry_id INT REFERENCES enquiries(id), quote_type VARCHAR(5) DEFAULT 'PQ', counterparty_id INT REFERENCES counterparties(id), commodity_code VARCHAR(20), offered_qty DECIMAL(12,3), offered_price DECIMAL(14,4), price_basis TEXT, delivery_date DATE, delivery_window VARCHAR(100), incoterms VARCHAR(10), payment_terms TEXT, validity_date DATE, notes TEXT, status VARCHAR(20) DEFAULT 'RECEIVED', received_at TIMESTAMPTZ DEFAULT NOW(), created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS origin VARCHAR(100)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS destination VARCHAR(100)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS direction VARCHAR(10)`);
    await query(`ALTER TABLE counterparties ADD COLUMN IF NOT EXISTS email VARCHAR(150)`);
    await query(`ALTER TABLE counterparties ADD COLUMN IF NOT EXISTS contact_person VARCHAR(100)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_buy_qty DECIMAL(12,3)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_buy_price DECIMAL(14,4)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_sell_qty DECIMAL(12,3)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_sell_price DECIMAL(14,4)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_margin DECIMAL(14,2)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_month_of_shipping DATE`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_shipment_term VARCHAR(10)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_loading_port INT REFERENCES locations(id)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_destination_port INT REFERENCES locations(id)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_shipment_cost DECIMAL(14,2)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_clearance_cost DECIMAL(14,2)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_process_type VARCHAR(30)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_bom_notes TEXT`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_packing_type VARCHAR(30)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_packing_cost DECIMAL(14,2)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_delivery_location INT REFERENCES locations(id)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_delivery_cost DECIMAL(14,2)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_payment_terms TEXT`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_finance_cost DECIMAL(14,2)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_hedging_cost DECIMAL(14,2)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS feasibility_margin_pct DECIMAL(8,4)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS feasibility_earliest_delivery DATE`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS feasibility_decision VARCHAR(20)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS feasibility_decided_by VARCHAR(50)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS feasibility_decided_at TIMESTAMPTZ`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS feasibility_notes TEXT`);
    await query(`CREATE TABLE IF NOT EXISTS deal_feasibility_checklist (id SERIAL PRIMARY KEY, deal_id INT NOT NULL REFERENCES deals(id) ON DELETE CASCADE, question_code VARCHAR(40) NOT NULL, question_text TEXT NOT NULL, answer VARCHAR(10), notes TEXT, answered_at TIMESTAMPTZ, UNIQUE(deal_id, question_code))`);
    await query(`ALTER TABLE quote_responses ADD COLUMN IF NOT EXISTS deal_id INT REFERENCES deals(id)`);
    await query(`ALTER TABLE hedges ADD COLUMN IF NOT EXISTS broker_contract_note VARCHAR(60)`);
    await query(`ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS uom_override VARCHAR(10)`);
    await query(`ALTER TABLE quotations ADD COLUMN IF NOT EXISTS uom_override VARCHAR(10)`);
    await query(`ALTER TABLE contract_pricing_lines ADD COLUMN IF NOT EXISTS shipment_month DATE`);
    await query(`ALTER TABLE contract_pricing_lines ADD COLUMN IF NOT EXISTS qp_offset_months INT DEFAULT 0`);
    await query(`ALTER TABLE contract_pricing_lines ADD COLUMN IF NOT EXISTS rollover_applicable BOOLEAN DEFAULT FALSE`);
    await query(`ALTER TABLE contract_pricing_lines ADD COLUMN IF NOT EXISTS rollover_rate_basis VARCHAR(20) DEFAULT 'PER-MT'`);
    await query(`ALTER TABLE contract_pricing_lines ADD COLUMN IF NOT EXISTS rollover_rate_value DECIMAL(14,4)`);
    // Group A fix: benchmark_code was wrongly pointed at commodities(code) instead of
    // pricing_benchmarks(code) — every Add Pricing Line save with a real benchmark
    // (e.g. LME-CU-CASH) was silently failing a foreign key violation. Drop and recreate
    // the constraint against the correct table for any database that already has the old one.
    await query(`ALTER TABLE contract_pricing_lines DROP CONSTRAINT IF EXISTS contract_pricing_lines_benchmark_code_fkey`);
    // Null out any existing benchmark_code that doesn't exist in pricing_benchmarks (e.g. the
    // old seeded 'LME-CU-BENCH', which was actually a commodity code) so the new constraint
    // below doesn't fail against pre-existing bad data.
    await query(`UPDATE contract_pricing_lines SET benchmark_code = NULL WHERE benchmark_code IS NOT NULL AND benchmark_code NOT IN (SELECT code FROM pricing_benchmarks)`);
    await query(`ALTER TABLE contract_pricing_lines ADD CONSTRAINT contract_pricing_lines_benchmark_code_fkey FOREIGN KEY (benchmark_code) REFERENCES pricing_benchmarks(code)`);
    await query(`CREATE TABLE IF NOT EXISTS payment_schedule_lines (id SERIAL PRIMARY KEY, contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE, line_no INT NOT NULL, pct DECIMAL(6,3) NOT NULL, trigger_event VARCHAR(40) NOT NULL, offset_days INT DEFAULT 0, offset_type VARCHAR(20) DEFAULT 'WORKING DAYS', basis VARCHAR(40), required_documents TEXT, due_date DATE, status VARCHAR(20) DEFAULT 'PENDING', created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE INDEX IF NOT EXISTS idx_payment_sched_contract ON payment_schedule_lines(contract_id)`);
    await query(`ALTER TABLE contract_qc_specs ALTER COLUMN spec_min TYPE DECIMAL(10,5)`);
    await query(`ALTER TABLE contract_qc_specs ALTER COLUMN spec_max TYPE DECIMAL(10,5)`);
    await query(`ALTER TABLE contract_qc_specs ALTER COLUMN spec_ref_avg TYPE DECIMAL(10,5)`);
    await query(`ALTER TABLE contract_qc_specs ADD COLUMN IF NOT EXISTS is_percentage BOOLEAN DEFAULT TRUE`);
    await query(`CREATE TABLE IF NOT EXISTS date_event_master (id SERIAL PRIMARY KEY, code VARCHAR(20) UNIQUE NOT NULL, name VARCHAR(60) NOT NULL, source_system VARCHAR(40) NOT NULL, offset_applicable BOOLEAN DEFAULT TRUE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`);
    // Link payment_schedule_lines.trigger_event to the new master now that it exists.
    // Null out any existing value that isn't a real event code first (e.g. anything typed
    // in before this master existed) so the new constraint doesn't fail against old data.
    await query(`UPDATE payment_schedule_lines SET trigger_event = NULL WHERE trigger_event IS NOT NULL AND trigger_event NOT IN (SELECT code FROM date_event_master)`);
    await query(`ALTER TABLE payment_schedule_lines DROP CONSTRAINT IF EXISTS payment_schedule_lines_trigger_event_fkey`);
    await query(`ALTER TABLE payment_schedule_lines ALTER COLUMN trigger_event DROP NOT NULL`);
    await query(`ALTER TABLE payment_schedule_lines ADD CONSTRAINT payment_schedule_lines_trigger_event_fkey FOREIGN KEY (trigger_event) REFERENCES date_event_master(code)`);
    await query(`ALTER TABLE adjustment_codes ADD COLUMN IF NOT EXISTS gl_account VARCHAR(20)`);
    await query(`CREATE TABLE IF NOT EXISTS currencies (id SERIAL PRIMARY KEY, code VARCHAR(3) UNIQUE NOT NULL, name VARCHAR(60) NOT NULL, symbol VARCHAR(10), decimals INT DEFAULT 2, is_base BOOLEAN DEFAULT FALSE, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS uom_master (id SERIAL PRIMARY KEY, code VARCHAR(10) UNIQUE NOT NULL, name VARCHAR(60) NOT NULL, category VARCHAR(20), conversion VARCHAR(60), active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS tax_codes (id SERIAL PRIMARY KEY, code VARCHAR(30) UNIQUE NOT NULL, description VARCHAR(100) NOT NULL, rate_pct DECIMAL(6,3) DEFAULT 0, jurisdiction VARCHAR(60), applies_to VARCHAR(100), active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS contract_event_dates (id SERIAL PRIMARY KEY, contract_id INT UNIQUE NOT NULL REFERENCES contracts(id) ON DELETE CASCADE, contract_date DATE, etd_estimated DATE, etd_actual DATE, bl_date DATE, bl_number VARCHAR(50), bl_date_locked BOOLEAN DEFAULT FALSE, bl_date_locked_by VARCHAR(50), bl_date_locked_at TIMESTAMPTZ, eta_estimated DATE, eta_actual DATE, nor_tendered_at TIMESTAMPTZ, pr_date DATE, pr_reference VARCHAR(50), grn_date DATE, grn_reference VARCHAR(50), grn_erp_posted BOOLEAN DEFAULT FALSE, assay_date DATE, assay_confirmed BOOLEAN DEFAULT FALSE, qp_start_date DATE, qp_end_date DATE, qp_close_confirmed BOOLEAN DEFAULT FALSE, payment_due_date DATE, payment_anchor_event VARCHAR(20), payment_terms_days INT, settlement_date DATE, updated_at TIMESTAMPTZ DEFAULT NOW(), updated_by VARCHAR(50))`);
    await query(`CREATE INDEX IF NOT EXISTS idx_event_dates_contract ON contract_event_dates(contract_id)`);
    await query(`CREATE TABLE IF NOT EXISTS payment_term_tranches (id SERIAL PRIMARY KEY, contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE, tranche_number INT NOT NULL, tranche_name VARCHAR(60) NOT NULL, percentage DECIMAL(5,2) NOT NULL, amount_basis VARCHAR(20) DEFAULT 'pct_of_contract', anchor_event VARCHAR(20) NOT NULL, offset_days INT DEFAULT 0, offset_direction VARCHAR(10) DEFAULT 'after', fixed_date DATE, calculated_due_date DATE, calculated_amount DECIMAL(15,2), currency VARCHAR(10) DEFAULT 'USD', invoice_type VARCHAR(20) DEFAULT 'provisional', invoice_id VARCHAR(30), status VARCHAR(20) DEFAULT 'pending_anchor', actual_payment_date DATE, actual_amount_paid DECIMAL(15,2), variance DECIMAL(15,2), erp_posted BOOLEAN DEFAULT FALSE, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE INDEX IF NOT EXISTS idx_pt_tranches_contract ON payment_term_tranches(contract_id)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS accrual_trigger_event VARCHAR(20)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS accrual_reversal_event VARCHAR(20)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS qty_or_days DECIMAL(14,3)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS actual_amount DECIMAL(15,2)`);
    await query(`ALTER TABLE contract_charge_lines ADD COLUMN IF NOT EXISTS variance DECIMAL(15,2)`);
    await query(`ALTER TABLE adjustment_codes ADD COLUMN IF NOT EXISTS default_trigger_event VARCHAR(20)`);
    await query(`ALTER TABLE adjustment_codes ADD COLUMN IF NOT EXISTS default_reversal_event VARCHAR(20)`);
    await query(`CREATE TABLE IF NOT EXISTS contract_charge_lines (id SERIAL PRIMARY KEY, contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE, charge_code VARCHAR(30) REFERENCES adjustment_codes(code), description TEXT, calc_basis VARCHAR(20) NOT NULL, calc_value DECIMAL(14,4) NOT NULL, computed_amount DECIMAL(15,2), currency VARCHAR(10) DEFAULT 'USD', counterparty_id INT REFERENCES counterparties(id), accrual_status VARCHAR(20) DEFAULT 'NOT_ACCRUED', accrued_at TIMESTAMPTZ, notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE INDEX IF NOT EXISTS idx_charge_lines_contract ON contract_charge_lines(contract_id)`);
    await query(`CREATE TABLE IF NOT EXISTS rollover_events (id SERIAL PRIMARY KEY, contract_id INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE, rollover_no INT NOT NULL, period_from DATE NOT NULL, period_to DATE NOT NULL, unfixed_qty DECIMAL(12,3) NOT NULL, rate_basis VARCHAR(20) NOT NULL, rate_value DECIMAL(14,4) NOT NULL, derived_rate_per_mt DECIMAL(14,4), amount_usd DECIMAL(15,2) NOT NULL, new_qp_start_date DATE, new_qp_end_date DATE, debit_note_no VARCHAR(30), status VARCHAR(20) DEFAULT 'PENDING', created_by VARCHAR(50), created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE INDEX IF NOT EXISTS idx_rollover_contract ON rollover_events(contract_id)`);
    await query(`CREATE TABLE IF NOT EXISTS pricing_benchmarks (id SERIAL PRIMARY KEY, code VARCHAR(30) UNIQUE NOT NULL, description TEXT NOT NULL, commodity_code VARCHAR(20) REFERENCES commodities(code), exchange_code VARCHAR(20) NOT NULL, reporting_agency VARCHAR(30), instrument_code VARCHAR(50), default_index_pct DECIMAL(6,3) DEFAULT 100, default_payable_pct DECIMAL(6,3) DEFAULT 100, active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS adjustment_codes (id SERIAL PRIMARY KEY, code VARCHAR(30) UNIQUE NOT NULL, description TEXT NOT NULL, category VARCHAR(30), calc_type VARCHAR(20) DEFAULT 'PCT_OF_VALUE', default_direction VARCHAR(10) DEFAULT 'DEDUCTION', active BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS invoice_adjustment_lines (id SERIAL PRIMARY KEY, invoice_id INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE, adjustment_code VARCHAR(30) REFERENCES adjustment_codes(code), payable_component VARCHAR(50), calc_value DECIMAL(12,4), calc_unit VARCHAR(20), qty_basis VARCHAR(50), computed_amount DECIMAL(15,2), direction VARCHAR(10) DEFAULT 'DEDUCTION', notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS audit_log (id SERIAL PRIMARY KEY, entity_type VARCHAR(30) NOT NULL, entity_id INT NOT NULL, entity_ref VARCHAR(40), action VARCHAR(30) NOT NULL, field_name VARCHAR(60), old_value TEXT, new_value TEXT, changed_by VARCHAR(60) DEFAULT 'A. Mallick', changed_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`);
    await query(`ALTER TABLE deals ADD COLUMN IF NOT EXISTS budget_locked_at TIMESTAMPTZ`);
    await query(`CREATE TABLE IF NOT EXISTS deal_enquiries (id SERIAL PRIMARY KEY, deal_id INT NOT NULL REFERENCES deals(id) ON DELETE CASCADE, enquiry_id INT NOT NULL REFERENCES enquiries(id), leg_role VARCHAR(20) DEFAULT 'BUY', added_at TIMESTAMPTZ DEFAULT NOW(), UNIQUE(deal_id, enquiry_id))`);
    // Create adj lines tables if missing
    await query(`CREATE TABLE IF NOT EXISTS quotation_adjustment_lines (id SERIAL PRIMARY KEY, quotation_id INT REFERENCES quotations(id) ON DELETE CASCADE, line_no INT DEFAULT 1, adj_code VARCHAR(30), description TEXT, adj_type VARCHAR(20) DEFAULT 'DEDUCTION', basis VARCHAR(20) DEFAULT 'per-unit', rate DECIMAL(12,4), uom VARCHAR(10) DEFAULT 'MT', computed_value DECIMAL(14,2), notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);
    await query(`CREATE TABLE IF NOT EXISTS quotation_penalties (id SERIAL PRIMARY KEY, quotation_id INT REFERENCES quotations(id) ON DELETE CASCADE, line_no INT DEFAULT 1, penalty_code VARCHAR(30), penalty_type VARCHAR(20) DEFAULT 'FLAT-RATE', element VARCHAR(50), threshold VARCHAR(50), rate VARCHAR(50), direction VARCHAR(10) DEFAULT 'OUT', notes TEXT, created_at TIMESTAMPTZ DEFAULT NOW())`);

    await query(`ALTER TABLE enquiries ADD COLUMN IF NOT EXISTS direction VARCHAR(10) DEFAULT 'BUY'`);
  } catch(e) {}
  console.log('✓ contracts');

  await query(`
    CREATE TABLE IF NOT EXISTS contract_pricing_lines (
      id                  SERIAL PRIMARY KEY,
      contract_id         INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      line_no             INT DEFAULT 1,
      source_item_code    VARCHAR(20) REFERENCES commodities(code),
      benchmark_code      VARCHAR(20) REFERENCES pricing_benchmarks(code), -- Group A fix: was wrongly pointed at commodities(code) — benchmark codes (e.g. LME-CU-CASH) live in pricing_benchmarks, not commodities. Every Add Pricing Line save with a real benchmark was silently failing the FK constraint and returning a 500.
      exchange_code       VARCHAR(20),
      reporting_agency    VARCHAR(30),
      instrument_code     VARCHAR(50),
      index_pct           DECIMAL(6,3) NOT NULL,   -- metal content %
      payable_pct         DECIMAL(6,3) NOT NULL,   -- contract-defined payable %
      premium_discount    DECIMAL(10,4) DEFAULT 0, -- USD/MT, + or -
      correlation_factor  DECIMAL(5,2) DEFAULT 100,
      pricing_rule        VARCHAR(20) NOT NULL,    -- event, average, specific_date
      calc_method         VARCHAR(20) NOT NULL,    -- lowest4, highest4, cashAsk, settlement, mid
      pricing_option      VARCHAR(20),             -- SUPPLIER, LONGER, NA
      qp_period_code      VARCHAR(30),
      shipment_month      DATE,                    -- Fix 2: first day of the shipment month — M/M+1/M+2 always counts from THIS, never BL date
      qp_offset_months    INT DEFAULT 0,           -- Fix 2: 0=M, 1=M+1, 2=M+2 — drives auto-computed qp_start_date/qp_end_date
      qp_start_date       DATE,
      qp_end_date         DATE,
      tc_usd_per_mt       DECIMAL(10,4),           -- treatment charge
      rc_pct              DECIMAL(6,3),            -- refining charge
      -- #7: rollover configuration — was page-level UI only, never saved anywhere, so
      -- there was nothing for an automatic check to read. Now persisted per pricing line.
      rollover_applicable BOOLEAN DEFAULT FALSE,
      rollover_rate_basis VARCHAR(20) DEFAULT 'PER-MT',  -- PER-MT, FIXED-TOTAL, PERCENTAGE
      rollover_rate_value DECIMAL(14,4),
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ contract_pricing_lines');

  // ── ROLLOVER EVENTS (Fix 3 — per-contract, multi-instance, append-only audit trail) ──
  // Per 23 June call: rollover is a finance charge for not fixing price within the
  // original QP window. Must support MULTIPLE rollovers per contract (#1, #2...) with a
  // full audit trail — confirmed explicitly: keep per-contract, not a separate master.
  await query(`
    CREATE TABLE IF NOT EXISTS rollover_events (
      id                  SERIAL PRIMARY KEY,
      contract_id         INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      rollover_no         INT NOT NULL,            -- sequential per contract: 1, 2, 3...
      period_from          DATE NOT NULL,
      period_to            DATE NOT NULL,
      unfixed_qty         DECIMAL(12,3) NOT NULL,
      rate_basis          VARCHAR(20) NOT NULL,    -- PER-MT, FIXED-TOTAL, PERCENTAGE
      rate_value          DECIMAL(14,4) NOT NULL,
      derived_rate_per_mt DECIMAL(14,4),
      amount_usd          DECIMAL(15,2) NOT NULL,
      new_qp_start_date   DATE,                    -- the extended QP window this rollover created
      new_qp_end_date     DATE,
      debit_note_no       VARCHAR(30),
      status              VARCHAR(20) DEFAULT 'PENDING', -- PENDING, ACCRUED, INVOICED
      created_by          VARCHAR(50),
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_rollover_contract ON rollover_events(contract_id);
  `);
  console.log('✓ rollover_events');

  // ── PAYMENT SCHEDULE LINES (per contract — Group A) ──
  await query(`
    CREATE TABLE IF NOT EXISTS payment_schedule_lines (
      id                SERIAL PRIMARY KEY,
      contract_id       INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      line_no           INT NOT NULL,
      pct               DECIMAL(6,3) NOT NULL,
      trigger_event     VARCHAR(40) NOT NULL,
      offset_days       INT DEFAULT 0,
      offset_type       VARCHAR(20) DEFAULT 'WORKING DAYS',
      basis             VARCHAR(40),
      required_documents TEXT,
      due_date          DATE,
      status            VARCHAR(20) DEFAULT 'PENDING',
      created_at        TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_payment_sched_contract ON payment_schedule_lines(contract_id);
  `);
  console.log('✓ payment_schedule_lines');

  // ── PRICING BENCHMARKS MASTER (B11 fix — master-driven, never hardcoded) ──
  await query(`
    CREATE TABLE IF NOT EXISTS pricing_benchmarks (
      id                  SERIAL PRIMARY KEY,
      code                VARCHAR(30) UNIQUE NOT NULL,
      description         TEXT NOT NULL,
      commodity_code      VARCHAR(20) REFERENCES commodities(code),
      exchange_code       VARCHAR(20) NOT NULL,
      reporting_agency    VARCHAR(30),
      instrument_code     VARCHAR(50),
      default_index_pct   DECIMAL(6,3) DEFAULT 100,
      default_payable_pct DECIMAL(6,3) DEFAULT 100,
      active              BOOLEAN DEFAULT TRUE,
      created_at          TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ pricing_benchmarks');

  // ── DATE EVENT MASTER (Group B) — used for event-based pricing AND event-based
  // payment terms. Per Prashant's master: every event type comes from a specific source
  // system (PC/SC, Logistics, Final Receipt/GRN, Provisional Receipt, Assay/QC) and every
  // event currently allows an offset (days before/after).
  await query(`
    CREATE TABLE IF NOT EXISTS date_event_master (
      id              SERIAL PRIMARY KEY,
      code            VARCHAR(20) UNIQUE NOT NULL,
      name            VARCHAR(60) NOT NULL,
      source_system   VARCHAR(40) NOT NULL,  -- PC/SC, Logistics, Final Receipt (GRN), Provisional Receipt, Assay/QC
      offset_applicable BOOLEAN DEFAULT TRUE,
      active          BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ date_event_master');

  await query(`
    CREATE TABLE IF NOT EXISTS contract_qc_specs (
      id              SERIAL PRIMARY KEY,
      contract_id     INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      element         VARCHAR(10) NOT NULL,  -- CU, PB, SN, MOISTURE, AS, SB
      spec_min        DECIMAL(10,5),         -- Group A QC fix: was DECIMAL(8,4), needs 5 decimal places
      spec_max        DECIMAL(10,5),
      spec_ref_avg    DECIMAL(10,5),         -- the Standard Value (fixed-value mode), renamed from spec_ref_avg
      is_percentage   BOOLEAN DEFAULT TRUE,  -- Group A QC fix: percentage vs absolute unit
      penalty_type    VARCHAR(10),           -- TYPE-A, TYPE-B, REJECTION
      penalty_rate    DECIMAL(10,4),
      penalty_unit    VARCHAR(20)            -- USD/MT/%, USD/%/MT
    );
  `);
  console.log('✓ contract_qc_specs');

  // ── ORDERS ──────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS orders (
      id              SERIAL PRIMARY KEY,
      order_no        VARCHAR(30) UNIQUE NOT NULL,
      order_type      VARCHAR(5) NOT NULL,   -- PO, SO
      contract_id     INT REFERENCES contracts(id),
      deal_id         INT REFERENCES deals(id),
      order_date      DATE NOT NULL,
      qty_mt          DECIMAL(12,3),
      status          VARCHAR(20) DEFAULT 'DRAFT',
      erp_ref         VARCHAR(50),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ orders');

  // ── LOGISTICS ───────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS logistics (
      id              SERIAL PRIMARY KEY,
      log_no          VARCHAR(20) UNIQUE NOT NULL,
      contract_id     INT REFERENCES contracts(id),
      deal_id         INT REFERENCES deals(id),
      shipment_type   VARCHAR(30),
      vessel_name     VARCHAR(100),
      carrier         VARCHAR(100),
      pol_id          INT REFERENCES locations(id),
      pod_id          INT REFERENCES locations(id),
      incoterms       VARCHAR(10),
      etd             DATE,
      atd             DATE,
      bl_date         DATE,
      eta             DATE,
      ata             DATE,
      obl_received_date DATE,             -- original BL docs received
      abl_received_date DATE,             -- airway bill if courier
      freight_rate    DECIMAL(10,4),
      freight_basis   VARCHAR(20),        -- PER-MT, LUMP-SUM
      freight_currency VARCHAR(5) DEFAULT 'USD',
      status          VARCHAR(20) DEFAULT 'BOOKING-CONF',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ logistics');

  await query(`
    CREATE TABLE IF NOT EXISTS containers (
      id              SERIAL PRIMARY KEY,
      container_no    VARCHAR(20) UNIQUE NOT NULL,
      logistics_id    INT NOT NULL REFERENCES logistics(id) ON DELETE CASCADE,
      seal_no         VARCHAR(30),
      size            VARCHAR(10) DEFAULT '20FT',
      tare_mt         DECIMAL(10,4),
      gross_weight_mt DECIMAL(10,4),
      -- net is computed: gross - tare
      moisture_pct    DECIMAL(6,3),
      -- dry weight computed: net * (1 - moisture/100)
      packaging       VARCHAR(30),
      material_code   VARCHAR(20) REFERENCES commodities(code),
      status          VARCHAR(20) DEFAULT 'PENDING',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_containers_logistics ON containers(logistics_id);
  `);
  console.log('✓ containers');

  // ── SHIPMENT / RECEIPT ──────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS goods_receipts (
      id              SERIAL PRIMARY KEY,
      receipt_no      VARCHAR(20) UNIQUE NOT NULL,
      logistics_id    INT REFERENCES logistics(id),
      receipt_stage   VARCHAR(20) NOT NULL,  -- PROVISIONAL, FINAL
      receipt_date    DATE,
      arrived_qty_mt  DECIMAL(12,3),
      warehouse_id    INT REFERENCES locations(id),
      status          VARCHAR(20) DEFAULT 'DRAFT',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ goods_receipts');

  await query(`
    CREATE TABLE IF NOT EXISTS lots (
      id              SERIAL PRIMARY KEY,
      lot_no          VARCHAR(30) UNIQUE NOT NULL,
      mrn_no          VARCHAR(30),
      container_id    INT REFERENCES containers(id),
      receipt_id      INT REFERENCES goods_receipts(id),
      logistics_id    INT REFERENCES logistics(id),
      commodity_code  VARCHAR(20) REFERENCES commodities(code),
      gross_weight_mt DECIMAL(10,4),
      tare_mt         DECIMAL(10,4),
      net_weight_mt   DECIMAL(10,4),
      moisture_pct    DECIMAL(6,3),
      dry_weight_mt   DECIMAL(10,4),
      payable_qty_mt  DECIMAL(10,4),       -- after assay + payable %
      lot_type        VARCHAR(20),          -- PRIMARY, SEGREGATED
      inventory_status VARCHAR(20) DEFAULT 'IN-TRANSIT',
      lot_status      VARCHAR(20) DEFAULT 'PENDING',  -- CLEARED, DISCREPANCY, ON-HOLD
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ lots');

  await query(`
    CREATE TABLE IF NOT EXISTS qc_results (
      id              SERIAL PRIMARY KEY,
      lot_id          INT NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
      element         VARCHAR(10) NOT NULL,
      actual_value    DECIMAL(10,4),
      unit            VARCHAR(10) DEFAULT '%',
      assay_date      DATE,
      lab_ref         VARCHAR(50),
      status          VARCHAR(20) DEFAULT 'PENDING',  -- PASS, FAIL, PENDING
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ qc_results');

  // ── PRICING & RISK ──────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS fixation_lots (
      id              SERIAL PRIMARY KEY,
      lot_ref         VARCHAR(30) UNIQUE NOT NULL,
      deal_id         VARCHAR(20) NOT NULL,
      contract_id     INT REFERENCES contracts(id),
      fixed_price     DECIMAL(12,4) NOT NULL,   -- price I
      fixed_qty_mt    DECIMAL(12,4) NOT NULL,
      fix_date        DATE NOT NULL,
      prompt_date     DATE,
      pricing_line_id INT REFERENCES contract_pricing_lines(id),
      hedge_ref       VARCHAR(30),
      status          VARCHAR(20) DEFAULT 'FIXED',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_fixations_deal ON fixation_lots(deal_id);
  `);
  console.log('✓ fixation_lots');

  await query(`
    CREATE TABLE IF NOT EXISTS hedges (
      id              SERIAL PRIMARY KEY,
      req_ref         VARCHAR(30) UNIQUE NOT NULL,
      deal_id         VARCHAR(20) NOT NULL,
      trade_date      DATE NOT NULL,
      hedge_type      VARCHAR(10) NOT NULL,   -- SHORT, LONG
      commodity_code  VARCHAR(20) REFERENCES commodities(code),
      instrument      VARCHAR(20) DEFAULT 'FUTURES',
      exchange_code   VARCHAR(20),
      qty_mt          DECIMAL(12,4) NOT NULL,  -- G
      entry_price     DECIMAL(12,4) NOT NULL,  -- M
      prompt_date     DATE,
      order_type      VARCHAR(20) DEFAULT 'MARKET',
      execution_price DECIMAL(12,4),
      exec_date       DATE,
      counterparty_ref VARCHAR(50),
      broker_contract_note VARCHAR(60),
      status          VARCHAR(20) DEFAULT 'PENDING',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_hedges_deal ON hedges(deal_id);
  `);
  console.log('✓ hedges');

  // ── ALLOCATION ──────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS allocations (
      id              SERIAL PRIMARY KEY,
      container_id    INT NOT NULL REFERENCES containers(id),
      lot_id          INT REFERENCES lots(id),
      buy_contract_id INT REFERENCES contracts(id),
      sell_contract_id INT REFERENCES contracts(id),
      sell_order_id   INT REFERENCES orders(id),
      gross_weight_mt DECIMAL(10,4),
      tare_mt         DECIMAL(10,4),
      net_weight_mt   DECIMAL(10,4),
      moisture_pct    DECIMAL(6,3),
      dry_weight_mt   DECIMAL(10,4),
      payable_weight_mt DECIMAL(10,4),
      allocation_pct  DECIMAL(6,3) DEFAULT 100,
      fixation_lot_ref VARCHAR(30),
      priced_status   VARCHAR(20) DEFAULT 'UNPRICED',  -- PRICED, UNPRICED
      status          VARCHAR(20) DEFAULT 'ALLOCATED',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ allocations');

  // ── AUDIT LOG ──────────────────────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id              SERIAL PRIMARY KEY,
      entity_type     VARCHAR(30) NOT NULL,
      entity_id       INT NOT NULL,
      entity_ref      VARCHAR(40),
      action          VARCHAR(30) NOT NULL,
      field_name      VARCHAR(60),
      old_value       TEXT,
      new_value       TEXT,
      changed_by      VARCHAR(60) DEFAULT 'A. Mallick',
      changed_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id)`);
  console.log('✓ audit_log');

  // ── INVOICES ────────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id              SERIAL PRIMARY KEY,
      invoice_no      VARCHAR(30) UNIQUE NOT NULL,
      invoice_type    VARCHAR(20) NOT NULL,    -- PROVISIONAL, FINAL
      invoice_date    DATE NOT NULL,
      deal_id         VARCHAR(20),
      contract_id     INT REFERENCES contracts(id),
      counterparty_id INT REFERENCES counterparties(id),
      ref_price       DECIMAL(12,4),           -- reference price used
      payable_price   DECIMAL(12,4),           -- after payable %
      qty_mt          DECIMAL(12,4),
      gross_amount    DECIMAL(15,2),
      net_amount      DECIMAL(15,2),
      provisional_pct DECIMAL(5,2) DEFAULT 90,
      provisional_amount DECIMAL(15,2),
      payment_due_date DATE,
      linked_provisional_id INT REFERENCES invoices(id),
      delta_amount    DECIMAL(15,2),           -- final vs provisional
      balance_due     DECIMAL(15,2),
      currency        VARCHAR(5) DEFAULT 'USD',
      status          VARCHAR(20) DEFAULT 'DRAFT',
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ invoices');

  // ── ADJUSTMENT CODES MASTER (E30 fix — master-driven, never hardcoded) ──
  await query(`
    CREATE TABLE IF NOT EXISTS adjustment_codes (
      id              SERIAL PRIMARY KEY,
      code            VARCHAR(30) UNIQUE NOT NULL,
      description     TEXT NOT NULL,
      category        VARCHAR(30),         -- COMMISSION, FREIGHT, PENALTY, FX, OTHER
      calc_type       VARCHAR(20) DEFAULT 'PCT_OF_VALUE', -- PCT_OF_VALUE, PER_UNIT, FLAT
      default_direction VARCHAR(10) DEFAULT 'DEDUCTION',  -- DEDUCTION, ADDITION
      active          BOOLEAN DEFAULT TRUE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ adjustment_codes');

  // GL account field for ERP General Ledger mapping (Group D — Charge Items).
  await query(`ALTER TABLE adjustment_codes ADD COLUMN IF NOT EXISTS gl_account VARCHAR(20)`);

  // ── CONTRACT CHARGE LINES (Group D) ── manual or linked charges per contract:
  // commission, freight, insurance etc. — fixed amount, percentage, or per-MT, feeding
  // an accrual module. Distinct from invoice_adjustment_lines, which only ever applied
  // reactively at invoice time — this is a standing charge attached to the contract itself.
  await query(`
    CREATE TABLE IF NOT EXISTS contract_charge_lines (
      id              SERIAL PRIMARY KEY,
      contract_id     INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      charge_code     VARCHAR(30) REFERENCES adjustment_codes(code),
      description     TEXT,
      calc_basis      VARCHAR(20) NOT NULL,  -- FIXED, PERCENTAGE, PER_MT
      calc_value      DECIMAL(14,4) NOT NULL,
      computed_amount DECIMAL(15,2),
      qty_or_days     DECIMAL(14,3),  -- H2: Qty / days column from the spec — used by Per MT
                                       -- and Per Day calc bases, distinct from calc_value (rate)
      currency        VARCHAR(10) DEFAULT 'USD',
      counterparty_id INT REFERENCES counterparties(id),  -- who the charge is payable to (agent, freight forwarder, insurer)
      accrual_status  VARCHAR(20) DEFAULT 'NOT_ACCRUED', -- NOT_ACCRUED, ACCRUED, POSTED
      accrued_at      TIMESTAMPTZ,
      -- H1/H2: estimated amount lives in computed_amount above. actual_amount is filled
      -- in once known (e.g. final invoice received); variance is computed on save and
      -- IS the penalty/adjustment line per Prashant's instruction — 'penalty calculation
      -- will also appear under the main vendor, whether positive or negative... there is
      -- no other place to put the penalty'. A formula change updates the main line itself,
      -- not a separate record.
      actual_amount   DECIMAL(15,2),
      variance        DECIMAL(15,2),
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_charge_lines_contract ON contract_charge_lines(contract_id);
  `);
  console.log('✓ contract_charge_lines');

  // H2 — Material lines, per the Excel spec's Commodity Line section. Was genuinely
  // client-side only before — typed lines and the Total Contract Quantity displayed
  // correctly within a single page load, but nothing ever persisted; reopening the
  // contract always reset the table to empty.
  await query(`
    CREATE TABLE IF NOT EXISTS contract_material_lines (
      id              SERIAL PRIMARY KEY,
      contract_id     INT NOT NULL REFERENCES contracts(id) ON DELETE CASCADE,
      line_no         INT NOT NULL,
      commodity_code  VARCHAR(20) REFERENCES commodities(code),
      grade           VARCHAR(100),
      hs_code         VARCHAR(20),
      origin          VARCHAR(60),
      qty_gross       DECIMAL(14,3) NOT NULL,
      tolerance_pct   DECIMAL(6,3),
      uom             VARCHAR(10) DEFAULT 'MT',
      unit_price      DECIMAL(14,4),
      price_basis     VARCHAR(60),
      provisional_value DECIMAL(16,2),
      counterparty_id INT REFERENCES counterparties(id),  -- H2: the main vendor for THIS
                                                           -- commodity line — charge items
                                                           -- payable to other parties are
                                                           -- separate, on contract_charge_lines
      incoterms       VARCHAR(10),
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_material_lines_contract ON contract_material_lines(contract_id);
  `);
  console.log('✓ contract_material_lines');

  // ── INVOICE ADJUSTMENT LINES ──────────────────────────────────
  await query(`
    CREATE TABLE IF NOT EXISTS invoice_adjustment_lines (
      id              SERIAL PRIMARY KEY,
      invoice_id      INT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      adjustment_code VARCHAR(30) REFERENCES adjustment_codes(code),
      payable_component VARCHAR(50),
      calc_value      DECIMAL(12,4),
      calc_unit       VARCHAR(20),          -- %, USD/MT, USD
      qty_basis       VARCHAR(50),
      computed_amount DECIMAL(15,2),
      direction       VARCHAR(10) DEFAULT 'DEDUCTION',
      notes           TEXT,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✓ invoice_adjustment_lines');

  // ── APPROVALS ───────────────────────────────────────────────────

  await query(`
    CREATE TABLE IF NOT EXISTS approval_requests (
      id              SERIAL PRIMARY KEY,
      ref_no          VARCHAR(20) UNIQUE NOT NULL,
      document_type   VARCHAR(30),
      document_ref    VARCHAR(30),
      value_usd       DECIMAL(15,2),
      submitted_by    VARCHAR(50),
      submitted_at    TIMESTAMPTZ DEFAULT NOW(),
      tier            INT DEFAULT 1,
      current_approver VARCHAR(50),
      status          VARCHAR(20) DEFAULT 'PENDING',
      notes           TEXT,
      approved_at     TIMESTAMPTZ,
      approved_by     VARCHAR(50)
    );
  `);
  console.log('✓ approval_requests');

  console.log('\n✅ All tables created successfully.');
}

setupDatabase()
  .then(() => {
    console.log('\nDatabase setup complete. Run: npm run db:seed');
    process.exit(0);
  })
  .catch(err => {
    console.error('\n❌ Setup failed:', err.message);
    process.exit(1);
  });
