const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
});

pool.on('error', (err) => {
  console.error('Unexpected pg pool error (idle client):', err.message);
  // swallow — without this handler, an idle connection error
  // from Supabase's pooler crashes the whole Node process
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    console.error('DB error:', err.message);
    throw err;
  }
}

async function logAudit(entityType, entityId, entityRef, action, fieldName, oldValue, newValue, changedBy) {
  try {
    await query(`
      INSERT INTO audit_log (entity_type, entity_id, entity_ref, action, field_name, old_value, new_value, changed_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [entityType, entityId, entityRef || null, action, fieldName || null,
        oldValue !== undefined && oldValue !== null ? String(oldValue) : null,
        newValue !== undefined && newValue !== null ? String(newValue) : null,
        changedBy || 'A. Mallick']);
  } catch(e) { console.warn('audit log failed:', e.message); }
}

async function getCreditExposure(counterpartyId) {
  // Sum committed exposure: open/converted quotations + active contracts for this counterparty
  const cpRes = await query('SELECT id, name, credit_limit, kyc_status FROM counterparties WHERE id=$1', [counterpartyId]);
  if (!cpRes.rows.length) return null;
  const cp = cpRes.rows[0];

  const quotRes = await query(`
    SELECT COALESCE(SUM(provisional_value),0) as total
    FROM quotations
    WHERE customer_id=$1 AND status IN ('OPEN','CONVERTED')
  `, [counterpartyId]);

  const contractRes = await query(`
    SELECT COALESCE(SUM(qty_mt * COALESCE(
      (SELECT provisional_price FROM quotations q WHERE q.deal_id = contracts.deal_id LIMIT 1), 0
    )),0) as total
    FROM contracts
    WHERE counterparty_id=$1 AND status NOT IN ('CANCELLED','CLOSED')
  `, [counterpartyId]);

  const usedFromQuotes = parseFloat(quotRes.rows[0]?.total || 0);
  const usedFromContracts = parseFloat(contractRes.rows[0]?.total || 0);
  const used = usedFromQuotes + usedFromContracts;
  const limit = cp.credit_limit !== null ? parseFloat(cp.credit_limit) : null;
  const available = limit !== null ? limit - used : null;

  return {
    counterparty_id: cp.id,
    counterparty_name: cp.name,
    kyc_status: cp.kyc_status,
    credit_limit: limit,
    credit_used: Math.round(used * 100) / 100,
    credit_available: available !== null ? Math.round(available * 100) / 100 : null,
    over_limit: limit !== null && used > limit,
    limit_set: limit !== null
  };
}

module.exports = { pool, query, logAudit, getCreditExposure };
