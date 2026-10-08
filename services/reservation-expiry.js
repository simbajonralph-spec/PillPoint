function expirePendingReservations(db) {
  const tx = db.transaction(() => {
    const overdue = db.prepare(`
      SELECT r.id, r.customer_id, r.inventory_id, r.quantity,
        r.status, m.name AS medicine_name, i.pharmacy_id, i.stock_quantity,
        i.medicine_id, u.name AS customer_name
      FROM reservations r
      JOIN inventory i ON i.id = r.inventory_id
      JOIN medicines m ON m.id = i.medicine_id
      JOIN users u ON u.id = r.customer_id
      WHERE r.status IN ('pending','confirmed','ready_for_pickup')
        AND COALESCE(
          datetime(r.expires_at),
          datetime(r.reserved_at, CASE WHEN r.status = 'pending' THEN '+24 hours' ELSE '+48 hours' END)
        ) <= datetime('now')
    `).all();
    const markExpired = db.prepare(`
      UPDATE reservations SET status = 'expired'
      WHERE id = ? AND status = ?
        AND status IN ('pending','confirmed','ready_for_pickup')
        AND COALESCE(
          datetime(expires_at),
          datetime(reserved_at, CASE WHEN status = 'pending' THEN '+24 hours' ELSE '+48 hours' END)
        ) <= datetime('now')
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
      if (!markExpired.run(reservation.id, reservation.status).changes) continue;
      db.prepare(`INSERT INTO stock_transactions (
        pharmacy_id, medicine_id, inventory_id, transaction_type, quantity,
        previous_quantity, new_quantity, reason, reference_number, remarks
      ) VALUES (?, ?, ?, 'reservation_cancellation', ?, ?, ?, 'reservation_expired', ?, ?)
      `).run(
        reservation.pharmacy_id, reservation.medicine_id, reservation.inventory_id,
        reservation.quantity, reservation.stock_quantity, reservation.stock_quantity,
        `RES-${reservation.id}`, `Released ${reservation.quantity} reserved units after reservation expiry; physical stock unchanged.`
      );
      db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, entity_type, entity_id, action, details)
        VALUES (?, 'inventory', ?, 'reservation_expired', ?)
      `).run(
        reservation.pharmacy_id, reservation.inventory_id,
        `Reservation #${reservation.id} expired and released ${reservation.quantity} units; physical stock unchanged.`
      );
      const expiryReason = reservation.status === 'pending'
        ? 'expired because the pharmacy did not confirm it within 24 hours'
        : 'expired because it was not picked up before the deadline';
      notifyCustomer.run(
        reservation.customer_id,
        `Reservation #${reservation.id} for ${reservation.medicine_name} ${expiryReason}.`
      );
      notifyPharmacy.run(
        `Reservation #${reservation.id} for ${reservation.medicine_name} from ${reservation.customer_name} ${expiryReason}.`,
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
