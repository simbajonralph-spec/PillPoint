const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db/database');
const customerRoutes = require('../routes/customer');
const pharmacyRoutes = require('../routes/pharmacy');

function inventoryState(inventoryId) {
  const row = db.prepare(`
    SELECT i.stock_quantity,
      COALESCE(SUM(CASE WHEN r.status IN ('pending', 'confirmed') THEN r.quantity ELSE 0 END), 0) AS reserved_quantity
    FROM inventory i LEFT JOIN reservations r ON r.inventory_id = i.id
    WHERE i.id = ? GROUP BY i.id
  `).get(inventoryId);
  return {
    physical: row.stock_quantity,
    reserved: row.reserved_quantity,
    available: Math.max(0, row.stock_quantity - row.reserved_quantity),
  };
}

test('reservation lifecycle synchronizes stock and serializes competing reservations', async t => {
  const customer = db.prepare("SELECT id, name FROM users WHERE role = 'customer' LIMIT 1").get();
  const staff = db.prepare(`
    SELECT u.id, u.name, u.pharmacy_id FROM users u
    JOIN pharmacies p ON p.id = u.pharmacy_id
    WHERE u.role = 'pharmacy_staff'
      AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    LIMIT 1
  `).get();
  assert.ok(customer, 'seed data should include a customer');
  assert.ok(staff, 'seed data should include staff for a verified pharmacy');

  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lifecycleName = `U06 Reservation Lifecycle ${suffix}`;
  const concurrencyName = `U06 Reservation Concurrency ${suffix}`;
  const createInventory = db.transaction((medicineName, stock) => {
    const medicine = db.prepare(`
      INSERT INTO medicines (name, category, description) VALUES (?, 'Test', 'Reservation test fixture')
    `).run(medicineName);
    const inventory = db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 12.34, ?, 2, 1)
    `).run(staff.pharmacy_id, medicine.lastInsertRowid, stock);
    return { medicineId: Number(medicine.lastInsertRowid), inventoryId: Number(inventory.lastInsertRowid) };
  });
  const lifecycle = createInventory(lifecycleName, 25);
  const concurrency = createInventory(concurrencyName, 10);
  const existingLifecycleReservations = db.prepare(`
    INSERT INTO reservations (customer_id, inventory_id, quantity, status)
    VALUES (?, ?, 10, 'pending'), (?, ?, 6, 'confirmed'),
      (?, ?, 12, 'cancelled'), (?, ?, 13, 'expired'), (?, ?, 14, 'completed')
  `).run(
    customer.id, lifecycle.inventoryId,
    customer.id, lifecycle.inventoryId,
    customer.id, lifecycle.inventoryId,
    customer.id, lifecycle.inventoryId,
    customer.id, lifecycle.inventoryId
  );
  const concurrencyReservation = db.prepare(`
    INSERT INTO reservations (customer_id, inventory_id, quantity, status)
    VALUES (?, ?, 6, 'confirmed')
  `).run(customer.id, concurrency.inventoryId);
  t.after(() => {
    const cleanup = db.transaction(() => {
      db.prepare('DELETE FROM stock_transactions WHERE inventory_id IN (?, ?)').run(lifecycle.inventoryId, concurrency.inventoryId);
      db.prepare("DELETE FROM inventory_audit_logs WHERE entity_type = 'inventory' AND entity_id IN (?, ?)")
        .run(lifecycle.inventoryId, concurrency.inventoryId);
      db.prepare('DELETE FROM reservations WHERE inventory_id IN (?, ?)').run(lifecycle.inventoryId, concurrency.inventoryId);
      db.prepare('DELETE FROM notifications WHERE message LIKE ? OR message LIKE ?')
        .run(`%${lifecycleName}%`, `%${concurrencyName}%`);
      db.prepare('DELETE FROM search_logs WHERE user_id = ? AND query = ?').run(customer.id, lifecycleName);
      db.prepare('DELETE FROM inventory WHERE id IN (?, ?)').run(lifecycle.inventoryId, concurrency.inventoryId);
      db.prepare('DELETE FROM medicines WHERE id IN (?, ?)').run(lifecycle.medicineId, concurrency.medicineId);
    });
    cleanup();
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const isPharmacy = req.get('x-test-role') === 'pharmacy_staff';
    req.session = {
      user: isPharmacy
        ? { id: staff.id, name: staff.name, role: 'pharmacy_staff', pharmacy_id: staff.pharmacy_id }
        : { id: customer.id, name: customer.name, role: 'customer' },
    };
    next();
  });
  app.use('/api/customer', customerRoutes);
  app.use('/api/pharmacy', pharmacyRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { role = 'customer', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-test-role': role, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json() };
  }

  assert.deepEqual(inventoryState(lifecycle.inventoryId), { physical: 25, reserved: 16, available: 9 });
  const invalidQuantity = await request('/api/customer/reservations', {
    body: { inventory_id: lifecycle.inventoryId, quantity: 1.5 },
  });
  assert.equal(invalidQuantity.status, 422);
  db.prepare('UPDATE inventory SET deployed = 0 WHERE id = ?').run(lifecycle.inventoryId);
  const undeployed = await request('/api/customer/reservations', {
    body: { inventory_id: lifecycle.inventoryId, quantity: 1 },
  });
  assert.equal(undeployed.status, 422);
  db.prepare('UPDATE inventory SET deployed = 1 WHERE id = ?').run(lifecycle.inventoryId);

  const created = await request('/api/customer/reservations', {
    body: { inventory_id: lifecycle.inventoryId, quantity: 3 },
  });
  assert.equal(created.status, 201);
  const firstReservationId = created.data.reservation_id;
  const firstReservation = db.prepare('SELECT inventory_id, quantity, price_at_reservation, status FROM reservations WHERE id = ?')
    .get(firstReservationId);
  assert.equal(firstReservation.inventory_id, lifecycle.inventoryId);
  assert.equal(firstReservation.quantity, 3);
  assert.equal(firstReservation.price_at_reservation, 12.34);
  assert.equal(firstReservation.status, 'pending');
  assert.deepEqual(inventoryState(lifecycle.inventoryId), { physical: 25, reserved: 19, available: 6 });

  const search = await request(`/api/customer/medicines/search?q=${encodeURIComponent(lifecycleName)}`);
  const searchResult = search.data.results.find(row => row.inventory_id === lifecycle.inventoryId);
  assert.equal(searchResult.available_stock, 6);
  assert.equal(searchResult.reserved_quantity, 19);

  const excess = await request('/api/customer/reservations', {
    body: { inventory_id: lifecycle.inventoryId, quantity: 7 },
  });
  assert.equal(excess.status, 422);

  const cancelled = await request(`/api/customer/reservations/${firstReservationId}/cancel`, { body: {} });
  assert.equal(cancelled.status, 200);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(firstReservationId).status, 'cancelled');
  assert.deepEqual(inventoryState(lifecycle.inventoryId), { physical: 25, reserved: 16, available: 9 });
  const searchAfterCancellation = await request(`/api/customer/medicines/search?q=${encodeURIComponent(lifecycleName)}`);
  assert.equal(searchAfterCancellation.data.results.find(row => row.inventory_id === lifecycle.inventoryId).available_stock, 9);

  const secondCreated = await request('/api/customer/reservations', {
    body: { inventory_id: lifecycle.inventoryId, quantity: 3 },
  });
  assert.equal(secondCreated.status, 201);
  const secondReservationId = secondCreated.data.reservation_id;
  assert.equal((await request(`/api/pharmacy/reservations/${secondReservationId}/confirm`, {
    role: 'pharmacy_staff', body: {},
  })).status, 200);
  assert.deepEqual(inventoryState(lifecycle.inventoryId), { physical: 25, reserved: 19, available: 6 });

  assert.equal((await request(`/api/pharmacy/reservations/${secondReservationId}/complete`, {
    role: 'pharmacy_staff', body: {},
  })).status, 200);
  const completed = db.prepare('SELECT status, completed_at FROM reservations WHERE id = ?').get(secondReservationId);
  assert.equal(completed.status, 'completed');
  assert.ok(completed.completed_at);
  assert.deepEqual(inventoryState(lifecycle.inventoryId), { physical: 22, reserved: 16, available: 6 });
  const history = await request('/api/customer/reservations');
  assert.equal(history.data.reservations.find(row => row.id === firstReservationId).status, 'cancelled');
  assert.equal(history.data.reservations.find(row => row.id === secondReservationId).status, 'completed');

  const concurrentAttempts = await Promise.all([
    request('/api/customer/reservations', { body: { inventory_id: concurrency.inventoryId, quantity: 3 } }),
    request('/api/customer/reservations', { body: { inventory_id: concurrency.inventoryId, quantity: 3 } }),
  ]);
  assert.deepEqual(concurrentAttempts.map(result => result.status).sort(), [201, 422]);
  assert.deepEqual(inventoryState(concurrency.inventoryId), { physical: 10, reserved: 9, available: 1 });
});