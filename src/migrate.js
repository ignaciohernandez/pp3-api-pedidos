require('dotenv').config();
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPool } = require('./db');

async function migrate() {
  const pool = createPool();
  const connection = await pool.getConnection();
  try {
    const directory = path.join(__dirname, '..', 'migrations');
    const files = (await fs.readdir(directory))
      .filter((file) => /^\d+-.*\.sql$/.test(file))
      .sort();
    for (const file of files) {
      const sql = await fs.readFile(path.join(directory, file), 'utf8');
      for (const statement of sql.split(';').map((part) => part.trim()).filter(Boolean)) {
        await connection.query(statement);
      }
      console.log(`Orders migration ${file} applied`);
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
