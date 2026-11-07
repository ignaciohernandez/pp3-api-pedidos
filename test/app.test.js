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

async function usePool(nextPool) {
  pool = nextPool;
  await new Promise((resolve) => server.close(resolve));
  server = http.createServer(createApp(pool));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
}

test('listing uses trusted identity, ignoring user and role query parameters', async () => {
  const orders = [
    { ...createLifecyclePool().order, id: 7, user_id: 'customer-1' },
    { ...createLifecyclePool().order, id: 8, user_id: 'customer-2' },
  ];
  await usePool({
    async execute(sql, values) {
      if (sql.includes('FROM order_items')) return [[]];
      if (sql.includes('WHERE user_id = ?')) return [orders.filter(order => order.user_id === values[0])];
      assert.equal(sql, 'SELECT * FROM orders ORDER BY id DESC LIMIT 500');
      return [[...orders].reverse()];
    },
  });
  for (const [role, ids] of [['client', [7]], ['admin', [8, 7]]]) {
    const response = await fetch(`${baseUrl}/api/pedidos?userId=customer-2&role=admin`, {
      headers: { 'x-service-token': serviceToken, 'x-user-id': 'customer-1', 'x-user-role': role },
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).map(order => order.id), ids);
  }
});

test('reads reject incomplete or unknown identity before accessing the database', async () => {
  for (const path of ['/api/pedidos', '/api/pedidos/7']) {
    for (const identity of [{}, { 'x-user-role': 'admin' }, { 'x-user-id': 'customer-1', 'x-user-role': 'unknown' }]) {
      const response = await fetch(`${baseUrl}${path}`, {
        headers: { 'x-service-token': serviceToken, ...identity },
      });
      assert.equal(response.status, 401);
    }
  }
});

test('order detail is visible only to its owner or an identified administrator', async () => {
  await usePool(createLifecyclePool());
  for (const [userId, role, status] of [
    ['customer-1', 'client', 200], ['customer-2', 'client', 404], ['administrator', 'admin', 200],
  ]) {
    const response = await fetch(`${baseUrl}/api/pedidos/7`, {
      headers: { 'x-service-token': serviceToken, 'x-user-id': userId, 'x-user-role': role },
    });
    assert.equal(response.status, status);
  }
});

test('state retries check permissions before returning an existing order', async () => {
  const lifecyclePool = createLifecyclePool();
  await usePool(lifecyclePool);
  for (const state of ['cancelling', 'cancelled', 'shipped', 'delivered']) {
    lifecyclePool.order.status = state;
    for (const [userId, role, status] of [
      ['customer-2', 'client', 404],
      ['customer-1', 'client', ['shipped', 'delivered'].includes(state) ? 404 : 200],
      ['administrator', 'admin', 200],
      [null, 'admin', 404],
    ]) {
      const response = await fetch(`${baseUrl}/api/pedidos/7`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json', 'x-service-token': serviceToken,
          'x-user-role': role, ...(userId ? { 'x-user-id': userId } : {}),
        },
        body: JSON.stringify({ estado: state }),
      });
      assert.equal(response.status, status, `${state}: ${userId}/${role}`);
      assert.equal(lifecyclePool.order.status, state);
    }
  }
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

function createOrderPool() {
  const orders = [];
  const details = [];
  const execute = async (sql, values = []) => {
    if (sql.includes('INSERT INTO orders')) {
      const [user_id, user_email, user_name, attempt_id, request_hash, coupon_code, direccion_entrega] = values;
      assert.match(sql, /coupon_code, direccion_entrega/);
      if (orders.some(order => order.user_id === user_id && order.attempt_id === attempt_id)) {
        throw Object.assign(new Error('Duplicate attempt'), { code: 'ER_DUP_ENTRY' });
      }
      const order = { ...createLifecyclePool().order, id: orders.length + 1,
        user_id, user_email, user_name, attempt_id, request_hash, coupon_code, direccion_entrega, status: 'pending' };
      orders.push(order);
      return [{ insertId: order.id }];
    }
    if (sql.includes('INSERT INTO order_items')) {
      details.push({ order_id: values[0], product_id: values[1], quantity: values[2] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('UPDATE order_items SET product_name')) {
      Object.assign(details.find(item => item.order_id === values[3] && item.product_id === values[4]), {
        product_name: values[0], unit_price_cents: values[1], subtotal_cents: values[2],
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("UPDATE orders SET status = 'confirmed'")) {
      Object.assign(orders.find(order => order.id === values[4]), {
        status: 'confirmed', subtotal_cents: values[0], discount_cents: values[1],
        total_cents: values[2], coupon_code: values[3],
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes('FROM order_items')) return [details.filter(item => item.order_id === values[0])];
    if (sql.includes('WHERE user_id = ? AND attempt_id = ?')) {
      return [orders.filter(order => order.user_id === values[0] && order.attempt_id === values[1])];
    }
    if (sql.includes('WHERE id = ?')) return [orders.filter(order => String(order.id) === String(values[0]))];
    if (sql.includes('WHERE user_id = ?')) return [orders.filter(order => order.user_id === values[0])];
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return { orders, details, execute, async getConnection() {
    return { execute, async beginTransaction() {}, async commit() {}, async rollback() {}, release() {} };
  } };
}

const orderHeaders = {
  'content-type': 'application/json', 'x-service-token': serviceToken,
  'x-user-id': 'customer-1', 'x-user-role': 'client', 'x-user-email': 'customer@example.com',
  'idempotency-key': 'address-attempt',
};
const orderBody = { items: [{ productId: 31, quantity: 2 }], couponCode: ' ahorro ' };
const postOrder = body => fetch(`${baseUrl}/api/pedidos`, {
  method: 'POST', headers: orderHeaders, body: JSON.stringify(body),
});

test('address is trimmed, persisted and returned by creation, list and detail', async () => {
  const database = createOrderPool();
  await usePool(database);
  const response = await postOrder({ ...orderBody, direccionEntrega: '  Avenida Siempre Viva 742  ' });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.direccionEntrega, 'Avenida Siempre Viva 742');
  assert.equal(database.orders[0].direccion_entrega, created.direccionEntrega);
  for (const path of ['/api/pedidos', `/api/pedidos/${created.id}`]) {
    const result = await fetch(`${baseUrl}${path}`, { headers: orderHeaders });
    assert.equal(result.status, 200);
    const body = await result.json();
    assert.equal((Array.isArray(body) ? body[0] : body).direccionEntrega, created.direccionEntrega);
  }
});

test('missing address stores null and historical orders return null', async () => {
  const database = createOrderPool();
  await usePool(database);
  const response = await postOrder(orderBody);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).direccionEntrega, null);
  assert.equal(database.orders[0].direccion_entrega, null);
  delete database.orders[0].direccion_entrega;
  for (const path of ['/api/pedidos', '/api/pedidos/1']) {
    const response = await fetch(`${baseUrl}${path}`, { headers: orderHeaders });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal((Array.isArray(body) ? body[0] : body).direccionEntrega, null);
  }
  const { createHash } = require('node:crypto');
  assert.equal(database.orders[0].request_hash, createHash('sha256').update(JSON.stringify({
    items: orderBody.items, couponCode: 'AHORRO',
  })).digest('hex'));
  assert.equal((await postOrder(orderBody)).status, 200);
  assert.equal((await postOrder({ ...orderBody, direccionEntrega: 'Nueva 123' })).status, 409);
  assert.equal(database.orders.length, 1);
});

test('invalid addresses fail before accessing the database', async () => {
  for (const direccionEntrega of [null, false, 123, {}, [], '', ' \t\n ', 'a'.repeat(501)]) {
    assert.equal((await postOrder({ ...orderBody, direccionEntrega })).status, 400);
  }
});

test('accepts 500 characters after trimming', async () => {
  const database = createOrderPool();
  await usePool(database);
  const response = await postOrder({ ...orderBody, direccionEntrega: `  ${'a'.repeat(500)}  ` });
  assert.equal(response.status, 201);
  assert.equal(database.orders[0].direccion_entrega.length, 500);
});

test('idempotency includes normalized address, items and coupon without duplicates', async () => {
  const database = createOrderPool();
  await usePool(database);
  const body = { ...orderBody, direccionEntrega: 'Calle 123' };
  assert.equal((await postOrder(body)).status, 201);
  const repeated = await postOrder({ ...body, couponCode: 'AHORRO', direccionEntrega: ' Calle 123 ' });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).id, database.orders[0].id);
  for (const changed of [
    { ...body, direccionEntrega: 'Otra 456' }, orderBody,
    { ...body, couponCode: 'OTRO' },
    { ...body, items: [{ productId: 31, quantity: 3 }] },
  ]) assert.equal((await postOrder(changed)).status, 409);
  assert.equal(database.orders.length, 1);
  assert.equal(database.details.length, 1);
});


test('coupon and address survive confirmation, reads and retries', async () => {
  const database = createOrderPool();
  await usePool(database);
  const body = { ...orderBody, direccionEntrega: 'Calle 123' };
  const created = await postOrder(body);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).cuponCodigo, 'AHORRO');
  const confirmation = { estado: 'confirmed', inventory: {
    items: [{ productId: 31, quantity: 2, productName: 'Producto', unitPriceCents: 6000, subtotalCents: 12000 }],
    subtotalCents: 12000, discountCents: 2000, totalCents: 10000, couponCode: 'AHORRO',
  } };
  const initialHash = database.orders[0].request_hash;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/pedidos/1`, {
      method: 'PATCH', headers: orderHeaders, body: JSON.stringify(confirmation),
    });
    assert.equal(response.status, 200);
    const order = await response.json();
    assert.equal(order.cuponCodigo, 'AHORRO');
    assert.equal(order.direccionEntrega, 'Calle 123');
  }
  for (const path of ['/api/pedidos', '/api/pedidos/1']) {
    const response = await fetch(`${baseUrl}${path}`, { headers: orderHeaders });
    assert.equal(response.status, 200);
    const result = await response.json();
    const order = Array.isArray(result) ? result[0] : result;
    assert.equal(order.cuponCodigo, 'AHORRO');
    assert.equal(order.direccionEntrega, 'Calle 123');
  }
  const retry = await postOrder(body);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).cuponCodigo, 'AHORRO');
  assert.equal((await postOrder({ ...body, couponCode: 'OTRO' })).status, 409);
  assert.equal(database.orders[0].request_hash, initialHash);
  assert.equal(database.orders.length, 1);
});
