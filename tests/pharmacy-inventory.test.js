const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const pharmacyRoutes = require('../routes/pharmacy');
const customerRoutes = require('../routes/customer');
const publicRoutes = require('../routes/public');
const { expirePendingReservations } = require('../services/reservation-expiry');

function callRoute(router, path, method, req) {
  const layer = router.stack.find(item => item.route?.path === path && item.route.methods[method]);
  assert.ok(layer, `${method.toUpperCase()} ${path} should be registered`);
  const handler = layer.route.stack.at(-1).handle;
  let statusCode = 200;
  let body;
  handler(req, {
    status(code) { statusCode = code; return this; },
    json(value) { body = value; return this; },
  });
  return { statusCode, body };
}

test('inventory quantities use reservations and stock movements remain transaction-backed', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  const customer = db.prepare("SELECT id, name FROM users WHERE role = 'customer' LIMIT 1").get();
  assert.ok(staff, 'seed data should include a pharmacy staff account');
  assert.ok(customer, 'seed data should include a customer account');

  const rollback = new Error('rollback pharmacy inventory fixtures');
  const run = db.transaction(() => {
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 inventory fixture', 'Test')
    `).run().lastInsertRowid);
    const inventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 12, 10, 4, 1)
    `).run(staff.pharmacy_id, medicineId).lastInsertRowid);
    const batchId = Number(db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number, expiration_date, quantity_received, current_quantity
      ) VALUES (?, ?, ?, 'P1-INVENTORY-BATCH', date('now','+365 days'), 10, 10)
    `).run(staff.pharmacy_id, medicineId, inventoryId).lastInsertRowid);
    const supplierId = Number(db.prepare(`
      INSERT INTO suppliers (pharmacy_id, name) VALUES (?, 'P1 inventory supplier')
    `).run(staff.pharmacy_id).lastInsertRowid);
    const pendingReservation = Number(db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status)
      VALUES (?, ?, 3, 'pending')
    `).run(customer.id, inventoryId).lastInsertRowid);
    const confirmedReservation = Number(db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status)
      VALUES (?, ?, 2, 'confirmed')
    `).run(customer.id, inventoryId).lastInsertRowid);
    const staffReq = {
      params: { id: String(inventoryId) },
      body: { stock_quantity: 99 },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    };

    const inventoryResponse = callRoute(pharmacyRoutes, '/inventory', 'get', {
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    const product = inventoryResponse.body.inventory.find(row => row.id === inventoryId);
    assert.equal(product.stock_quantity, 10);
    assert.equal(product.reserved_quantity, 5);
    assert.equal(product.available_quantity, 5);

    const editResponse = callRoute(pharmacyRoutes, '/inventory/:id', 'put', staffReq);
    assert.equal(editResponse.statusCode, 422);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 10);

    const excessiveOut = callRoute(pharmacyRoutes, '/inventory/stock-out', 'post', {
      body: { inventory_id: inventoryId, quantity: 6, reason: 'sold' },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(excessiveOut.statusCode, 422);

    const noReason = callRoute(pharmacyRoutes, '/inventory/stock-out', 'post', {
      body: { inventory_id: inventoryId, quantity: 1, batch_id: batchId },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(noReason.statusCode, 422);
    const stockOut = callRoute(pharmacyRoutes, '/inventory/stock-out', 'post', {
      body: {
        inventory_id: inventoryId,
        quantity: 2,
        reason: 'sold',
        reference_number: 'P1-SALE-REF',
        remarks: 'Sold at counter',
      },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(stockOut.statusCode, 200);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 8);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE id = ?').get(batchId).current_quantity, 8);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM stock_transactions
      WHERE inventory_id = ? AND transaction_type = 'stock_out' AND quantity = 2
    `).get(inventoryId).total, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM inventory_audit_logs
      WHERE entity_id = ? AND action = 'stock_out'
    `).get(inventoryId).total, 1);
    const recordedOut = db.prepare(`
      SELECT * FROM stock_transactions WHERE inventory_id = ? AND transaction_type = 'stock_out' ORDER BY id DESC LIMIT 1
    `).get(inventoryId);
    assert.equal(recordedOut.reason, 'sold');
    assert.equal(recordedOut.reference_number, 'P1-SALE-REF');
    assert.equal(recordedOut.staff_user_id, staff.id);
    assert.equal(recordedOut.batch_id, batchId);

    const pickup = callRoute(pharmacyRoutes, '/reservations/:id/complete', 'post', {
      params: { id: String(confirmedReservation) },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(pickup.statusCode, 200);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 6);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE id = ?').get(batchId).current_quantity, 6);

    const badReservation = callRoute(customerRoutes, '/reservations', 'post', {
      body: { inventory_id: inventoryId, quantity: 2.5 },
      session: { user: { id: customer.id, name: customer.name, role: 'customer' } },
    });
    assert.equal(badReservation.statusCode, 422);

    const cancel = callRoute(customerRoutes, '/reservations/:id/cancel', 'post', {
      params: { id: String(pendingReservation) },
      session: { user: { id: customer.id, name: customer.name, role: 'customer' } },
    });
    assert.equal(cancel.statusCode, 200);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 6);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM stock_transactions
      WHERE inventory_id = ? AND transaction_type = 'reservation_cancellation'
    `).get(inventoryId).total, 1);

    const reservation = callRoute(customerRoutes, '/reservations', 'post', {
      body: { inventory_id: inventoryId, quantity: 1 },
      session: { user: { id: customer.id, name: customer.name, role: 'customer' } },
    });
    assert.equal(reservation.statusCode, 201);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 6);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM stock_transactions
      WHERE inventory_id = ? AND transaction_type = 'reservation' AND reason = 'reservation_hold'
    `).get(inventoryId).total, 1);

    const stockIn = callRoute(pharmacyRoutes, '/inventory/stock-in', 'post', {
      body: {
        inventory_id: inventoryId,
        quantity: 2,
        batch_number: 'P1-RECEIVED-BATCH',
        supplier_id: supplierId,
        purchase_price: 4.25,
        selling_price: 13.5,
        manufacturing_date: '2026-01-01',
        expiration_date: '2027-01-01',
        supplier_reference: 'P1-PO-98',
        storage_location: 'Shelf B2',
        remarks: 'Initial receipt test',
      },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    const invalidReceipt = callRoute(pharmacyRoutes, '/inventory/stock-in', 'post', {
      body: {
        inventory_id: inventoryId,
        quantity: 1,
        batch_number: 'P1-INVALID-DATE',
        manufacturing_date: '2027-01-01',
        expiration_date: '2026-01-01',
      },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(invalidReceipt.statusCode, 422);
    assert.equal(stockIn.statusCode, 200);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 8);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM stock_transactions
      WHERE inventory_id = ? AND transaction_type = 'stock_in' AND quantity = 2
    `).get(inventoryId).total, 1);
    const receivedBatch = db.prepare(`
      SELECT * FROM medicine_batches WHERE pharmacy_id = ? AND batch_number = 'P1-RECEIVED-BATCH'
    `).get(staff.pharmacy_id);
    assert.equal(receivedBatch.supplier_id, supplierId);
    assert.equal(receivedBatch.quantity_received, 2);
    assert.equal(receivedBatch.current_quantity, 2);
    assert.equal(receivedBatch.purchase_price, 4.25);
    assert.equal(receivedBatch.selling_price, 13.5);
    assert.equal(receivedBatch.manufacturing_date, '2026-01-01');
    assert.equal(receivedBatch.expiration_date, '2027-01-01');
    assert.equal(receivedBatch.supplier_reference, 'P1-PO-98');
    assert.equal(receivedBatch.storage_location, 'Shelf B2');
    const receivedTransaction = db.prepare(`
      SELECT * FROM stock_transactions WHERE inventory_id = ? AND transaction_type = 'stock_in' ORDER BY id DESC LIMIT 1
    `).get(inventoryId);
    assert.equal(receivedTransaction.batch_id, receivedBatch.id);
    assert.equal(receivedTransaction.staff_user_id, staff.id);
    assert.equal(receivedTransaction.reference_number, 'P1-PO-98');
    assert.match(receivedTransaction.remarks, /Initial receipt test/);

    const adjustment = callRoute(pharmacyRoutes, '/inventory/adjust', 'post', {
      body: { inventory_id: inventoryId, adjustment: -1, reason: 'test recount' },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(adjustment.statusCode, 200);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 7);
    assert.equal(db.prepare(`
      SELECT COALESCE(SUM(current_quantity), 0) AS total FROM medicine_batches WHERE inventory_id = ?
    `).get(inventoryId).total, 7);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS total FROM inventory_audit_logs
      WHERE entity_id = ? AND action = 'adjustment'
    `).get(inventoryId).total, 1);

    const deleteResponse = callRoute(pharmacyRoutes, '/inventory/:id', 'delete', {
      params: { id: String(inventoryId) },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(deleteResponse.statusCode, 422);
    throw rollback;
  });

  assert.throws(() => run(), error => error === rollback);
});

test('stock-out consumes only unexpired batches in FEFO order and exposes inventory mismatches', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  assert.ok(staff, 'seed data should include a pharmacy staff account');

  const rollback = new Error('rollback FEFO inventory fixtures');
  const run = db.transaction(() => {
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 FEFO fixture', 'Test')
    `).run().lastInsertRowid);
    const inventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 10, 10, 2, 1)
    `).run(staff.pharmacy_id, medicineId).lastInsertRowid);
    const firstExpiring = Number(db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number,
        expiration_date, quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'P1-FEFO-FIRST', date('now','+10 days'), 2, 2, 'active')
    `).run(staff.pharmacy_id, medicineId, inventoryId).lastInsertRowid);
    const secondExpiring = Number(db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number,
        expiration_date, quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'P1-FEFO-SECOND', date('now','+40 days'), 5, 5, 'active')
    `).run(staff.pharmacy_id, medicineId, inventoryId).lastInsertRowid);
    const expiredBatch = Number(db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number,
        expiration_date, quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'P1-FEFO-EXPIRED', date('now','-1 day'), 3, 3, 'active')
    `).run(staff.pharmacy_id, medicineId, inventoryId).lastInsertRowid);

    const inventoryResponse = callRoute(pharmacyRoutes, '/inventory', 'get', {
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    const item = inventoryResponse.body.inventory.find(row => row.id === inventoryId);
    assert.equal(item.available_quantity, 7);
    assert.equal(item.integrity_ok, true);
    const expired = inventoryResponse.body.batches.find(row => row.id === expiredBatch);
    assert.equal(expired.expiration_warning, 'expired');
    assert.equal(inventoryResponse.body.batches.find(row => row.id === firstExpiring).expiration_warning, 'within_30_days');
    assert.equal(inventoryResponse.body.batches.find(row => row.id === secondExpiring).expiration_warning, 'within_90_days');

    const response = callRoute(pharmacyRoutes, '/inventory/stock-out', 'post', {
      body: { inventory_id: inventoryId, quantity: 4, reason: 'sold' },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE id = ?').get(firstExpiring).current_quantity, 0);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE id = ?').get(secondExpiring).current_quantity, 3);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE id = ?').get(expiredBatch).current_quantity, 3);
    const fefoTransactions = db.prepare(`
      SELECT batch_id, quantity FROM stock_transactions
      WHERE inventory_id = ? AND transaction_type = 'stock_out'
      ORDER BY id DESC LIMIT 2
    `).all(inventoryId);
    assert.deepEqual(fefoTransactions.map(row => [row.batch_id, row.quantity]), [
      [secondExpiring, 2],
      [firstExpiring, 2],
    ]);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 6);

    const customer = db.prepare("SELECT id FROM users WHERE role = 'customer' LIMIT 1").get();
    assert.ok(customer, 'seed data should include a customer account');
    db.prepare('UPDATE inventory SET stock_quantity = 10 WHERE id = ?').run(inventoryId);
    db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status)
      VALUES (?, ?, 3, 'confirmed')
    `).run(customer.id, inventoryId);
    const pickupReservationId = Number(db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status)
      VALUES (?, ?, 1, 'confirmed')
    `).run(customer.id, inventoryId).lastInsertRowid);
    db.exec(`
      CREATE TRIGGER p1_fail_pickup_inventory_update
      BEFORE UPDATE OF stock_quantity ON inventory
      WHEN OLD.id = ${inventoryId}
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);
    const failedPickup = callRoute(pharmacyRoutes, '/reservations/:id/complete', 'post', {
      params: { id: String(pickupReservationId) },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(failedPickup.statusCode, 422);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE id = ?').get(secondExpiring).current_quantity, 3);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 10);
    assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(pickupReservationId).status, 'confirmed');
    db.exec('DROP TRIGGER p1_fail_pickup_inventory_update');

    const integrityResponse = callRoute(pharmacyRoutes, '/inventory', 'get', {
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    const mismatch = integrityResponse.body.inventory.find(row => row.id === inventoryId);
    assert.equal(mismatch.integrity_ok, false);
    assert.equal(mismatch.integrity_difference, 4);
    assert.equal(mismatch.available_quantity, 0);
    const reconcile = callRoute(pharmacyRoutes, '/inventory/reconcile-batches', 'post', {
      body: { inventory_id: inventoryId, reason: 'Verified physical count against all batch records' },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(reconcile.statusCode, 200);
    assert.equal(reconcile.body.adjustment, -4);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 6);
    assert.equal(db.prepare('SELECT SUM(current_quantity) AS total FROM medicine_batches WHERE inventory_id = ?').get(inventoryId).total, 6);
    const reconciliationTransaction = db.prepare(`
      SELECT reason, quantity, previous_quantity, new_quantity, staff_user_id
      FROM stock_transactions WHERE inventory_id = ? AND reason = 'batch_reconciliation'
      ORDER BY id DESC LIMIT 1
    `).get(inventoryId);
    assert.deepEqual(
      [reconciliationTransaction.reason, reconciliationTransaction.quantity, reconciliationTransaction.previous_quantity, reconciliationTransaction.new_quantity, reconciliationTransaction.staff_user_id],
      ['batch_reconciliation', -4, 10, 6, staff.id]
    );
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_audit_logs
      WHERE entity_id = ? AND action = 'batch_integrity_reconciled'
    `).get(inventoryId).count, 1);

    throw rollback;
  });

  assert.throws(() => run(), error => error === rollback);
});

test('publishing validates products atomically and never changes stock or inventory records', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  assert.ok(staff, 'seed data should include a pharmacy staff account');

  const rollback = new Error('rollback publishing fixtures');
  const run = db.transaction(() => {
    const validMedicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 Publish Valid', 'Test Category')
    `).run().lastInsertRowid);
    const invalidMedicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 Publish Incomplete', NULL)
    `).run().lastInsertRowid);
    const expiredMedicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 Publish Expired', 'Test Category')
    `).run().lastInsertRowid);
    const insertInventory = db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold)
      VALUES (?, ?, ?, ?, 1)
    `);
    const validInventoryId = Number(insertInventory.run(staff.pharmacy_id, validMedicineId, 9.5, 4).lastInsertRowid);
    const invalidInventoryId = Number(insertInventory.run(staff.pharmacy_id, invalidMedicineId, 0, 0).lastInsertRowid);
    const expiredInventoryId = Number(insertInventory.run(staff.pharmacy_id, expiredMedicineId, 8, 2).lastInsertRowid);
    const validBatchId = Number(db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number, expiration_date,
        quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'P1-PUBLISH-GOOD', date('now','+60 days'), 4, 4, 'active')
    `).run(staff.pharmacy_id, validMedicineId, validInventoryId).lastInsertRowid);
    db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number, expiration_date,
        quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'P1-PUBLISH-EXPIRED', date('now','-1 day'), 2, 2, 'active')
    `).run(staff.pharmacy_id, expiredMedicineId, expiredInventoryId);

    const staffSession = { user: { ...staff, role: 'pharmacy_staff' } };
    const bulkBlocked = callRoute(pharmacyRoutes, '/inventory/publish', 'post', {
      body: { inventory_ids: [validInventoryId, invalidInventoryId, expiredInventoryId] },
      session: staffSession,
    });
    assert.equal(bulkBlocked.statusCode, 422);
    assert.ok(bulkBlocked.body.product_issues[invalidInventoryId].some(issue => issue.includes('Category')));
    assert.ok(bulkBlocked.body.product_issues[invalidInventoryId].some(issue => issue.includes('Price')));
    assert.ok(bulkBlocked.body.product_issues[invalidInventoryId].some(issue => issue.includes('Available stock')));
    assert.ok(bulkBlocked.body.product_issues[expiredInventoryId].some(issue => issue.includes('expiration date')));
    assert.equal(db.prepare('SELECT deployed FROM inventory WHERE id = ?').get(validInventoryId).deployed, 0);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(validInventoryId).stock_quantity, 4);

    const beforePublish = callRoute(publicRoutes, '/pharmacies/:id', 'get', {
      params: { id: String(staff.pharmacy_id) },
      query: {},
      session: {},
    });
    assert.ok(!beforePublish.body.products.some(row => row.inventory_id === validInventoryId));

    const publish = callRoute(pharmacyRoutes, '/inventory/publish', 'post', {
      body: { inventory_ids: [validInventoryId] },
      session: staffSession,
    });
    assert.equal(publish.statusCode, 200);
    assert.equal(publish.body.published_count, 1);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(validInventoryId).stock_quantity, 4);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE inventory_id = ?').get(validInventoryId).current_quantity, 4);
    const originalExpiration = db.prepare('SELECT expiration_date FROM medicine_batches WHERE id = ?').get(validBatchId).expiration_date;
    const editExpiration = callRoute(pharmacyRoutes, '/inventory/:id', 'put', {
      params: { id: String(validInventoryId) },
      body: { expiration_date: '2027-01-15' },
      session: staffSession,
    });
    assert.equal(editExpiration.statusCode, 422);
    assert.equal(db.prepare('SELECT expiration_date FROM medicine_batches WHERE id = ?').get(validBatchId).expiration_date, originalExpiration);
    const validExpirationEdit = callRoute(pharmacyRoutes, '/inventory/:id', 'put', {
      params: { id: String(validInventoryId) },
      body: {
        expiration_date: '2027-01-15',
        expiration_change_reason: 'Corrected against supplier package',
      },
      session: staffSession,
    });
    assert.equal(validExpirationEdit.statusCode, 200);
    assert.equal(db.prepare('SELECT expiration_date FROM medicine_batches WHERE id = ?').get(validBatchId).expiration_date, '2027-01-15');
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(validInventoryId).stock_quantity, 4);
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM inventory_audit_logs
      WHERE entity_id = ? AND action = 'batch_expiration_updated'
    `).get(validBatchId).count, 1);

    const invalidUnpublishSelection = callRoute(pharmacyRoutes, '/inventory/unpublish', 'post', {
      body: { inventory_ids: [validInventoryId, 99999999] },
      session: staffSession,
    });
    assert.equal(invalidUnpublishSelection.statusCode, 404);
    assert.equal(db.prepare('SELECT deployed FROM inventory WHERE id = ?').get(validInventoryId).deployed, 1);

    const customerVisible = callRoute(publicRoutes, '/pharmacies/:id', 'get', {
      params: { id: String(staff.pharmacy_id) },
      query: {},
      session: {},
    });
    assert.ok(customerVisible.body.products.some(row => row.inventory_id === validInventoryId));
    db.prepare(`UPDATE medicine_batches SET expiration_date = date('now','-1 day') WHERE id = ?`).run(validBatchId);
    const hiddenAfterExpiry = callRoute(publicRoutes, '/pharmacies/:id', 'get', {
      params: { id: String(staff.pharmacy_id) },
      query: {},
      session: {},
    });
    assert.ok(!hiddenAfterExpiry.body.products.some(row => row.inventory_id === validInventoryId));
    db.prepare(`UPDATE medicine_batches SET expiration_date = date('now','+60 days') WHERE id = ?`).run(validBatchId);

    const unpublish = callRoute(pharmacyRoutes, '/inventory/unpublish', 'post', {
      body: { inventory_ids: [validInventoryId] },
      session: staffSession,
    });
    assert.equal(unpublish.statusCode, 200);
    assert.equal(unpublish.body.unpublished_count, 1);
    assert.equal(db.prepare('SELECT deployed FROM inventory WHERE id = ?').get(validInventoryId).deployed, 0);
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(validInventoryId).stock_quantity, 4);
    const hiddenAgain = callRoute(publicRoutes, '/pharmacies/:id', 'get', {
      params: { id: String(staff.pharmacy_id) },
      query: {},
      session: {},
    });
    assert.ok(!hiddenAgain.body.products.some(row => row.inventory_id === validInventoryId));

    throw rollback;
  });
  assert.throws(() => run(), error => error === rollback);
});

test('reservation ready-for-pickup workflow holds stock, notifies customers, and finalizes FEFO pickup', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  const customer = db.prepare("SELECT id, name FROM users WHERE role = 'customer' LIMIT 1").get();
  assert.ok(staff);
  assert.ok(customer);

  const rollback = new Error('rollback reservation workflow fixtures');
  const run = db.transaction(() => {
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 Reservation Workflow', 'Test')
    `).run().lastInsertRowid);
    const inventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 15, 5, 1, 1)
    `).run(staff.pharmacy_id, medicineId).lastInsertRowid);
    const batchId = Number(db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number,
        expiration_date, quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'P1-RESERVATION-FEFO', date('now','+120 days'), 5, 5, 'active')
    `).run(staff.pharmacy_id, medicineId, inventoryId).lastInsertRowid);
    const customerSession = { user: { id: customer.id, name: customer.name, role: 'customer' } };
    const staffSession = { user: { ...staff, role: 'pharmacy_staff' } };

    const created = callRoute(customerRoutes, '/reservations', 'post', {
      body: { inventory_id: inventoryId, quantity: 3 },
      session: customerSession,
    });
    assert.equal(created.statusCode, 201);
    const reservationId = created.body.reservation_id;
    const overbooked = callRoute(customerRoutes, '/reservations', 'post', {
      body: { inventory_id: inventoryId, quantity: 3 },
      session: customerSession,
    });
    assert.equal(overbooked.statusCode, 422);

    const confirmed = callRoute(pharmacyRoutes, '/reservations/:id/confirm', 'post', {
      params: { id: String(reservationId) },
      session: staffSession,
    });
    assert.equal(confirmed.statusCode, 200);
    const confirmationDeadline = db.prepare('SELECT expires_at FROM reservations WHERE id = ?').get(reservationId).expires_at;
    assert.ok(confirmationDeadline);
    const ready = callRoute(pharmacyRoutes, '/reservations/:id/ready', 'post', {
      params: { id: String(reservationId) },
      session: staffSession,
    });
    assert.equal(ready.statusCode, 200);
    let reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
    assert.equal(reservation.status, 'ready_for_pickup');
    assert.equal(reservation.expires_at, confirmationDeadline);

    const staffRows = callRoute(pharmacyRoutes, '/reservations', 'get', {
      session: staffSession,
    }).body.reservations;
    const row = staffRows.find(item => item.id === reservationId);
    assert.equal(row.price, 15);
    assert.equal(row.physical_stock, 5);
    assert.equal(row.reserved_quantity, 3);
    assert.equal(row.available_quantity, 2);

    const issue = callRoute(pharmacyRoutes, '/reservations/:id/report-issue', 'post', {
      params: { id: String(reservationId) },
      body: { issue: 'Please bring valid identification for pickup.' },
      session: staffSession,
    });
    assert.equal(issue.statusCode, 200);
    const customerRows = callRoute(customerRoutes, '/reservations', 'get', {
      session: customerSession,
    }).body.reservations;
    assert.equal(customerRows.find(item => item.id === reservationId).issue_note, 'Please bring valid identification for pickup.');
    assert.ok(db.prepare(`
      SELECT id FROM notifications WHERE user_id = ? AND message LIKE '%valid identification%'
    `).get(customer.id));
    assert.ok(db.prepare(`
      SELECT id FROM inventory_audit_logs WHERE entity_type = 'reservation' AND entity_id = ?
        AND action = 'reservation_issue_reported'
    `).get(reservationId));

    const pickedUp = callRoute(pharmacyRoutes, '/reservations/:id/picked-up', 'post', {
      params: { id: String(reservationId) },
      session: staffSession,
    });
    assert.equal(pickedUp.statusCode, 200);
    reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId);
    assert.equal(reservation.status, 'completed');
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 2);
    assert.equal(db.prepare('SELECT current_quantity FROM medicine_batches WHERE id = ?').get(batchId).current_quantity, 2);
    assert.equal(db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations
      WHERE inventory_id = ? AND status IN ('pending','confirmed','ready_for_pickup')
    `).get(inventoryId).total, 0);

    const secondReservation = callRoute(customerRoutes, '/reservations', 'post', {
      body: { inventory_id: inventoryId, quantity: 1 },
      session: customerSession,
    });
    assert.equal(secondReservation.statusCode, 201);
    const secondId = secondReservation.body.reservation_id;
    assert.equal(callRoute(pharmacyRoutes, '/reservations/:id/confirm', 'post', {
      params: { id: String(secondId) },
      session: staffSession,
    }).statusCode, 200);
    assert.equal(callRoute(pharmacyRoutes, '/reservations/:id/ready', 'post', {
      params: { id: String(secondId) },
      session: staffSession,
    }).statusCode, 200);
    const customerCancel = callRoute(customerRoutes, '/reservations/:id/cancel', 'post', {
      params: { id: String(secondId) },
      session: customerSession,
    });
    assert.equal(customerCancel.statusCode, 200);
    assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(secondId).status, 'cancelled');
    assert.equal(db.prepare('SELECT stock_quantity FROM inventory WHERE id = ?').get(inventoryId).stock_quantity, 2);

    const overduePickup = Number(db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status, expires_at)
      VALUES (?, ?, 1, 'ready_for_pickup', datetime('now','-1 hour'))
    `).run(customer.id, inventoryId).lastInsertRowid);
    assert.equal(expirePendingReservations(db), 1);
    assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(overduePickup).status, 'expired');
    assert.ok(db.prepare(`
      SELECT id FROM notifications WHERE user_id = ? AND message LIKE '%not picked up before the deadline%'
    `).get(customer.id));
    throw rollback;
  });
  assert.throws(() => run(), error => error === rollback);
});

test('supplier center records reusable suppliers, linked receipts, product history, and last delivery', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  assert.ok(staff);

  const rollback = new Error('rollback supplier center fixtures');
  const run = db.transaction(() => {
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 Supplier History', 'Test')
    `).run().lastInsertRowid);
    const inventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold)
      VALUES (?, ?, 12, 0, 2)
    `).run(staff.pharmacy_id, medicineId).lastInsertRowid);
    const supplier = callRoute(pharmacyRoutes, '/suppliers', 'post', {
      body: {
        name: 'P1 Supplier Center',
        contact_person: 'Casey Contact',
        phone: '555-0100',
        email: 'supplier@example.test',
        address: 'Unit 2',
      },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(supplier.statusCode, 201);

    const received = callRoute(pharmacyRoutes, '/inventory/stock-in', 'post', {
      body: {
        inventory_id: inventoryId,
        quantity: 7,
        batch_number: 'P1-SUPPLIER-HISTORY-BATCH',
        supplier_id: supplier.body.id,
        supplier_reference: 'PO-P1-100',
        purchase_price: 4.2,
        expiration_date: '2027-12-31',
      },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(received.statusCode, 200);
    const transaction = db.prepare(`
      SELECT supplier_id, batch_id, quantity FROM stock_transactions
      WHERE inventory_id = ? AND transaction_type = 'stock_in'
    `).get(inventoryId);
    assert.equal(transaction.supplier_id, supplier.body.id);
    assert.equal(transaction.quantity, 7);
    assert.ok(transaction.batch_id);
    assert.equal(db.prepare('SELECT supplier_id FROM medicine_batches WHERE id = ?').get(transaction.batch_id).supplier_id, supplier.body.id);

    const supplierList = callRoute(pharmacyRoutes, '/suppliers', 'get', {
      query: {},
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    const listRow = supplierList.body.suppliers.find(row => row.id === supplier.body.id);
    assert.equal(listRow.name, 'P1 Supplier Center');
    assert.equal(listRow.contact_person, 'Casey Contact');
    assert.equal(listRow.phone, '555-0100');
    assert.equal(listRow.email, 'supplier@example.test');
    assert.equal(listRow.products_supplied, 1);
    assert.equal(listRow.delivery_count, 1);
    assert.ok(listRow.last_delivery_date);

    const medicineSuppliers = callRoute(pharmacyRoutes, '/suppliers', 'get', {
      query: { medicine_id: String(medicineId) },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(medicineSuppliers.body.suppliers.length, 1);
    const profile = callRoute(pharmacyRoutes, '/suppliers/:id', 'get', {
      params: { id: String(supplier.body.id) },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(profile.body.products[0].medicine_id, medicineId);
    assert.equal(profile.body.products[0].units_received, 7);
    assert.equal(profile.body.deliveries[0].batch_number, 'P1-SUPPLIER-HISTORY-BATCH');
    assert.equal(profile.body.deliveries[0].reference_number, 'PO-P1-100');
    assert.equal(profile.body.total_purchases, null);
    const movementHistory = callRoute(pharmacyRoutes, '/inventory/history', 'get', {
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(
      movementHistory.body.history.find(row => row.inventory_id === inventoryId).supplier_name,
      'P1 Supplier Center'
    );
    throw rollback;
  });
  assert.throws(() => run(), error => error === rollback);
});

test('pharmacy alert center exposes actionable conditions and stable unique alert IDs', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  const customer = db.prepare("SELECT id, name FROM users WHERE role = 'customer' LIMIT 1").get();
  assert.ok(staff);
  assert.ok(customer);

  const rollback = new Error('rollback pharmacy alert fixtures');
  const run = db.transaction(() => {
    const makeProduct = (name, stock, threshold, batchQuantity, expiration) => {
      const medicineId = Number(db.prepare(
        'INSERT INTO medicines (name, category) VALUES (?, ?)'
      ).run(name, 'Test').lastInsertRowid);
      const inventoryId = Number(db.prepare(`
        INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold)
        VALUES (?, ?, 10, ?, ?)
      `).run(staff.pharmacy_id, medicineId, stock, threshold).lastInsertRowid);
      if (batchQuantity !== null) {
        db.prepare(`
          INSERT INTO medicine_batches (
            pharmacy_id, medicine_id, inventory_id, batch_number,
            expiration_date, quantity_received, current_quantity, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
        `).run(
          staff.pharmacy_id, medicineId, inventoryId, `${name.replace(/\W/g, '-').toUpperCase()}-BATCH`,
          expiration, batchQuantity, batchQuantity
        );
      }
      return { medicineId, inventoryId };
    };

    const outOfStock = makeProduct('P1 Alert Out', 0, 2, null, null);
    const mismatch = makeProduct('P1 Alert Mismatch', 3, 2, null, null);
    const expired = makeProduct('P1 Alert Expired', 2, 1, 2, '2020-01-01');
    const expiring = makeProduct('P1 Alert Expiring', 4, 5, 4, '2026-10-20');
    const highDemand = makeProduct('P1 Alert Demand', 1, 2, 1, '2027-10-20');
    const reservationStock = makeProduct('P1 Alert Reservation', 10, 2, 10, '2027-10-20');
    for (let index = 0; index < 12; index += 1) {
      db.prepare(`
        INSERT INTO search_logs (user_id, query, medicine_ids, pharmacy_ids)
        VALUES (?, 'P1 Alert Demand', ?, '[]')
      `).run(customer.id, JSON.stringify([highDemand.medicineId]));
    }
    const reservation = db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status, expires_at)
      VALUES (?, ?, 1, 'pending', datetime('now','+3 hours'))
    `).run(customer.id, reservationStock.inventoryId);
    const folderId = Number(db.prepare(
      'INSERT INTO folders (pharmacy_id, name) VALUES (?, ?)'
    ).run(staff.pharmacy_id, 'P1 Alert Publishing').lastInsertRowid);
    db.prepare(`
      INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action)
      VALUES (?, ?, 'P1 Alert Publishing', 1, 'deployed')
    `).run(staff.pharmacy_id, folderId);

    const received = makeProduct('P1 Alert Received', 0, 2, null, null);
    const receipt = callRoute(pharmacyRoutes, '/inventory/stock-in', 'post', {
      body: {
        inventory_id: received.inventoryId,
        quantity: 2,
        batch_number: 'P1-ALERT-RECEIPT',
        expiration_date: '2027-12-31',
      },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(receipt.statusCode, 200);

    const request = { session: { user: { ...staff, role: 'pharmacy_staff' } } };
    const first = callRoute(pharmacyRoutes, '/alerts', 'get', request).body.alerts;
    const ids = first.map(alert => alert.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const expected of [
      `out-of-stock:${outOfStock.inventoryId}`,
      `inventory-mismatch:${mismatch.inventoryId}`,
      `expired-stock:${expired.inventoryId}`,
      `expiring-within-30-days:${expiring.inventoryId}`,
      `high-demand-low-stock:${highDemand.inventoryId}`,
      `reservation-nearing-expiry:${reservation.lastInsertRowid}`,
      `new-reservation:${reservation.lastInsertRowid}`,
    ]) assert.ok(ids.includes(expected), `expected alert ${expected}`);
    const demandAlert = first.find(alert => alert.id === `high-demand-low-stock:${highDemand.inventoryId}`);
    assert.match(demandAlert.reason, /12 recent searches/);
    assert.ok(demandAlert.actions.some(action => action.label === 'Restock'));
    const expiredAlert = first.find(alert => alert.id === `expired-stock:${expired.inventoryId}`);
    assert.equal(expiredAlert.severity, 'critical');
    assert.ok(expiredAlert.actions.some(action => action.label === 'Review Expiration'));
    const receivedAlert = first.find(alert => alert.category === 'Stock received' && alert.medicine_name === 'P1 Alert Received');
    assert.ok(receivedAlert, 'stock receipts should appear as informational activity');
    assert.ok(first.some(alert => alert.category === 'Product publishing result' && /P1 Alert Publishing/.test(alert.reason)));
    const second = callRoute(pharmacyRoutes, '/alerts', 'get', request).body.alerts;
    assert.deepEqual(second.map(alert => alert.id), ids);
    throw rollback;
  });
  assert.throws(() => run(), error => error === rollback);
});
