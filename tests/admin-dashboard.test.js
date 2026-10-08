const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db/database');
const adminRoutes = require('../routes/admin');

test('admin dashboard uses current pharmacy, customer, inventory, and batch records', async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  assert.ok(admin, 'seed data should include an admin');

  const pendingPharmacyId = Number(db.prepare(`
    INSERT INTO pharmacies (name, address, latitude, longitude, verification_status)
    VALUES (?, 'Dashboard test address', 1, 1, 'PENDING')
  `).run(`Dashboard pending ${suffix}`).lastInsertRowid);
  const verifiedPharmacyId = Number(db.prepare(`
    INSERT INTO pharmacies (name, address, latitude, longitude, verified, verification_status)
    VALUES (?, 'Dashboard test address', 1, 1, 1, 'VERIFIED')
  `).run(`Dashboard verified ${suffix}`).lastInsertRowid);
  const medicineId = Number(db.prepare(`
    INSERT INTO medicines (name, category) VALUES (?, 'Dashboard test')
  `).run(`Dashboard medicine ${suffix}`).lastInsertRowid);
  const inventoryId = Number(db.prepare(`
    INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
    VALUES (?, ?, 10, 2, 5, 1)
  `).run(verifiedPharmacyId, medicineId).lastInsertRowid);
  const batchNumber = `DASHBOARD-${suffix}`;
  const batchId = Number(db.prepare(`
    INSERT INTO medicine_batches (
      pharmacy_id, medicine_id, inventory_id, batch_number, current_quantity, expiration_date
    ) VALUES (?, ?, ?, ?, 2, date('now', '+15 days'))
  `).run(verifiedPharmacyId, medicineId, inventoryId, batchNumber).lastInsertRowid);
  const username = `dashboard-customer-${suffix}`;
  const customerId = Number(db.prepare(`
    INSERT INTO users (name, username, email, password_hash, role)
    VALUES (?, ?, ?, 'test-hash', 'customer')
  `).run(`Dashboard Customer ${suffix}`, username, `${username}@example.test`).lastInsertRowid);
  const searchId = Number(db.prepare(`
    INSERT INTO search_logs (user_id, query, searched_at)
    VALUES (?, 'dashboard test activity', datetime('now'))
  `).run(customerId).lastInsertRowid);

  const app = express();
  app.use((req, res, next) => {
    req.session = { user: { id: admin.id, role: 'admin' } };
    next();
  });
  app.use('/api/admin', adminRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/dashboard`);
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.ok(data.actionRequired.pendingPharmacies.some(pharmacy => pharmacy.id === pendingPharmacyId));
    assert.ok(data.actionRequired.lowStockItems.some(item => item.inventory_id === inventoryId));
    assert.ok(data.actionRequired.expiringMedicineBatches.some(batch => batch.id === batchId));
    assert.ok(data.systemOverview.activeCustomers >= 1);
    assert.ok(data.systemOverview.activeProducts >= 1);
    assert.ok(data.stats.lowStockAlerts >= 1);
    assert.equal(data.systemOverview.activeCustomers, db.prepare(`
      SELECT COUNT(*) AS c FROM users u
      WHERE u.role = 'customer' AND (
        EXISTS (SELECT 1 FROM search_logs s WHERE s.user_id = u.id AND s.searched_at >= datetime('now', '-30 days'))
        OR EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id = u.id AND r.reserved_at >= datetime('now', '-30 days'))
      )
    `).get().c);
  } finally {
    await new Promise(resolve => server.close(resolve));
    db.prepare('DELETE FROM search_logs WHERE id = ?').run(searchId);
    db.prepare('DELETE FROM users WHERE id = ?').run(customerId);
    db.prepare('DELETE FROM medicine_batches WHERE id = ?').run(batchId);
    db.prepare('DELETE FROM inventory WHERE id = ?').run(inventoryId);
    db.prepare('DELETE FROM medicines WHERE id = ?').run(medicineId);
    db.prepare('DELETE FROM pharmacies WHERE id IN (?, ?)').run(pendingPharmacyId, verifiedPharmacyId);
  }
});
