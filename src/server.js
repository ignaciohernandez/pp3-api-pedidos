require('dotenv').config();
const { createPool } = require('./db');
const { createApp } = require('./app');

const port = Number(process.env.PORT || 3103);
if (!process.env.SERVICE_TOKEN || process.env.SERVICE_TOKEN.length < 32) {
  throw new Error('SERVICE_TOKEN must contain at least 32 characters');
}

const pool = createPool();
const app = createApp(pool);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Orders service listening on port ${port}`);
  // Pre-calentar la conexión a la BD para que el primer request sea rápido
  pool.query('SELECT 1').catch((err) => console.error('DB warmup failed:', err.message));
});

async function shutdown() {
  server.close(async () => {
    await pool.end();
    process.exit(0);
  });
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
