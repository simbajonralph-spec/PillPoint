// Shared notification endpoints — every authenticated role (customer, pharmacy_staff, admin)
// only ever sees/marks their own notifications (scoped by user_id from the session).
const express = require('express');
const db = require('../db/database');
const { requireAuth } = require('../middleware');
const router = express.Router();

router.use(requireAuth);

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC').all(req.session.user.id);
  res.json({ notifications: rows });
});

router.post('/:id/read', (req, res) => {
  const n = db.prepare('SELECT * FROM notifications WHERE id = ?').get(req.params.id);
  if (!n || n.user_id !== req.session.user.id) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').run(n.id);
  res.json({ ok: true });
});

router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(req.session.user.id);
  res.json({ ok: true });
});

module.exports = router;
