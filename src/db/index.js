const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
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

module.exports = { pool, query, logAudit };
