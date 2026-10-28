const assert = require('node:assert/strict');
const http = require('node:http');
const { afterEach, beforeEach, test } = require('node:test');
const { createApp } = require('../src/app');

const serviceToken = 'test-service-token-that-is-long-enough-for-this-suite';
let server;
let baseUrl;
let pool;

function createLifecyclePool() {
  const order = {
    id: 7,
    user_id: 'customer-1',
    user_email: 'customer@example.com',
    user_name: 'Cliente Demo',
    attempt_id: 'attempt-7',
    request_hash: 'hash',
    status: 'confirmed',
    subtotal_cents: 12000,
    discount_cents: 2000,
    total_cents: 10000,
    coupon_code: 'AHORRO',
    created_at: new Date('2026-01-01T00:00:00Z'),
  };
  const detailRows = [{
    product_id: 31,
    product_name: 'Café',
    quantity: 2,
    unit_price_cents: 6000,
    subtotal_cents: 12000,
  }];
  const payments = [];
  const receipts = [];
  const execute = async (sql, values) => {
    if (sql.includes('SELECT * FROM orders WHERE id = ?')) {
      return [[String(order.id) === String(values[0]) ? { ...order } : undefined].filter(Boolean)];
    }
    if (sql.includes('SELECT product_id, product_name, quantity')) return [[...detailRows]];
    if (sql.includes('INSERT INTO payments')) {
      const payment = {
        id: payments.length + 1,
        order_id: values[0],
        method: values[1],
        amount_cents: values[2],
        status: values[3],
        created_at: new Date('2026-01-02T00:00:00Z'),
      };
      payments.push(payment);
      return [{ insertId: payment.id }];
    }
    if (sql.includes('SELECT * FROM payments WHERE id = ?')) {
      return [[payments.find((payment) => payment.id === values[0])].filter(Boolean)];
    }
    if (sql.includes('INSERT INTO receipts')) {
      const receipt = {
        id: receipts.length + 1,
        order_id: values[0],
        payment_id: values[1],
        customer_name: values[2],
        customer_email: values[3],
        payment_method: values[4],
        subtotal_cents: values[5],
        discount_cents: values[6],
        total_cents: values[7],
        coupon_code: values[8],
        items: values[9],
        issued_at: new Date('2026-01-02T00:00:00Z'),
      };
      receipts.push(receipt);
      return [{ insertId: receipt.id }];
    }
    if (sql.includes('UPDATE orders SET status = ?')) {
      order.status = values[0];
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("UPDATE orders SET status = 'paid'")) {
      order.status = 'paid';
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('SELECT * FROM receipts WHERE order_id = ?')) {
      return [[receipts.find((receipt) => String(receipt.order_id) === String(values[0]))].filter(Boolean)];
    }
    if (sql.includes('SELECT * FROM receipts WHERE id = ?')) {
      return [[receipts.find((receipt) => receipt.id === values[0])].filter(Boolean)];
    }
    throw new Error(`Unexpected SQL in lifecycle test: ${sql}`);
  };
  const connection = {
    execute,
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
  };
  return {
    order,
    payments,
    receipts,
    async getConnection() {
      return connection;
    },
    execute,
    async query() {
      throw new Error('Unexpected query in lifecycle test');
    },
  };
}

beforeEach(async () => {
  process.env.SERVICE_TOKEN = serviceToken;
  pool = {
    async query() {
      throw new Error('Database should not be accessed by these tests');
    },
    async execute() {
      throw new Error('Database should not be accessed by these tests');
    },
    async getConnection() {
      throw new Error('Database should not be accessed by these tests');
    },
  };
  server = http.createServer(createApp(pool));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterEach(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('orders API cannot be reached with only a customer request', async () => {
  const response = await fetch(`${baseUrl}/api/pedidos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ items: [{ productId: 31, quantity: 1 }] }),
  });
  assert.equal(response.status, 403);
});

test('rejects malformed order writes before opening a database transaction', async () => {
  const response = await fetch(`${baseUrl}/api/pedidos`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-service-token': serviceToken,
      'x-user-id': 'customer-1',
      'x-user-email': 'customer@example.com',
      'idempotency-key': 'attempt-1',
    },
    body: JSON.stringify({ items: [{ productId: 31, quantity: 0 }] }),
  });
  assert.equal(response.status, 400);
});

test('simulated payments are retryable and produce one owner-protected receipt', async () => {
  pool = createLifecyclePool();
  await new Promise((resolve) => server.close(resolve));
  server = http.createServer(createApp(pool));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = {
    'content-type': 'application/json',
    'x-service-token': serviceToken,
    'x-user-id': 'customer-1',
    'x-user-role': 'client',
  };

  const rejected = await fetch(`${baseUrl}/api/pedidos/7/pagar`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ metodo: 'tarjeta', resultadoSimulado: 'rechazado' }),
  });
  const rejectedResult = await rejected.json();
  assert.equal(rejected.status, 200);
  assert.equal(rejectedResult.pago.estado, 'Rechazado');
  assert.equal(pool.order.status, 'confirmed');

  const approved = await fetch(`${baseUrl}/api/pedidos/7/pagar`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ metodo: 'transferencia', resultadoSimulado: 'aprobado' }),
  });
  const approvedResult = await approved.json();
  assert.equal(approved.status, 200);
  assert.equal(approvedResult.pago.estado, 'Aprobado');
  assert.equal(approvedResult.comprobante.numero, 'COMP-00000001');
  assert.equal(pool.order.status, 'paid');

  const repeated = await fetch(`${baseUrl}/api/pedidos/7/pagar`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ metodo: 'tarjeta', resultadoSimulado: 'rechazado' }),
  });
  const repeatedResult = await repeated.json();
  assert.equal(repeated.status, 200);
  assert.equal(repeatedResult.pago, null);
  assert.equal(repeatedResult.comprobante.numero, 'COMP-00000001');
  assert.equal(pool.receipts.length, 1);

  const receipt = await fetch(`${baseUrl}/api/pedidos/7/comprobante`, {
    headers: {
      'x-service-token': serviceToken,
      'x-user-id': 'customer-1',
      'x-user-role': 'client',
    },
  });
  const receiptResult = await receipt.json();
  assert.equal(receipt.status, 200);
  assert.equal(receiptResult.cliente, 'Cliente Demo customer@example.com');
  assert.equal(receiptResult.productos[0].nombreProducto, 'Café');
  assert.equal(receiptResult.total, 100);

  const otherUserReceipt = await fetch(`${baseUrl}/api/pedidos/7/comprobante`, {
    headers: { 'x-service-token': serviceToken, 'x-user-id': 'customer-2', 'x-user-role': 'client' },
  });
  assert.equal(otherUserReceipt.status, 404);
});
