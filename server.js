const express = require('express');
const session = require('express-session');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const authRoutes = require('./routes/auth');
const customerRoutes = require('./routes/customer');
const pharmacyRoutes = require('./routes/pharmacy');
const adminRoutes = require('./routes/admin');
const notificationRoutes = require('./routes/notifications');
const publicRoutes = require('./routes/public');
const paiRoutes = require('./routes/pai');
const db = require('./db/database');
const { startReservationExpiryMonitor } = require('./services/reservation-expiry');

const app = express();
const PORT = process.env.PORT || 3000;

startReservationExpiryMonitor(db);

app.use(express.json({ limit: '12mb' })); // supports store photos and business-permit uploads
app.use(session({
  secret: 'pillpoint-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 } // 8 hours
}));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

app.use('/api/auth', authRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/customer', customerRoutes);
app.use('/api/pharmacy', pharmacyRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/pai', paiRoutes);

app.use(express.static(path.join(__dirname, 'public')));

// Last-resort error handler: API clients (including the P.A.I. widget) expect
// JSON, so never leak Express's default HTML error page on /api routes.
app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = Number(err && (err.status || err.statusCode)) || 500;
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be valid JSON.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large.' });
  }
  if (status >= 500) {
    console.error(`Unhandled API error on ${req.method} ${req.originalUrl}:`, err && err.stack ? err.stack : err);
    return res.status(status).json({ error: 'Something went wrong on the server. Please try again.' });
  }
  console.error(`API request failed on ${req.method} ${req.originalUrl} (status ${status}):`, err && err.message);
  return res.status(status).json({ error: (err && err.message) || 'Request failed.' });
});

app.listen(PORT, () => {
  console.log(`\nPillPoint is running: http://localhost:${PORT}\n`);
});
