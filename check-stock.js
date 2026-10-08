const db = require('./db/database');

const rows = db.prepare(`
  SELECT
    i.id AS inventory_id,
    m.name AS medicine_name,
    p.name AS pharmacy_name,
    i.stock_quantity,
    (
      SELECT COALESCE(SUM(r.quantity), 0)
      FROM reservations r
      WHERE r.inventory_id = i.id
        AND r.status IN ('pending', 'confirmed')
    ) AS reserved_quantity,
    (
      i.stock_quantity - (
        SELECT COALESCE(SUM(r.quantity), 0)
        FROM reservations r
        WHERE r.inventory_id = i.id
          AND r.status IN ('pending', 'confirmed')
      )
    ) AS available_stock
  FROM inventory i
  JOIN medicines m ON m.id = i.medicine_id
  JOIN pharmacies p ON p.id = i.pharmacy_id
  WHERE m.name LIKE '%Amoxicillin%'
`).all();
console.table(rows);