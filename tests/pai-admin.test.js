const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const { generateAdminReport, getAdminInsights } = require('../services/pai/insights');

test('admin insights and report explain real demand, availability, participation, anomalies, and pricing', () => {
  const rollback = new Error('rollback P.A.I. admin insight fixtures');
  const run = db.transaction(() => {
    const customer = db.prepare("SELECT id FROM users WHERE role = 'customer' LIMIT 1").get();
    assert.ok(customer, 'seed data should include a customer for search and reservation fixtures');
    const pharmacyIds = ['P.A.I. admin insight pharmacy', 'P.A.I. admin peer pharmacy 1', 'P.A.I. admin peer pharmacy 2', 'P.A.I. admin inactive pharmacy']
      .map(name => Number(db.prepare(`
        INSERT INTO pharmacies (name, address, latitude, longitude, verified, verification_status, created_at)
        VALUES (?, 'Test address', 1, 1, 1, 'VERIFIED', datetime('now', '-90 days'))
      `).run(name).lastInsertRowid));
    const [pharmacyId, peerOneId, peerTwoId, inactivePharmacyId] = pharmacyIds;
    const medicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category, description)
      VALUES ('P.A.I. Admin Insight Fixture Medicine', 'Test', 'Test fixture')
    `).run().lastInsertRowid);
    const inventoryIds = [
      Number(db.prepare(`
        INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed, updated_at)
        VALUES (?, ?, 100, 40, 5, 1, datetime('now'))
      `).run(pharmacyId, medicineId).lastInsertRowid),
    ];
    const priceMedicineId = Number(db.prepare(`
      INSERT INTO medicines (name, category, description)
      VALUES ('P.A.I. Admin Price Fixture Medicine', 'Test', 'Test fixture')
    `).run().lastInsertRowid);
    const priceInventoryIds = [
      [pharmacyId, 100],
      [peerOneId, 10],
      [peerTwoId, 11],
    ].map(([peerPharmacyId, price]) => Number(db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed, updated_at)
      VALUES (?, ?, ?, 30, 5, 1, datetime('now'))
    `).run(peerPharmacyId, priceMedicineId, price).lastInsertRowid));

    for (let index = 0; index < 5; index += 1) {
      db.prepare(`
        INSERT INTO search_logs (user_id, query, medicine_ids, pharmacy_ids, result_count, searched_at)
        VALUES (?, 'fixture previous search', ?, ?, 1, datetime('now', '-10 days'))
      `).run(customer.id, JSON.stringify([medicineId]), JSON.stringify([pharmacyId]));
    }
    for (let index = 0; index < 20; index += 1) {
      db.prepare(`
        INSERT INTO search_logs (user_id, query, medicine_ids, pharmacy_ids, result_count, searched_at)
        VALUES (?, 'fixture recent search', ?, ?, 1, datetime('now', '-1 days'))
      `).run(customer.id, JSON.stringify([medicineId]), JSON.stringify([pharmacyId]));
    }

    for (let index = 0; index < 5; index += 1) {
      db.prepare(`
        INSERT INTO reservations (customer_id, inventory_id, quantity, status, reserved_at)
        VALUES (?, ?, 1, 'completed', datetime('now', '-10 days'))
      `).run(customer.id, inventoryIds[0]);
    }
    for (let index = 0; index < 15; index += 1) {
      db.prepare(`
        INSERT INTO reservations (customer_id, inventory_id, quantity, status, reserved_at)
        VALUES (?, ?, 1, 'confirmed', datetime('now', '-1 days'))
      `).run(customer.id, inventoryIds[0]);
    }

    for (const daysAgo of [3, 4, 5]) {
      db.prepare(`
        INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, transaction_type, quantity, created_at)
        VALUES (?, ?, ?, 'stock_in', 1, datetime('now', ?))
      `).run(pharmacyId, medicineId, inventoryIds[0], `-${daysAgo} days`);
    }
    for (let index = 0; index < 4; index += 1) {
      db.prepare(`
        INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, transaction_type, quantity, created_at)
        VALUES (?, ?, ?, 'stock_in', 1, datetime('now', '-1 days'))
      `).run(pharmacyId, medicineId, inventoryIds[0]);
    }

    const insights = getAdminInsights();
    const gap = insights.demand_supply_gaps.find(item => item.medicine_name === 'P.A.I. Admin Insight Fixture Medicine');
    assert.ok(gap, 'high-search medicine with one available pharmacy should be flagged as limited PillPoint availability');
    assert.equal(gap.available_pharmacies, 1);
    assert.equal(gap.available_units, 40, 'reservation rows must not multiply current inventory stock');
    assert.equal(gap.reservation_units_30_days, 20, 'reservation totals are independently aggregated');
    assert.match(gap.insight, /within PillPoint/);
    assert.match(gap.reason, /threshold/);

    const priceAnomaly = insights.price_anomalies.find(item => item.medicine_name === 'P.A.I. Admin Price Fixture Medicine'
      && item.pharmacy_id === pharmacyId);
    assert.ok(priceAnomaly);
    assert.match(priceAnomaly.evidence, /median/);
    assert.match(priceAnomaly.recommendation, /not presume misconduct/);

    assert.ok(insights.anomalies.some(item => item.type === 'medicine_search_spike'
      && item.subject === 'P.A.I. Admin Insight Fixture Medicine'));
    assert.ok(insights.anomalies.some(item => item.type === 'reservation_activity_spike'));
    assert.ok(insights.anomalies.some(item => item.type === 'inventory_activity_spike'));
    assert.ok(insights.system_insights.every(item => item.evidence && item.reason && item.recommendation));

    const participation = insights.pharmacy_participation.pharmacies.find(item => item.pharmacy_id === pharmacyId);
    assert.ok(participation);
    assert.ok(participation.stale_inventory === false);
    assert.ok(participation.evidence && participation.reason && participation.recommendation);
    const inactiveParticipation = insights.pharmacy_participation.pharmacies.find(item => item.pharmacy_id === inactivePharmacyId);
    assert.ok(inactiveParticipation);
    assert.equal(inactiveParticipation.inactive, true);
    assert.equal(inactiveParticipation.stale_inventory, true);

    const report = generateAdminReport();
    assert.equal(report.title, 'PILLPOINT SYSTEM SUMMARY');
    assert.ok(report.reporting_period);
    assert.ok(report.sections.customer_activity.evidence);
    assert.ok(report.sections.medicine_demand.evidence);
    assert.ok(report.sections.medicine_availability.evidence);
    assert.ok(report.sections.pharmacy_participation.evidence);
    assert.ok(report.sections.reservation_activity.evidence);
    assert.ok(report.sections.inventory_observations.evidence);
    assert.ok(report.sections.price_observations.evidence);
    assert.ok(report.sections.important_system_insights.length);
    assert.ok(report.sections.recommended_administrative_actions.every(item => item.evidence && item.reason));
    assert.match(report.disclaimer, /not confirmed regional shortages/);

    throw rollback;
  });
  assert.throws(() => run(), error => error === rollback);
});

test('admin insights and reports return a valid empty-data shape', () => {
  const insights = getAdminInsights();
  assert.ok(Array.isArray(insights.system_insights));
  assert.ok(Array.isArray(insights.demand_supply_gaps));
  assert.ok(Array.isArray(insights.anomalies));
  assert.ok(Array.isArray(insights.price_anomalies));
  const report = generateAdminReport();
  assert.ok(report.sections.customer_activity);
  assert.ok(report.sections.important_system_insights);
  assert.ok(report.sections.recommended_administrative_actions);
});
