const { Pool } = require('pg');
const dns = require('dns');
require('dotenv').config();

// Force IPv4 DNS resolution
dns.setDefaultResultOrder('ipv4first');

const pool = new Pool({
  host: process.env.DB_HOST || 'db.qsxhfypwmntbirknoeit.supabase.co',
  port: parseInt(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'postgres',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  ssl: { rejectUnauthorized: false },
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected DB pool error:', err.message);
});

async function query(text, params) {
  try {
    const res = await pool.query(text, params);
    return res;
  } catch (err) {
    console.error('DB query error:', { text: text.substring(0, 60), err: err.message });
    throw err;
  }
}

module.exports = { pool, query };
