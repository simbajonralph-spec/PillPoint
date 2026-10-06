const db = require('../../db/database');

const REPORTING_DAYS = 30;
const COMPARISON_DAYS = 7;
const STALE_INVENTORY_DAYS = 30;
const PRICE_DEVIATION_PERCENT = 50;
const ANOMALY_MULTIPLIER = 3;

function parseIdList(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.map(Number).filter(Number.isInteger) : [];
  } catch (error) {
    return [];
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function periodRange(days) {
  const start = db.prepare("SELECT datetime('now', ?) AS value").get(`-${days} days`).value;
  return { start, end: new Date().toISOString() };
}

function getSearchActivity() {
  const rows = db.prepare(`
    SELECT medicine_ids, pharmacy_ids, searched_at
    FROM search_logs
    WHERE searched_at >= datetime('now', '-30 days')
    ORDER BY searched_at DESC
  `).all();
  const medicineCounts = new Map();
  const pharmacyActivity = new Map();
  const searchByWindow = { recent: 0, previous: 0 };
  const now = Date.now();
  const weekStart = now - COMPARISON_DAYS * 86400000;
  const previousStart = now - COMPARISON_DAYS * 2 * 86400000;

  rows.forEach((row) => {
    const timestamp = new Date(row.searched_at.replace(' ', 'T') + (row.searched_at.includes('Z') ? '' : 'Z')).getTime();
    if (timestamp >= weekStart) searchByWindow.recent += 1;
    else if (timestamp >= previousStart) searchByWindow.previous += 1;

    const pharmacyIds = new Set(parseIdList(row.pharmacy_ids));
    pharmacyIds.forEach((pharmacyId) => {
      if (!pharmacyActivity.has(pharmacyId)) pharmacyActivity.set(pharmacyId, { total: 0, recent: 0 });
      const activity = pharmacyActivity.get(pharmacyId);
      activity.total += 1;
      if (timestamp >= weekStart) activity.recent += 1;
    });

    new Set(parseIdList(row.medicine_ids)).forEach((medicineId) => {
      if (!medicineCounts.has(medicineId)) medicineCounts.set(medicineId, { total: 0, recent: 0 });
      const count = medicineCounts.get(medicineId);
      count.total += 1;
      if (timestamp >= weekStart) count.recent += 1;
    });
  });

  return { rows, medicineCounts, pharmacyActivity, searchByWindow };
}

function getTopSearched(medicineCounts) {
  const names = new Map(db.prepare('SELECT id, name FROM medicines').all().map(item => [Number(item.id), item.name]));
  return Array.from(medicineCounts.entries()).map(([medicineId, counts]) => ({
    medicine_id: medicineId,
    medicine_name: names.get(medicineId) || `Medicine #${medicineId}`,
    search_count: counts.total,
    recent_searches: counts.recent,
  })).sort((a, b) => b.search_count - a.search_count || a.medicine_name.localeCompare(b.medicine_name)).slice(0, 10);
}

function getMedicineDemand() {
  const { medicineCounts } = getSearchActivity();
  const demand = db.prepare(`
    WITH reservation_demand AS (
      SELECT i.medicine_id, SUM(r.quantity) AS reservation_units
      FROM reservations r
      JOIN inventory i ON i.id = r.inventory_id
      WHERE r.reserved_at >= datetime('now', '-30 days')
        AND r.status IN ('pending', 'confirmed', 'completed')
      GROUP BY i.medicine_id
    ),
    current_availability AS (
      SELECT i.medicine_id,
        COUNT(DISTINCT p.id) AS available_pharmacies,
        SUM(i.stock_quantity) AS available_units
      FROM inventory i
      JOIN pharmacies p ON p.id = i.pharmacy_id
      WHERE i.deployed = 1 AND i.stock_quantity > 0
        AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      GROUP BY i.medicine_id
    )
    SELECT m.id AS medicine_id, m.name AS medicine_name,
      COALESCE(rd.reservation_units, 0) AS reservation_units,
      COALESCE(ca.available_pharmacies, 0) AS available_pharmacies,
      COALESCE(ca.available_units, 0) AS available_units
    FROM medicines m
    LEFT JOIN reservation_demand rd ON rd.medicine_id = m.id
    LEFT JOIN current_availability ca ON ca.medicine_id = m.id
  `).all();
  return demand.map((item) => ({
    ...item,
    searches: Number(medicineCounts.get(Number(item.medicine_id))?.total || 0),
    reservation_units: Number(item.reservation_units),
    available_pharmacies: Number(item.available_pharmacies),
    available_units: Number(item.available_units),
  }));
}

function getDemandSupplyGaps(medicines) {
  const searchCounts = medicines.map(item => item.searches).filter(value => value > 0).sort((a, b) => a - b);
  const demandThreshold = searchCounts.length ? Math.max(5, median(searchCounts)) : 5;
  return medicines.filter(item => item.searches >= demandThreshold
    && item.available_pharmacies <= 2).map(item => ({
    medicine_id: item.medicine_id,
    medicine_name: item.medicine_name,
    searches_30_days: item.searches,
    reservation_units_30_days: item.reservation_units,
    available_pharmacies: item.available_pharmacies,
    available_units: item.available_units,
    insight: 'Customer interest is relatively high while availability is limited within PillPoint.',
    evidence: `${item.searches} search results included this medicine in the last ${REPORTING_DAYS} days; ${item.available_pharmacies} verified pharmacies currently have deployed in-stock listings (${item.available_units} units).`,
    reason: `Search activity met the selected-period high-interest threshold of ${demandThreshold}, while no more than two verified pharmacies currently show available listings.`,
    recommendation: 'Monitor listing coverage and consider whether participating pharmacies need an inventory update. This is not a confirmed regional shortage.',
  })).sort((a, b) => b.searches_30_days - a.searches_30_days);
}

function getPharmacyParticipation(searchActivity) {
  const pharmacies = db.prepare(`
    SELECT p.id AS pharmacy_id, p.name AS pharmacy_name,
      COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) AS verification_status,
      COUNT(DISTINCT i.id) AS inventory_items,
      COUNT(DISTINCT CASE WHEN i.deployed = 1 THEN i.id END) AS deployed_items,
      COUNT(DISTINCT CASE WHEN i.deployed = 1 AND i.stock_quantity > 0 THEN i.medicine_id END) AS available_medicines,
      COUNT(DISTINCT i.medicine_id) AS listed_medicines,
      MAX(i.updated_at) AS last_inventory_update,
      MAX(b.updated_at) AS last_batch_update,
      MAX(t.created_at) AS last_stock_activity,
      COUNT(DISTINCT CASE WHEN r.reserved_at >= datetime('now', '-30 days')
        AND r.status IN ('pending', 'confirmed', 'completed') THEN r.id END) AS reservations_30_days
    FROM pharmacies p
    LEFT JOIN inventory i ON i.pharmacy_id = p.id
    LEFT JOIN medicine_batches b ON b.pharmacy_id = p.id
    LEFT JOIN stock_transactions t ON t.pharmacy_id = p.id
    LEFT JOIN reservations r ON r.inventory_id = i.id
    GROUP BY p.id, p.name, p.verification_status, p.verified
    ORDER BY p.name
  `).all();
  const totalMedicines = Number(db.prepare('SELECT COUNT(*) AS count FROM medicines').get().count);
  const now = Date.now();

  const entries = pharmacies.map((row) => {
    const lastUpdate = [row.last_inventory_update, row.last_batch_update, row.last_stock_activity]
      .filter(Boolean)
      .map(value => new Date(value.replace(' ', 'T') + (value.includes('Z') ? '' : 'Z')).getTime())
      .filter(Number.isFinite)
      .sort((a, b) => b - a)[0];
    const daysSinceUpdate = Number.isFinite(lastUpdate) ? Math.floor((now - lastUpdate) / 86400000) : null;
    const verified = row.verification_status === 'VERIFIED';
    const stale = verified && (daysSinceUpdate === null || daysSinceUpdate >= STALE_INVENTORY_DAYS);
    const activity = searchActivity.pharmacyActivity.get(Number(row.pharmacy_id)) || { total: 0, recent: 0 };
    const reasons = [];
    if (row.verification_status !== 'VERIFIED') reasons.push(`verification status is ${row.verification_status}`);
    if (!row.inventory_items) reasons.push('no inventory listings are recorded');
    if (stale) reasons.push(daysSinceUpdate === null
      ? 'no inventory, batch, or stock transaction update is recorded'
      : `no inventory, batch, or stock transaction update in ${daysSinceUpdate} days`);
    if (verified && row.reservations_30_days === 0 && activity.total === 0) reasons.push('no recorded reservations or search-result activity in the last 30 days');

    return {
      pharmacy_id: Number(row.pharmacy_id),
      pharmacy_name: row.pharmacy_name,
      verification_status: row.verification_status,
      inventory_items: Number(row.inventory_items),
      deployed_items: Number(row.deployed_items),
      available_medicines: Number(row.available_medicines),
      medicine_coverage_percent: totalMedicines ? Number((Number(row.listed_medicines) / totalMedicines * 100).toFixed(1)) : 0,
      last_inventory_update: row.last_inventory_update,
      last_batch_update: row.last_batch_update,
      last_stock_activity: row.last_stock_activity,
      days_since_update: daysSinceUpdate,
      reservations_30_days: Number(row.reservations_30_days),
      pharmacy_matched_searches_30_days: activity.total,
      stale_inventory: stale,
      low_activity: verified && row.reservations_30_days === 0 && activity.total === 0,
      inactive: !verified || !row.inventory_items || stale,
      evidence: `${row.verification_status}; ${row.inventory_items} inventory items (${row.deployed_items} deployed); ${row.available_medicines} medicines in stock; ${row.reservations_30_days} reservations and ${activity.total} search-result events in the last ${REPORTING_DAYS} days${daysSinceUpdate === null ? '; no update date found' : `; latest inventory/batch/stock activity ${daysSinceUpdate} days ago`}.`,
      reason: reasons.length ? reasons.join('; ') : 'No inactivity or stale-update indicator met the review criteria.',
      recommendation: stale || !row.inventory_items
        ? 'Consider contacting the pharmacy to encourage an inventory review; P.A.I. does not contact pharmacies.'
        : row.verification_status !== 'VERIFIED'
          ? 'Review the pharmacy verification workflow as appropriate.'
          : 'Continue monitoring participation and listing coverage.',
    };
  });

  return {
    summary: {
      total: entries.length,
      verified: entries.filter(item => item.verification_status === 'VERIFIED').length,
      inactive: entries.filter(item => item.inactive).length,
      stale_inventory: entries.filter(item => item.stale_inventory).length,
      low_activity: entries.filter(item => item.low_activity).length,
    },
    pharmacies: entries,
  };
}

function getSystemAnomalies(searchActivity) {
  const anomalies = [];
  const searchCurrent = searchActivity.searchByWindow.recent;
  const searchPrevious = searchActivity.searchByWindow.previous;
  if (searchPrevious >= 5 && searchCurrent >= searchPrevious * ANOMALY_MULTIPLIER) {
    anomalies.push({
      type: 'search_activity_spike',
      subject: 'System-wide search activity',
      severity: 'REVIEW',
      evidence: `${searchCurrent} search events in the last ${COMPARISON_DAYS} days versus ${searchPrevious} in the previous ${COMPARISON_DAYS} days.`,
      reason: 'Recent activity is at least three times the comparison window, which is used here as an unusual-activity review threshold.',
      recommendation: 'Review the search trend and operational context. Unusual activity requires investigation and is not evidence of misconduct.',
    });
  }

  const medicineRows = db.prepare('SELECT id, name FROM medicines').all();
  const byMedicine = new Map(medicineRows.map(row => [Number(row.id), row.name]));
  const perMedicine = new Map();
  searchActivity.rows.forEach((row) => {
    const timestamp = new Date(row.searched_at.replace(' ', 'T') + (row.searched_at.includes('Z') ? '' : 'Z')).getTime();
    const current = timestamp >= Date.now() - COMPARISON_DAYS * 86400000;
    parseIdList(row.medicine_ids).forEach((medicineId) => {
      if (!perMedicine.has(medicineId)) perMedicine.set(medicineId, { recent: 0, previous: 0 });
      const counts = perMedicine.get(medicineId);
      if (current) counts.recent += 1;
      else counts.previous += 1;
    });
  });
  perMedicine.forEach((counts, medicineId) => {
    if (counts.previous >= 3 && counts.recent >= counts.previous * ANOMALY_MULTIPLIER) {
      anomalies.push({
        type: 'medicine_search_spike',
        subject: byMedicine.get(medicineId) || `Medicine #${medicineId}`,
        severity: 'REVIEW',
        evidence: `${counts.recent} searches in the last ${COMPARISON_DAYS} days versus ${counts.previous} in the previous ${COMPARISON_DAYS} days.`,
        reason: 'Search activity is at least three times the prior equal-length period and has a minimum comparison count of three.',
        recommendation: 'Review medicine demand alongside current availability within PillPoint; do not treat this signal as a confirmed shortage.',
      });
    }
  });

  const reservationWindows = db.prepare(`
    SELECT SUM(CASE WHEN reserved_at >= datetime('now', '-7 days') THEN 1 ELSE 0 END) AS recent,
      SUM(CASE WHEN reserved_at >= datetime('now', '-14 days') AND reserved_at < datetime('now', '-7 days') THEN 1 ELSE 0 END) AS previous
    FROM reservations
    WHERE status IN ('pending', 'confirmed', 'completed')
      AND reserved_at >= datetime('now', '-14 days')
  `).get();
  const recentReservations = Number(reservationWindows.recent || 0);
  const previousReservations = Number(reservationWindows.previous || 0);
  if (previousReservations >= 5 && recentReservations >= previousReservations * ANOMALY_MULTIPLIER) {
    anomalies.push({
      type: 'reservation_activity_spike',
      subject: 'System-wide reservation activity',
      severity: 'REVIEW',
      evidence: `${recentReservations} reservations in the last ${COMPARISON_DAYS} days versus ${previousReservations} in the previous ${COMPARISON_DAYS} days.`,
      reason: 'Recent reservation events are at least three times the equal-length comparison window.',
      recommendation: 'Review demand and inventory coverage. This anomaly is a signal for review, not an allegation of misconduct.',
    });
  }

  const transactionCounts = db.prepare(`
    SELECT pharmacy_id, date(created_at) AS activity_day,
      COUNT(*) AS transaction_count,
      MAX(created_at) AS last_activity
    FROM stock_transactions
    WHERE created_at >= datetime('now', '-30 days')
    GROUP BY pharmacy_id, date(created_at)
  `).all();
  const countsByPharmacy = new Map();
  transactionCounts.forEach((row) => {
    if (!countsByPharmacy.has(Number(row.pharmacy_id))) countsByPharmacy.set(Number(row.pharmacy_id), []);
    countsByPharmacy.get(Number(row.pharmacy_id)).push(row);
  });
  const pharmacyNames = new Map(db.prepare('SELECT id, name FROM pharmacies').all().map(item => [Number(item.id), item.name]));
  countsByPharmacy.forEach((days, pharmacyId) => {
    const baseline = median(days.map(row => Number(row.transaction_count)));
    if (days.length < 3 || baseline <= 0) return;
    const spikes = days.filter(row => Number(row.transaction_count) >= baseline * ANOMALY_MULTIPLIER);
    if (!spikes.length) return;
    anomalies.push({
      type: 'inventory_activity_spike',
      subject: pharmacyNames.get(pharmacyId) || `Pharmacy #${pharmacyId}`,
      severity: 'REVIEW',
      evidence: `${spikes.map(row => `${row.activity_day}: ${row.transaction_count} transactions`).join('; ')}; median active-day volume is ${baseline}.`,
      reason: 'One or more daily inventory transaction counts reached at least three times the pharmacy’s median active-day count during the selected 30-day window.',
      recommendation: 'Review the affected stock transactions against operational context. Unusual activity requires review and does not imply misconduct.',
    });
  });

  return anomalies;
}

function getPriceAnomalies() {
  const rows = db.prepare(`
    SELECT i.id AS inventory_id, i.pharmacy_id, p.name AS pharmacy_name,
      i.medicine_id, m.name AS medicine_name, i.price
    FROM inventory i
    JOIN pharmacies p ON p.id = i.pharmacy_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.deployed = 1 AND i.stock_quantity > 0 AND i.price > 0
      AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
  `).all();
  const byMedicine = new Map();
  rows.forEach((row) => {
    if (!byMedicine.has(Number(row.medicine_id))) byMedicine.set(Number(row.medicine_id), []);
    byMedicine.get(Number(row.medicine_id)).push(row);
  });
  const anomalies = [];
  byMedicine.forEach((listings) => {
    if (listings.length < 3) return;
    const midpoint = median(listings.map(item => Number(item.price)));
    if (!(midpoint > 0)) return;
    listings.forEach((listing) => {
      const deviation = Number((((Number(listing.price) - midpoint) / midpoint) * 100).toFixed(1));
      if (Math.abs(deviation) < PRICE_DEVIATION_PERCENT) return;
      anomalies.push({
        inventory_id: listing.inventory_id,
        pharmacy_id: listing.pharmacy_id,
        pharmacy_name: listing.pharmacy_name,
        medicine_id: listing.medicine_id,
        medicine_name: listing.medicine_name,
        listed_price: Number(listing.price),
        median_price: Number(midpoint.toFixed(2)),
        comparison_listings: listings.length,
        deviation_percent: deviation,
        severity: 'REVIEW',
        evidence: `${listing.pharmacy_name} lists ${listing.medicine_name} at ${Number(listing.price).toFixed(2)}, ${Math.abs(deviation).toFixed(1)}% ${deviation > 0 ? 'above' : 'below'} the median ${midpoint.toFixed(2)} across ${listings.length} verified, deployed, in-stock PillPoint listings.`,
        reason: `The price differs from the same-medicine system median by at least ${PRICE_DEVIATION_PERCENT}%; this is a comparison signal, not proof of an error.`,
        recommendation: 'Possible causes include a data-entry error, an outdated listing, or a legitimate pricing difference. Review with context; do not presume misconduct or change the price automatically.',
      });
    });
  });
  return anomalies.sort((a, b) => Math.abs(b.deviation_percent) - Math.abs(a.deviation_percent)).slice(0, 20);
}

function getCoreSystemData() {
  const search = getSearchActivity();
  const medicines = getMedicineDemand();
  const participation = getPharmacyParticipation(search);
  const reservations = db.prepare(`
    SELECT COUNT(*) AS event_count, COALESCE(SUM(quantity), 0) AS units
    FROM reservations
    WHERE reserved_at >= datetime('now', '-30 days')
      AND status IN ('pending', 'confirmed', 'completed')
  `).get();
  const inventory = db.prepare(`
    SELECT COUNT(*) AS listings,
      COUNT(DISTINCT medicine_id) AS medicines_listed,
      COUNT(DISTINCT CASE WHEN deployed = 1 AND stock_quantity > 0 THEN medicine_id END) AS available_medicines,
      COALESCE(SUM(CASE WHEN deployed = 1 AND stock_quantity > 0 THEN stock_quantity ELSE 0 END), 0) AS available_units,
      SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) AS out_of_stock_listings,
      SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= low_stock_threshold THEN 1 ELSE 0 END) AS low_stock_listings
    FROM inventory
  `).get();
  const batches = db.prepare(`
    SELECT COUNT(*) AS expiring_batches,
      COALESCE(SUM(current_quantity), 0) AS expiring_units
    FROM medicine_batches
    WHERE current_quantity > 0
      AND expiration_date IS NOT NULL
      AND date(expiration_date) BETWEEN date('now') AND date('now', '+30 days')
      AND status NOT IN ('expired', 'depleted', 'recalled', 'archived')
  `).get();
  return { search, medicines, participation, reservations, inventory, batches };
}

function buildInsights() {
  const data = getCoreSystemData();
  const topSearched = getTopSearched(data.search.medicineCounts);
  const gaps = getDemandSupplyGaps(data.medicines);
  const anomalies = getSystemAnomalies(data.search);
  const priceAnomalies = getPriceAnomalies();
  const insights = [];

  if (topSearched.length) {
    const top = topSearched[0];
    const supply = data.medicines.find(item => Number(item.medicine_id) === Number(top.medicine_id));
    insights.push({
      type: 'high_search_activity',
      insight: `${top.medicine_name} has the highest recorded search activity in PillPoint.`,
      evidence: `${top.search_count} search result events in the last ${REPORTING_DAYS} days; ${supply?.available_pharmacies || 0} verified pharmacies currently have deployed in-stock listings.`,
      reason: 'Search activity is ranked from medicine IDs stored with actual PillPoint search results and compared with current verified availability.',
      recommendation: 'Monitor availability within PillPoint, especially if search activity remains high.',
    });
  }
  gaps.slice(0, 10).forEach(gap => insights.push({
    type: 'demand_supply_gap',
    insight: gap.insight,
    evidence: gap.evidence,
    reason: gap.reason,
    recommendation: gap.recommendation,
    medicine_name: gap.medicine_name,
  }));
  if (data.participation.summary.stale_inventory > 0) {
    const stale = data.participation.pharmacies.filter(item => item.stale_inventory);
    insights.push({
      type: 'stale_pharmacy_inventory',
      insight: `${stale.length} verified pharmacies have inventory activity that may need updating.`,
      evidence: stale.slice(0, 5).map(item => `${item.pharmacy_name}: ${item.days_since_update == null ? 'no recorded update' : `${item.days_since_update} days since update`}`).join('; '),
      reason: `Latest inventory, batch, or stock transaction activity was ${STALE_INVENTORY_DAYS} or more days ago, or no update date was available.`,
      recommendation: 'Consider contacting pharmacies to encourage an inventory review; P.A.I. does not contact them automatically.',
    });
  }
  anomalies.forEach(anomaly => insights.push({
    type: anomaly.type,
    insight: `Unusual activity detected for ${anomaly.subject}; requires review.`,
    evidence: anomaly.evidence,
    reason: anomaly.reason,
    recommendation: anomaly.recommendation,
    severity: anomaly.severity,
  }));
  priceAnomalies.slice(0, 10).forEach(anomaly => insights.push({
    type: 'price_anomaly',
    insight: `One listing has a substantially different price for ${anomaly.medicine_name}.`,
    evidence: anomaly.evidence,
    reason: anomaly.reason,
    recommendation: anomaly.recommendation,
    severity: anomaly.severity,
  }));

  return { data, topSearched, gaps, anomalies, priceAnomalies, insights };
}

function getAdminInsights() {
  const { data, topSearched, gaps, anomalies, priceAnomalies, insights } = buildInsights();
  const lowStock = db.prepare(`
    SELECT i.id AS inventory_id, m.name AS medicine_name, i.pharmacy_id, p.name AS pharmacy_name,
      i.stock_quantity, i.low_stock_threshold,
      i.stock_quantity - i.low_stock_threshold AS shortfall
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE i.stock_quantity <= i.low_stock_threshold
      AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    ORDER BY shortfall, i.stock_quantity
    LIMIT 20
  `).all();
  const searches30Days = data.search.rows.length;

  return {
    generated_at: new Date().toISOString(),
    reporting_period: `Last ${REPORTING_DAYS} days`,
    top_searched: topSearched,
    low_stock_items: lowStock,
    pharmacy_availability: data.participation.pharmacies.slice(0, 20).map(item => ({
      pharmacy_id: item.pharmacy_id,
      pharmacy_name: item.pharmacy_name,
      verification_status: item.verification_status,
      tracked_items: item.inventory_items,
      available_medicines: item.available_medicines,
      stale_inventory: item.stale_inventory,
      days_since_update: item.days_since_update,
    })),
    summary: {
      top_search_count: topSearched[0]?.search_count || 0,
      low_stock_alerts: lowStock.length,
      pharmacies_with_risk: data.participation.pharmacies.filter(item => item.stale_inventory).length,
      search_events_30_days: searches30Days,
      reservation_events_30_days: Number(data.reservations.event_count),
      demand_supply_gaps: gaps.length,
      anomalies_requiring_review: anomalies.length,
      price_anomalies: priceAnomalies.length,
    },
    system_insights: insights,
    demand_supply_gaps: gaps.slice(0, 20),
    pharmacy_participation: data.participation,
    anomalies: anomalies.slice(0, 30),
    price_anomalies: priceAnomalies,
  };
}

function generateAdminReport() {
  const insights = getAdminInsights();
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM users WHERE role = 'customer') AS customer_count,
      (SELECT COUNT(*) FROM medicines) AS medicine_catalog_count,
      (SELECT COUNT(*) FROM pharmacies) AS pharmacy_count,
      (SELECT COUNT(*) FROM pharmacies WHERE COALESCE(verification_status, CASE WHEN verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED') AS verified_pharmacy_count
  `).get();
  const inventory = db.prepare(`
    SELECT COUNT(*) AS listings,
      SUM(CASE WHEN deployed = 1 AND stock_quantity > 0 THEN 1 ELSE 0 END) AS available_listings,
      SUM(CASE WHEN stock_quantity = 0 THEN 1 ELSE 0 END) AS out_of_stock_listings,
      SUM(CASE WHEN stock_quantity > 0 AND stock_quantity <= low_stock_threshold THEN 1 ELSE 0 END) AS low_stock_listings,
      COALESCE(SUM(CASE WHEN deployed = 1 AND stock_quantity > 0 THEN stock_quantity ELSE 0 END), 0) AS available_units
    FROM inventory
  `).get();
  const reservations = db.prepare(`
    SELECT COUNT(*) AS events, COALESCE(SUM(quantity), 0) AS units
    FROM reservations
    WHERE reserved_at >= datetime('now', '-30 days')
      AND status IN ('pending', 'confirmed', 'completed')
  `).get();
  const searches = insights.summary.search_events_30_days;
  const topMedicines = insights.top_searched.slice(0, 5);
  const reportInsights = insights.system_insights;

  const recommendedActions = [
    ...insights.demand_supply_gaps.slice(0, 5).map(item => ({
      action: `Monitor PillPoint availability for ${item.medicine_name}.`,
      evidence: item.evidence,
      reason: item.reason,
    })),
    ...insights.pharmacy_participation.pharmacies.filter(item => item.stale_inventory).slice(0, 5).map(item => ({
      action: `Consider requesting an inventory review from ${item.pharmacy_name}.`,
      evidence: item.evidence,
      reason: item.reason,
    })),
    ...insights.price_anomalies.slice(0, 5).map(item => ({
      action: `Review the ${item.medicine_name} listing at ${item.pharmacy_name}.`,
      evidence: item.evidence,
      reason: item.reason,
    })),
  ];

  return {
    title: 'PILLPOINT SYSTEM SUMMARY',
    generated_at: new Date().toISOString(),
    reporting_period: `Last ${REPORTING_DAYS} days`,
    sections: {
      customer_activity: {
        search_events: searches,
        customers_with_search_activity: db.prepare(`
          SELECT COUNT(DISTINCT user_id) AS count FROM search_logs
          WHERE searched_at >= datetime('now', '-30 days')
        `).get().count,
        evidence: `${searches} search-log events from ${db.prepare(`
          SELECT COUNT(DISTINCT user_id) AS count FROM search_logs
          WHERE searched_at >= datetime('now', '-30 days')
        `).get().count} customers and ${reservations.events} qualifying reservation events were recorded in the reporting period.`,
        reason: 'Counts are derived from existing PillPoint search logs and reservations; customer activity here counts users with search events, not all registered users.',
      },
      medicine_demand: {
        top_searched: topMedicines,
        demand_supply_gaps: insights.demand_supply_gaps,
        evidence: topMedicines.length
          ? topMedicines.map(item => `${item.medicine_name}: ${item.search_count} search events`).join('; ')
          : 'No medicine search-result events were recorded in this reporting period.',
        reason: 'Medicine demand counts only medicine IDs present in recorded search results; gap findings compare those searches with current verified listings.',
      },
      medicine_availability: {
        catalog_medicines: Number(totals.medicine_catalog_count),
        available_listings: Number(inventory.available_listings || 0),
        available_units: Number(inventory.available_units || 0),
        out_of_stock_listings: Number(inventory.out_of_stock_listings || 0),
        low_stock_listings: Number(inventory.low_stock_listings || 0),
        evidence: `${inventory.available_listings || 0} deployed listings have positive stock; ${inventory.available_units || 0} available units; ${inventory.out_of_stock_listings || 0} zero-stock records.`,
        reason: 'Availability is calculated from current inventory deployment and stock fields. Counts describe recorded PillPoint listings, not regional supply.',
      },
      pharmacy_participation: {
        total: Number(totals.pharmacy_count),
        verified: Number(totals.verified_pharmacy_count),
        stale_inventory: insights.pharmacy_participation.summary.stale_inventory,
        low_activity: insights.pharmacy_participation.summary.low_activity,
        pharmacies: insights.pharmacy_participation.pharmacies,
        evidence: `${totals.verified_pharmacy_count} of ${totals.pharmacy_count} pharmacies are verified; ${insights.pharmacy_participation.summary.stale_inventory} verified pharmacies meet the stale-inventory review rule.`,
        reason: `Stale inventory means no inventory, batch, or stock transaction update in ${STALE_INVENTORY_DAYS} days, or no recorded update date.`,
      },
      reservation_activity: {
        events: Number(reservations.events),
        units: Number(reservations.units),
        evidence: `${reservations.events} pending, confirmed, or completed reservations covering ${reservations.units} units in the last ${REPORTING_DAYS} days.`,
        reason: 'Cancelled and expired reservations are excluded from this activity total.',
      },
      inventory_observations: {
        low_stock_listings: Number(inventory.low_stock_listings || 0),
        out_of_stock_listings: Number(inventory.out_of_stock_listings || 0),
        evidence: `${inventory.low_stock_listings || 0} listings are at or below their stored low-stock thresholds; ${inventory.out_of_stock_listings || 0} listings have zero stock.`,
        reason: 'These are counts from existing inventory records; the report does not alter records.',
      },
      price_observations: {
        anomalies: insights.price_anomalies,
        evidence: insights.price_anomalies.length
          ? `${insights.price_anomalies.length} listings differ at least ${PRICE_DEVIATION_PERCENT}% from the same-medicine system median.`
          : `No listing met the ${PRICE_DEVIATION_PERCENT}% same-medicine median deviation review rule.`,
        reason: 'Comparison uses verified pharmacies with deployed, positive-stock listings and at least three comparable listings; a difference is not proof of an error.',
      },
      important_system_insights: reportInsights,
      recommended_administrative_actions: recommendedActions,
    },
    disclaimer: 'This report summarizes recorded PillPoint system data. Demand/supply signals refer to PillPoint listing coverage, not confirmed regional shortages. Anomalies require administrative review and do not imply misconduct.',
  };
}

module.exports = {
  getAdminInsights,
  generateAdminReport,
};
