const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const db = require('../db/database');
const authRoutes = require('../routes/auth');
const notificationRoutes = require('../routes/notifications');

test('pharmacy registration saves its optional logo without requiring it', async () => {
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  assert.ok(admin, 'seed data should include an admin for registration notifications');
  const app = express();
  app.use(express.json({ limit: '12mb' }));
  app.use(session({ secret: 'registration-test-secret', resave: false, saveUninitialized: false }));
  app.use('/api/auth', authRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const adminNotificationsApp = express();
  adminNotificationsApp.use((req, res, next) => {
    req.session = { user: { id: admin.id, role: 'admin' } };
    next();
  });
  adminNotificationsApp.use('/api/notifications', notificationRoutes);
  const adminNotificationsServer = adminNotificationsApp.listen(0, '127.0.0.1');
  await new Promise(resolve => adminNotificationsServer.once('listening', resolve));
  const createdEmails = [];
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const adminNotificationsUrl = `http://127.0.0.1:${adminNotificationsServer.address().port}/api/notifications`;

  try {
    for (const [index, pharmacy_logo] of [
      [1, 'data:image/png;base64,aVZCT1J3MEtHZ29B'],
      [2, undefined],
    ]) {
      const email = `pharmacy-logo-test-${process.pid}-${Date.now()}-${index}@example.test`;
      createdEmails.push(email);
      const response = await fetch(`${baseUrl}/api/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'pharmacy_staff',
          phone: '+639123456789',
          email,
          password: 'test-password',
          pharmacy_name: `Registration Test Pharmacy ${index}`,
          pharmacy_address: 'Test address',
          owner_first_name: 'Test',
          owner_last_name: 'Owner',
          business_permit: 'data:application/pdf;base64,JVBERi0xLjQ=',
          pharmacy_logo,
          latitude: 8.9,
          longitude: 125.5,
        }),
      });

      const responseBody = await response.json();
      assert.equal(response.status, 200, JSON.stringify(responseBody));
      const { user } = responseBody;
      const saved = db.prepare('SELECT pharmacy_logo FROM pharmacies WHERE id = ?').get(user.pharmacy_id);
      assert.equal(saved.pharmacy_logo, pharmacy_logo || null);
      const notification = db.prepare(`
          SELECT id, title, message, type FROM notifications
          WHERE user_id = ? AND type = 'pharmacy_registration' AND title = ?
          ORDER BY id DESC LIMIT 1
        `).get(admin.id, `New pharmacy registration: Registration Test Pharmacy ${index}`);
      assert.ok(notification, 'admin should receive the registration notification');
      assert.equal(notification.type, 'pharmacy_registration');
      assert.match(notification.message, new RegExp(`branch: Registration Test Pharmacy ${index}`, 'i'));
      assert.match(notification.message, /Owner: Test Owner/);
      assert.match(notification.message, /Email: .*example\.test/);
      assert.match(notification.message, /Business permit: Submitted/);
      assert.match(notification.message, new RegExp(`Pharmacy logo: ${pharmacy_logo ? 'Submitted' : 'Not submitted'}`));
      const inboxResponse = await fetch(adminNotificationsUrl);
      assert.equal(inboxResponse.status, 200);
      const { notifications } = await inboxResponse.json();
      assert.ok(notifications.some(item => item.id === notification.id), 'admin inbox should expose the new registration notification');
    }
  } finally {
    db.transaction(() => {
      for (const email of createdEmails) {
        const user = db.prepare('SELECT id, pharmacy_id FROM users WHERE email = ?').get(email);
        if (!user) continue;
        db.prepare('DELETE FROM notifications WHERE user_id = ?').run(user.id);
        db.prepare("DELETE FROM notifications WHERE type = 'pharmacy_registration' AND title = ?")
          .run(`New pharmacy registration: Registration Test Pharmacy ${createdEmails.indexOf(email) + 1}`);
        db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
        db.prepare('DELETE FROM pharmacies WHERE id = ?').run(user.pharmacy_id);
      }
    })();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await new Promise((resolve, reject) => adminNotificationsServer.close(error => error ? reject(error) : resolve()));
  }
});
