const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db/database');
const { requireAuth } = require('../middleware');
const router = express.Router();

const EIGHT_HOURS = 1000 * 60 * 60 * 8;
const THIRTY_DAYS = 1000 * 60 * 60 * 24 * 30;

// POST /api/auth/register
// Self-registration is intentionally restricted to 'customer' and 'pharmacy_staff'.
// There is no code path here that can create an 'admin' account — admins are
// provisioned only via the seeded database account.
router.post('/register', (req, res) => {
  const { username, phone, email, password } = req.body;
  const role = req.body.role === 'pharmacy_staff' ? 'pharmacy_staff' : 'customer';
  const accountName = role === 'pharmacy_staff'
    ? `pharmacy-${(email || '').trim().toLowerCase()}`
    : (username || '').trim();

  if ((!accountName && role === 'customer') || !phone || !email || !password) {
    const requiredFields = role === 'pharmacy_staff'
      ? 'Mobile number, email and password are required.'
      : 'Username, mobile number, email and password are required.';
    return res.status(422).json({ error: requiredFields });
  }
  if (!/^\+639\d{9}$/.test(phone.trim())) {
    return res.status(422).json({ error: 'Enter a Philippine mobile number in +639XXXXXXXXX format.' });
  }
  if (password.length < 6) {
    return res.status(422).json({ error: 'Password must be at least 6 characters.' });
  }
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) {
    return res.status(422).json({ error: 'An account with that email already exists.' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(accountName)) {
    return res.status(422).json({ error: 'That username is already taken.' });
  }

  const hash = bcrypt.hashSync(password, 10);

  if (role === 'pharmacy_staff') {
    const { pharmacy_name, pharmacy_address, owner_first_name, owner_last_name, business_permit, latitude, longitude, description, hours } = req.body;
    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    if (!pharmacy_name || !pharmacy_address || !owner_first_name || !owner_last_name || !business_permit) {
      return res.status(422).json({ error: 'Pharmacy name, address, owner name and business permit are required.' });
    }
    if (!isFinite(lat) || !isFinite(lng)) {
      return res.status(422).json({ error: 'Please set your pharmacy location on the map.' });
    }
    if (!/^data:(application\/pdf|image\/(png|jpe?g|webp));base64,/.test(business_permit)) {
      return res.status(422).json({ error: 'Business permit must be a PDF, PNG, JPG, or WEBP file.' });
    }

    const tx = db.transaction(() => {
      const pharmacyInfo = db.prepare(`
        INSERT INTO pharmacies (name, address, latitude, longitude, phone, business_email, owner_first_name, owner_last_name, business_permit, verified, description, hours)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(pharmacy_name.trim(), pharmacy_address.trim(), lat, lng, phone.trim(), email.trim(), owner_first_name.trim(), owner_last_name.trim(), business_permit, (description || '').trim() || null, (hours || '').trim() || null);

      const userInfo = db.prepare(`
        INSERT INTO users (name, username, phone, email, password_hash, role, pharmacy_id) VALUES (?, ?, ?, ?, ?, 'pharmacy_staff', ?)
      `).run(pharmacy_name.trim(), accountName, phone.trim(), email, hash, pharmacyInfo.lastInsertRowid);

      db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?,?,?,?)`).run(
        userInfo.lastInsertRowid, 'Welcome to PillPoint',
        `${pharmacy_name} has been registered and is pending admin verification. You can manage inventory in the meantime.`,
        'info'
      );

      return userInfo.lastInsertRowid;
    });

    const userId = tx();
    const user = db.prepare('SELECT id, name, username, phone, profile_image, email, role, pharmacy_id FROM users WHERE id = ?').get(userId);
    req.session.user = user;
    return res.json({ user });
  }

  const info = db.prepare(
    `INSERT INTO users (name, username, phone, email, password_hash, role, pharmacy_id) VALUES (?, ?, ?, ?, ?, 'customer', NULL)`
  ).run(accountName, accountName, phone.trim(), email, hash);

  const user = db.prepare('SELECT id, name, username, phone, profile_image, email, role, pharmacy_id FROM users WHERE id = ?').get(info.lastInsertRowid);
  req.session.user = user;
  res.json({ user });
});

router.post('/login', (req, res) => {
  const { email, password, remember } = req.body;
  const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!row || !bcrypt.compareSync(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Invalid email or password.' });
  }
  const user = {
    id: row.id, name: row.role === 'pharmacy_staff' ? row.name : row.username || row.name, username: row.username || row.name,
    phone: row.phone, profile_image: row.profile_image,
    email: row.email, role: row.role, pharmacy_id: row.pharmacy_id,
  };
  req.session.user = user;
  // "Remember me" extends the session cookie from the default 8 hours to 30 days.
  req.session.cookie.maxAge = remember ? THIRTY_DAYS : EIGHT_HOURS;
  res.json({ user });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

router.get('/me', (req, res) => {
  const user = req.session.user ? { ...req.session.user } : null;
  if (user && user.username && user.role !== 'pharmacy_staff') user.name = user.username;
  if (user?.role === 'pharmacy_staff') {
    const pharmacy = db.prepare('SELECT name, profile_image FROM pharmacies WHERE id = ?').get(user.pharmacy_id);
    if (pharmacy) {
      user.name = pharmacy.name;
      user.pharmacy_name = pharmacy.name;
      user.pharmacy_profile_image = pharmacy.profile_image;
    }
  }
  res.json({ user });
});

// PUT /api/auth/profile — update this account's username, mobile, and profile photo.
router.put('/profile', requireAuth, (req, res) => {
  const username = (req.body.username || '').trim();
  const phone = (req.body.phone || '').trim();
  const profileImage = req.body.profile_image;
  if (!username) {
    return res.status(422).json({ error: 'Username is required.' });
  }
  if (phone && !/^\+639\d{9}$/.test(phone)) {
    return res.status(422).json({ error: 'Enter a Philippine mobile number in +639XXXXXXXXX format.' });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ? AND id <> ?').get(username, req.session.user.id)) {
    return res.status(422).json({ error: 'That username is already taken.' });
  }
  if (profileImage && !/^data:image\/(png|jpe?g|webp);base64,/.test(profileImage)) {
    return res.status(422).json({ error: 'Profile picture must be a PNG, JPG, or WEBP image.' });
  }
  const displayName = req.session.user.role === 'pharmacy_staff' ? req.session.user.name : username;
  db.prepare('UPDATE users SET name = ?, username = ?, phone = ?, profile_image = ? WHERE id = ?').run(
    displayName, username, phone || null, profileImage || null, req.session.user.id
  );
  req.session.user.name = displayName;
  req.session.user.username = username;
  req.session.user.phone = phone || null;
  req.session.user.profile_image = profileImage || null;
  res.json({ user: req.session.user });
});

module.exports = router;
