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

app.listen(PORT, () => {
  console.log(`\nPillPoint is running: http://localhost:${PORT}\n`);
});
