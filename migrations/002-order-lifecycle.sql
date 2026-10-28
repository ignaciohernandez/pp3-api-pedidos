ALTER TABLE orders
  MODIFY status ENUM('pending', 'confirmed', 'rejected', 'paid', 'cancelling', 'cancelled', 'shipped', 'delivered')
  NOT NULL DEFAULT 'pending';

CREATE TABLE IF NOT EXISTS payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  method ENUM('card', 'transfer') NOT NULL,
  amount_cents BIGINT UNSIGNED NOT NULL,
  status ENUM('approved', 'rejected') NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT payments_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  KEY payments_order_created_idx (order_id, created_at)
);

CREATE TABLE IF NOT EXISTS receipts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL UNIQUE,
  payment_id BIGINT UNSIGNED NOT NULL UNIQUE,
  issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(320) NOT NULL,
  payment_method ENUM('card', 'transfer') NOT NULL,
  subtotal_cents BIGINT UNSIGNED NOT NULL,
  discount_cents BIGINT UNSIGNED NOT NULL,
  total_cents BIGINT UNSIGNED NOT NULL,
  coupon_code VARCHAR(64) NULL,
  items JSON NOT NULL,
  CONSTRAINT receipts_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  CONSTRAINT receipts_payment_fk FOREIGN KEY (payment_id) REFERENCES payments(id) ON DELETE CASCADE
);
