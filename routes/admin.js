const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware');
const router = express.Router();

router.use(requireAuth, requireRole('admin'));

function getVerificationStatus(pharmacy) {
  if (pharmacy && pharmacy.verification_status) return pharmacy.verification_status;
  if (pharmacy && pharmacy.verified === 1) return 'VERIFIED';
  return 'PENDING';
}

function isVerifiedPharmacy(pharmacy) {
  return getVerificationStatus(pharmacy) === 'VERIFIED';
}

function logAdminAction({ adminId, action, targetType, targetId, targetName, description, reason, status = 'SUCCESS' }) {
  db.prepare(`
    INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, target_name, description, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(adminId, action, targetType || null, targetId || null, targetName || null, description || '', reason || null, status, new Date().toISOString());
}

function buildPharmacyListQuery({ q = '', status = 'ALL' } = {}) {
  const where = [];
  const params = [];
  const normalized = (status || 'ALL').toUpperCase();
  if (normalized !== 'ALL') {
    where.push("COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = ?");
    params.push(normalized);
  }
  if (q) {
    where.push(`(
      p.name LIKE ? OR p.address LIKE ? OR p.phone LIKE ? OR p.business_email LIKE ? OR p.owner_first_name LIKE ? OR p.owner_last_name LIKE ?
    )`);
    const like = `%${q}%`;
    params.push(like, like, like, like, like, like);
  }
  return {
    sql: `
      SELECT p.*,
        COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) AS verification_status,
        CASE WHEN p.business_permit IS NOT NULL AND p.business_permit != '' THEN 1 ELSE 0 END AS has_business_permit
      FROM pharmacies p ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.name ASC
    `,
    params,
  };
}

// GET /api/admin/dashboard
router.get('/dashboard', (req, res) => {
  const totals = {
    pharmacies: db.prepare('SELECT COUNT(*) AS c FROM pharmacies').get().c,
    verifiedPharmacies: db.prepare("SELECT COUNT(*) AS c FROM pharmacies WHERE COALESCE(verification_status, CASE WHEN verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'").get().c,
    pendingPharmacies: db.prepare("SELECT COUNT(*) AS c FROM pharmacies WHERE COALESCE(verification_status, CASE WHEN verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'PENDING'").get().c,
    suspendedPharmacies: db.prepare("SELECT COUNT(*) AS c FROM pharmacies WHERE COALESCE(verification_status, CASE WHEN verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'SUSPENDED'").get().c,
    customers: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'customer'").get().c,
    reservations: db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c,
  };
  const shortageCount = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT medicine_id FROM inventory GROUP BY medicine_id HAVING SUM(stock_quantity) = 0
    )
  `).get().c;

  const pendingReservations = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE status = 'pending'`).get().c;
  const lowStockAlerts = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE p.verification_status = 'VERIFIED' AND i.stock_quantity > 0 AND i.stock_quantity <= i.low_stock_threshold
  `).get().c;
  const criticalStockAlerts = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE p.verification_status = 'VERIFIED' AND i.stock_quantity > 0 AND i.stock_quantity <= CAST(i.low_stock_threshold * 0.5 AS INTEGER)
  `).get().c;
  const outOfStockAlerts = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE p.verification_status = 'VERIFIED' AND i.stock_quantity = 0
  `).get().c;
  const expiringSoon = db.prepare(`
    SELECT COUNT(*) AS c FROM medicine_batches mb JOIN pharmacies p ON p.id = mb.pharmacy_id
    WHERE p.verification_status = 'VERIFIED' AND mb.expiration_date IS NOT NULL AND mb.expiration_date > date('now') AND mb.expiration_date <= date('now', '+30 days')
  `).get().c;
  const totalInventoryValue = db.prepare(`SELECT COALESCE(SUM(price * stock_quantity),0) AS v FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id WHERE p.verification_status = 'VERIFIED'`).get().v;
  const newCustomersThisWeek = db.prepare(`
    SELECT COUNT(*) AS c FROM users WHERE role = 'customer' AND created_at >= datetime('now','-7 days')
  `).get().c;

  const topPharmacies = db.prepare(`
    SELECT p.id, p.name, COUNT(r.id) AS reservation_count
    FROM pharmacies p
    LEFT JOIN inventory i ON i.pharmacy_id = p.id
    LEFT JOIN reservations r ON r.inventory_id = i.id
    GROUP BY p.id ORDER BY reservation_count DESC LIMIT 5
  `).all();

  const reservationsByStatus = db.prepare(`
    SELECT status, COUNT(*) AS count FROM reservations GROUP BY status
  `).all();

  const recentActivity = db.prepare(`
    SELECT a.*, u.name AS admin_name
    FROM admin_audit_logs a
    LEFT JOIN users u ON u.id = a.admin_id
    ORDER BY a.created_at DESC
    LIMIT 10
  `).all();

  res.json({
    totals,
    shortageCount,
    stats: {
      pendingReservations,
      lowStockAlerts,
      criticalStockAlerts,
      outOfStockAlerts,
      expiringSoon,
      totalInventoryValue: +totalInventoryValue.toFixed(2),
      newCustomersThisWeek,
    },
    recentActivity,
    topPharmacies,
    reservationsByStatus,
  });
});

// GET /api/admin/pharmacies?q=search+term&status=VERIFIED
router.get('/pharmacies', (req, res) => {
  const q = (req.query.q || '').trim();
  const status = (req.query.status || 'ALL').toString().toUpperCase();
  const query = buildPharmacyListQuery({ q, status });
  const rows = db.prepare(query.sql).all(...query.params);
  const withCounts = rows.map(p => {
    const c = db.prepare(`
      SELECT COUNT(*) AS c FROM reservations r JOIN inventory i ON i.id = r.inventory_id WHERE i.pharmacy_id = ?
    `).get(p.id);
    const reviews = db.prepare(`
      SELECT r.rating, r.comment, r.updated_at,
        COALESCE(NULLIF(u.username, ''), 'customer-' || u.id) AS customer_username,
        COALESCE(NULLIF(u.username, ''), 'Customer') AS customer_name
      FROM pharmacy_ratings r JOIN users u ON u.id = r.customer_id
      WHERE r.pharmacy_id = ? ORDER BY r.updated_at DESC
    `).all(p.id);
    const average_rating = reviews.length
      ? +(reviews.reduce((total, review) => total + review.rating, 0) / reviews.length).toFixed(1)
      : null;
    const verificationStatus = getVerificationStatus(p);
    return {
      ...p,
      verified: verificationStatus === 'VERIFIED',
      verification_status: verificationStatus,
      reservation_count: c.c,
      reviews,
      average_rating,
      rating_count: reviews.length,
      has_business_permit: !!p.has_business_permit,
    };
  });
  res.json({ pharmacies: withCounts });
});

router.get('/pharmacies/:id', (req, res) => {
  const p = db.prepare(`
    SELECT p.*,
      COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) AS verification_status,
      CASE WHEN p.business_permit IS NOT NULL AND p.business_permit != '' THEN 1 ELSE 0 END AS has_business_permit,
      CONCAT(COALESCE(owner_first_name, ''), ' ', COALESCE(owner_last_name, '')).trim() AS owner_full_name,
      (SELECT COUNT(*) FROM reservations r JOIN inventory i ON i.id = r.inventory_id WHERE i.pharmacy_id = p.id) AS reservation_count
    FROM pharmacies p
    WHERE p.id = ?
  `).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pharmacy not found.' });
  p.verification_status = getVerificationStatus(p);
  res.json({ pharmacy: p });
});

router.get('/pharmacies/:id/permit', (req, res) => {
  const pharmacy = db.prepare('SELECT business_permit FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!pharmacy || !pharmacy.business_permit) return res.status(404).send('Business permit not found.');
  const match = /^data:(application\/pdf|image\/(png|jpeg|webp));base64,([\s\S]+)$/.exec(pharmacy.business_permit);
  if (!match) return res.status(422).send('Stored business permit is invalid.');
  res.type(match[1]).set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `inline; filename="business-permit-${req.params.id}"`);
  res.send(Buffer.from(match[3], 'base64'));
});

router.post('/pharmacies/:id/notify', (req, res) => {
  const pharmacy = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found.' });
  const title = (req.body.title || '').trim();
  const message = (req.body.message || '').trim();
  if (!title || !message) {
    return res.status(422).json({ error: 'Title and message are required.' });
  }
  const staff = db.prepare(`SELECT id FROM users WHERE pharmacy_id = ? AND role = 'pharmacy_staff'`).all(pharmacy.id);
  if (!staff.length) {
    return res.status(422).json({ error: 'This pharmacy has no staff account to notify.' });
  }
  const insert = db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?,?,?,'admin')`);
  const tx = db.transaction(() => staff.forEach(s => insert.run(s.id, title, message)));
  tx();
  logAdminAction({
    adminId: req.session.user.id,
    action: 'PHARMACY NOTIFICATION SENT',
    targetType: 'PHARMACY',
    targetId: pharmacy.id,
    targetName: pharmacy.name,
    description: `Notification sent to pharmacy staff: ${title}`,
    status: 'SUCCESS',
  });
  res.json({ ok: true, notified: staff.length });
});

router.post('/pharmacies/:id/verify', (req, res) => {
  const p = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pharmacy not found.' });
  const reason = (req.body.reason || '').trim();
  db.prepare(`
    UPDATE pharmacies
    SET verified = 1,
        verification_status = 'VERIFIED',
        verification_date = datetime('now'),
        verification_reason = ?,
        rejection_reason = NULL,
        suspension_reason = NULL,
        approved_by_admin_id = ?,
        status_updated_at = datetime('now')
    WHERE id = ?
  `).run(reason || null, req.session.user.id, p.id);
  logAdminAction({
    adminId: req.session.user.id,
    action: 'PHARMACY APPROVED',
    targetType: 'PHARMACY',
    targetId: p.id,
    targetName: p.name,
    description: 'Pharmacy verification was approved.',
    reason: reason || null,
    status: 'SUCCESS',
  });
  res.json({ ok: true });
});

router.post('/pharmacies/:id/reject', (req, res) => {
  const p = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pharmacy not found.' });
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(422).json({ error: 'A rejection reason is required.' });
  db.prepare(`
    UPDATE pharmacies
    SET verified = 0,
        verification_status = 'REJECTED',
        rejection_reason = ?,
        suspension_reason = NULL,
        status_updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, p.id);
  logAdminAction({
    adminId: req.session.user.id,
    action: 'PHARMACY REJECTED',
    targetType: 'PHARMACY',
    targetId: p.id,
    targetName: p.name,
    description: 'Pharmacy verification was rejected.',
    reason,
    status: 'SUCCESS',
  });
  res.json({ ok: true });
});

router.post('/pharmacies/:id/suspend', (req, res) => {
  const p = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pharmacy not found.' });
  const reason = (req.body.reason || '').trim();
  if (!reason) return res.status(422).json({ error: 'A suspension reason is required.' });
  db.prepare(`
    UPDATE pharmacies
    SET verified = 0,
        verification_status = 'SUSPENDED',
        suspension_reason = ?,
        status_updated_at = datetime('now')
    WHERE id = ?
  `).run(reason, p.id);
  logAdminAction({
    adminId: req.session.user.id,
    action: 'PHARMACY SUSPENDED',
    targetType: 'PHARMACY',
    targetId: p.id,
    targetName: p.name,
    description: 'Pharmacy was temporarily suspended.',
    reason,
    status: 'SUCCESS',
  });
  res.json({ ok: true });
});

router.post('/pharmacies/:id/reactivate', (req, res) => {
  const p = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pharmacy not found.' });
  const reason = (req.body.reason || '').trim();
  db.prepare(`
    UPDATE pharmacies
    SET verified = 1,
        verification_status = 'VERIFIED',
        suspension_reason = NULL,
        status_updated_at = datetime('now')
    WHERE id = ?
  `).run(p.id);
  logAdminAction({
    adminId: req.session.user.id,
    action: 'PHARMACY REACTIVATED',
    targetType: 'PHARMACY',
    targetId: p.id,
    targetName: p.name,
    description: 'Pharmacy was reactivated after suspension.',
    reason: reason || null,
    status: 'SUCCESS',
  });
  res.json({ ok: true });
});

// GET /api/admin/inventory
router.get('/inventory', (req, res) => {
  const q = (req.query.q || '').trim();
  const statusFilter = (req.query.status || 'ALL').toString().toUpperCase();
  const pharmacyFilter = (req.query.pharmacy || '').trim();
  const categoryFilter = (req.query.category || '').trim();
  const fromDate = (req.query.fromDate || '').trim();
  const toDate = (req.query.toDate || '').trim();

  const where = ["p.verification_status = 'VERIFIED'"];
  const params = [];
  if (q) {
    where.push('(m.name LIKE ? OR p.name LIKE ? OR m.category LIKE ?)');
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  if (pharmacyFilter) {
    where.push('p.name LIKE ?');
    params.push(`%${pharmacyFilter}%`);
  }
  if (categoryFilter) {
    where.push('m.category LIKE ?');
    params.push(`%${categoryFilter}%`);
  }
  if (fromDate) {
    where.push('COALESCE(MAX(mb.expiration_date), i.updated_at) >= ?');
    params.push(fromDate);
  }
  if (toDate) {
    where.push('COALESCE(MAX(mb.expiration_date), i.updated_at) <= ?');
    params.push(toDate);
  }

  const rows = db.prepare(`
    SELECT
      i.id AS inventory_id,
      i.pharmacy_id,
      p.name AS pharmacy_name,
      m.id AS medicine_id,
      m.name AS medicine_name,
      m.category,
      i.stock_quantity AS current_stock,
      i.low_stock_threshold AS minimum_stock,
      CASE
        WHEN i.stock_quantity = 0 THEN 'OUT_OF_STOCK'
        WHEN i.stock_quantity <= i.low_stock_threshold THEN 'LOW_STOCK'
        WHEN i.stock_quantity <= CAST(i.low_stock_threshold * 0.5 AS INTEGER) THEN 'CRITICAL'
        ELSE 'NORMAL'
      END AS stock_status,
      MAX(mb.expiration_date) AS expiration_date,
      MAX(COALESCE(mb.updated_at, i.updated_at)) AS last_updated
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    JOIN pharmacies p ON p.id = i.pharmacy_id
    LEFT JOIN medicine_batches mb ON mb.inventory_id = i.id
    WHERE ${where.join(' AND ')}
    GROUP BY i.id
    ORDER BY p.name ASC, m.name ASC
  `).all(...params);

  const filteredRows = rows.filter(row => {
    const status = row.stock_status;
    const exp = row.expiration_date ? new Date(row.expiration_date) : null;
    const expiringSoon = exp && exp > new Date() && exp <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const expired = exp && exp <= new Date();
    const normalized = statusFilter === 'ALL' ? true :
      (statusFilter === 'NORMAL' ? status === 'NORMAL' :
      (statusFilter === 'LOW_STOCK' ? status === 'LOW_STOCK' :
      (statusFilter === 'CRITICAL' ? status === 'CRITICAL' :
      (statusFilter === 'OUT_OF_STOCK' ? status === 'OUT_OF_STOCK' :
      (statusFilter === 'EXPIRING_SOON' ? expiringSoon :
      (statusFilter === 'EXPIRED' ? expired : true))))));
    return normalized;
  });

  const counts = {
    totalProducts: filteredRows.length,
    lowStock: filteredRows.filter(r => r.stock_status === 'LOW_STOCK').length,
    criticalStock: filteredRows.filter(r => r.stock_status === 'CRITICAL').length,
    outOfStock: filteredRows.filter(r => r.stock_status === 'OUT_OF_STOCK').length,
    expiringSoon: filteredRows.filter(r => {
      const exp = r.expiration_date ? new Date(r.expiration_date) : null;
      return !!(exp && exp > new Date() && exp <= new Date(Date.now() + 30 * 24 * 60 * 60 * 1000));
    }).length,
  };

  const shortages = db.prepare(`
    SELECT m.id AS medicine_id, m.name, m.category,
      COALESCE(SUM(i.stock_quantity), 0) AS total_stock,
      COUNT(DISTINCT i.pharmacy_id) AS pharmacies_carrying,
      COALESCE((
        SELECT COUNT(*)
        FROM search_logs sl
        WHERE (
          sl.medicine_ids = '[' || CAST(m.id AS TEXT) || ']' OR
          sl.medicine_ids LIKE '%,' || CAST(m.id AS TEXT) || ',%' OR
          sl.medicine_ids LIKE '[' || CAST(m.id AS TEXT) || ',%' OR
          sl.medicine_ids LIKE '%,' || CAST(m.id AS TEXT) || ']'
        )
      ), 0) AS customer_searches
    FROM medicines m
    LEFT JOIN inventory i ON i.medicine_id = m.id
    LEFT JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE p.verification_status = 'VERIFIED'
    GROUP BY m.id
    HAVING total_stock = 0
    ORDER BY m.name ASC
  `).all();

  res.json({ inventory: filteredRows, counts, shortages, filters: { q, statusFilter, pharmacyFilter, categoryFilter, fromDate, toDate } });
});

// GET /api/admin/shortages — medicines with zero total stock system-wide
router.get('/shortages', (req, res) => {
  const rows = db.prepare(`
    SELECT m.id AS medicine_id, m.name, m.category, COALESCE(SUM(i.stock_quantity), 0) AS total_stock,
           COUNT(DISTINCT i.pharmacy_id) AS pharmacies_carrying,
           COALESCE((SELECT COUNT(*) FROM search_logs WHERE INSTR(search_logs.medicine_ids, CAST(m.id AS TEXT)) > 0), 0) AS customer_searches
    FROM medicines m
    LEFT JOIN inventory i ON i.medicine_id = m.id
    LEFT JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE p.verification_status = 'VERIFIED' OR p.id IS NULL
    GROUP BY m.id
    HAVING total_stock = 0
    ORDER BY m.name ASC
  `).all();
  res.json({ shortages: rows });
});

// GET /api/admin/audit-logs
router.get('/audit-logs', (req, res) => {
  const q = (req.query.q || '').trim();
  const actionType = (req.query.actionType || '').trim();
  const targetType = (req.query.targetType || '').trim();
  const pharmacy = (req.query.pharmacy || '').trim();
  const status = (req.query.status || '').trim();
  const fromDate = (req.query.fromDate || '').trim();
  const toDate = (req.query.toDate || '').trim();

  const where = [];
  const params = [];
  if (actionType) { where.push('a.action = ?'); params.push(actionType); }
  if (targetType) { where.push('a.target_type = ?'); params.push(targetType); }
  if (pharmacy) { where.push('(a.target_name LIKE ? OR p.name LIKE ?)'); params.push(`%${pharmacy}%`, `%${pharmacy}%`); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (fromDate) { where.push('datetime(a.created_at) >= datetime(?)'); params.push(fromDate); }
  if (toDate) { where.push('datetime(a.created_at) <= datetime(?)'); params.push(toDate); }
  if (q) { where.push('(a.action LIKE ? OR a.description LIKE ? OR a.reason LIKE ? OR a.target_name LIKE ?)'); const like = `%${q}%`; params.push(like, like, like, like); }

  const rows = db.prepare(`
    SELECT a.*, u.name AS admin_name, p.name AS pharmacy_name
    FROM admin_audit_logs a
    LEFT JOIN users u ON u.id = a.admin_id
    LEFT JOIN pharmacies p ON p.id = a.target_id AND a.target_type = 'PHARMACY'
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.created_at DESC
  `).all(...params);

  res.json({ logs: rows });
});

// GET /api/admin/notifications
router.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.json({ notifications: rows });
});

module.exports = router;
