const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db/database');
const adminRoutes = require('../routes/admin');

test('admin audit logs support filters and stable server-side pagination', async () => {
  const runId = `${process.pid}-${Date.now()}`;
  const action = `AUDIT_FILTER_TEST_${runId}`;
  const targetType = `AUDIT_FILTER_TARGET_${runId}`;
  const targetPrefix = `Audit filter target ${runId}`;
  const admin = db.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1").get();
  assert.ok(admin, 'seed data should include an admin');
  const insert = db.prepare(`
    INSERT INTO admin_audit_logs (admin_id, action, target_type, target_name, description, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'INFO', ?)
  `);
  const ids = [];
  for (let index = 0; index < 11; index += 1) {
    const createdAt = `2026-10-01T10:${String(index).padStart(2, '0')}:00.000Z`;
    ids.push(Number(insert.run(
      admin.id,
      action,
      targetType,
      `${targetPrefix} ${index}`,
      `Audit test description ${index}`,
      `Audit test reason ${index}`,
      createdAt,
    ).lastInsertRowid));
  }

  const app = express();
  app.use((req, res, next) => {
    req.session = { user: { id: admin.id, role: 'admin' } };
    next();
  });
  app.use('/api/admin', adminRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/admin/audit-logs`;

  try {
    const firstPageResponse = await fetch(`${baseUrl}?actionType=${encodeURIComponent(action)}&targetType=${encodeURIComponent(targetType)}&status=INFO&fromDate=2026-10-01&toDate=2026-10-01&page=1&pageSize=10`);
    assert.equal(firstPageResponse.status, 200);
    const firstPage = await firstPageResponse.json();
    assert.equal(firstPage.logs.length, 10);
    assert.deepEqual(firstPage.pagination, { page: 1, pageSize: 10, total: 11, totalPages: 2 });
    assert.ok(firstPage.logs.every(log => log.action === action && log.target_type === targetType && log.status === 'INFO'));
    assert.equal(firstPage.logs[0].id, ids[10]);
    assert.ok(firstPage.filters.actions.includes(action));
    assert.ok(firstPage.filters.targetTypes.includes(targetType));
    assert.ok(firstPage.filters.statuses.includes('INFO'));

    const secondPageResponse = await fetch(`${baseUrl}?actionType=${encodeURIComponent(action)}&page=2&pageSize=10`);
    assert.equal(secondPageResponse.status, 200);
    const secondPage = await secondPageResponse.json();
    assert.equal(secondPage.logs.length, 1);
    assert.equal(secondPage.logs[0].id, ids[0]);
    assert.deepEqual(secondPage.pagination, { page: 2, pageSize: 10, total: 11, totalPages: 2 });

    const searchResponse = await fetch(`${baseUrl}?q=${encodeURIComponent(`${targetPrefix} 3`)}&pageSize=10`);
    assert.equal(searchResponse.status, 200);
    const searchResult = await searchResponse.json();
    assert.equal(searchResult.pagination.total, 1);
    assert.equal(searchResult.logs[0].id, ids[3]);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.prepare(`DELETE FROM admin_audit_logs WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
  }
});
