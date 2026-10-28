const { timingSafeEqual } = require('node:crypto');

function requireService(req, res, next) {
  const provided = Buffer.from(req.get('x-service-token') || '');
  const expected = Buffer.from(process.env.SERVICE_TOKEN || '');
  if (!expected.length || provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return res.status(403).json({ message: 'Autenticación de servicio requerida' });
  }
  return next();
}

module.exports = { requireService };
