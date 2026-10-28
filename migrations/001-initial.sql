CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_id VARCHAR(128) NOT NULL,
  user_email VARCHAR(320) NOT NULL,
  user_name VARCHAR(255) NOT NULL,
  attempt_id VARCHAR(128) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  status ENUM('pending', 'confirmed', 'rejected', 'paid', 'cancelled') NOT NULL DEFAULT 'pending',
  subtotal_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
  discount_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
  total_cents BIGINT UNSIGNED NOT NULL DEFAULT 0,
  coupon_code VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY orders_user_attempt_unique (user_id, attempt_id),
  KEY orders_status_created_idx (status, created_at)
);

CREATE TABLE IF NOT EXISTS order_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  order_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  product_name VARCHAR(255) NULL,
  quantity INT UNSIGNED NOT NULL,
  unit_price_cents BIGINT UNSIGNED NULL,
  subtotal_cents BIGINT UNSIGNED NULL,
  CONSTRAINT order_items_order_fk FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  UNIQUE KEY order_items_order_product_unique (order_id, product_id)
);
