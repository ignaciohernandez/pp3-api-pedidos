require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPool } = require('./db');

async function migrate() {
  const pool = createPool();
  const connection = await pool.getConnection();
  try {
    // Tabla de control de migraciones
    await connection.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const directory = path.join(__dirname, '..', 'migrations');
    const files = (await fs.readdir(directory))
      .filter((file) => /^\d+-.*\.sql$/.test(file))
      .sort();

    for (const file of files) {
      const [rows] = await connection.query(
        'SELECT filename FROM schema_migrations WHERE filename = ?',
        [file],
      );

      if (rows.length > 0) {
        console.log(`${file} already applied`);
        continue;
      }

      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await connection.query(statement);
      }
      await connection.query(
        'INSERT INTO schema_migrations (filename) VALUES (?)',
        [file],
      );
      console.log(`${file} applied`);
    }
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Orders migration failed:', error);
  process.exitCode = 1;
});
