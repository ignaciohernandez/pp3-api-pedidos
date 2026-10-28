# pp3-api-pedidos

# API de Pedidos

Microservicio independiente de pedidos del e-commerce (PP3). Gestiona el ciclo de vida
completo de un pedido: creación idempotente, confirmación con importes autorizados,
pago simulado, comprobante, cancelación con devolución de stock, y envío/entrega.

## Stack

| Componente | Tecnología |
|---|---|
| Runtime | Node.js 22 |
| Framework | Express 5 |
| Base de datos | MySQL 8 (Aiven) |
| Deploy | Render (Docker) |

## Arquitectura

Este servicio se despliega de forma independiente y no comparte código ni base de datos
con los demás servicios del sistema.
