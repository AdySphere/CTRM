# CTRM Platform — Backend

Node.js + PostgreSQL backend for AdySphere CTRM Platform.

## Setup (do this once)

### Step 1 — Get your database (Supabase, free, 2 minutes)

1. Go to https://supabase.com and sign up
2. Click "New Project" — name it `ctrm-platform`, pick a region close to UAE
3. Set a strong database password — **save this, you'll need it**
4. Wait ~2 minutes for it to provision
5. Go to: Settings → Database → Connection string → URI
6. Copy the URI — it looks like: `postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres`

### Step 2 — Configure environment

```bash
cd ctrm-backend
cp .env.example .env
```

Open `.env` and paste your database URL:
```
DATABASE_URL=postgresql://postgres:yourpassword@yourhost.supabase.co:5432/postgres
```

### Step 3 — Install and setup

```bash
npm install
npm run db:setup    # creates all tables
npm run db:seed     # loads demo data (DEAL123, DEAL456, containers, prices)
```

### Step 4 — Run

```bash
npm run dev         # development (auto-restarts on changes)
# or
npm start           # production
```

Open http://localhost:3000 — you should see the CTRM frontend.
Check http://localhost:3000/api/health — should return `{"status":"ok","db":"connected"}`

---

## API Reference

### Market Prices
```
GET  /api/market-prices              — all prices (filter: ?commodity=LME-CU-BENCH&days=30)
GET  /api/market-prices/latest       — one row per commodity, most recent
POST /api/market-prices              — save new price entry
  Body: { quote_date, commodity_code, cash_bid, cash_ask, bid_3m, ask_3m, settlement }
```

### Forward Curve
```
GET  /api/forward-curve              — curve strip (?commodity=LME-CU-BENCH)
GET  /api/forward-curve/price        — single prompt price (?commodity=LME-CU-BENCH&prompt_date=2026-07-15)
POST /api/forward-curve              — save curve row
  Body: { curve_date, commodity_code, prompt_date, bid, ask, settlement }
```

### Contracts
```
GET  /api/contracts                  — all contracts (?type=PC&status=ACTIVE)
GET  /api/contracts/:id              — single contract with pricing lines + QC specs
POST /api/contracts                  — create contract
POST /api/contracts/:id/pricing-lines — add pricing line to contract
```

### Deals
```
GET  /api/deals                      — all deals
POST /api/deals                      — create deal
PATCH /api/deals/:id/confirm         — confirm deal
```

### Logistics
```
GET  /api/logistics                  — all logistics records
GET  /api/logistics/:id              — single record with containers
POST /api/logistics                  — create logistics record
PATCH /api/logistics/:id             — update (BL date, OBL date, status etc)
```

### Containers
```
GET  /api/containers                 — all containers (?logistics_id=1)
POST /api/containers                 — add container (net/dry weight auto-computed)
PATCH /api/containers/:id            — update container
```

### Fixations (Fix Today)
```
GET  /api/fixations                  — all fixations (?deal_id=DEAL123)
POST /api/fixations                  — record fixation
  Body: { deal_id, fixed_price, fixed_qty_mt, fix_date, prompt_date }
  → This changes state from UNPRICED → PRICED in Exposure
```

### Hedges
```
GET  /api/hedges                     — all hedges (?deal_id=DEAL123)
POST /api/hedges                     — create hedge requisition
PATCH /api/hedges/:id/execute        — mark as executed
  Body: { execution_price, exec_date }
```

### Allocations
```
GET  /api/allocations                — all allocations (container → contract)
POST /api/allocations                — allocate container to sales contract
  Body: { container_id, buy_contract_id, sell_contract_id, fixation_lot_ref }
  → Net/dry weight auto-computed from container. PRICED if fixation_lot_ref set.
```

### Exposure & MTM ← CORE CALCULATION
```
GET  /api/exposure                   — full exposure for all deals (?as_of_date=2026-05-09)
GET  /api/exposure?deal_id=DEAL123   — single deal exposure
GET  /api/exposure/qp/DEAL123        — QP running average for DEAL123

Returns per deal:
  D: total payable qty (contractQty × indexPct)
  E: priced qty (from fixations)
  F: unpriced qty (D - E)
  G: futures hedge qty (from hedges)
  H: hedge ratio (G/E or G/F)
  I: weighted avg fixed price (from fixations) — null if unpriced
  J: today's settlement (from market_prices)
  K: physical MTM = (J-I) × direction × E — null if PRE_QP or UNPRICED
  L: physical P&L = K (Phase 1)
  M: futures entry price (from hedges)
  N: futures MTM = SHORT:(M-J)×G / LONG:(J-M)×G
  O: net P&L = L + N
  P: effectiveness ratio = ABS(N/L)
  Q: IFRS 9 status (Effective/Partial/Ineffective)
  state: PRE_QP / UNPRICED / PARTIAL / PRICED
```

### Invoices
```
POST /api/invoices/compute           — compute invoice amounts (no save)
  Body: { deal_no, invoice_type, as_of_date }
  → Returns ref_price, payable_price, gross_amount, provisional_amount, balance_due
POST /api/invoices                   — create and save invoice
GET  /api/invoices                   — all invoices
```

### Master Data
```
GET  /api/master/commodities
GET  /api/master/counterparties      (?type=VENDOR or CUSTOMER)
GET  /api/master/locations
GET  /api/master/qp-periods
```

---

## Deploy to Railway (free hosting)

1. Push this folder to GitHub
2. Go to https://railway.app — connect your GitHub
3. New Project → Deploy from GitHub repo
4. Add environment variable: `DATABASE_URL` = your Supabase URL
5. Railway auto-deploys. You get a URL like `https://ctrm-platform.railway.app`

---

## Data Flow

```
Market Prices (daily entry)
    ↓
Forward Curve (prompt prices)
    ↓
Contracts (index%, payable%, QP dates, calc method)
    ↓
Logistics → Containers → Lots
    ↓
QP Window (running average from market prices × calc method)
    ↓
Fixations (Fix Today → state: UNPRICED → PRICED)
    ↓
Hedges (futures positions against physical exposure)
    ↓
Exposure & MTM (all 17 columns, live from DB)
    ↓
Provisional Invoice (QP avg or fixed price × 90%)
    ↓
Final Invoice (closed QP avg, delta note, balance due)
```

Every save writes to PostgreSQL. Every calculation reads from PostgreSQL.
Nothing is hardcoded. Change a market price and Run MTM → everything updates.
