function expirePendingReservations(db) {
  const tx = db.transaction(() => {
    const overdue = db.prepare(`
      SELECT r.id, r.customer_id, r.inventory_id, r.quantity,
        m.name AS medicine_name, i.pharmacy_id, u.name AS customer_name
      FROM reservations r
      JOIN inventory i ON i.id = r.inventory_id
      JOIN medicines m ON m.id = i.medicine_id
      JOIN users u ON u.id = r.customer_id
      WHERE r.status = 'pending'
        AND datetime(r.reserved_at) <= datetime('now', '-24 hours')
    `).all();
    const markExpired = db.prepare(`
      UPDATE reservations SET status = 'expired'
      WHERE id = ? AND status = 'pending'
        AND datetime(reserved_at) <= datetime('now', '-24 hours')
    `);
    const notifyCustomer = db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, 'Reservation expired', ?, 'reservation')
    `);
    const notifyPharmacy = db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      SELECT id, 'Reservation expired', ?, 'reservation'
      FROM users WHERE pharmacy_id = ? AND role = 'pharmacy_staff'
    `);

    let expiredCount = 0;
    for (const reservation of overdue) {
      if (!markExpired.run(reservation.id).changes) continue;
      notifyCustomer.run(
        reservation.customer_id,
        `Reservation #${reservation.id} for ${reservation.medicine_name} expired because the pharmacy did not confirm it within 24 hours.`
      );
      notifyPharmacy.run(
        `Reservation #${reservation.id} for ${reservation.medicine_name} from ${reservation.customer_name} expired without confirmation.`,
        reservation.pharmacy_id
      );
      expiredCount++;
    }
    return expiredCount;
  });

  return tx();
}

function startReservationExpiryMonitor(db) {
  const runCheck = () => {
    try {
      expirePendingReservations(db);
    } catch (error) {
      console.error('Unable to expire overdue reservations:', error);
    }
  };

  runCheck();
  const timer = setInterval(runCheck, 60 * 1000);
  timer.unref();
  return timer;
}

module.exports = { expirePendingReservations, startReservationExpiryMonitor };
