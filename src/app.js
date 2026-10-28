const { createHash } = require('node:crypto');
const express = require('express');
const { requireService } = require('./auth');

const hashRequest = (request) => createHash('sha256').update(JSON.stringify(request)).digest('hex');
const asMoney = (value) => Number.isSafeInteger(Number(value)) && Number(value) >= 0;

async function getDetails(pool, orderId) {
  const [rows] = await pool.execute(
    `SELECT product_id, product_name, quantity, unit_price_cents, subtotal_cents
     FROM order_items WHERE order_id = ? ORDER BY product_id`,
    [orderId],
  );
  return rows.map((row) => ({
    productoId: Number(row.product_id),
    nombreProducto: row.product_name,
    cantidad: Number(row.quantity),
    precioUnitario: row.unit_price_cents == null ? null : Number(row.unit_price_cents) / 100,
    subtotal: row.subtotal_cents == null ? null : Number(row.subtotal_cents) / 100,
    unitPriceCents: row.unit_price_cents == null ? null : Number(row.unit_price_cents),
    subtotalCents: row.subtotal_cents == null ? null : Number(row.subtotal_cents),
  }));
}

function formatOrder(order, details = []) {
  return {
    id: Number(order.id),
    pedidoId: Number(order.id),
    userId: order.user_id,
    estado: order.status,
    status: order.status,
    fecha: order.created_at,
    total: Number(order.total_cents) / 100,
    subtotal: Number(order.subtotal_cents) / 100,
    descuento: Number(order.discount_cents) / 100,
    cuponCodigo: order.coupon_code,
    clienteInfo: { nombre: order.user_name, email: order.user_email },
    detalles: details,
    attemptId: order.attempt_id,
  };
}

function formatPayment(payment) {
  return {
    id: Number(payment.id),
    pedidoId: Number(payment.order_id),
    metodo: payment.method === 'card' ? 'Tarjeta' : 'Transferencia',
    monto: Number(payment.amount_cents) / 100,
    estado: payment.status === 'approved' ? 'Aprobado' : 'Rechazado',
    fecha: payment.created_at,
  };
}

function formatReceipt(receipt) {
  const items = typeof receipt.items === 'string' ? JSON.parse(receipt.items) : receipt.items;
  return {
    id: Number(receipt.id),
    numero: `COMP-${String(receipt.id).padStart(8, '0')}`,
    pedidoId: Number(receipt.order_id),
    fecha: receipt.issued_at,
    tipoFactura: 'Comprobante no fiscal',
    cliente: [receipt.customer_name, receipt.customer_email].filter(Boolean).join(' '),
    subtotal: Number(receipt.subtotal_cents) / 100,
    descuento: Number(receipt.discount_cents) / 100,
    cupon: receipt.coupon_code,
    total: Number(receipt.total_cents) / 100,
    metodoPago: receipt.payment_method === 'card' ? 'Tarjeta' : 'Transferencia',
    estadoPago: 'Aprobado',
    productos: items,
  };
}

function createApp(pool) {
  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', requireService);

  app.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      return res.json({ status: 'ok', service: 'orders' });
    } catch (error) {
      console.error('Orders health check failed:', error);
      return res.status(503).json({ status: 'unavailable', service: 'orders' });
    }
  });

  app.post('/api/pedidos', async (req, res) => {
    const userId = req.get('x-user-id');
    const userEmail = req.get('x-user-email');
    const userName = req.get('x-user-name') || '';
    const attemptId = req.get('idempotency-key');
    const rawItems = req.body?.items;
    if (!userId || !userEmail || !attemptId || !Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > 100) {
      return res.status(400).json({ message: 'Identidad, clave idempotente y artículos válidos son obligatorios' });
    }

    const quantities = new Map();
    for (const item of rawItems) {
      const productId = Number(item.productId);
      const quantity = Number(item.quantity);
      if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(quantity) || quantity <= 0) {
        return res.status(400).json({ message: 'Cada artículo requiere producto y cantidad enteros positivos' });
      }
      quantities.set(productId, (quantities.get(productId) || 0) + quantity);
    }
    const items = [...quantities.entries()].sort(([a], [b]) => a - b)
      .map(([productId, quantity]) => ({ productId, quantity }));
    const couponCode = typeof req.body.couponCode === 'string' ? req.body.couponCode.trim().toUpperCase() : null;
    const requestHash = hashRequest({ items, couponCode });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute(
        `INSERT INTO orders (user_id, user_email, user_name, attempt_id, request_hash, status, coupon_code)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [userId, userEmail, userName, attemptId, requestHash, couponCode],
      );
      const orderId = result.insertId;
      for (const item of items) {
        await connection.execute(
          'INSERT INTO order_items (order_id, product_id, quantity) VALUES (?, ?, ?)',
          [orderId, item.productId, item.quantity],
        );
      }
      await connection.commit();
      const [orders] = await pool.execute('SELECT * FROM orders WHERE id = ?', [orderId]);
      return res.status(201).json(formatOrder(orders[0], await getDetails(pool, orderId)));
    } catch (error) {
      await connection.rollback();
      if (error.code === 'ER_DUP_ENTRY') {
        const [orders] = await pool.execute(
          'SELECT * FROM orders WHERE user_id = ? AND attempt_id = ?',
          [userId, attemptId],
        );
        const existing = orders[0];
        if (!existing) {
          console.error('Idempotency unique-key conflict without matching order:', error);
          return res.status(503).json({ message: 'No se pudo resolver la operación repetida' });
        }
        if (existing.request_hash !== requestHash) {
          return res.status(409).json({ message: 'La clave de idempotencia ya fue usada con otro contenido' });
        }
        return res.status(200).json(formatOrder(existing, await getDetails(pool, existing.id)));
      }
      console.error('Failed to create pending order:', error);
      return res.status(500).json({ message: 'No se pudo crear el pedido' });
    } finally {
      connection.release();
    }
  });

  app.get('/api/pedidos/internal/pendientes', async (_req, res) => {
    try {
      const [orders] = await pool.execute("SELECT * FROM orders WHERE status = 'pending' ORDER BY id ASC LIMIT 100");
      const result = [];
      for (const order of orders) result.push(formatOrder(order, await getDetails(pool, order.id)));
      return res.json(result);
    } catch (error) {
      console.error('Failed to list pending orders:', error);
      return res.status(500).json({ message: 'No se pudieron consultar los pedidos pendientes' });
    }
  });

  app.get('/api/pedidos/internal/cancelaciones', async (_req, res) => {
    try {
      const [orders] = await pool.execute("SELECT * FROM orders WHERE status = 'cancelling' ORDER BY id ASC LIMIT 100");
      const result = [];
      for (const order of orders) result.push(formatOrder(order, await getDetails(pool, order.id)));
      return res.json(result);
    } catch (error) {
      console.error('Failed to list pending order cancellations:', error);
      return res.status(500).json({ message: 'No se pudieron consultar las cancelaciones pendientes' });
    }
  });

  app.get('/api/pedidos/internal/intentos/:attemptId', async (req, res) => {
    const userId = req.get('x-user-id');
    if (!userId || !req.params.attemptId) return res.status(400).json({ message: 'Identidad e intento son obligatorios' });
    try {
      const [orders] = await pool.execute(
        'SELECT * FROM orders WHERE user_id = ? AND attempt_id = ?',
        [userId, req.params.attemptId],
      );
      if (!orders.length) return res.status(404).json({ message: 'No se encontró el intento' });
      return res.json(formatOrder(orders[0], await getDetails(pool, orders[0].id)));
    } catch (error) {
      console.error('Failed to recover order attempt:', error);
      return res.status(500).json({ message: 'No se pudo consultar el intento' });
    }
  });

  app.get('/api/pedidos', async (req, res) => {
    const userId = req.get('x-user-id');
    const role = req.get('x-user-role');
    if (!userId || !['client', 'admin'].includes(role)) return res.status(401).json({ message: 'Identidad de usuario requerida' });
    try {
      const [orders] = role === 'admin'
        ? await pool.execute('SELECT * FROM orders ORDER BY id DESC LIMIT 500')
        : await pool.execute('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC LIMIT 500', [userId]);
      const result = [];
      for (const order of orders) result.push(formatOrder(order, await getDetails(pool, order.id)));
      return res.json(result);
    } catch (error) {
      console.error('Failed to list orders:', error);
      return res.status(500).json({ message: 'No se pudieron consultar los pedidos' });
    }
  });

  app.get('/api/pedidos/:id', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ message: 'Pedido no encontrado' });
    try {
      const [orders] = await pool.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
      const order = orders[0];
      if (!order || (req.get('x-user-role') !== 'admin' && order.user_id !== req.get('x-user-id'))) {
        return res.status(404).json({ message: 'Pedido no encontrado' });
      }
      return res.json(formatOrder(order, await getDetails(pool, order.id)));
    } catch (error) {
      console.error('Failed to get order:', error);
      return res.status(500).json({ message: 'No se pudo consultar el pedido' });
    }
  });

  app.post('/api/pedidos/:id/pagar', async (req, res) => {
    if (req.get('x-user-role') !== 'client') {
      return res.status(403).json({ mensaje: 'Solo los clientes pueden pagar pedidos' });
    }
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ mensaje: 'Pedido no encontrado' });
    const method = String(req.body?.metodo || '').toLowerCase();
    const simulatedResult = String(req.body?.resultadoSimulado || 'aprobado').toLowerCase();
    if (!['tarjeta', 'transferencia'].includes(method)) {
      return res.status(400).json({ mensaje: 'Elegí Tarjeta o Transferencia como método de pago' });
    }
    if (!['aprobado', 'rechazado'].includes(simulatedResult)) {
      return res.status(400).json({ mensaje: 'Resultado simulado inválido' });
    }
    const userId = req.get('x-user-id');
    if (!userId) return res.status(401).json({ mensaje: 'Identidad de usuario requerida' });

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [orders] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [req.params.id]);
      const order = orders[0];
      if (!order || order.user_id !== userId) {
        await connection.rollback();
        return res.status(404).json({ mensaje: 'Pedido no encontrado' });
      }
      if (order.status === 'paid') {
        const [receipts] = await connection.execute('SELECT * FROM receipts WHERE order_id = ?', [order.id]);
        if (!receipts[0]) throw new Error(`Paid order ${order.id} has no receipt`);
        await connection.commit();
        return res.status(200).json({
          mensaje: 'El pedido ya estaba pagado',
          pago: null,
          estadoPedido: 'Pagado',
          comprobante: {
            id: Number(receipts[0].id),
            numero: `COMP-${String(receipts[0].id).padStart(8, '0')}`,
          },
        });
      }
      if (order.status !== 'confirmed') {
        await connection.rollback();
        return res.status(409).json({ mensaje: 'Solo se pueden pagar pedidos pendientes de pago' });
      }

      const paymentStatus = simulatedResult === 'aprobado' ? 'approved' : 'rejected';
      const paymentMethod = method === 'tarjeta' ? 'card' : 'transfer';
      const [paymentResult] = await connection.execute(
        'INSERT INTO payments (order_id, method, amount_cents, status) VALUES (?, ?, ?, ?)',
        [order.id, paymentMethod, order.total_cents, paymentStatus],
      );
      const [paymentRows] = await connection.execute('SELECT * FROM payments WHERE id = ?', [paymentResult.insertId]);
      const payment = paymentRows[0];
      if (paymentStatus === 'rejected') {
        await connection.commit();
        return res.json({
          mensaje: 'Pago rechazado; el pedido continúa pendiente',
          pago: formatPayment(payment),
          estadoPedido: 'Pendiente',
          comprobante: null,
        });
      }

      const details = await getDetails(connection, order.id);
      const receiptItems = details.map((detail) => ({
        nombreProducto: detail.nombreProducto,
        cantidad: detail.cantidad,
        precioUnitario: detail.precioUnitario,
        subtotal: detail.subtotal,
      }));
      const customerName = String(order.user_name || '').trim();
      const [receiptResult] = await connection.execute(
        `INSERT INTO receipts
          (order_id, payment_id, customer_name, customer_email, payment_method,
           subtotal_cents, discount_cents, total_cents, coupon_code, items)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          order.id,
          payment.id,
          customerName,
          order.user_email,
          paymentMethod,
          order.subtotal_cents,
          order.discount_cents,
          order.total_cents,
          order.coupon_code,
          JSON.stringify(receiptItems),
        ],
      );
      await connection.execute("UPDATE orders SET status = 'paid' WHERE id = ?", [order.id]);
      const [receipts] = await connection.execute('SELECT * FROM receipts WHERE id = ?', [receiptResult.insertId]);
      await connection.commit();
      return res.json({
        mensaje: 'Pago aprobado',
        pago: formatPayment(payment),
        estadoPedido: 'Pagado',
        comprobante: {
          id: Number(receipts[0].id),
          numero: `COMP-${String(receipts[0].id).padStart(8, '0')}`,
        },
      });
    } catch (error) {
      await connection.rollback();
      console.error('Failed to process simulated payment:', error);
      return res.status(500).json({ mensaje: 'No se pudo procesar el pago simulado' });
    } finally {
      connection.release();
    }
  });

  app.get('/api/pedidos/:id/comprobante', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ mensaje: 'Comprobante no encontrado' });
    const userId = req.get('x-user-id');
    const role = req.get('x-user-role');
    if (!userId || !['client', 'admin'].includes(role)) {
      return res.status(401).json({ mensaje: 'Identidad de usuario requerida' });
    }
    try {
      const [orders] = await pool.execute('SELECT * FROM orders WHERE id = ?', [req.params.id]);
      const order = orders[0];
      if (!order || (role !== 'admin' && order.user_id !== userId)) {
        return res.status(404).json({ mensaje: 'Comprobante no encontrado' });
      }
      if (!['paid', 'shipped', 'delivered'].includes(order.status)) {
        return res.status(404).json({ mensaje: 'El pedido todavía no tiene comprobante pagado' });
      }
      const [receipts] = await pool.execute('SELECT * FROM receipts WHERE order_id = ?', [order.id]);
      if (!receipts[0]) return res.status(404).json({ mensaje: 'Comprobante no encontrado' });
      return res.json(formatReceipt(receipts[0]));
    } catch (error) {
      console.error('Failed to get order receipt:', error);
      return res.status(500).json({ mensaje: 'No se pudo consultar el comprobante' });
    }
  });

  app.patch('/api/pedidos/:id', async (req, res) => {
    if (!/^\d+$/.test(req.params.id)) return res.status(404).json({ message: 'Pedido no encontrado' });
    const { estado, inventory } = req.body || {};
    if (!['confirmed', 'rejected', 'cancelling', 'cancelled', 'shipped', 'delivered'].includes(estado)) {
      return res.status(400).json({ message: 'Transición de pedido inválida' });
    }
    if (estado === 'confirmed' && (!inventory || !Array.isArray(inventory.items)
      || !asMoney(inventory.subtotalCents) || !asMoney(inventory.discountCents)
      || !asMoney(inventory.totalCents))) {
      return res.status(400).json({ message: 'Importes autorizados de inventario inválidos' });
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [orders] = await connection.execute('SELECT * FROM orders WHERE id = ? FOR UPDATE', [req.params.id]);
      const order = orders[0];
      if (!order) {
        await connection.rollback();
        return res.status(404).json({ message: 'Pedido no encontrado' });
      }
      if (['cancelling', 'cancelled', 'shipped', 'delivered'].includes(estado)) {
        if (order.status === estado) {
          await connection.commit();
          return res.status(200).json(formatOrder(order, await getDetails(connection, order.id)));
        }
        const role = req.get('x-user-role');
        const userId = req.get('x-user-id');
        const ownsOrder = userId && order.user_id === userId;
        const authorized = estado === 'shipped' || estado === 'delivered'
          ? role === 'admin'
          : role === 'admin' || (role === 'client' && ownsOrder);
        const validTransition = estado === 'cancelling'
          ? order.status === 'confirmed'
          : estado === 'cancelled'
            ? order.status === 'cancelling'
            : estado === 'shipped'
              ? order.status === 'paid'
              : order.status === 'shipped';
        if (!authorized || !validTransition) {
          await connection.rollback();
          return res.status(409).json({ message: 'El pedido no admite esta transición' });
        }
        await connection.execute('UPDATE orders SET status = ? WHERE id = ?', [estado, order.id]);
        order.status = estado;
        await connection.commit();
        return res.status(200).json(formatOrder(order, await getDetails(connection, order.id)));
      }
      if (order.status === estado) {
        const details = await getDetails(connection, order.id);
        if (estado === 'confirmed') {
          const inventoryItems = new Map(inventory.items.map((item) => [Number(item.productId), item]));
          const matches = details.length === inventoryItems.size && details.every((detail) => {
            const authorized = inventoryItems.get(detail.productoId);
            return authorized
              && Number(authorized.quantity) === detail.cantidad
              && authorized.productName === detail.nombreProducto
              && Number(authorized.unitPriceCents) === detail.unitPriceCents
              && Number(authorized.subtotalCents) === detail.subtotalCents;
          });
          if (!matches || Number(order.subtotal_cents) !== Number(inventory.subtotalCents)
            || Number(order.discount_cents) !== Number(inventory.discountCents)
            || Number(order.total_cents) !== Number(inventory.totalCents)
            || (order.coupon_code || null) !== (inventory.couponCode || null)) {
            await connection.rollback();
            return res.status(409).json({ message: 'La confirmación repetida difiere de la persistida' });
          }
        }
        await connection.commit();
        return res.status(200).json(formatOrder(order, details));
      }
      if (order.status !== 'pending') {
        await connection.rollback();
        return res.status(409).json({ message: 'El pedido ya no admite esta transición' });
      }

      if (estado === 'rejected') {
        await connection.execute("UPDATE orders SET status = 'rejected' WHERE id = ?", [order.id]);
      } else {
        const storedItems = await getDetails(connection, order.id);
        const incoming = new Map(inventory.items.map((item) => [
          Number(item.productId),
          item,
        ]));
        if (incoming.size !== storedItems.length) {
          await connection.rollback();
          return res.status(409).json({ message: 'El detalle autorizado no coincide con el pedido' });
        }
        let calculatedSubtotal = 0;
        for (const item of storedItems) {
          const authorized = incoming.get(item.productoId);
          if (!authorized || Number(authorized.quantity) !== item.cantidad || !asMoney(authorized.unitPriceCents)
            || typeof authorized.productName !== 'string' || !authorized.productName.trim()) {
            await connection.rollback();
            return res.status(409).json({ message: 'El detalle autorizado no coincide con el pedido' });
          }
          const lineCents = Number(authorized.unitPriceCents) * item.cantidad;
          if (!Number.isSafeInteger(lineCents)) throw new Error('Order amount exceeds safe integer range');
          calculatedSubtotal += lineCents;
          await connection.execute(
            `UPDATE order_items SET product_name = ?, unit_price_cents = ?, subtotal_cents = ?
             WHERE order_id = ? AND product_id = ?`,
            [authorized.productName, authorized.unitPriceCents, lineCents, order.id, item.productoId],
          );
        }
        if (calculatedSubtotal !== Number(inventory.subtotalCents)
          || Number(inventory.discountCents) > calculatedSubtotal
          || Number(inventory.totalCents) !== calculatedSubtotal - Number(inventory.discountCents)) {
          await connection.rollback();
          return res.status(409).json({ message: 'Los importes autorizados no coinciden con el detalle' });
        }
        await connection.execute(
          `UPDATE orders SET status = 'confirmed', subtotal_cents = ?, discount_cents = ?,
            total_cents = ?, coupon_code = ? WHERE id = ?`,
          [inventory.subtotalCents, inventory.discountCents, inventory.totalCents, inventory.couponCode || null, order.id],
        );
      }
      await connection.commit();
      const [updated] = await pool.execute('SELECT * FROM orders WHERE id = ?', [order.id]);
      return res.status(200).json(formatOrder(updated[0], await getDetails(pool, order.id)));
    } catch (error) {
      await connection.rollback();
      console.error('Failed to transition order:', error);
      return res.status(500).json({ message: 'No se pudo actualizar el pedido' });
    } finally {
      connection.release();
    }
  });

  return app;
}

module.exports = { createApp };
