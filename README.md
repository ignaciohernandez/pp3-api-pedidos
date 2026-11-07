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

## Contrato de pedidos

Todas las rutas `/api` requieren `x-service-token`. El Gateway valida el JWT y
construye `x-user-id` y `x-user-role` a partir de sus claims, sin aceptar identidad
aportada por el cliente en headers, query o body. Pedidos confía en esa identidad
únicamente después de autenticar al servicio. Los roles admitidos son `client` y `admin`.

| Método y ruta | Comportamiento |
|---|---|
| `GET /api/pedidos` | Cliente: únicamente sus pedidos. Administrador: todos. Hasta 500, ordenados por ID descendente. |
| `GET /api/pedidos/:id` | Propietario o administrador. Devuelve 404 a otro cliente y 401 si falta identidad válida. |
| `POST /api/pedidos` | Crea un pedido pendiente; requiere identidad, email, `Idempotency-Key` e `items` con `productId` y `quantity`. Devuelve 201 al crear, 200 al repetir el mismo contenido y 409 si cambia el contenido. |
| `PATCH /api/pedidos/:id` | Actualiza `estado` con transiciones controladas. Confirmación y rechazo son operaciones internas del coordinador. Cancelación: propietario o administrador; envío y entrega: administrador. También se comprueban permisos al repetir una transición. |

No se necesita `/mis-pedidos`: la identidad autenticada determina el alcance de
`GET /api/pedidos`. Para cambios de estado parciales corresponde `PATCH`.

## Integración con Catálogo

El Gateway coordina el descuento y la devolución de stock mediante
`POST /api/movimientos-stock` de Catálogo y claves idempotentes. Pedidos conserva
el flujo `pending → confirmed/rejected`, `confirmed → cancelling → cancelled`
y la confirmación de importes autorizados. No descuenta ni devuelve stock por su
cuenta: duplicar esa responsabilidad produciría movimientos repetidos.

## Token interno y prueba end-to-end

En Render, `ORDERS_SERVICE_TOKEN` del **Gateway** debe contener exactamente el
mismo secreto que `SERVICE_TOKEN` de **Pedidos**, con al menos 32 caracteres.
Son nombres de configuración diferentes para la misma credencial; Pedidos lee
`SERVICE_TOKEN`, no `ORDERS_SERVICE_TOKEN`. No guardar valores reales en Git.
`CATALOG_SERVICE_TOKEN` es la credencial independiente para Catálogo.

La configuración de Render no se modifica desde este repositorio. Antes de la
prueba end-to-end hay que verificar ambos valores en sus servicios y desplegar
el Gateway con sus rutas públicas pendientes: consulta por ID y cancelación con
PATCH; retirar el alias `/api/pedidos/mis-pedidos` coordinando sus consumidores.

La revisión del Gateway se realizó sobre
[`LuCorral/PP3-Ecommerce-Microservices`, rama `arquitectura-microservicios`, commit `97d9dac`](https://github.com/LuCorral/PP3-Ecommerce-Microservices/tree/97d9dac5c2af6329e6a5b32f451073b49e0f48d2).
Ya implementa listado, creación, identidad desde JWT y movimientos de stock;
no se modificó ese repositorio por falta de permisos de escritura.

Para validar la integración: probar listado y detalle con dos clientes y un
administrador; crear un pedido y comprobar un solo descuento; cancelar y repetir
la cancelación comprobando una sola devolución. Un health check correcto no
demuestra que el token interno esté configurado.

## Pruebas locales

Ejecutar `npm ci` y `npm test` con Node.js 22 o superior. Las pruebas levantan la
API HTTP con un pool de base de datos simulado; cubren aislamiento por usuario,
acceso administrador, identidad inválida, permisos en reintentos y el ciclo de
pago/comprobante. No sustituyen la prueba con MySQL y Catálogo reales.
