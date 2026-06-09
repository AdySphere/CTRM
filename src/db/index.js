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

module.exports = { pool, query };
