const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const pharmacyRoutes = require('../routes/pharmacy');

function getDashboard(req) {
  const route = pharmacyRoutes.stack.find(layer => layer.route?.path === '/dashboard');
  assert.ok(route, 'pharmacy dashboard route should be registered');
  const handler = route.route.stack.find(layer => layer.method === 'get')?.handle;
  assert.equal(typeof handler, 'function');
  let response;
  handler(req, { json(value) { response = value; } });
  return response;
}

function getAnalytics(req) {
  const route = pharmacyRoutes.stack.find(layer => layer.route?.path === '/analytics');
  assert.ok(route, 'pharmacy analytics route should be registered');
  const handler = route.route.stack.find(layer => layer.method === 'get')?.handle;
  assert.equal(typeof handler, 'function');
  let statusCode = 200;
  let response;
  handler(req, {
    status(code) { statusCode = code; return this; },
    json(value) { response = value; },
  });
  return { statusCode, body: response };
}

test('pharmacy dashboard reports database-backed sales, stocked expiries, and inventory actions', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  const customer = db.prepare("SELECT id FROM users WHERE role = 'customer' LIMIT 1").get();
  assert.ok(staff, 'seed data should include a pharmacy staff account');
  assert.ok(customer, 'seed data should include a customer account');

  const rollback = new Error('rollback pharmacy dashboard fixtures');
  const run = db.transaction(() => {
    const req = { session: { user: { ...staff, role: 'pharmacy_staff' } } };
    const before = getDashboard(req);
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P1 dashboard fixture', 'Test')
    `).run().lastInsertRowid);
    const inventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 17.25, 7, 8, 1)
    `).run(staff.pharmacy_id, medicineId).lastInsertRowid);

    db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number, expiration_date,
        quantity_received, current_quantity
      ) VALUES (?, ?, ?, 'P1-DASHBOARD-BATCH', date('now', '+5 days'), 4, 4)
    `).run(staff.pharmacy_id, medicineId, inventoryId);
    db.prepare(`
      INSERT INTO reservations (
        customer_id, inventory_id, quantity, price_at_reservation, status, reserved_at, completed_at
      ) VALUES (?, ?, 2, 17.25, 'completed', datetime('now'), datetime('now'))
    `).run(customer.id, inventoryId);
    db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status, reserved_at)
      VALUES (?, ?, 1, 'pending', datetime('now')), (?, ?, 1, 'confirmed', datetime('now')),
        (?, ?, 1, 'ready_for_pickup', datetime('now'))
    `).run(customer.id, inventoryId, customer.id, inventoryId, customer.id, inventoryId);

    const dashboard = getDashboard(req);
    assert.equal(dashboard.stats.totalItems - before.stats.totalItems, 1);
    assert.equal(dashboard.stats.totalStock - before.stats.totalStock, 7);
    assert.equal(dashboard.stats.lowStock - before.stats.lowStock, 1);
    assert.equal(dashboard.stats.pendingReservations - before.stats.pendingReservations, 1);
    assert.equal(dashboard.stats.confirmedReservations - before.stats.confirmedReservations, 1);
    assert.equal(dashboard.stats.readyForPickupReservations - before.stats.readyForPickupReservations, 1);
    assert.equal(dashboard.stats.expiringSoon - before.stats.expiringSoon, 1);
    assert.equal(dashboard.stats.salesToday - before.stats.salesToday, 34.5);
    assert.equal(dashboard.stats.salesThisWeek - before.stats.salesThisWeek, 34.5);
    assert.equal(dashboard.stats.salesThisMonth - before.stats.salesThisMonth, 34.5);
    assert.ok(dashboard.attention.expiringProducts.some(item =>
      item.medicine_name === 'P1 dashboard fixture' && item.units_expiring === 4
    ));

    throw rollback;
  });

  assert.throws(() => run(), error => error === rollback);
});

test('pharmacy analytics uses filtered database records consistently and reports unsupported metrics', () => {
  const staff = db.prepare(`
    SELECT id, pharmacy_id FROM users
    WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get();
  const customer = db.prepare("SELECT id FROM users WHERE role = 'customer' LIMIT 1").get();
  assert.ok(staff);
  assert.ok(customer);

  const rollback = new Error('rollback pharmacy analytics fixtures');
  const run = db.transaction(() => {
    const today = db.prepare("SELECT date('now','localtime') AS today").get().today;
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P9 Analytics Demand Fixture', 'Test')
    `).run().lastInsertRowid);
    const inventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold)
      VALUES (?, ?, 12, 3, 2)
    `).run(staff.pharmacy_id, medicineId).lastInsertRowid);
    db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number,
        expiration_date, quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'P9-ANALYTICS-BATCH', date('now','+180 days'), 3, 3, 'active')
    `).run(staff.pharmacy_id, medicineId, inventoryId);

    db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, price_at_reservation, status, reserved_at, completed_at)
      VALUES (?, ?, 2, 8, 'completed', datetime('now'), datetime('now'))
    `).run(customer.id, inventoryId);
    db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status, reserved_at)
      VALUES (?, ?, 1, 'cancelled', datetime('now')),
        (?, ?, 1, 'expired', datetime('now')),
        (?, ?, 1, 'pending', datetime('now'))
    `).run(customer.id, inventoryId, customer.id, inventoryId, customer.id, inventoryId);
    db.prepare(`
      INSERT INTO stock_transactions (
        pharmacy_id, medicine_id, inventory_id, transaction_type, quantity, reason
      ) VALUES (?, ?, ?, 'adjustment', 1, 'P9 analytics test adjustment')
    `).run(staff.pharmacy_id, medicineId, inventoryId);
    db.prepare(`
      INSERT INTO search_logs (user_id, query, medicine_ids, pharmacy_ids, searched_at)
      VALUES (?, 'P9 Analytics Demand Fixture', ?, ?, datetime('now'))
    `).run(customer.id, JSON.stringify([medicineId]), JSON.stringify([staff.pharmacy_id]));
    const outOfStockMedicine = Number(db.prepare(`
      INSERT INTO medicines (name, category) VALUES ('P9 Analytics Unavailable Fixture', 'Test')
    `).run().lastInsertRowid);
    const outOfStockInventory = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold)
      VALUES (?, ?, 10, 0, 2)
    `).run(staff.pharmacy_id, outOfStockMedicine).lastInsertRowid);
    db.prepare(`
      INSERT INTO search_logs (user_id, query, medicine_ids, pharmacy_ids, searched_at)
      VALUES (?, 'P9 Analytics Unavailable Fixture', ?, ?, datetime('now'))
    `).run(customer.id, JSON.stringify([outOfStockMedicine]), JSON.stringify([staff.pharmacy_id]));

    const response = getAnalytics({
      query: { start_date: today, end_date: today },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(response.statusCode, 200);
    const data = response.body;
    assert.equal(data.dateRange.startDate, today);
    assert.equal(data.sales.unitsSold, 2);
    assert.equal(data.sales.revenue, 16);
    assert.equal(data.sales.daily.reduce((sum, row) => sum + Number(row.units_sold), 0), data.sales.unitsSold);
    assert.equal(data.sales.weekly.reduce((sum, row) => sum + Number(row.units_sold), 0), data.sales.unitsSold);
    assert.equal(data.sales.monthly.reduce((sum, row) => sum + Number(row.units_sold), 0), data.sales.unitsSold);
    assert.equal(data.demand.mostSearched.find(row => row.medicine_id === medicineId).searches, 1);
    assert.equal(data.demand.highDemandLowStock.find(row => row.inventory_id === inventoryId).available_quantity, 2);
    assert.ok(data.demand.searchedUnavailable.some(row => row.medicine_id === outOfStockMedicine));
    assert.equal(data.operations.reservationTotal, 4);
    assert.equal(data.operations.completionRate, 0.25);
    assert.equal(data.operations.cancellationRate, 0.25);
    assert.equal(data.operations.expiredReservationRate, 0.25);
    assert.equal(data.operations.adjustmentFrequency, 1);
    assert.equal(data.inventory.stock_turnover.value, null);
    assert.match(data.inventory.stock_turnover.reason, /Insufficient data/);
    assert.equal(
      data.demand.searchReservationRelationship.find(row => row.medicine_id === medicineId).units_reserved,
      3
    );

    const invalidRange = getAnalytics({
      query: { start_date: `${today}garbage`, end_date: today },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(invalidRange.statusCode, 422);
    const reversedRange = getAnalytics({
      query: { start_date: '2026-10-09', end_date: '2026-10-08' },
      session: { user: { ...staff, role: 'pharmacy_staff' } },
    });
    assert.equal(reversedRange.statusCode, 422);
    throw rollback;
  });
  assert.throws(() => run(), error => error === rollback);
});
