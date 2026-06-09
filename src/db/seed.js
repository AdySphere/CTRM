const { query } = require('./index');

async function seed() {
  console.log('Seeding CTRM database with demo data...\n');

  // ── COMMODITIES ─────────────────────────────────────────────────
  await query(`
    INSERT INTO commodities (code, name, category, type, uom, exchange_code, currency, correlation_factor, erp_item_ref)
    VALUES
      ('CU-MILLBERRY',  'Copper MillBerry (Scrap)',      'BASE-METAL', 'SCRAP',       'MT', 'LME',   'USD', 91.00, 'ITEM-010'),
      ('CU-BERRY',      'Copper Berry (Lower Grade)',    'BASE-METAL', 'SCRAP',       'MT', 'LME',   'USD', 80.00, 'ITEM-011'),
      ('CU-CATHODE-A',  'Copper Cathode Grade A',        'BASE-METAL', 'REFINED',     'MT', 'LME',   'USD', 100.00,'ITEM-001'),
      ('PB-SN-INGOT',   'Lead-Tin Ingots (PbSnSb)',      'BASE-METAL', 'ALLOY',       'MT', 'LME',   'USD', 100.00,'ITEM-020'),
      ('STEEL-HMS1',    'Steel Scrap HMS 1&2',           'FERROUS',    'SCRAP',       'MT', 'CFR',   'USD', 100.00,'ITEM-006'),
      ('LME-CU-BENCH',  'LME Copper Cathode (Benchmark)','BASE-METAL','REFINED',     'MT', 'LME',   'USD', 100.00, NULL),
      ('ICE-BRENT',     'ICE Brent Crude',               'ENERGY',     'CRUDE',       'BBL','ICE',   'USD', 100.00, NULL),
      ('PLATTS-DUBAI',  'Dubai Crude (Platts)',          'ENERGY',     'CRUDE',       'BBL','PLATTS','USD', 100.00, NULL),
      ('CBOT-WHEAT',    'CBOT Wheat SRW',                'AGRICULTURAL','GRAIN',      'BU', 'CBOT',  'USD', 100.00, NULL),
      ('CBOT-SOY',      'CBOT Soybeans',                 'AGRICULTURAL','OILSEED',    'BU', 'CBOT',  'USD', 100.00, NULL)
    ON CONFLICT (code) DO NOTHING;
  `);
  console.log('✓ commodities seeded');

  // ── COUNTERPARTIES ───────────────────────────────────────────────
  await query(`
    INSERT INTO counterparties (code, name, type, country, currency, payment_term_code, tax_ref, erp_ref, kyc_status)
    VALUES
      ('GLEN-AG',   'Glencore AG',            'VENDOR',   'Switzerland', 'USD', 'LC-SIGHT-100', 'CHE-123456', 'V-001', 'APPROVED'),
      ('TATA-MET',  'Tata Metals Ltd',        'CUSTOMER', 'India',       'USD', 'TT-90-10',     'IN-MUM-001', 'C-001', 'APPROVED'),
      ('AURUBIS',   'Aurubis Beerse NV',      'CUSTOMER', 'Belgium',     'USD', 'TT-70-30',     'BE0403075580','C-003','APPROVED'),
      ('NOBLE-SG',  'Noble Resources Pte',    'VENDOR',   'Singapore',   'USD', 'LC-SIGHT-100', 'SG-789012',  'V-002', 'APPROVED'),
      ('HANWA-SG',  'Hanwa Singapore PTE',    'AGENT',    'Singapore',   'USD', 'COMMISSION',   'SG-AGT-001', 'A-001', 'APPROVED'),
      ('VITOL-SA',  'Vitol SA',               'VENDOR',   'Switzerland', 'USD', 'TT-90-10',     'CHE-VITOL',  'V-003', 'APPROVED'),
      ('BP-TRAD',   'BP Trading Ltd',         'CUSTOMER', 'UK',          'USD', 'TT-90-10',     'UK-BP-001',  'C-004', 'APPROVED')
    ON CONFLICT (code) DO NOTHING;
  `);
  console.log('✓ counterparties seeded');

  // ── LOCATIONS ────────────────────────────────────────────────────
  await query(`
    INSERT INTO locations (code, name, type, country, region, un_locode)
    VALUES
      ('DAR-TZ',   'Dar es Salaam',    'PORT',      'Tanzania',    'East Africa',  'TZDAR'),
      ('JNPT-IN',  'Nhava Sheva JNPT', 'PORT',      'India',       'West India',   'INJNP'),
      ('JEBEL-UAE','Jebel Ali',        'PORT',      'UAE',         'Gulf',         'AEJEA'),
      ('ANT-BE',   'Antwerp',          'PORT',      'Belgium',     'North Europe', 'BEANT'),
      ('HAM-DE',   'Hamburg',          'PORT',      'Germany',     'North Europe', 'DEHAM'),
      ('YARD-DXB', 'Dubai Main Yard',  'YARD',      'UAE',         'Gulf',         NULL)
    ON CONFLICT (code) DO NOTHING;
  `);
  console.log('✓ locations seeded');

  // ── QP PERIOD MASTER ─────────────────────────────────────────────
  await query(`
    INSERT INTO qp_period_master (code, name, pricing_type, anchor_event, start_offset_type, start_offset_days, end_offset_type, end_offset_days)
    VALUES
      ('LME-M1',      'LME M+1 Average',              'average',      'BL_DATE',           'NEXT-MONTH-START', 0, 'NEXT-MONTH-END', 0),
      ('LME-M',       'LME Current Month Average',    'average',      'BL_DATE',           'MONTH-START',      0, 'MONTH-END',      0),
      ('BL-PLUS10',   'BL + 10 Calendar Days',        'average',      'BL_DATE',           'SAME-DAY',         0, 'OFFSET-CD',      10),
      ('ASSAY-5WD',   '5 WD After Assay Receipt',     'average',      'ASSAY_RECEIPT_DATE','SAME-DAY',         0, 'OFFSET-BD',      5),
      ('PLATTS-3DAY', 'Platts 3-Day Average',         'average',      'BL_DATE',           'OFFSET-BD',       -1, 'OFFSET-BD',      1)
    ON CONFLICT (code) DO NOTHING;
  `);
  console.log('✓ qp_period_master seeded');

  // ── MARKET PRICES — seed 10 days of LME Cu ───────────────────────
  await query(`
    INSERT INTO market_prices (quote_date, commodity_code, exchange_code, currency, unit, cash_bid, cash_ask, bid_3m, ask_3m, settlement)
    VALUES
      ('2026-05-09', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9233.37, 9246.37, 9244.40, 9258.40, 9240.00),
      ('2026-05-08', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9269.45, 9284.15, 9285.84, 9302.30, 9276.80),
      ('2026-05-07', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9180.10, 9195.30, 9192.50, 9208.70, 9187.80),
      ('2026-05-06', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9145.20, 9159.80, 9157.40, 9172.60, 9152.50),
      ('2026-05-05', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9210.60, 9225.40, 9222.80, 9238.20, 9218.00),
      ('2026-04-30', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9050.00, 9065.00, 9062.00, 9078.00, 9057.50),
      ('2026-04-29', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 8990.00, 9005.00, 9002.00, 9018.00, 8997.50),
      ('2026-04-28', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 8960.00, 8975.00, 8972.00, 8988.00, 8967.50),
      ('2026-04-25', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9100.00, 9115.00, 9112.00, 9128.00, 9107.50),
      ('2026-04-24', 'LME-CU-BENCH', 'LME', 'USD', '$/MT', 9080.00, 9095.00, 9092.00, 9108.00, 9087.50),
      ('2026-05-09', 'ICE-BRENT',     'ICE', 'USD', '$/BBL', NULL, NULL, NULL, NULL, 83.20),
      ('2026-05-08', 'ICE-BRENT',     'ICE', 'USD', '$/BBL', NULL, NULL, NULL, NULL, 82.85),
      ('2026-05-09', 'CBOT-WHEAT',   'CBOT','USD', 'c/bu',  NULL, NULL, NULL, NULL, 548.00),
      ('2026-05-09', 'CBOT-SOY',     'CBOT','USD', 'c/bu',  NULL, NULL, NULL, NULL, 1388.69),
      ('2026-05-09', 'PLATTS-DUBAI', 'PLATTS','USD','$/BBL', NULL, NULL, NULL, NULL, 82.10)
    ON CONFLICT (quote_date, commodity_code) DO NOTHING;
  `);
  console.log('✓ market_prices seeded');

  // ── FORWARD CURVE — LME Cu Jul26 prompt ─────────────────────────
  await query(`
    INSERT INTO forward_curve (curve_date, commodity_code, exchange_code, prompt_date, prompt_label, prompt_type, bid, ask, settlement)
    VALUES
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-05-11', 'LME 11-May-26', 'Daily', 9239.43, 9241.63, 9240.28),
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-05-12', 'LME 12-May-26', 'Daily', 9242.74, 9245.35, 9244.40),
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-05-15', 'LME 15-May-26', 'Daily', 9244.13, 9246.05, 9245.08),
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-06-17', 'LME Jun-26',    'Daily', 9259.00, 9263.00, 9261.00),
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-07-15', 'LME Jul-26 ★',  'Daily', 9270.36, 9273.84, 9271.71),
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-07-30', 'LME 30-Jul-26', 'Daily', 9283.00, 9287.00, 9285.00),
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-08-20', 'LME Aug-26',    'Daily', 9282.00, 9285.12, 9283.76),
      ('2026-05-09', 'LME-CU-BENCH', 'LME', '2026-09-17', 'LME Sep-26',    'Daily', 9300.00, 9304.16, 9302.40),
      ('2026-05-09', 'ICE-BRENT',    'ICE', '2026-06-30', 'Jun26',          'Monthly', 82.67, 82.83, 82.75),
      ('2026-05-09', 'ICE-BRENT',    'ICE', '2026-07-31', 'Jul26',          'Monthly', 83.89, 84.09, 83.99),
      ('2026-05-09', 'CBOT-WHEAT',  'CBOT', '2026-07-14', 'Jul26',          'Monthly', 553.53, 553.61, 553.57)
    ON CONFLICT (curve_date, commodity_code, prompt_date) DO NOTHING;
  `);
  console.log('✓ forward_curve seeded');

  // ── DEALS ────────────────────────────────────────────────────────
  const dealRes = await query(`
    INSERT INTO deals (deal_no, deal_date, commodity_code, deal_type, qty_mt,
      supplier_id, customer_id, confirmed, confirmed_at, status)
    VALUES
      ('DEAL123', '2026-03-20 14:00:00+00', 'CU-MILLBERRY', 'BACK-TO-BACK', 100,
        (SELECT id FROM counterparties WHERE code='GLEN-AG'),
        (SELECT id FROM counterparties WHERE code='TATA-MET'),
        TRUE, '2026-03-20 14:00:00+00', 'CONFIRMED'),
      ('DEAL456', '2026-03-21 10:30:00+00', 'CU-MILLBERRY', 'BACK-TO-BACK', 56.25,
        (SELECT id FROM counterparties WHERE code='GLEN-AG'),
        (SELECT id FROM counterparties WHERE code='TATA-MET'),
        TRUE, '2026-03-21 10:30:00+00', 'CONFIRMED')
    ON CONFLICT (deal_no) DO NOTHING
    RETURNING id, deal_no;
  `);
  console.log('✓ deals seeded:', dealRes.rows.map(r => r.deal_no).join(', '));

  // ── CONTRACTS ────────────────────────────────────────────────────
  const pcRes = await query(`
    INSERT INTO contracts (contract_no, contract_date, contract_type, commodity_code,
      counterparty_id, qty_mt, incoterms, pol_id, pod_id, payment_pct, status,
      deal_id)
    VALUES
      ('PC-2026-001', '2026-03-22', 'PC', 'CU-MILLBERRY',
        (SELECT id FROM counterparties WHERE code='GLEN-AG'),
        100, 'CIF',
        (SELECT id FROM locations WHERE code='DAR-TZ'),
        (SELECT id FROM locations WHERE code='JNPT-IN'),
        90, 'ACTIVE',
        (SELECT id FROM deals WHERE deal_no='DEAL123')),
      ('SC-2026-001', '2026-03-22', 'SC', 'CU-MILLBERRY',
        (SELECT id FROM counterparties WHERE code='TATA-MET'),
        56.25, 'CIF',
        (SELECT id FROM locations WHERE code='DAR-TZ'),
        (SELECT id FROM locations WHERE code='JNPT-IN'),
        90, 'ACTIVE',
        (SELECT id FROM deals WHERE deal_no='DEAL456'))
    ON CONFLICT (contract_no) DO NOTHING
    RETURNING id, contract_no;
  `);
  console.log('✓ contracts seeded:', pcRes.rows.map(r => r.contract_no).join(', '));

  // ── CONTRACT PRICING LINES ───────────────────────────────────────
  await query(`
    INSERT INTO contract_pricing_lines
      (contract_id, line_no, source_item_code, benchmark_code, exchange_code,
       reporting_agency, index_pct, payable_pct, pricing_rule, calc_method,
       pricing_option, qp_period_code, qp_start_date, qp_end_date)
    VALUES
      ((SELECT id FROM contracts WHERE contract_no='PC-2026-001'),
       1, 'CU-MILLBERRY', 'LME-CU-BENCH', 'LME', 'LME',
       91, 91, 'event', 'lowest4', 'SUPPLIER', 'LME-M1',
       '2026-04-24', '2026-05-23'),
      ((SELECT id FROM contracts WHERE contract_no='SC-2026-001'),
       1, 'CU-MILLBERRY', 'LME-CU-BENCH', 'LME', 'LME',
       95, 95, 'event', 'highest4', 'LONGER', 'LME-M1',
       '2026-01-01', '2026-01-31')
    ON CONFLICT DO NOTHING;
  `);
  console.log('✓ contract pricing lines seeded');

  // ── LOGISTICS ────────────────────────────────────────────────────
  const logRes = await query(`
    INSERT INTO logistics (log_no, contract_id, deal_id, shipment_type, vessel_name,
      carrier, pol_id, pod_id, incoterms, etd, bl_date, eta, status)
    VALUES
      ('LOG-2026-011', 
        (SELECT id FROM contracts WHERE contract_no='PC-2026-001'),
        (SELECT id FROM deals WHERE deal_no='DEAL123'),
        'BACK-TO-BACK', 'MV Pacific Star', 'Maersk',
        (SELECT id FROM locations WHERE code='DAR-TZ'),
        (SELECT id FROM locations WHERE code='JNPT-IN'),
        'CIF', '2026-04-15', '2026-04-18', '2026-05-02', 'IN-TRANSIT')
    ON CONFLICT (log_no) DO NOTHING
    RETURNING id, log_no;
  `);
  console.log('✓ logistics seeded:', logRes.rows.map(r => r.log_no).join(', '));

  // ── CONTAINERS ───────────────────────────────────────────────────
  if (logRes.rows.length > 0) {
    const logId = logRes.rows[0].id;
    await query(`
      INSERT INTO containers (container_no, logistics_id, seal_no, size,
        tare_mt, gross_weight_mt, moisture_pct, material_code, status)
      VALUES
        ('KMTC121', ${logId}, 'SEAL-001', '20FT', 2.20, 24.00, 9.2, 'CU-MILLBERRY', 'LOADED'),
        ('KMTC122', ${logId}, 'SEAL-002', '20FT', 2.20, 25.00, 8.8, 'CU-MILLBERRY', 'LOADED'),
        ('KMTC123', ${logId}, 'SEAL-003', '20FT', 2.20, 26.00, 9.5, 'CU-MILLBERRY', 'LOADED'),
        ('MAER232', ${logId}, 'SEAL-004', '20FT', 2.20, 27.50, 8.5, 'CU-BERRY',     'LOADED')
      ON CONFLICT (container_no) DO NOTHING;
    `);
    console.log('✓ containers seeded (KMTC121/122/123/MAER232)');
  }

  // ── FIXATION LOTS ─────────────────────────────────────────────────
  await query(`
    INSERT INTO fixation_lots (lot_ref, deal_id, fixed_price, fixed_qty_mt, fix_date, prompt_date, status)
    VALUES
      ('FIX123', 'DEAL123', 8848.00, 68.25, '2026-04-28', '2026-07-15', 'FIXED'),
      ('FIX456', 'DEAL456', 10500.00, 51.19, '2026-04-30', '2026-07-30', 'FIXED')
    ON CONFLICT (lot_ref) DO NOTHING;
  `);
  console.log('✓ fixation_lots seeded');

  // ── ORDERS (PO + SO) ─────────────────────────────────────────────
  await query(`
    INSERT INTO orders (order_no, order_type, contract_id, deal_id, order_date, qty_mt, status, erp_ref)
    VALUES
      ('PO-2026-001', 'PO',
        (SELECT id FROM contracts WHERE contract_no='PC-2026-001'),
        (SELECT id FROM deals WHERE deal_no='DEAL123'),
        '2026-03-25', 100.00, 'CONFIRMED', 'ERP-PO-8801'),
      ('SO-10042', 'SO',
        (SELECT id FROM contracts WHERE contract_no='SC-2026-001'),
        (SELECT id FROM deals WHERE deal_no='DEAL456'),
        '2026-03-25', 56.25, 'CONFIRMED', 'ERP-SO-10042'),
      ('SO-10043', 'SO',
        (SELECT id FROM contracts WHERE contract_no='SC-2026-001'),
        (SELECT id FROM deals WHERE deal_no='DEAL123'),
        '2026-04-01', 43.75, 'CONFIRMED', 'ERP-SO-10043')
    ON CONFLICT (order_no) DO NOTHING;
  `);
  console.log('✓ orders seeded (PO-2026-001, SO-10042, SO-10043)');

  // ── HEDGES ───────────────────────────────────────────────────────
  await query(`
    INSERT INTO hedges (req_ref, deal_id, trade_date, hedge_type, commodity_code,
      exchange_code, qty_mt, entry_price, prompt_date, status)
    VALUES
      ('REQ-001', 'DEAL123', '2026-04-18', 'SHORT', 'LME-CU-BENCH', 'LME', 68.25, 9000.00, '2026-07-15', 'EXECUTED'),
      ('REQ-002', 'DEAL456', '2026-04-30', 'LONG',  'LME-CU-BENCH', 'LME', 51.19, 10500.00,'2026-07-30', 'EXECUTED')
    ON CONFLICT (req_ref) DO NOTHING;
  `);
  console.log('✓ hedges seeded');

  console.log('\n✅ All seed data loaded.');
  console.log('\nDemo scenario ready:');
  console.log('  DEAL123 → PC-2026-001 → LOG-2026-011 → KMTC121/122/123/MAER232 → FIX123 → REQ-001');
  console.log('  DEAL456 → SC-2026-001 → FIX456 → REQ-002');
}

seed()
  .then(() => process.exit(0))
  .catch(err => {
    console.error('Seed failed:', err.message);
    process.exit(1);
  });
