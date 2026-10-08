const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const { getInventoryInsights } = require('../services/pai/inventory');

test('pharmacy insights use scoped inventory, reservations, batches, peer prices, and search activity', () => {
  const rollback = new Error('rollback P.A.I. pharmacy insight fixtures');
  const run = db.transaction(() => {
    const customer = db.prepare("SELECT id FROM users WHERE role = 'customer' LIMIT 1").get();
    assert.ok(customer, 'seed data should include a customer for reservation fixtures');

    const pharmacyIds = ['P.A.I. insight pharmacy', 'P.A.I. peer pharmacy 1', 'P.A.I. peer pharmacy 2', 'P.A.I. peer pharmacy 3']
      .map(name => Number(db.prepare(`
        INSERT INTO pharmacies (name, address, latitude, longitude, verified, verification_status)
        VALUES (?, 'Test address', 1, 1, 1, 'VERIFIED')
      `).run(name).lastInsertRowid));
    const [pharmacyId, ...peerIds] = pharmacyIds;
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category, description)
      VALUES ('P.A.I. Pharmacy Insight Test Medicine', 'Test', 'Test fixture')
    `).run().lastInsertRowid);
    const inventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 12, 4, 5, 1)
    `).run(pharmacyId, medicineId).lastInsertRowid);

    peerIds.forEach((peerId, index) => db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, ?, 20, 5, 1)
    `).run(peerId, medicineId, [4, 5, 6][index]));

    db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number,
        expiration_date, quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'PAI-INSIGHT-BATCH', date('now', '+5 days'), 25, 25, 'active')
    `).run(pharmacyId, medicineId, inventoryId);
    db.prepare(`
      INSERT INTO reservations (customer_id, inventory_id, quantity, status, reserved_at)
      VALUES (?, ?, 6, 'completed', datetime('now', '-2 days')),
        (?, ?, 4, 'confirmed', datetime('now', '-1 days')),
        (?, ?, 4, 'completed', datetime('now', '-10 days'))
    `).run(customer.id, inventoryId, customer.id, inventoryId, customer.id, inventoryId);
    db.prepare(`
      INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, transaction_type, quantity)
      VALUES (?, ?, ?, 'stock_out', 14)
    `).run(pharmacyId, medicineId, inventoryId);
    db.prepare(`
      INSERT INTO search_logs (user_id, query, medicine_ids, pharmacy_ids, result_count)
      VALUES (?, 'P.A.I. insight fixture', ?, ?, 1)
    `).run(customer.id, JSON.stringify([medicineId]), JSON.stringify([pharmacyId]));
    db.prepare(`
      INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, transaction_type, quantity)
      VALUES (?, ?, ?, 'stock_in', 25)
    `).run(pharmacyId, medicineId, inventoryId);

    const emptyStockMedicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category, description)
      VALUES ('P.A.I. Empty Stock Fixture', 'Test', 'Test fixture')
    `).run().lastInsertRowid);
    const emptyStockInventoryId = Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 10, 0, 5, 1)
    `).run(pharmacyId, emptyStockMedicineId).lastInsertRowid);
    db.prepare(`
      INSERT INTO medicine_batches (
        pharmacy_id, medicine_id, inventory_id, batch_number,
        expiration_date, quantity_received, current_quantity, status
      ) VALUES (?, ?, ?, 'PAI-MISSING-EXPIRY', NULL, 1, 1, 'active')
    `).run(pharmacyId, emptyStockMedicineId, emptyStockInventoryId);

    const result = getInventoryInsights(pharmacyId);
    const stockRisk = result.stock_risk.items.find(item => item.inventory_id === inventoryId);
    assert.equal(stockRisk.severity, 'HIGH');
    assert.match(stockRisk.reason, /2\.0 days of supply/);
    assert.equal(result.stock_risk.items.find(item => item.inventory_id === emptyStockInventoryId).severity, 'CRITICAL');

    const demand = result.demand_analysis.items.find(item => item.medicine_name === 'P.A.I. Pharmacy Insight Test Medicine');
    assert.equal(demand.trend, 'UNUSUALLY_HIGH');
    assert.equal(demand.recent_reservation_units, 10);
    assert.equal(demand.recent_stock_out_units, 14);
    assert.equal(demand.previous_reservation_units, 4);
    assert.equal(demand.recent_searches, 1);
    assert.deepEqual(result.top_searched[0], {
      medicine_id: medicineId,
      medicine_name: 'P.A.I. Pharmacy Insight Test Medicine',
      search_count: 1,
    });
    assert.equal(result.demand_analysis.restock_recommendations[0].medicine_name, 'P.A.I. Pharmacy Insight Test Medicine');

    const expiry = result.expiry_risk.items.find(item => item.batch_number === 'PAI-INSIGHT-BATCH');
    assert.ok(expiry);
    assert.equal(expiry.severity, 'HIGH');
    assert.match(expiry.recommendation, /does not adjust or remove inventory/);

    const price = result.price_analysis.items.find(item => item.inventory_id === inventoryId);
    assert.ok(price);
    assert.equal(price.peer_median_price, 5);
    assert.equal(price.peer_listing_count, 3, JSON.stringify(price));
    assert.match(price.recommendation, /never changes pharmacy prices/);

    assert.ok(result.data_quality.issues.some(issue => issue.inventory_id === emptyStockInventoryId
      && issue.issue === 'Published listing has no stock'));
    assert.ok(result.data_quality.issues.some(issue => issue.inventory_id === inventoryId
      && issue.issue === 'Inventory and batch quantities differ'));
    assert.ok(result.data_quality.issues.some(issue => issue.batch_id
      && issue.issue === 'Active batch has no expiration date'));

    assert.equal(result.performance_summary.reservation_count, 2);
    assert.equal(result.performance_summary.reservation_units, 10);
    assert.equal(result.performance_summary.pharmacy_matched_searches, 1);
    assert.equal(result.performance_summary.stock_movements_30_days, 2);
    assert.equal(result.performance_summary.top_reserved_medicines[0].medicine_name, 'P.A.I. Pharmacy Insight Test Medicine');

    throw rollback;
  });

  assert.throws(() => run(), error => error === rollback);
});

test('pharmacy insights are scoped to the requested pharmacy', () => {
  const pharmacyId = db.prepare(`
    SELECT pharmacy_id FROM users WHERE role = 'pharmacy_staff' AND pharmacy_id IS NOT NULL LIMIT 1
  `).get()?.pharmacy_id;
  assert.ok(pharmacyId, 'seed data should include a pharmacy staff account');

  const result = getInventoryInsights(pharmacyId);
  assert.ok(result.stock_risk);
  assert.ok(result.demand_analysis);
  assert.ok(result.expiry_risk);
  assert.ok(result.price_analysis);
  assert.ok(result.data_quality);
  assert.ok(result.performance_summary);
});
