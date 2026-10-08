const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db/database');
const adminRoutes = require('../routes/admin');

test('admin can open exact pharmacy registration details and separate submitted documents', async () => {
  const pharmacyName = `Admin document test ${process.pid}-${Date.now()}`;
  const pharmacyId = Number(db.prepare(`
    INSERT INTO pharmacies (
      name, address, latitude, longitude, phone, business_email, owner_first_name,
      owner_last_name, description, hours, business_permit, pharmacy_logo,
      verified, verification_status, verification_stage
    ) VALUES (?, 'Test address', 1, 1, '+639123456789', 'branch@example.test', 'Test',
      'Owner', 'Registration description', 'Mon-Fri 8AM-5PM', ?, ?, 1, 'VERIFIED', 'APPROVED')
  `).run(
    pharmacyName,
    'data:application/pdf;base64,JVBERi0xLjQ=',
    'data:image/png;base64,aGVsbG8=',
  ).lastInsertRowid);
  const otherPharmacyName = `Other branch ${process.pid}-${Date.now()}`;
  const otherPharmacyId = Number(db.prepare(`
    INSERT INTO pharmacies (name, address, latitude, longitude, phone, business_email, owner_first_name, owner_last_name)
    VALUES (?, 'Other address', 2, 2, '+639987654321', 'other@example.test', 'Other', 'Owner')
  `).run(otherPharmacyName).lastInsertRowid);
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  assert.ok(admin, 'seed data should include an admin');
  const staffUsername = `admin-docs-staff-${process.pid}-${Date.now()}`;
  const staffInfo = db.prepare(`
    INSERT INTO users (name, username, email, password_hash, role, pharmacy_id)
    VALUES (?, ?, ?, 'test-hash', 'pharmacy_staff', ?)
  `).run('Test staff', staffUsername, `${staffUsername}@example.test`, pharmacyId);
  const staffId = Number(staffInfo.lastInsertRowid);
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { user: { id: admin.id, role: 'admin' } };
    next();
  });
  app.use('/api/admin', adminRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/pharmacies`;

  try {
    const listResponse = await fetch(baseUrl);
    assert.equal(listResponse.status, 200);
    const { pharmacies } = await listResponse.json();
    const pharmacy = pharmacies.find(item => item.id === pharmacyId);
    assert.ok(pharmacies.some(item => item.id === otherPharmacyId));
    assert.ok(pharmacy);
    assert.equal(pharmacy.has_business_permit, true);
    assert.equal(pharmacy.has_pharmacy_logo, true);
    assert.equal(Object.hasOwn(pharmacy, 'business_permit'), false);
    assert.equal(Object.hasOwn(pharmacy, 'pharmacy_logo'), false);

    const detailResponse = await fetch(`${baseUrl}/${pharmacyId}`);
    assert.equal(detailResponse.status, 200);
    const { pharmacy: submission } = await detailResponse.json();
    assert.equal(submission.name, pharmacyName);
    assert.equal(submission.owner_first_name, 'Test');
    assert.equal(submission.owner_last_name, 'Owner');
    assert.equal(submission.business_email, 'branch@example.test');
    assert.equal(submission.phone, '+639123456789');
    assert.equal(submission.address, 'Test address');
    assert.equal(submission.latitude, 1);
    assert.equal(submission.longitude, 1);
    assert.equal(submission.description, 'Registration description');
    assert.equal(submission.hours, 'Mon-Fri 8AM-5PM');
    const otherDetailResponse = await fetch(`${baseUrl}/${otherPharmacyId}`);
    assert.equal(otherDetailResponse.status, 200);
    const { pharmacy: otherSubmission } = await otherDetailResponse.json();
    assert.equal(otherSubmission.name, otherPharmacyName);
    assert.equal(otherSubmission.business_email, 'other@example.test');
    assert.notEqual(otherSubmission.name, submission.name);
    assert.notEqual(otherSubmission.business_email, submission.business_email);
    assert.equal(submission.has_business_permit, true);
    assert.equal(submission.has_pharmacy_logo, true);
    for (const secretField of ['password', 'password_hash', 'token', 'secret', 'business_permit', 'pharmacy_logo']) {
      assert.equal(Object.hasOwn(submission, secretField), false, `${secretField} must not be returned in the details response`);
    }
    assert.deepEqual(Object.keys(submission).sort(), [
      'id', 'name', 'address', 'latitude', 'longitude', 'phone', 'business_email',
      'owner_first_name', 'owner_last_name', 'description', 'hours',
      'verification_status', 'correction_reason', 'rejection_reason', 'suspension_reason',
      'verification_reason', 'created_at', 'status_updated_at',
      'has_business_permit', 'has_pharmacy_logo',
    ].sort());

    const [permitResponse, logoResponse] = await Promise.all([
      fetch(`${baseUrl}/${pharmacyId}/permit`),
      fetch(`${baseUrl}/${pharmacyId}/logo`),
    ]);
    assert.equal(permitResponse.status, 200);
    assert.match(permitResponse.headers.get('content-type'), /application\/pdf/);
    assert.equal(logoResponse.status, 200);
    assert.match(logoResponse.headers.get('content-type'), /image\/png/);
    assert.equal(await logoResponse.text(), 'hello');

    const notificationResponse = await fetch(`${baseUrl}/${pharmacyId}/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Registration follow-up', message: 'Please confirm the submitted details.' }),
    });
    assert.equal(notificationResponse.status, 200);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND title = ?')
      .get(staffId, 'Registration follow-up').count, 1);

    const suspendResponse = await fetch(`${baseUrl}/${pharmacyId}/suspend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Test suspension reason' }),
    });
    assert.equal(suspendResponse.status, 200);
    assert.equal(db.prepare('SELECT verification_status FROM pharmacies WHERE id = ?').get(pharmacyId).verification_status, 'SUSPENDED');

    const reactivateResponse = await fetch(`${baseUrl}/${pharmacyId}/reactivate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'Suspension issue resolved.' }),
    });
    assert.equal(reactivateResponse.status, 200);

    for (const [action, reason, expectedStatus] of [
      ['require-reverification', 'Updated permit must be checked.', 'REVERIFICATION_REQUIRED'],
      ['review', '', 'UNDER_REVIEW'],
      ['request-correction', 'Business permit image is unreadable. Please upload a clearer copy.', 'CORRECTION_REQUIRED'],
      ['reject', 'Test rejection reason', 'REJECTED'],
    ]) {
      if (action === 'request-correction') {
        const missingCorrectionReason = await fetch(`${baseUrl}/${pharmacyId}/request-correction`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: ' ' }),
        });
        assert.equal(missingCorrectionReason.status, 422);
      }
      const response = await fetch(`${baseUrl}/${pharmacyId}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reason ? { reason } : {}),
      });
      assert.equal(response.status, 200, `${action} should succeed`);
      const state = db.prepare('SELECT verification_status, verification_stage, rejection_reason, correction_reason FROM pharmacies WHERE id = ?').get(pharmacyId);
      assert.equal(state.verification_stage, expectedStatus);
      if (action === 'request-correction') assert.equal(state.correction_reason, reason);
      if (action === 'reject') assert.equal(state.rejection_reason, reason);
    }
    const rejectedPharmacy = db.prepare('SELECT verification_status, rejection_reason FROM pharmacies WHERE id = ?').get(pharmacyId);
    assert.equal(rejectedPharmacy.verification_status, 'REJECTED');
    assert.equal(rejectedPharmacy.rejection_reason, 'Test rejection reason');
    const history = db.prepare(`
      SELECT actor_user_id, actor_role, action, previous_status, new_status, reason, created_at
      FROM pharmacy_verification_history WHERE pharmacy_id = ? ORDER BY id
    `).all(pharmacyId);
    assert.deepEqual(history.map(item => item.new_status), [
      'SUSPENDED', 'APPROVED', 'REVERIFICATION_REQUIRED', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'REJECTED',
    ]);
    assert.ok(history.every(item => item.actor_user_id === admin.id && item.actor_role === 'admin'));
    assert.equal(history.find(item => item.new_status === 'CORRECTION_REQUIRED').reason, 'Business permit image is unreadable. Please upload a clearer copy.');
    assert.ok(history.every(item => item.created_at));
    const audit = db.prepare(`
      SELECT action, description, reason FROM admin_audit_logs
      WHERE target_type = 'PHARMACY' AND target_id = ?
    `).all(pharmacyId);
    assert.equal(audit.length, history.length + 1, 'the existing staff notification action is also audited');
    assert.ok(audit.some(item => item.description.includes('from APPROVED to SUSPENDED')));
    assert.ok(audit.some(item => item.description.includes('from UNDER_REVIEW to CORRECTION_REQUIRED')));
    assert.ok(db.prepare('SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND type = ?')
      .get(staffId, 'admin').count >= 7);
    const correctionNotice = db.prepare(`
      SELECT message FROM notifications
      WHERE user_id = ? AND title = 'Pharmacy registration correction required'
      ORDER BY id DESC LIMIT 1
    `).get(staffId);
    assert.match(correctionNotice.message, /Business permit image is unreadable/);
    const historyResponse = await fetch(`${baseUrl}/${pharmacyId}/verification-history`);
    assert.equal(historyResponse.status, 200);
    assert.equal((await historyResponse.json()).history.length, history.length);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.prepare('DELETE FROM pharmacy_verification_history WHERE pharmacy_id = ?').run(pharmacyId);
    db.prepare('DELETE FROM admin_audit_logs WHERE admin_id = ? AND target_type = ? AND target_id = ?')
      .run(admin.id, 'PHARMACY', pharmacyId);
    db.prepare('DELETE FROM notifications WHERE user_id = ?').run(staffId);
    db.prepare('DELETE FROM users WHERE id = ?').run(staffId);
    db.prepare('DELETE FROM pharmacies WHERE id IN (?, ?)').run(pharmacyId, otherPharmacyId);
  }
});
