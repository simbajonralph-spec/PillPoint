const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware');
const router = express.Router();

// Haversine distance in km
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.use(requireAuth, requireRole('customer'));

// GET /api/customer/dashboard
router.get('/dashboard', (req, res) => {
  const uid = req.session.user.id;
  const recentReservations = db.prepare(`
    SELECT r.id, r.quantity, r.status, r.reserved_at, m.name AS medicine_name, p.name AS pharmacy_name
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE r.customer_id = ?
    ORDER BY r.reserved_at DESC LIMIT 5
  `).all(uid);

  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) AS count FROM reservations WHERE customer_id = ? GROUP BY status
  `).all(uid);

  const topRatedPharmacies = db.prepare(`
    SELECT p.id, p.name, p.address, p.profile_image, p.cover_image,
      ROUND(AVG(r.rating), 1) AS average_rating, COUNT(r.id) AS rating_count
    FROM pharmacies p
    JOIN pharmacy_ratings r ON r.pharmacy_id = p.id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    GROUP BY p.id
    ORDER BY average_rating DESC, rating_count DESC, p.name ASC
    LIMIT 5
  `).all();

  const unreadNotifications = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0
  `).get(uid);

  // Real search-activity stats, derived from search_logs (populated every time
  // this customer runs a search on the Search Medicines page).
  const searchesMade = db.prepare(`SELECT COUNT(*) AS count FROM search_logs WHERE user_id = ?`).get(uid).count;

  const searchHistory = db.prepare(`SELECT medicine_ids, pharmacy_ids FROM search_logs WHERE user_id = ?`).all(uid);
  const medicineIds = new Set();
  const pharmacyIds = new Set();
  const medicineCounts = {};
  const medicineNames = new Map(db.prepare(`SELECT id, name FROM medicines`).all().map(m => [m.id, m.name]));

  searchHistory.forEach(row => {
    const meds = (() => {
      try {
        const parsed = JSON.parse(row.medicine_ids || '[]');
        return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
      } catch (err) {
        return [];
      }
    })();
    const pharmacies = (() => {
      try {
        const parsed = JSON.parse(row.pharmacy_ids || '[]');
        return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isFinite) : [];
      } catch (err) {
        return [];
      }
    })();

    meds.forEach(id => {
      medicineIds.add(id);
      medicineCounts[id] = (medicineCounts[id] || 0) + 1;
    });
    pharmacies.forEach(id => pharmacyIds.add(id));
  });

  const medicinesSearched = medicineIds.size;
  const pharmaciesViewed = pharmacyIds.size;

  // Top 5 most-searched medicines for this customer (one count per search event
  // that surfaced the medicine, not per pharmacy row) — powers the pie chart.
  const topSearchedMedicines = Object.entries(medicineCounts)
    .map(([id, count]) => ({ name: medicineNames.get(Number(id)) || `Medicine #${id}`, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 10);

  // Potential savings: for completed reservations, compare what was paid against
  // the average price of that same medicine across all pharmacies right now.
  const savingsRows = db.prepare(`
    SELECT r.quantity, i.price AS paid_price, i.medicine_id
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    WHERE r.customer_id = ? AND r.status = 'completed'
  `).all(uid);
  let potentialSavings = 0;
  if (savingsRows.length) {
    const avgPriceStmt = db.prepare(`SELECT AVG(price) AS avg_price FROM inventory WHERE medicine_id = ?`);
    savingsRows.forEach(r => {
      const avg = avgPriceStmt.get(r.medicine_id).avg_price || r.paid_price;
      const diff = (avg - r.paid_price) * r.quantity;
      if (diff > 0) potentialSavings += diff;
    });
  }

  res.json({
    user: req.session.user,
    recentReservations,
    statusCounts,
    topRatedPharmacies,
    unreadNotifications: unreadNotifications.count,
    searchActivity: {
      searchesMade,
      medicinesSearched,
      pharmaciesViewed,
      potentialSavings: +potentialSavings.toFixed(2),
      topSearchedMedicines,
    },
  });
});

// GET /api/customer/medicines/search?q=&category=
router.get('/medicines/search', (req, res) => {
  const q = `%${(req.query.q || '').trim()}%`;
  const category = (req.query.category || '').trim();

  let sql = `
    SELECT i.id AS inventory_id, i.price, i.stock_quantity, i.low_stock_threshold, i.brand,
           m.id AS medicine_id, m.name AS medicine_name, m.category,
           p.id AS pharmacy_id, p.name AS pharmacy_name, p.address, p.latitude, p.longitude,
           COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) AS verification_status,
           p.verified,
           p.store_image, p.profile_image, p.cover_image, p.description, p.hours,
           CASE WHEN EXISTS (
             SELECT 1 FROM inventory available
             WHERE available.pharmacy_id = p.id AND available.deployed = 1 AND available.stock_quantity > 0
           ) THEN 'Available' ELSE 'No stock currently available' END AS pharmacy_status,
           (SELECT ROUND(AVG(rating), 1) FROM pharmacy_ratings WHERE pharmacy_id = p.id) AS average_rating,
           (SELECT COUNT(*) FROM pharmacy_ratings WHERE pharmacy_id = p.id) AS rating_count
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED' AND m.name LIKE ? AND i.deployed = 1 AND i.stock_quantity > 0
  `;
  const params = [q];
  if (category) {
    sql += ' AND m.category = ?';
    params.push(category);
  }
  sql += ` ORDER BY (
    SELECT COUNT(*)
    FROM search_logs sl
    WHERE sl.user_id = ? AND INSTR(sl.medicine_ids, CAST(m.id AS TEXT)) > 0
  ) DESC, m.name ASC, i.price ASC`;
  const rows = db.prepare(sql).all(...params, req.session.user.id);
  const topMedicineIds = [...new Set(rows.map(r => r.medicine_id))].slice(0, 10);
  const visibleRows = rows.filter(r => topMedicineIds.includes(r.medicine_id));
  const shortageMedicineIds = [];

  const categories = db.prepare('SELECT DISTINCT category FROM medicines WHERE category IS NOT NULL').all().map(c => c.category);

  // Log this search as real activity — only when it actually looked for something,
  // so an empty initial page load doesn't get counted.
  const rawQuery = (req.query.q || '').trim();
  if (rawQuery || category) {
    const medicineIds = [...new Set(visibleRows.map(r => r.medicine_id))];
    const pharmacyIds = [...new Set(visibleRows.map(r => r.pharmacy_id))];
    db.prepare(`
      INSERT INTO search_logs (user_id, query, category, medicine_ids, pharmacy_ids, result_count)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.session.user.id, rawQuery || null, category || null,
      JSON.stringify(medicineIds), JSON.stringify(pharmacyIds), visibleRows.length
    );
  }

  res.json({ results: visibleRows, shortageMedicineIds, categories });
});

// GET /api/customer/pharmacies/nearby?lat=&lng=
router.get('/pharmacies/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const pharmacies = db.prepare(`
    SELECT p.id, p.name, p.address, p.latitude, p.longitude, p.phone,
      COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) AS verification_status,
      p.verified,
      p.store_image, p.profile_image, p.cover_image, p.description, p.hours,
      ROUND(AVG(r.rating), 1) AS average_rating, COUNT(r.id) AS rating_count
    FROM pharmacies p LEFT JOIN pharmacy_ratings r ON r.pharmacy_id = p.id
    WHERE COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    GROUP BY p.id
  `).all();

  const withDistance = pharmacies.map(p => ({
    ...p,
    distance_km: (isFinite(lat) && isFinite(lng)) ? +distanceKm(lat, lng, p.latitude, p.longitude).toFixed(2) : null,
  }));

  if (isFinite(lat) && isFinite(lng)) {
    withDistance.sort((a, b) => a.distance_km - b.distance_km);
  }

  res.json({ pharmacies: withDistance, hasUserLocation: isFinite(lat) && isFinite(lng) });
});

// GET /api/customer/pharmacies/:id — full pharmacy profile + its currently deployed products.
// "Currently selling" always reflects live folder deployments, never draft/archived items.
router.get('/pharmacies/:id', (req, res) => {
  const pharmacy = db.prepare(`
    SELECT p.id, p.name, p.address, p.latitude, p.longitude, p.phone, p.business_email,
      COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) AS verification_status,
      p.verified,
      p.store_image, p.profile_image, p.cover_image, p.description, p.hours,
      ROUND(AVG(r.rating), 1) AS average_rating, COUNT(r.id) AS rating_count
    FROM pharmacies p LEFT JOIN pharmacy_ratings r ON r.pharmacy_id = p.id
    WHERE p.id = ? GROUP BY p.id
  `).get(req.params.id);
  if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found.' });

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const distance_km = (isFinite(lat) && isFinite(lng))
    ? +distanceKm(lat, lng, pharmacy.latitude, pharmacy.longitude).toFixed(2)
    : null;

  const products = db.prepare(`
    SELECT i.id AS inventory_id, i.price, i.stock_quantity, i.brand,
           m.id AS medicine_id, m.name AS medicine_name, m.category
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND i.deployed = 1
    ORDER BY m.name ASC
  `).all(pharmacy.id);

  const reviews = db.prepare(`
    SELECT r.rating, r.comment, r.created_at, r.updated_at,
      COALESCE(NULLIF(u.username, ''), 'customer-' || u.id) AS customer_username,
      COALESCE(NULLIF(u.username, ''), 'Customer') AS customer_name
    FROM pharmacy_ratings r JOIN users u ON u.id = r.customer_id
    WHERE r.pharmacy_id = ? ORDER BY r.updated_at DESC
  `).all(pharmacy.id);
  const myRating = db.prepare(`
    SELECT rating, comment FROM pharmacy_ratings WHERE pharmacy_id = ? AND customer_id = ?
  `).get(pharmacy.id, req.session.user.id) || null;
  const canRate = true;

  res.json({ pharmacy: { ...pharmacy, distance_km }, products, reviews, myRating, canRate });
});

// GET /api/customer/reservations
router.get('/reservations', (req, res) => {
  const rows = db.prepare(`
        SELECT r.*, m.name AS medicine_name, p.name AS pharmacy_name, p.id AS pharmacy_id,
          COALESCE(r.price_at_reservation, i.price) AS price,
          (SELECT rating FROM pharmacy_ratings WHERE pharmacy_id = p.id AND customer_id = r.customer_id) AS customer_rating
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE r.customer_id = ?
    ORDER BY r.reserved_at DESC
  `).all(req.session.user.id);
  res.json({ reservations: rows });
});

// POST /api/customer/reservations  { inventory_id, quantity }
router.post('/reservations', (req, res) => {
  const { inventory_id, quantity } = req.body;
  const qty = parseInt(quantity, 10);
  if (!inventory_id || !qty || qty < 1) {
    return res.status(422).json({ error: 'inventory_id and a valid quantity are required.' });
  }

  const inv = db.prepare('SELECT * FROM inventory WHERE id = ?').get(inventory_id);
  if (!inv) return res.status(404).json({ error: 'Inventory item not found.' });
  if (!inv.deployed) return res.status(422).json({ error: 'This item is not currently available for reservation.' });

  const tx = db.transaction(() => {
    const currentInventory = db.prepare('SELECT * FROM inventory WHERE id = ?').get(inv.id);
    if (!currentInventory || !currentInventory.deployed) {
      return { error: 'This item is not currently available for reservation.', status: 422 };
    }
    const reservedNow = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS reserved
      FROM reservations
      WHERE inventory_id = ? AND status IN ('pending','confirmed')
    `).get(currentInventory.id).reserved;
    if (currentInventory.stock_quantity - reservedNow < qty) {
      return { error: 'Not enough available stock for this reservation.', status: 422 };
    }

    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24).toISOString();
    const reservation = db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, price_at_reservation, status, expires_at)
      VALUES (?, ?, ?, ?, 'pending', ?)
    `).run(req.session.user.id, currentInventory.id, qty, currentInventory.price, expires);

    const medicine = db.prepare('SELECT name FROM medicines WHERE id = ?').get(currentInventory.medicine_id);
    db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?,?,?,?)`).run(
      req.session.user.id, 'Reservation placed',
      `Your reservation for ${medicine.name} (x${qty}) is pending pharmacy confirmation.`, 'reservation'
    );
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      SELECT id, 'New reservation request', ?, 'reservation'
      FROM users WHERE pharmacy_id = ? AND role = 'pharmacy_staff'
    `).run(
      `A new reservation request for ${medicine.name} (x${qty}) was placed by ${req.session.user.name}.`,
      currentInventory.pharmacy_id
    );
    return { reservation_id: Number(reservation.lastInsertRowid) };
  });

  const result = tx.immediate();
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.status(201).json(result);
});

// POST /api/customer/reservations/:id/cancel
router.post('/reservations/:id/cancel', (req, res) => {
  const reservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
  if (reservation.customer_id !== req.session.user.id) {
    return res.status(403).json({ error: 'You can only cancel your own reservations.' });
  }
  if (!['pending', 'confirmed'].includes(reservation.status)) {
    return res.status(422).json({ error: 'Only pending or confirmed reservations can be cancelled.' });
  }

  const tx = db.transaction(() => {
    const cancelled = db.prepare(`
      UPDATE reservations SET status = 'cancelled'
      WHERE id = ? AND status IN ('pending','confirmed')
    `).run(reservation.id);
    if (!cancelled.changes) return false;
    db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      SELECT id, 'Reservation cancelled by customer', ?, 'reservation'
      FROM users WHERE pharmacy_id = (
        SELECT pharmacy_id FROM inventory WHERE id = ?
      ) AND role = 'pharmacy_staff'
    `).run(
      `Reservation #${reservation.id} was cancelled by ${req.session.user.name}; the reserved units are available again.`,
      reservation.inventory_id
    );
    return true;
  });
  if (!tx.immediate()) return res.status(422).json({ error: 'Only pending or confirmed reservations can be cancelled.' });

  res.json({ ok: true });
});

router.post('/pharmacies/:id/rating', (req, res) => {
  const pharmacyId = Number(req.params.id);
  const rating = Number(req.body.rating);
  const comment = typeof req.body.comment === 'string' ? req.body.comment.trim() : '';
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return res.status(422).json({ error: 'Rating must be between 1 and 5.' });
  }
  if (!comment) {
    return res.status(422).json({ error: 'Please write a comment about your experience.' });
  }
  if (comment.length > 200) {
    return res.status(422).json({ error: 'Review comments must be 200 characters or fewer.' });
  }
  if (!db.prepare('SELECT id FROM pharmacies WHERE id = ?').get(pharmacyId)) {
    return res.status(404).json({ error: 'Pharmacy not found.' });
  }
  db.prepare(`
    INSERT INTO pharmacy_ratings (pharmacy_id, customer_id, rating, comment)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(pharmacy_id, customer_id) DO UPDATE SET
      rating = excluded.rating, comment = excluded.comment, updated_at = CURRENT_TIMESTAMP
  `).run(pharmacyId, req.session.user.id, rating, comment || null);
  res.json({ ok: true });
});

router.delete('/pharmacies/:id/rating', (req, res) => {
  const pharmacyId = Number(req.params.id);
  const result = db.prepare(`
    DELETE FROM pharmacy_ratings WHERE pharmacy_id = ? AND customer_id = ?
  `).run(pharmacyId, req.session.user.id);
  if (!result.changes) return res.status(404).json({ error: 'Your review was not found.' });
  res.json({ ok: true });
});

// GET /api/customer/notifications
router.get('/notifications', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.json({ notifications: rows });
});

// POST /api/customer/notifications/:id/read
router.post('/notifications/:id/read', (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!n || n.user_id !== req.session.user.id) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

module.exports = router;
