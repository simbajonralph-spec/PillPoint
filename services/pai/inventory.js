const db = require('../../db/database');

const DEMAND_WINDOW_DAYS = 7;
const EXPIRY_WINDOW_DAYS = 30;
const HIGH_STOCK_RISK_DAYS = 3;
const MODERATE_STOCK_RISK_DAYS = 7;
const PRICE_ANOMALY_PERCENT = 50;
const STALE_PRICE_DAYS = 90;

function riskLevelFromDays(days) {
  if (days === 0) return 'CRITICAL';
  if (Number.isNaN(days) || !Number.isFinite(days)) return 'NO_RECENT_DEMAND';
  if (days < HIGH_STOCK_RISK_DAYS) return 'HIGH';
  if (days <= MODERATE_STOCK_RISK_DAYS) return 'MODERATE';
  return 'LOW';
}

function parseJsonIds(value) {
  try {
    const ids = JSON.parse(value || '[]');
    return Array.isArray(ids) ? ids.map(Number).filter(Number.isInteger) : [];
  } catch (error) {
    return [];
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function getInventoryRows(pharmacyId) {
  return db.prepare(`
    SELECT i.id AS inventory_id, i.medicine_id, m.name AS medicine_name,
      i.stock_quantity, i.low_stock_threshold, i.price, i.deployed, i.updated_at,
      COALESCE((
        SELECT SUM(r.quantity)
        FROM reservations r
        WHERE r.inventory_id = i.id
          AND r.status IN ('pending', 'confirmed', 'completed')
          AND r.reserved_at >= datetime('now', '-7 days')
      ), 0) AS recent_demand_units,
      COALESCE((
        SELECT SUM(ABS(t.quantity))
        FROM stock_transactions t
        WHERE t.inventory_id = i.id
          AND t.transaction_type = 'stock_out'
          AND t.created_at >= datetime('now', '-7 days')
      ), 0) AS recent_stock_out_units,
      COALESCE((
        SELECT SUM(r.quantity)
        FROM reservations r
        WHERE r.inventory_id = i.id
          AND r.status IN ('pending', 'confirmed', 'completed')
          AND r.reserved_at >= datetime('now', '-14 days')
          AND r.reserved_at < datetime('now', '-7 days')
      ), 0) AS previous_demand_units,
      COALESCE((
        SELECT SUM(ABS(t.quantity))
        FROM stock_transactions t
        WHERE t.inventory_id = i.id
          AND t.transaction_type = 'stock_out'
          AND t.created_at >= datetime('now', '-14 days')
          AND t.created_at < datetime('now', '-7 days')
      ), 0) AS previous_stock_out_units
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ?
    ORDER BY m.name ASC
  `).all(pharmacyId);
}

function getSearchActivity(pharmacyId, medicineIds) {
  const idSet = new Set(medicineIds);
  const activity = new Map(medicineIds.map(id => [id, {
    recent_searches: 0,
    previous_searches: 0,
    month_searches: 0,
  }]));
  activity.month_search_events = 0;
  const rows = db.prepare(`
    SELECT medicine_ids, pharmacy_ids,
      CASE
        WHEN searched_at >= datetime('now', '-7 days') THEN 'recent'
        WHEN searched_at >= datetime('now', '-14 days') THEN 'previous'
        ELSE 'outside'
      END AS period,
      CASE WHEN searched_at >= datetime('now', 'start of month') THEN 1 ELSE 0 END AS in_month
    FROM search_logs
    WHERE searched_at >= datetime('now', '-14 days')
       OR searched_at >= datetime('now', 'start of month')
  `).all();

  rows.forEach((row) => {
    const pharmacyIds = parseJsonIds(row.pharmacy_ids);
    if (!pharmacyIds.includes(Number(pharmacyId))) return;
    const matchedMedicineIds = new Set(parseJsonIds(row.medicine_ids).filter(id => idSet.has(id)));
    if (row.in_month && matchedMedicineIds.size) activity.month_search_events += 1;
    matchedMedicineIds.forEach((medicineId) => {
      const item = activity.get(medicineId);
      if (row.in_month) item.month_searches += 1;
      if (row.period === 'recent') item.recent_searches += 1;
      else if (row.period === 'previous') item.previous_searches += 1;
    });
  });

  return activity;
}

function getStockRisk(rows) {
  const items = rows.map((item) => {
    const recentDemandUnits = Math.max(Number(item.recent_demand_units), Number(item.recent_stock_out_units));
    const averageDailyDemand = recentDemandUnits / DEMAND_WINDOW_DAYS;
    const estimatedDaysOfStock = averageDailyDemand > 0
      ? Number(item.stock_quantity) / averageDailyDemand
      : Number.POSITIVE_INFINITY;
    const severity = Number(item.stock_quantity) === 0 ? 'CRITICAL' : riskLevelFromDays(estimatedDaysOfStock);
    const belowThreshold = Number(item.stock_quantity) <= Number(item.low_stock_threshold);
    const evidence = Number(item.stock_quantity) === 0
      ? 'Current inventory is 0 units.'
      : `Current inventory is ${item.stock_quantity} units with a low-stock threshold of ${item.low_stock_threshold}; there were ${item.recent_demand_units} reservation units and ${item.recent_stock_out_units} stock-out units during the last ${DEMAND_WINDOW_DAYS} days.`;
    const reason = Number(item.stock_quantity) === 0
      ? 'There is no stock available in the pharmacy inventory.'
      : Number.isFinite(estimatedDaysOfStock)
        ? `At the recent activity rate, current stock represents approximately ${estimatedDaysOfStock.toFixed(1)} days of supply${belowThreshold ? ` and is at or below the configured threshold of ${item.low_stock_threshold} units` : ''}.`
        : `No qualifying reservations or stock-outs were recorded in the last ${DEMAND_WINDOW_DAYS} days, so days-of-stock cannot be estimated from recent demand${belowThreshold ? `; current stock is at or below the configured threshold of ${item.low_stock_threshold} units` : ''}.`;

    return {
      inventory_id: item.inventory_id,
      medicine_name: item.medicine_name,
      severity,
      current_stock: Number(item.stock_quantity),
      threshold: Number(item.low_stock_threshold),
      recent_demand_units: Number(recentDemandUnits),
      recent_reservation_units: Number(item.recent_demand_units),
      recent_stock_out_units: Number(item.recent_stock_out_units),
      estimated_days: Number.isFinite(estimatedDaysOfStock) ? Number(estimatedDaysOfStock.toFixed(1)) : null,
      evidence,
      reason,
      message: reason,
      recommendation: Number(item.stock_quantity) === 0
        ? 'Review replenishment options; P.A.I. does not change stock.'
        : Number(item.stock_quantity) <= Number(item.low_stock_threshold)
          ? 'Review replenishment timing against the configured low-stock threshold.'
          : 'Monitor reservation activity and keep the reorder threshold under review.',
    };
  }).filter(item => item.current_stock <= item.threshold
    || item.severity === 'CRITICAL'
    || item.severity === 'HIGH'
    || item.severity === 'MODERATE');

  items.sort((a, b) => {
    const order = { CRITICAL: 0, HIGH: 1, MODERATE: 2, LOW: 3, NO_RECENT_DEMAND: 4 };
    return order[a.severity] - order[b.severity] || a.medicine_name.localeCompare(b.medicine_name);
  });

  return {
    items: items.slice(0, 20),
    summary: {
      critical: items.filter(item => item.severity === 'CRITICAL').length,
      high: items.filter(item => item.severity === 'HIGH').length,
      moderate: items.filter(item => item.severity === 'MODERATE').length,
    },
  };
}

function getDemandAnalysis(rows, searchActivity) {
  const items = rows.map((item) => {
    const recentReservationUnits = Number(item.recent_demand_units);
    const previousReservationUnits = Number(item.previous_demand_units);
    const recentStockOutUnits = Number(item.recent_stock_out_units);
    const previousStockOutUnits = Number(item.previous_stock_out_units);
    const recentUnits = Math.max(recentReservationUnits, recentStockOutUnits);
    const previousUnits = Math.max(previousReservationUnits, previousStockOutUnits);
    const changePercent = previousUnits > 0
      ? Number((((recentUnits - previousUnits) / previousUnits) * 100).toFixed(1))
      : null;
    const searches = searchActivity.get(Number(item.medicine_id)) || {
      recent_searches: 0, previous_searches: 0, month_searches: 0,
    };
    const unusuallyHigh = previousUnits > 0 && recentUnits >= previousUnits * 2 && recentUnits - previousUnits >= 5;
    const searchInterestIncreasing = recentUnits === previousUnits && searches.recent_searches > searches.previous_searches;
    const searchInterestDecreasing = recentUnits === previousUnits && searches.recent_searches < searches.previous_searches;
    let trend = 'STABLE';
    if (unusuallyHigh) trend = 'UNUSUALLY_HIGH';
    else if (recentUnits > previousUnits) trend = 'INCREASING';
    else if (recentUnits < previousUnits) trend = 'DECREASING';
    else if (searchInterestIncreasing) trend = 'INCREASING_INTEREST';
    else if (searchInterestDecreasing) trend = 'DECREASING_INTEREST';

    const evidence = `${recentReservationUnits} reservation units and ${recentStockOutUnits} stock-out units in the last ${DEMAND_WINDOW_DAYS} days versus ${previousReservationUnits} reservation units and ${previousStockOutUnits} stock-out units in the previous ${DEMAND_WINDOW_DAYS} days; ${searches.recent_searches} pharmacy-matched searches versus ${searches.previous_searches}.`;
    return {
      inventory_id: item.inventory_id,
      medicine_name: item.medicine_name,
      current_stock: Number(item.stock_quantity),
      low_stock_threshold: Number(item.low_stock_threshold),
      trend,
      recent_reservation_units: recentReservationUnits,
      previous_reservation_units: previousReservationUnits,
      recent_stock_out_units: recentStockOutUnits,
      previous_stock_out_units: previousStockOutUnits,
      recent_demand_units: recentUnits,
      previous_demand_units: previousUnits,
      change_percent: changePercent,
      recent_searches: searches.recent_searches,
      previous_searches: searches.previous_searches,
      evidence,
      reason: previousUnits === 0 && recentUnits > 0
        ? 'Reservation or stock-out activity was recorded in the current period but not the comparison period.'
        : unusuallyHigh
          ? 'Reservation volume is at least twice the previous period and increased by at least five units.'
          : searchInterestIncreasing
            ? 'Pharmacy-matched search activity increased while recorded reservation and stock-out units were unchanged.'
            : searchInterestDecreasing
              ? 'Pharmacy-matched search activity decreased while recorded reservation and stock-out units were unchanged.'
          : 'Trend is based on a comparison of actual reservation units across equal periods.',
      recommendation: trend === 'UNUSUALLY_HIGH' || trend === 'INCREASING'
        ? 'Review stock coverage and recent reservation activity; this is not a guaranteed forecast.'
        : trend === 'INCREASING_INTEREST'
          ? 'Review current availability in light of increased search activity; this is not a guaranteed forecast.'
        : trend === 'DECREASING'
          ? 'Continue monitoring before changing replenishment plans.'
          : trend === 'DECREASING_INTEREST'
            ? 'Continue monitoring search and reservation activity before changing replenishment plans.'
          : 'No material reservation trend change is evident from these periods.',
    };
  }).filter(item => item.recent_reservation_units > 0
    || item.previous_reservation_units > 0
    || item.recent_stock_out_units > 0
    || item.previous_stock_out_units > 0
    || item.recent_searches > 0
    || item.previous_searches > 0);

  const summary = {
    increasing: items.filter(item => item.trend === 'INCREASING' || item.trend === 'INCREASING_INTEREST').length,
    decreasing: items.filter(item => item.trend === 'DECREASING' || item.trend === 'DECREASING_INTEREST').length,
    unusually_high: items.filter(item => item.trend === 'UNUSUALLY_HIGH').length,
    stable: items.filter(item => item.trend === 'STABLE').length,
  };
  const restockRecommendations = items
    .filter(item => item.current_stock <= item.low_stock_threshold
      && (item.recent_searches > 0 || item.recent_demand_units > 0))
    .sort((a, b) => b.recent_searches - a.recent_searches
      || b.recent_demand_units - a.recent_demand_units
      || a.medicine_name.localeCompare(b.medicine_name))
    .slice(0, 5)
    .map(item => ({
      inventory_id: item.inventory_id,
      medicine_name: item.medicine_name,
      current_stock: item.current_stock,
      low_stock_threshold: item.low_stock_threshold,
      recent_searches: item.recent_searches,
      recent_demand_units: item.recent_demand_units,
      recommendation: item.recommendation,
    }));
  return { items: items.slice(0, 20), restock_recommendations: restockRecommendations, summary };
}

function getExpiryRisk(pharmacyId) {
  const batches = db.prepare(`
    SELECT b.id AS batch_id, b.batch_number, b.inventory_id, b.medicine_id,
      m.name AS medicine_name, b.current_quantity,
      date(b.expiration_date) AS expiration_date,
      CAST(julianday(date(b.expiration_date)) - julianday(date('now')) AS INTEGER) AS days_until_expiry,
      COALESCE((
        SELECT SUM(r.quantity)
        FROM reservations r
        JOIN inventory i ON i.id = r.inventory_id
        WHERE i.pharmacy_id = b.pharmacy_id
          AND i.medicine_id = b.medicine_id
          AND r.status IN ('pending', 'confirmed', 'completed')
          AND r.reserved_at >= datetime('now', '-30 days')
      ), 0) AS reservation_demand_30_days,
      COALESCE((
        SELECT SUM(ABS(t.quantity))
        FROM stock_transactions t
        WHERE t.pharmacy_id = b.pharmacy_id
          AND t.medicine_id = b.medicine_id
          AND t.transaction_type = 'stock_out'
          AND t.created_at >= datetime('now', '-30 days')
      ), 0) AS stock_out_30_days
    FROM medicine_batches b
    JOIN medicines m ON m.id = b.medicine_id
    WHERE b.pharmacy_id = ?
      AND b.current_quantity > 0
      AND b.expiration_date IS NOT NULL
      AND date(b.expiration_date) BETWEEN date('now') AND date('now', '+' || ? || ' days')
      AND b.status NOT IN ('expired', 'depleted', 'recalled', 'archived')
    ORDER BY date(b.expiration_date), m.name
  `).all(pharmacyId, EXPIRY_WINDOW_DAYS);
  const items = batches.map((batch) => {
    const demand30Days = Math.max(Number(batch.reservation_demand_30_days), Number(batch.stock_out_30_days));
    const urgency = Number(batch.days_until_expiry) <= 7 ? 'HIGH'
      : demand30Days === 0 || Number(batch.current_quantity) > demand30Days ? 'MODERATE'
        : 'LOW';
    return {
      batch_id: batch.batch_id,
      batch_number: batch.batch_number,
      medicine_name: batch.medicine_name,
      current_quantity: Number(batch.current_quantity),
      expiration_date: batch.expiration_date,
      days_until_expiry: Number(batch.days_until_expiry),
      demand_30_days: demand30Days,
      severity: urgency,
      evidence: `${batch.current_quantity} units in batch ${batch.batch_number} expire on ${batch.expiration_date}; recent 30-day demand evidence includes ${batch.reservation_demand_30_days} reservation units and ${batch.stock_out_30_days} stock-out units.`,
      recommendation: 'Review the batch and applicable pharmacy procedures; P.A.I. does not adjust or remove inventory.',
    };
  });
  return {
    items: items.slice(0, 20),
    summary: {
      high: items.filter(item => item.severity === 'HIGH').length,
      moderate: items.filter(item => item.severity === 'MODERATE').length,
      low: items.filter(item => item.severity === 'LOW').length,
    },
  };
}

function getPriceAnalysis(pharmacyId) {
  const listings = db.prepare(`
    SELECT i.id AS inventory_id, i.medicine_id, m.name AS medicine_name, i.price,
      i.updated_at, p.id AS pharmacy_id, p.name AS pharmacy_name
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    JOIN pharmacies p ON p.id = i.pharmacy_id
    WHERE i.deployed = 1 AND i.stock_quantity > 0
      AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      AND i.price > 0
  `).all();
  const byMedicine = new Map();
  listings.forEach((listing) => {
    if (!byMedicine.has(Number(listing.medicine_id))) byMedicine.set(Number(listing.medicine_id), []);
    byMedicine.get(Number(listing.medicine_id)).push(listing);
  });
  const now = Date.now();
  const items = [];

  listings.filter(item => Number(item.pharmacy_id) === Number(pharmacyId)).forEach((listing) => {
    const peerPrices = (byMedicine.get(Number(listing.medicine_id)) || [])
      .filter(peer => Number(peer.pharmacy_id) !== Number(pharmacyId))
      .map(peer => Number(peer.price))
      .filter(price => Number.isFinite(price) && price > 0);
    if (peerPrices.length < 2) return;
    const peerMedian = median(peerPrices);
    const deviationPercent = Number((((Number(listing.price) - peerMedian) / peerMedian) * 100).toFixed(1));
    const updatedAt = listing.updated_at ? new Date(`${listing.updated_at.replace(' ', 'T')}Z`).getTime() : NaN;
    const stale = Number.isFinite(updatedAt) && now - updatedAt >= STALE_PRICE_DAYS * 24 * 60 * 60 * 1000;
    if (Math.abs(deviationPercent) < PRICE_ANOMALY_PERCENT && !(stale && Math.abs(deviationPercent) >= 30)) return;

    items.push({
      inventory_id: listing.inventory_id,
      medicine_name: listing.medicine_name,
      listed_price: Number(listing.price),
      peer_median_price: Number(peerMedian.toFixed(2)),
      peer_listing_count: peerPrices.length,
      deviation_percent: deviationPercent,
      price_age_days: Number.isFinite(updatedAt) ? Math.max(0, Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000))) : null,
      severity: Math.abs(deviationPercent) >= PRICE_ANOMALY_PERCENT ? 'REVIEW' : 'POSSIBLY_OUTDATED',
      evidence: `Your listed price is ${Math.abs(deviationPercent).toFixed(1)}% ${deviationPercent > 0 ? 'above' : 'below'} the median price of ${peerPrices.length} current verified PillPoint listings${stale ? ` and has not been updated in ${Math.max(0, Math.floor((now - updatedAt) / (24 * 60 * 60 * 1000)))} days` : ''}.`,
      recommendation: 'Review whether the price is current and intentional. P.A.I. never changes pharmacy prices.',
    });
  });
  return {
    items: items.slice(0, 20),
    summary: { flagged: items.length },
  };
}

function getDataQualityIssues(pharmacyId) {
  const inventory = db.prepare(`
    SELECT i.id AS inventory_id, i.medicine_id, m.name AS medicine_name,
      i.stock_quantity, i.low_stock_threshold, i.price, i.deployed,
      COALESCE((
        SELECT SUM(b.current_quantity)
        FROM medicine_batches b
        WHERE b.inventory_id = i.id
          AND b.status NOT IN ('depleted', 'recalled', 'archived')
      ), 0) AS tracked_batch_stock,
      (SELECT COUNT(*) FROM medicine_batches b WHERE b.inventory_id = i.id) AS batch_count
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ?
  `).all(pharmacyId);
  const issues = [];
  inventory.forEach((item) => {
    const add = (issue, reason, suggestedCorrection) => issues.push({
      inventory_id: item.inventory_id,
      medicine_name: item.medicine_name,
      issue,
      reason,
      suggested_correction: suggestedCorrection,
    });
    if (Number(item.price) <= 0) add('Invalid listed price', 'The listing price is zero or negative.', 'Review and correct the price in inventory management.');
    if (Number(item.stock_quantity) < 0) add('Negative inventory stock', 'The inventory record has a stock quantity below zero.', 'Reconcile inventory with the latest stock transactions.');
    if (Number(item.low_stock_threshold) < 0) add('Invalid low-stock threshold', 'The configured low-stock threshold is below zero.', 'Review the threshold in inventory management.');
    if (Number(item.deployed) === 1 && Number(item.stock_quantity) === 0) {
      add('Published listing has no stock', 'The listing is deployed, but its current stock is zero and it cannot appear as available to customers.', 'Review stock and publication status; no changes were made.');
    }
    if (Number(item.batch_count) > 0 && Number(item.tracked_batch_stock) !== Number(item.stock_quantity)) {
      add('Inventory and batch quantities differ', `Inventory records ${item.stock_quantity} units while non-terminal batches total ${item.tracked_batch_stock} units.`, 'Reconcile the inventory and batch records before making stock decisions.');
    }
  });

  const batches = db.prepare(`
    SELECT b.id AS batch_id, b.inventory_id, b.medicine_id, m.name AS medicine_name,
      b.batch_number, b.current_quantity, b.expiration_date,
      date(b.expiration_date) AS valid_expiration_date,
      CASE WHEN date(b.expiration_date) < date('now') THEN 1 ELSE 0 END AS is_expired
    FROM medicine_batches b
    JOIN medicines m ON m.id = b.medicine_id
    WHERE b.pharmacy_id = ? AND b.current_quantity > 0
      AND b.status NOT IN ('expired', 'depleted', 'recalled', 'archived')
  `).all(pharmacyId);
  batches.forEach((batch) => {
    if (!batch.expiration_date) {
      issues.push({
        inventory_id: batch.inventory_id,
        batch_id: batch.batch_id,
        medicine_name: batch.medicine_name,
        issue: 'Active batch has no expiration date',
        reason: `Batch ${batch.batch_number} has ${batch.current_quantity} units but no recorded expiration date.`,
        suggested_correction: 'Verify the package or supplier record and update batch details if the expiration date is available.',
      });
    } else if (!batch.valid_expiration_date) {
      issues.push({
        inventory_id: batch.inventory_id,
        batch_id: batch.batch_id,
        medicine_name: batch.medicine_name,
        issue: 'Invalid batch expiration date',
        reason: `Batch ${batch.batch_number} has an expiration value that cannot be read as a date.`,
        suggested_correction: 'Verify the package or supplier record and correct the batch date if appropriate.',
      });
    } else if (batch.is_expired) {
      issues.push({
        inventory_id: batch.inventory_id,
        batch_id: batch.batch_id,
        medicine_name: batch.medicine_name,
        issue: 'Expired batch still has recorded stock',
        reason: `Batch ${batch.batch_number} expired on ${batch.expiration_date} but still records ${batch.current_quantity} units.`,
        suggested_correction: 'Review the batch record and follow pharmacy procedures; P.A.I. does not change stock.',
      });
    }
  });
  return { issues: issues.slice(0, 50), summary: { issue_count: issues.length } };
}

function getPerformanceSummary(pharmacyId, rows, searchActivity, expiryRisk, stockRisk, demandAnalysis) {
  const reservationStats = db.prepare(`
    SELECT COUNT(*) AS reservation_count, COALESCE(SUM(r.quantity), 0) AS reservation_units
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ?
      AND r.status IN ('pending', 'confirmed', 'completed')
      AND r.reserved_at >= datetime('now', 'start of month')
  `).get(pharmacyId);
  const topReserved = db.prepare(`
    SELECT m.name AS medicine_name, SUM(r.quantity) AS quantity_reserved
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ?
      AND r.status IN ('pending', 'confirmed', 'completed')
      AND r.reserved_at >= datetime('now', 'start of month')
    GROUP BY i.medicine_id, m.name
    ORDER BY quantity_reserved DESC, m.name ASC
    LIMIT 5
  `).all(pharmacyId);
  const movements = db.prepare(`
    SELECT COUNT(*) AS count FROM stock_transactions
    WHERE pharmacy_id = ? AND created_at >= datetime('now', '-30 days')
  `).get(pharmacyId);
  const statusCounts = {
    available: rows.filter(item => Number(item.stock_quantity) > Number(item.low_stock_threshold)).length,
    low_stock: rows.filter(item => Number(item.stock_quantity) > 0 && Number(item.stock_quantity) <= Number(item.low_stock_threshold)).length,
    out_of_stock: rows.filter(item => Number(item.stock_quantity) === 0).length,
  };
  const totalSearches = Number(searchActivity.month_search_events || 0);
  const trends = demandAnalysis.summary;

  return {
    reporting_period: 'Current calendar month to date',
    reservation_count: Number(reservationStats.reservation_count),
    reservation_units: Number(reservationStats.reservation_units),
    pharmacy_matched_searches: totalSearches,
    stock_movements_30_days: Number(movements.count),
    inventory_status: statusCounts,
    low_stock_medicines: statusCounts.low_stock,
    out_of_stock_medicines: statusCounts.out_of_stock,
    potential_expiry_risks: expiryRisk.items.length,
    demand_trends: trends,
    top_reserved_medicines: topReserved.map(item => ({
      medicine_name: item.medicine_name,
      quantity_reserved: Number(item.quantity_reserved),
    })),
    summary: `${Number(reservationStats.reservation_count)} reservations (${Number(reservationStats.reservation_units)} units), ${totalSearches} pharmacy-matched searches, ${statusCounts.low_stock} low-stock medicines, and ${expiryRisk.items.length} batches requiring expiry review during this reporting period.`,
    stock_risk_count: stockRisk.items.length,
  };
}

function getInventoryInsights(pharmacyId) {
  const rows = getInventoryRows(pharmacyId);
  const searchActivity = getSearchActivity(pharmacyId, rows.map(item => Number(item.medicine_id)));
  const stockRisk = getStockRisk(rows);
  const demandAnalysis = getDemandAnalysis(rows, searchActivity);
  const topSearched = rows
    .map(item => {
      const activity = searchActivity.get(Number(item.medicine_id));
      return {
        medicine_id: Number(item.medicine_id),
        medicine_name: item.medicine_name,
        search_count: Number(activity?.recent_searches || 0),
      };
    })
    .filter(item => item.search_count > 0)
    .sort((a, b) => b.search_count - a.search_count || a.medicine_name.localeCompare(b.medicine_name))
    .slice(0, 5);
  const expiryRisk = getExpiryRisk(pharmacyId);
  const priceAnalysis = getPriceAnalysis(pharmacyId);
  const dataQuality = getDataQualityIssues(pharmacyId);
  const performanceSummary = getPerformanceSummary(
    pharmacyId, rows, searchActivity, expiryRisk, stockRisk, demandAnalysis
  );

  return {
    generated_at: new Date().toISOString(),
    insights: stockRisk.items.slice(0, 10).map(item => ({
      title: `${item.medicine_name} is at ${item.severity} stock risk`,
      message: item.reason,
      severity: item.severity,
      medicine_name: item.medicine_name,
      current_stock: item.current_stock,
      threshold: item.threshold,
      recent_demand_units: item.recent_demand_units,
      estimated_days: item.estimated_days,
      recommendation: item.recommendation,
    })),
    summary: stockRisk.summary,
    stock_risk: stockRisk,
    demand_analysis: demandAnalysis,
    top_searched: topSearched,
    expiry_risk: expiryRisk,
    price_analysis: priceAnalysis,
    data_quality: dataQuality,
    performance_summary: performanceSummary,
  };
}

module.exports = {
  getInventoryInsights,
};
