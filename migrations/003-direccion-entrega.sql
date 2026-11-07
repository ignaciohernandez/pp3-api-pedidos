SET @direccion_entrega_sql = (
  SELECT IF(COUNT(*) = 0,
    'ALTER TABLE orders ADD COLUMN direccion_entrega VARCHAR(500) NULL',
    'SELECT 1')
  FROM information_schema.columns
  WHERE table_schema = DATABASE() AND table_name = 'orders' AND column_name = 'direccion_entrega'
);
PREPARE direccion_entrega_statement FROM @direccion_entrega_sql;
EXECUTE direccion_entrega_statement;
DEALLOCATE PREPARE direccion_entrega_statement;
