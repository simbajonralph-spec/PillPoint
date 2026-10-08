const ELIGIBLE_BATCH_STATUSES = ['active', 'expiring_soon'];

function eligibleBatchQuantitySql(inventoryAlias = 'i') {
  return `(
    SELECT COALESCE(SUM(b.current_quantity), 0)
    FROM medicine_batches b
    WHERE b.inventory_id = ${inventoryAlias}.id
      AND b.current_quantity > 0
      AND b.status IN ('active', 'expiring_soon')
      AND (b.expiration_date IS NULL OR date(b.expiration_date) >= date('now', 'localtime'))
  )`;
}

function publishedProductSql(inventoryAlias = 'i', medicineAlias = 'm') {
  const eligibleQuantity = eligibleBatchQuantitySql(inventoryAlias);
  const reservations = `(SELECT COALESCE(SUM(r.quantity), 0) FROM reservations r
    WHERE r.inventory_id = ${inventoryAlias}.id AND r.status IN ('pending','confirmed','ready_for_pickup'))`;
  return `(
    ${inventoryAlias}.deployed = 1
    AND TRIM(COALESCE(${medicineAlias}.name, '')) <> ''
    AND TRIM(COALESCE(${medicineAlias}.category, '')) <> ''
    AND ${inventoryAlias}.price > 0
    AND ${inventoryAlias}.stock_quantity = (
      SELECT COALESCE(SUM(b.current_quantity), 0)
      FROM medicine_batches b WHERE b.inventory_id = ${inventoryAlias}.id
    )
    AND EXISTS (
      SELECT 1 FROM medicine_batches valid_batch
      WHERE valid_batch.inventory_id = ${inventoryAlias}.id
        AND valid_batch.current_quantity > 0
        AND valid_batch.status IN ('active','expiring_soon')
        AND TRIM(COALESCE(valid_batch.batch_number, '')) <> ''
        AND valid_batch.expiration_date IS NOT NULL
        AND date(valid_batch.expiration_date) IS NOT NULL
        AND date(valid_batch.expiration_date) >= date('now','localtime')
    )
    AND MAX(0, MIN(${inventoryAlias}.stock_quantity, ${eligibleQuantity}) - ${reservations}) > 0
  )`;
}

function totalBatchQuantity(db, inventoryId) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(current_quantity), 0) AS total
    FROM medicine_batches WHERE inventory_id = ?
  `).get(inventoryId).total);
}

function eligibleBatchQuantity(db, inventoryId) {
  return Number(db.prepare(`
    SELECT COALESCE(SUM(current_quantity), 0) AS total
    FROM medicine_batches
    WHERE inventory_id = ? AND current_quantity > 0
      AND status IN ('active','expiring_soon')
      AND (expiration_date IS NULL OR date(expiration_date) >= date('now','localtime'))
  `).get(inventoryId).total);
}

function inventoryIntegrity(db, inventoryId, physicalQuantity) {
  const batchQuantity = totalBatchQuantity(db, inventoryId);
  const physical = Number(physicalQuantity || 0);
  return {
    batch_quantity: batchQuantity,
    integrity_ok: physical === batchQuantity,
    integrity_difference: physical - batchQuantity,
  };
}

module.exports = {
  ELIGIBLE_BATCH_STATUSES,
  eligibleBatchQuantity,
  eligibleBatchQuantitySql,
  inventoryIntegrity,
  publishedProductSql,
  totalBatchQuantity,
};
