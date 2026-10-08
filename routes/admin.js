const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware');
const router = express.Router();

router.use(requireAuth, requireRole('admin'));

function getVerificationStatus(pharmacy) {
  if (pharmacy && pharmacy.verification_stage && pharmacy.verification_stage !== 'PENDING') return pharmacy.verification_stage;
  if (pharmacy && pharmacy.verification_status === 'VERIFIED') return 'APPROVED';
  if (pharmacy && pharmacy.verification_status && pharmacy.verification_status !== 'PENDING') return pharmacy.verification_status;
  if (pharmacy && pharmacy.verified === 1) return 'APPROVED';
  if (pharmacy && pharmacy.verification_stage) return pharmacy.verification_stage;
  return 'PENDING';
}

function isVerifiedPharmacy(pharmacy) {
  return getVerificationStatus(pharmacy) === 'APPROVED';
}

function logAdminAction({ adminId, action, targetType, targetId, targetName, description, reason, status = 'SUCCESS' }) {
  db.prepare(`
    INSERT INTO admin_audit_logs (admin_id, action, target_type, target_id, target_name, description, reason, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(adminId, action, targetType || null, targetId || null, targetName || null, description || '', reason || null, status, new Date().toISOString());
}

function recordVerificationTransition({ pharmacy, actor, action, newStatus, reason, notificationTitle, notificationMessage }) {
  const previousStatus = getVerificationStatus(pharmacy);
  const stageToLegacyStatus = {
    APPROVED: 'VERIFIED',
    SUSPENDED: 'SUSPENDED',
    REJECTED: 'REJECTED',
  };
  const legacyStatus = stageToLegacyStatus[newStatus] || 'PENDING';
  const actorName = actor.name || actor.username || `User ${actor.id}`;
  const now = new Date().toISOString();
  const staff = db.prepare("SELECT id FROM users WHERE pharmacy_id = ? AND role = 'pharmacy_staff'").all(pharmacy.id);
  const admins = actor.role === 'pharmacy_staff'
    ? db.prepare("SELECT id FROM users WHERE role = 'admin'").all()
    : [];
  const insertNotification = db.prepare(`
    INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'admin')
  `);
  const writeTransition = db.transaction(() => {
    db.prepare(`
      UPDATE pharmacies
      SET verification_stage = ?,
          verification_status = ?,
          verified = ?,
          correction_reason = ?,
          rejection_reason = ?,
          suspension_reason = ?,
          verification_reason = ?,
          verification_date = CASE WHEN ? = 'APPROVED' THEN ? ELSE verification_date END,
          approved_by_admin_id = CASE WHEN ? = 'APPROVED' AND ? = 'admin' THEN ? ELSE approved_by_admin_id END,
          status_updated_at = ?
      WHERE id = ?
    `).run(
      newStatus,
      legacyStatus,
      newStatus === 'APPROVED' ? 1 : 0,
      newStatus === 'CORRECTION_REQUIRED' ? reason : null,
      newStatus === 'REJECTED' ? reason : null,
      newStatus === 'SUSPENDED' ? reason : null,
      reason || null,
      newStatus, now,
      newStatus, actor.role, actor.id, now, pharmacy.id,
    );
    db.prepare(`
      INSERT INTO pharmacy_verification_history (
        pharmacy_id, actor_user_id, actor_name, actor_role, action,
        previous_status, new_status, reason, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(pharmacy.id, actor.id, actorName, actor.role, action, previousStatus, newStatus, reason || null, now);

    if (actor.role === 'admin') {
      logAdminAction({
        adminId: actor.id,
        action: `PHARMACY ${action}`,
        targetType: 'PHARMACY',
        targetId: pharmacy.id,
        targetName: pharmacy.name,
        description: `Verification status changed from ${previousStatus} to ${newStatus}.`,
        reason: reason || null,
      });
    }
    [...staff, ...admins].forEach(user => insertNotification.run(
      user.id,
      notificationTitle,
      notificationMessage,
    ));
  });
  writeTransition();
  return { previousStatus, newStatus, notified: staff.length, adminsNotified: admins.length };
}

function buildPharmacyListQuery({ q = '', status = 'ALL' } = {}) {
  const where = [];
  const params = [];
  const normalized = (status || 'ALL').toUpperCase();
  if (normalized !== 'ALL') {
    where.push("COALESCE(NULLIF(p.verification_stage, ''), CASE p.verification_status WHEN 'VERIFIED' THEN 'APPROVED' ELSE p.verification_status END, 'PENDING') = ?");
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
      SELECT p.id, p.name, p.address, p.phone, p.verified,
        p.owner_first_name, p.owner_last_name, p.business_email, p.hours,
        p.correction_reason,
        COALESCE(NULLIF(p.verification_stage, ''), CASE p.verification_status WHEN 'VERIFIED' THEN 'APPROVED' ELSE p.verification_status END, 'PENDING') AS verification_status,
        CASE WHEN p.business_permit IS NOT NULL AND p.business_permit != '' THEN 1 ELSE 0 END AS has_business_permit,
        CASE WHEN p.pharmacy_logo IS NOT NULL AND p.pharmacy_logo != '' THEN 1 ELSE 0 END AS has_pharmacy_logo
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
    pendingPharmacies: db.prepare("SELECT COUNT(*) AS c FROM pharmacies WHERE COALESCE(NULLIF(verification_stage, ''), CASE verification_status WHEN 'VERIFIED' THEN 'APPROVED' ELSE verification_status END, 'PENDING') = 'PENDING'").get().c,
    suspendedPharmacies: db.prepare("SELECT COUNT(*) AS c FROM pharmacies WHERE COALESCE(verification_status, CASE WHEN verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'SUSPENDED'").get().c,
    customers: db.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'customer'").get().c,
    reservations: db.prepare('SELECT COUNT(*) AS c FROM reservations').get().c,
  };
  const shortageCount = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT m.id
      FROM medicines m
      LEFT JOIN inventory i ON i.medicine_id = m.id
      LEFT JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE p.verification_status = 'VERIFIED' OR p.id IS NULL
      GROUP BY m.id
      HAVING COALESCE(SUM(i.stock_quantity), 0) = 0
    )
  `).get().c;

  const pendingReservations = db.prepare(`SELECT COUNT(*) AS c FROM reservations WHERE status = 'pending'`).get().c;
  const lowStockAlerts = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      AND i.stock_quantity > 0 AND i.stock_quantity <= i.low_stock_threshold
  `).get().c;
  const criticalStockAlerts = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      AND i.stock_quantity > 0 AND i.stock_quantity <= CAST(i.low_stock_threshold * 0.5 AS INTEGER)
  `).get().c;
  const outOfStockAlerts = db.prepare(`
    SELECT COUNT(*) AS c FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      AND i.stock_quantity = 0
  `).get().c;
  const expiringSoon = db.prepare(`
    SELECT COUNT(*) AS c FROM medicine_batches mb JOIN pharmacies p ON p.id = mb.pharmacy_id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      AND mb.current_quantity > 0 AND mb.expiration_date IS NOT NULL
      AND date(mb.expiration_date) BETWEEN date('now') AND date('now', '+30 days')
      AND mb.status NOT IN ('expired', 'depleted', 'recalled', 'archived')
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

  const actionRequired = {
    pendingPharmacies: db.prepare(`
      SELECT id, name, address FROM pharmacies
      WHERE COALESCE(NULLIF(verification_stage, ''), CASE verification_status WHEN 'VERIFIED' THEN 'APPROVED' ELSE verification_status END, 'PENDING') = 'PENDING'
      ORDER BY created_at ASC
    `).all(),
    pharmaciesRequiringCorrection: db.prepare(`
      SELECT id, name, correction_reason FROM pharmacies
      WHERE COALESCE(NULLIF(verification_stage, ''), CASE verification_status WHEN 'VERIFIED' THEN 'APPROVED' ELSE verification_status END, 'PENDING') = 'CORRECTION_REQUIRED'
      ORDER BY status_updated_at DESC, name ASC
    `).all(),
    lowStockItems: db.prepare(`
      SELECT i.id AS inventory_id, m.name AS medicine_name, p.name AS pharmacy_name,
        i.stock_quantity, i.low_stock_threshold
      FROM inventory i
      JOIN medicines m ON m.id = i.medicine_id
      JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE i.stock_quantity > 0 AND i.stock_quantity <= i.low_stock_threshold
        AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      ORDER BY i.stock_quantity ASC, m.name ASC
      LIMIT 10
    `).all(),
    expiringMedicineBatches: db.prepare(`
      SELECT b.id, b.batch_number, b.expiration_date, b.current_quantity,
        m.name AS medicine_name, p.name AS pharmacy_name
      FROM medicine_batches b
      JOIN medicines m ON m.id = b.medicine_id
      JOIN pharmacies p ON p.id = b.pharmacy_id
      WHERE b.current_quantity > 0
        AND b.expiration_date IS NOT NULL
        AND date(b.expiration_date) BETWEEN date('now') AND date('now', '+30 days')
        AND b.status NOT IN ('expired', 'depleted', 'recalled', 'archived')
        AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      ORDER BY date(b.expiration_date) ASC
      LIMIT 10
    `).all(),
  };
  const systemOverview = {
    activeCustomers: db.prepare(`
      SELECT COUNT(*) AS c FROM users u
      WHERE u.role = 'customer' AND (
        EXISTS (SELECT 1 FROM search_logs s WHERE s.user_id = u.id AND s.searched_at >= datetime('now', '-30 days'))
        OR EXISTS (SELECT 1 FROM reservations r WHERE r.customer_id = u.id AND r.reserved_at >= datetime('now', '-30 days'))
      )
    `).get().c,
    activeProducts: db.prepare(`
      SELECT COUNT(*) AS c FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE i.deployed = 1
        AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    `).get().c,
    inventoryUnits: db.prepare(`
      SELECT COALESCE(SUM(i.stock_quantity), 0) AS c
      FROM inventory i JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    `).get().c,
  };
  const inventoryIntegrity = {
    batchQuantityMismatches: db.prepare(`
      SELECT COUNT(*) AS c FROM inventory i
      WHERE EXISTS (SELECT 1 FROM medicine_batches b WHERE b.inventory_id = i.id)
        AND i.stock_quantity != COALESCE((
          SELECT SUM(b.current_quantity) FROM medicine_batches b
          WHERE b.inventory_id = i.id AND b.status NOT IN ('depleted', 'recalled', 'archived')
        ), 0)
    `).get().c,
    activeBatchesMissingExpiry: db.prepare(`
      SELECT COUNT(*) AS c FROM medicine_batches
      WHERE current_quantity > 0 AND expiration_date IS NULL
        AND status NOT IN ('expired', 'depleted', 'recalled', 'archived')
    `).get().c,
    expiredBatchesWithStock: db.prepare(`
      SELECT COUNT(*) AS c FROM medicine_batches
      WHERE current_quantity > 0 AND expiration_date IS NOT NULL
        AND date(expiration_date) < date('now')
        AND status NOT IN ('depleted', 'recalled', 'archived')
    `).get().c,
  };

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
    actionRequired,
    systemOverview,
    inventoryIntegrity,
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
      verified: verificationStatus === 'APPROVED',
      verification_status: verificationStatus,
      reservation_count: c.c,
      reviews,
      average_rating,
      rating_count: reviews.length,
      has_business_permit: !!p.has_business_permit,
      has_pharmacy_logo: !!p.has_pharmacy_logo,
    };
  });
  res.json({ pharmacies: withCounts });
});

router.get('/pharmacies/:id', (req, res) => {
  const p = db.prepare(`
    SELECT p.id, p.name, p.address, p.latitude, p.longitude, p.phone, p.business_email,
      p.owner_first_name, p.owner_last_name, p.description, p.hours,
      COALESCE(NULLIF(p.verification_stage, ''), CASE p.verification_status WHEN 'VERIFIED' THEN 'APPROVED' ELSE p.verification_status END, 'PENDING') AS verification_status,
      p.correction_reason, p.rejection_reason, p.suspension_reason, p.verification_reason,
      p.created_at, p.status_updated_at,
      (p.business_permit IS NOT NULL AND p.business_permit != '') AS has_business_permit,
      (p.pharmacy_logo IS NOT NULL AND p.pharmacy_logo != '') AS has_pharmacy_logo
    FROM pharmacies p
    WHERE p.id = ?
  `).get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Pharmacy not found.' });
  p.has_business_permit = Boolean(p.has_business_permit);
  p.has_pharmacy_logo = Boolean(p.has_pharmacy_logo);
  res.json({ pharmacy: p });
});

router.get('/pharmacies/:id/verification-history', (req, res) => {
  const pharmacy = db.prepare('SELECT id FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found.' });
  const history = db.prepare(`
    SELECT id, actor_user_id, actor_name, actor_role, action,
      previous_status, new_status, reason, created_at
    FROM pharmacy_verification_history
    WHERE pharmacy_id = ?
    ORDER BY created_at DESC, id DESC
  `).all(pharmacy.id);
  res.json({ history });
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

router.get('/pharmacies/:id/logo', (req, res) => {
  const pharmacy = db.prepare('SELECT pharmacy_logo FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!pharmacy || !pharmacy.pharmacy_logo) return res.status(404).send('Pharmacy logo not found.');
  const match = /^data:(image\/(png|jpe?g|webp));base64,([\s\S]+)$/.exec(pharmacy.pharmacy_logo);
  if (!match) return res.status(422).send('Stored pharmacy logo is invalid.');
  res.type(match[1]).set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', `inline; filename="pharmacy-logo-${req.params.id}"`);
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

function runVerificationAction(req, res, {
  action,
  newStatus,
  allowedFrom,
  reasonRequired = false,
  notificationTitle,
  notificationMessage,
}) {
  const pharmacy = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(req.params.id);
  if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found.' });
  const previousStatus = getVerificationStatus(pharmacy);
  if (!allowedFrom.includes(previousStatus)) {
    return res.status(409).json({ error: `${action} is not allowed while this pharmacy is ${previousStatus.replaceAll('_', ' ').toLowerCase()}.` });
  }
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  if (reasonRequired && !reason) return res.status(422).json({ error: `A reason is required to ${action.toLowerCase()}.` });
  if (newStatus === 'APPROVED' && (!pharmacy.business_permit || !pharmacy.owner_first_name || !pharmacy.owner_last_name || !pharmacy.name || !pharmacy.address)) {
    return res.status(422).json({ error: 'The pharmacy registration is missing required owner, address, or business permit information.' });
  }
  const result = recordVerificationTransition({
    pharmacy,
    actor: { ...req.session.user, role: 'admin' },
    action,
    newStatus,
    reason,
    notificationTitle,
    notificationMessage: notificationMessage(reason, pharmacy.name),
  });
  res.json({ ok: true, ...result });
}

router.post('/pharmacies/:id/review', (req, res) => runVerificationAction(req, res, {
  action: 'REVIEW STARTED',
  newStatus: 'UNDER_REVIEW',
  allowedFrom: ['PENDING', 'REVERIFICATION_REQUIRED'],
  notificationTitle: 'Pharmacy registration under review',
  notificationMessage: (_reason, name) => `${name}'s registration is now under administrative review.`,
}));

router.post('/pharmacies/:id/request-correction', (req, res) => runVerificationAction(req, res, {
  action: 'CORRECTION REQUESTED',
  newStatus: 'CORRECTION_REQUIRED',
  allowedFrom: ['PENDING', 'UNDER_REVIEW', 'REVERIFICATION_REQUIRED'],
  reasonRequired: true,
  notificationTitle: 'Pharmacy registration correction required',
  notificationMessage: (reason, name) => `${name}: ${reason} Please update your Pharmacy Profile and submit the registration for review again.`,
}));

const approvePharmacy = (req, res) => runVerificationAction(req, res, {
  action: 'APPROVED',
  newStatus: 'APPROVED',
  allowedFrom: ['PENDING', 'UNDER_REVIEW'],
  notificationTitle: 'Pharmacy registration approved',
  notificationMessage: (_reason, name) => `${name}'s registration has been approved. Your pharmacy is now verified.`,
});
router.post('/pharmacies/:id/approve', approvePharmacy);
router.post('/pharmacies/:id/verify', approvePharmacy);

router.post('/pharmacies/:id/reject', (req, res) => runVerificationAction(req, res, {
  action: 'REJECTED',
  newStatus: 'REJECTED',
  allowedFrom: ['PENDING', 'UNDER_REVIEW', 'CORRECTION_REQUIRED', 'REVERIFICATION_REQUIRED'],
  reasonRequired: true,
  notificationTitle: 'Pharmacy registration rejected',
  notificationMessage: (reason, name) => `${name}'s registration was rejected. Reason: ${reason}`,
}));

router.post('/pharmacies/:id/suspend', (req, res) => runVerificationAction(req, res, {
  action: 'SUSPENDED',
  newStatus: 'SUSPENDED',
  allowedFrom: ['APPROVED'],
  reasonRequired: true,
  notificationTitle: 'Pharmacy account suspended',
  notificationMessage: (reason, name) => `${name} has been suspended. Reason: ${reason}`,
}));

router.post('/pharmacies/:id/reactivate', (req, res) => runVerificationAction(req, res, {
  action: 'REACTIVATED',
  newStatus: 'APPROVED',
  allowedFrom: ['SUSPENDED'],
  reasonRequired: true,
  notificationTitle: 'Pharmacy account reactivated',
  notificationMessage: (reason, name) => `${name} has been reactivated.${reason ? ` Reason: ${reason}` : ''}`,
}));

router.post('/pharmacies/:id/require-reverification', (req, res) => runVerificationAction(req, res, {
  action: 'REVERIFICATION REQUIRED',
  newStatus: 'REVERIFICATION_REQUIRED',
  allowedFrom: ['APPROVED'],
  reasonRequired: true,
  notificationTitle: 'Pharmacy reverification required',
  notificationMessage: (reason, name) => `${name} must complete reverification. Reason: ${reason} Update your Pharmacy Profile and submit it for review.`,
}));

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
  const queryValue = key => typeof req.query[key] === 'string' ? req.query[key].trim() : '';
  const q = queryValue('q').slice(0, 200);
  const actionType = queryValue('actionType');
  const targetType = queryValue('targetType');
  const pharmacy = queryValue('pharmacy').slice(0, 200);
  const status = queryValue('status');
  const fromDate = queryValue('fromDate');
  const toDate = queryValue('toDate');
  const requestedPage = Number.parseInt(queryValue('page'), 10);
  const requestedPageSize = Number.parseInt(queryValue('pageSize'), 10);
  const pageSize = [10, 25, 50, 100].includes(requestedPageSize) ? requestedPageSize : 25;
  const page = Number.isInteger(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const where = [];
  const params = [];
  if (actionType) { where.push('a.action = ?'); params.push(actionType); }
  if (targetType) { where.push('a.target_type = ?'); params.push(targetType); }
  if (pharmacy) { where.push('(a.target_name LIKE ? OR p.name LIKE ?)'); params.push(`%${pharmacy}%`, `%${pharmacy}%`); }
  if (status) { where.push('a.status = ?'); params.push(status); }
  if (fromDate) { where.push('datetime(a.created_at) >= datetime(?)'); params.push(fromDate); }
  if (toDate) { where.push("datetime(a.created_at) < datetime(?, '+1 day')"); params.push(toDate); }
  if (q) { where.push('(a.action LIKE ? OR a.description LIKE ? OR a.reason LIKE ? OR a.target_name LIKE ?)'); const like = `%${q}%`; params.push(like, like, like, like); }

  const fromSql = `
    FROM admin_audit_logs a
    LEFT JOIN users u ON u.id = a.admin_id
    LEFT JOIN pharmacies p ON p.id = a.target_id AND a.target_type = 'PHARMACY'
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
  `;
  const total = db.prepare(`SELECT COUNT(*) AS count ${fromSql}`).get(...params).count;
  const totalPages = Math.ceil(total / pageSize);
  const currentPage = totalPages ? Math.min(page, totalPages) : 1;
  const rows = db.prepare(`
    SELECT a.*, u.name AS admin_name, p.name AS pharmacy_name
    ${fromSql}
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, pageSize, (currentPage - 1) * pageSize);

  const filters = {
    actions: db.prepare('SELECT DISTINCT action FROM admin_audit_logs WHERE action IS NOT NULL AND action != \'\' ORDER BY action').all().map(row => row.action),
    targetTypes: db.prepare('SELECT DISTINCT target_type FROM admin_audit_logs WHERE target_type IS NOT NULL AND target_type != \'\' ORDER BY target_type').all().map(row => row.target_type),
    statuses: db.prepare('SELECT DISTINCT status FROM admin_audit_logs WHERE status IS NOT NULL AND status != \'\' ORDER BY status').all().map(row => row.status),
  };
  res.json({ logs: rows, pagination: { page: currentPage, pageSize, total, totalPages }, filters });
});

// GET /api/admin/notifications
router.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.json({ notifications: rows });
});

module.exports = router;
