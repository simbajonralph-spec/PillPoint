const express = require('express');
const db = require('../db/database');
const router = express.Router();

function distanceKm(lat1, lon1, lat2, lon2) {
  const radius = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get('/pharmacies/:id', (req, res) => {
  const pharmacy = db.prepare(`
    SELECT p.id, p.name, p.address, p.latitude, p.longitude, p.phone, p.business_email,
      p.verified, p.store_image, p.profile_image, p.cover_image, p.description, p.hours, p.created_at,
      ROUND(AVG(r.rating), 1) AS average_rating, COUNT(r.id) AS rating_count
    FROM pharmacies p LEFT JOIN pharmacy_ratings r ON r.pharmacy_id = p.id
    WHERE p.id = ? GROUP BY p.id
  `).get(req.params.id);
  if (!pharmacy) return res.status(404).json({ error: 'Pharmacy not found.' });

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const distance_km = Number.isFinite(lat) && Number.isFinite(lng)
    ? +distanceKm(lat, lng, pharmacy.latitude, pharmacy.longitude).toFixed(2)
    : null;
  const products = db.prepare(`
    SELECT i.id AS inventory_id, i.price, i.stock_quantity, i.brand,
      m.id AS medicine_id, m.name AS medicine_name, m.category
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND i.deployed = 1 ORDER BY m.name ASC
  `).all(pharmacy.id);
  const viewerId = req.session.user?.role === 'customer' ? req.session.user.id : null;
  const reviews = db.prepare(`
    SELECT r.rating, r.comment, r.created_at, r.updated_at, u.profile_image,
      COALESCE(NULLIF(u.username, ''), 'customer-' || u.id) AS customer_username,
      COALESCE(NULLIF(u.username, ''), u.name, 'Customer') AS customer_name,
      CASE WHEN r.customer_id = ? THEN 1 ELSE 0 END AS is_mine
    FROM pharmacy_ratings r JOIN users u ON u.id = r.customer_id
    WHERE r.pharmacy_id = ? ORDER BY r.updated_at DESC
  `).all(viewerId || -1, pharmacy.id);
  const ratingDistribution = db.prepare(`
    SELECT rating, COUNT(*) AS count FROM pharmacy_ratings
    WHERE pharmacy_id = ? GROUP BY rating
  `).all(pharmacy.id);
  const counts = new Map(ratingDistribution.map(row => [row.rating, row.count]));
  const canRate = Boolean(viewerId);
  const myRating = viewerId
    ? db.prepare('SELECT rating, comment FROM pharmacy_ratings WHERE pharmacy_id = ? AND customer_id = ?').get(pharmacy.id, viewerId) || null
    : null;

  res.json({
    pharmacy: { ...pharmacy, distance_km },
    products,
    reviews,
    ratingDistribution: [5, 4, 3, 2, 1].map(rating => ({ rating, count: counts.get(rating) || 0 })),
    myRating,
    canRate,
  });
});

module.exports = router;
