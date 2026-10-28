const mysql = require('mysql2/promise');

function createPool() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  let databaseUrl;
  try {
    databaseUrl = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL must be a valid MySQL connection URL');
  }
  if (databaseUrl.protocol !== 'mysql:') throw new Error('DATABASE_URL must use the mysql: protocol');
  return mysql.createPool({
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password),
    database: databaseUrl.pathname.replace(/^\//, ''),
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : undefined,
    waitForConnections: true,
    connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
    decimalNumbers: true,
  });
}

module.exports = { createPool };
