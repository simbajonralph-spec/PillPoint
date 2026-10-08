const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db/database');
const adminRoutes = require('../routes/admin');
const pharmacyRoutes = require('../routes/pharmacy');

test('pharmacy can replace a requested document and resubmit for admin review', async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  assert.ok(admin, 'seed data should include an admin');
  const pharmacyName = `Correction test pharmacy ${suffix}`;
  const pharmacyId = Number(db.prepare(`
    INSERT INTO pharmacies (
      name, address, latitude, longitude, owner_first_name, owner_last_name,
      verification_status, verification_stage, correction_reason
    ) VALUES (?, 'Correction test address', 1, 1, 'Test', 'Owner', 'PENDING', 'CORRECTION_REQUIRED', ?)
  `).run(pharmacyName, 'Upload a clearer business permit.').lastInsertRowid);
  const username = `correction-staff-${suffix}`;
  const staffId = Number(db.prepare(`
    INSERT INTO users (name, username, email, password_hash, role, pharmacy_id)
    VALUES ('Correction Test Staff', ?, ?, 'test-hash', 'pharmacy_staff', ?)
  `).run(username, `${username}@example.test`, pharmacyId).lastInsertRowid);
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use((req, res, next) => {
    req.session = {
      user: req.path.startsWith('/api/pharmacy')
        ? { id: staffId, role: 'pharmacy_staff', pharmacy_id: pharmacyId, name: 'Correction Test Staff' }
        : { id: admin.id, role: 'admin', name: 'Test Admin' },
    };
    next();
  });
  app.use('/api/admin', adminRoutes);
  app.use('/api/pharmacy', pharmacyRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;

  try {
    const blockedResubmit = await fetch(`${baseUrl}/pharmacy/verification/resubmit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(blockedResubmit.status, 422, 'required permit must be present before resubmitting');

    const updateResponse = await fetch(`${baseUrl}/pharmacy/profile`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ business_permit: 'data:application/pdf;base64,JVBERi0xLjQ=' }),
    });
    assert.equal(updateResponse.status, 200);

    const resubmitResponse = await fetch(`${baseUrl}/pharmacy/verification/resubmit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Uploaded a new readable permit.' }),
    });
    assert.equal(resubmitResponse.status, 200);
    assert.equal(db.prepare('SELECT verification_stage FROM pharmacies WHERE id = ?').get(pharmacyId).verification_stage, 'UNDER_REVIEW');

    const history = db.prepare(`
      SELECT actor_user_id, actor_role, action, previous_status, new_status, reason
      FROM pharmacy_verification_history WHERE pharmacy_id = ? ORDER BY id
    `).get(pharmacyId);
    assert.equal(history.actor_user_id, staffId);
    assert.equal(history.actor_role, 'pharmacy_staff');
    assert.equal(history.previous_status, 'CORRECTION_REQUIRED');
    assert.equal(history.new_status, 'UNDER_REVIEW');
    assert.equal(history.reason, 'Uploaded a new readable permit.');
    assert.equal(db.prepare(`
      SELECT COUNT(*) AS count FROM notifications
      WHERE user_id = ? AND title = 'Pharmacy registration resubmitted'
    `).get(admin.id).count, 1);

    const adminPharmacyList = await fetch(`${baseUrl}/admin/pharmacies?status=UNDER_REVIEW`);
    const result = await adminPharmacyList.json();
    assert.ok(result.pharmacies.some(pharmacy => pharmacy.id === pharmacyId));
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.prepare('DELETE FROM pharmacy_verification_history WHERE pharmacy_id = ?').run(pharmacyId);
    db.prepare(`
      DELETE FROM notifications
      WHERE user_id = ? AND title = 'Pharmacy registration resubmitted' AND message = ?
    `).run(admin.id, `${pharmacyName} resubmitted its registration for review.`);
    db.prepare('DELETE FROM users WHERE id = ?').run(staffId);
    db.prepare('DELETE FROM pharmacies WHERE id = ?').run(pharmacyId);
  }
});
