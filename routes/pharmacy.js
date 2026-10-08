const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware');
const { eligibleBatchQuantitySql, inventoryIntegrity, publishedProductSql } = require('../services/inventory-batches');
const router = express.Router();

router.use(requireAuth, requireRole('pharmacy_staff'));

function myPharmacyId(req) {
  return req.session.user.pharmacy_id;
}

function validInventoryDate(value) {
  if (value == null || value === '') return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function getPublishingIssues(inventoryId, pharmacyId) {
  const item = db.prepare(`
    SELECT i.stock_quantity, i.price, m.name AS medicine_name, m.category,
      MAX(0, MIN(i.stock_quantity, ${eligibleBatchQuantitySql('i')}) - COALESCE((
        SELECT SUM(r.quantity) FROM reservations r
        WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')
      ), 0)) AS available_quantity,
      (SELECT COALESCE(SUM(b.current_quantity), 0) FROM medicine_batches b WHERE b.inventory_id = i.id) AS batch_quantity,
      EXISTS (
        SELECT 1 FROM medicine_batches b
        WHERE b.inventory_id = i.id AND b.current_quantity > 0
          AND b.status IN ('active','expiring_soon')
          AND TRIM(COALESCE(b.batch_number, '')) <> ''
          AND b.expiration_date IS NOT NULL
          AND date(b.expiration_date) IS NOT NULL
          AND date(b.expiration_date) >= date('now','localtime')
      ) AS has_publishable_batch
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.id = ? AND i.pharmacy_id = ?
  `).get(inventoryId, pharmacyId);
  if (!item) return null;
  const issues = [];
  if (!String(item.medicine_name || '').trim()) issues.push('Medicine name is required.');
  if (!String(item.category || '').trim()) issues.push('Category is required.');
  if (!Number.isFinite(Number(item.price)) || Number(item.price) <= 0) issues.push('Price must be greater than zero.');
  if (Number(item.available_quantity) <= 0) issues.push('Available stock must be greater than zero.');
  if (!Number(item.has_publishable_batch)) issues.push('An in-stock batch with a batch number and valid, future expiration date is required.');
  if (Number(item.stock_quantity) !== Number(item.batch_quantity)) issues.push('Physical stock must reconcile with batch quantities.');
  return issues;
}

function normalizeInventoryIds(value) {
  const values = Array.isArray(value) ? value : [value];
  const ids = [...new Set(values.map(Number))];
  return ids.length > 0 && ids.length <= 100 && ids.every(id => Number.isInteger(id) && id > 0) ? ids : null;
}

function savePublishingHistory(item, action) {
  db.prepare(`
    INSERT INTO deploy_log (pharmacy_id, inventory_id, medicine_name, brand, price, stock_quantity, action)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(item.pharmacy_id, item.id, item.medicine_name, item.brand, item.price, item.stock_quantity, action);
}

function updateFolderPublishingStatus(folderId) {
  if (!folderId) return;
  const counts = db.prepare(`
    SELECT COUNT(*) AS total, SUM(CASE WHEN deployed = 1 THEN 1 ELSE 0 END) AS published
    FROM inventory WHERE folder_id = ?
  `).get(folderId);
  const status = counts.total > 0 && Number(counts.published) === Number(counts.total)
    ? 'deployed'
    : Number(counts.published) > 0 ? 'ready' : 'draft';
  db.prepare(`UPDATE folders SET status = ?, deployed_at = CASE WHEN ? = 'deployed' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE id = ?`)
    .run(status, status, folderId);
}

function publishInventoryIds(inventoryIds, pharmacyId, userId, { recordProductHistory = true } = {}) {
  const transaction = db.transaction(() => {
    const issues = {};
    for (const id of inventoryIds) {
      const validation = getPublishingIssues(id, pharmacyId);
      if (!validation) return { error: 'One or more selected products are not in this pharmacy inventory.' };
      if (validation.length) issues[id] = validation;
    }
    if (Object.keys(issues).length) return { issues };

    const folders = new Set();
    let publishedCount = 0;
    inventoryIds.forEach(id => {
      const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(id, pharmacyId);
      if (!item.deployed) {
        db.prepare(`UPDATE inventory SET deployed = 1, deployed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
        if (recordProductHistory) {
          savePublishingHistory({ ...item, medicine_name: db.prepare('SELECT name FROM medicines WHERE id = ?').get(item.medicine_id).name }, 'deployed');
        }
        db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
          VALUES (?, ?, 'inventory', ?, 'product_published', ?)
        `).run(pharmacyId, userId, id, 'Product published.');
        publishedCount += 1;
      }
      if (item.folder_id) folders.add(item.folder_id);
    });
    folders.forEach(updateFolderPublishingStatus);
    return { published_count: publishedCount };
  });
  return transaction.immediate();
}

function consumeBatchStock(inventoryId, quantity, { batchId = null, allowExpired = false } = {}) {
  const batches = batchId
    ? [db.prepare(`
      SELECT * FROM medicine_batches WHERE id = ? AND inventory_id = ?
        AND current_quantity > 0
        AND status IN ('active','expiring_soon','expired')
        AND (status = 'expired' OR date(expiration_date) < date('now', 'localtime'))
    `).get(batchId, inventoryId)].filter(Boolean)
    : db.prepare(`
      SELECT * FROM medicine_batches
      WHERE inventory_id = ? AND current_quantity > 0
        AND status IN ('active','expiring_soon')
        AND (expiration_date IS NULL OR date(expiration_date) >= date('now', 'localtime'))
      ORDER BY CASE WHEN expiration_date IS NULL THEN 1 ELSE 0 END, date(expiration_date) ASC, id ASC
    `).all(inventoryId);
  if (batchId && !allowExpired) return null;
  let remaining = Number(quantity);
  if (batches.reduce((total, batch) => total + Number(batch.current_quantity), 0) < remaining) return null;
  const allocations = [];
  for (const batch of batches) {
    if (remaining <= 0) break;
    const removed = Math.min(remaining, Number(batch.current_quantity));
    const nextQuantity = Number(batch.current_quantity) - removed;
    const updated = db.prepare(`
      UPDATE medicine_batches SET current_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND current_quantity >= ?
    `).run(nextQuantity, nextQuantity === 0 ? (batch.status === 'expired' ? 'expired' : 'depleted') : batch.status, batch.id, removed);
    if (!updated.changes) throw new Error('Batch quantity changed during stock consumption.');
    allocations.push({ batch, quantity: removed, previous: Number(batch.current_quantity), next: nextQuantity });
    remaining -= removed;
  }
  if (remaining > 0) return null;
  return allocations;
}

// GET /api/pharmacy/dashboard
router.get('/dashboard', (req, res) => {
  const pid = myPharmacyId(req);
  const pharmacy = db.prepare(`
    SELECT id, name, address, verified, verification_status, verification_stage, correction_reason
    FROM pharmacies WHERE id = ?
  `).get(pid);

  const eligibleQuantity = eligibleBatchQuantitySql('i');
  const activeReservedUnits = `(SELECT COALESCE(SUM(r.quantity), 0) FROM reservations r
    WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup'))`;
  const availableUnits = `MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) - ${activeReservedUnits})`;

  const lowStock = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory i
    WHERE i.pharmacy_id = ? AND ${availableUnits} > 0 AND ${availableUnits} <= i.low_stock_threshold
  `).get(pid);
  const outStock = db.prepare(`SELECT COUNT(*) AS count FROM inventory i WHERE i.pharmacy_id = ? AND ${availableUnits} = 0`).get(pid);
  const pendingReservations = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'pending'
  `).get(pid);
  const confirmedReservations = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'confirmed'
  `).get(pid);
  const readyForPickupReservations = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'ready_for_pickup'
  `).get(pid);
  const completedPickups = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed'
  `).get(pid);
  const totalItems = db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = ?').get(pid);
  const totalMedicines = db.prepare(`SELECT COUNT(DISTINCT medicine_id) AS count FROM inventory WHERE pharmacy_id = ?`).get(pid);
  const totalStock = db.prepare(`SELECT COALESCE(SUM(stock_quantity), 0) AS total FROM inventory WHERE pharmacy_id = ?`).get(pid);
  const reservedStock = db.prepare(`
    SELECT COALESCE(SUM(r.quantity), 0) AS total
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status IN ('pending','confirmed','ready_for_pickup')
  `).get(pid);
  const availableItems = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory i
    WHERE i.pharmacy_id = ? AND ${availableUnits} > i.low_stock_threshold
  `).get(pid);
  const expiringSoon = db.prepare(`
    SELECT COUNT(DISTINCT inventory_id) AS count FROM medicine_batches
    WHERE pharmacy_id = ? AND current_quantity > 0 AND expiration_date IS NOT NULL
      AND date(expiration_date) BETWEEN date('now') AND date('now', '+30 days')
      AND status NOT IN ('expired', 'depleted', 'recalled', 'archived')
  `).get(pid);
  const expiringProducts = db.prepare(`
    SELECT i.id AS inventory_id, m.name AS medicine_name,
      MIN(date(b.expiration_date)) AS expiration_date,
      SUM(b.current_quantity) AS units_expiring
    FROM medicine_batches b
    JOIN inventory i ON i.id = b.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE b.pharmacy_id = ? AND b.current_quantity > 0 AND b.expiration_date IS NOT NULL
      AND date(b.expiration_date) BETWEEN date('now') AND date('now', '+30 days')
      AND b.status NOT IN ('expired', 'depleted', 'recalled', 'archived')
    GROUP BY i.id
    ORDER BY expiration_date ASC, m.name ASC LIMIT 5
  `).all(pid);
  const expiredBatches = db.prepare(`
    SELECT COUNT(*) AS count FROM medicine_batches
    WHERE pharmacy_id = ? AND current_quantity > 0 AND expiration_date IS NOT NULL
      AND (status = 'expired' OR date(expiration_date) < date('now','localtime'))
  `).get(pid);
  const unpublishedItems = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = ? AND deployed = 0
  `).get(pid);
  const todaysReservations = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND date(r.reserved_at, 'localtime') = date('now', 'localtime')
  `).get(pid);
  const estimatedInventoryValue = db.prepare(`
    SELECT COALESCE(SUM(price * stock_quantity), 0) AS total FROM inventory WHERE pharmacy_id = ?
  `).get(pid);
  const sales = db.prepare(`
    SELECT
      COALESCE(SUM(CASE
        WHEN date(r.completed_at, 'localtime') = date('now', 'localtime')
        THEN r.quantity * COALESCE(r.price_at_reservation, i.price) ELSE 0 END), 0) AS today,
      COALESCE(SUM(CASE
        WHEN date(r.completed_at, 'localtime') >= date(
          'now', 'localtime',
          '-' || ((CAST(strftime('%w', 'now', 'localtime') AS INTEGER) + 6) % 7) || ' days'
        ) THEN r.quantity * COALESCE(r.price_at_reservation, i.price) ELSE 0 END), 0) AS thisWeek,
      COALESCE(SUM(CASE
        WHEN strftime('%Y-%m', r.completed_at, 'localtime') = strftime('%Y-%m', 'now', 'localtime')
        THEN r.quantity * COALESCE(r.price_at_reservation, i.price) ELSE 0 END), 0) AS thisMonth
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed' AND r.completed_at IS NOT NULL
  `).get(pid);
  const unreadNotifications = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0
  `).get(req.session.user.id);
  const deployedItems = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND ${publishedProductSql('i', 'm')}
  `).get(pid);
  const deployedFolders = db.prepare(`SELECT COUNT(*) AS count FROM folders WHERE pharmacy_id = ? AND status = 'deployed'`).get(pid);
  const visiblePublishedProduct = publishedProductSql('i', 'm');
  const activeDeployedFolder = db.prepare(`
    SELECT f.id, f.name, MAX(i.deployed_at) AS deployed_at
    FROM folders f JOIN inventory i ON i.folder_id = f.id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE f.pharmacy_id = ? AND ${visiblePublishedProduct}
    GROUP BY f.id ORDER BY MAX(i.deployed_at) DESC, f.id DESC LIMIT 1
  `).get(pid) || null;
  const totalFolders = db.prepare('SELECT COUNT(*) AS count FROM folders WHERE pharmacy_id = ?').get(pid);
  const deployedThisMonth = db.prepare(`
    SELECT COUNT(*) AS count FROM folder_deploy_log
    WHERE pharmacy_id = ? AND action = 'deployed' AND strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')
  `).get(pid);

  // Inventory-by-category breakdown, for the 3D inventory pie chart.
  const inventoryByCategory = db.prepare(`
    SELECT COALESCE(m.category, 'Uncategorized') AS category, COUNT(*) AS count,
      COALESCE(SUM(i.price * i.stock_quantity), 0) AS value
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ?
    GROUP BY category ORDER BY count DESC
  `).all(pid);

  const stockByStatus = db.prepare(`
    SELECT CASE
      WHEN ${availableUnits} = 0 THEN 'Out of Stock'
      WHEN ${availableUnits} <= i.low_stock_threshold THEN 'Low Stock'
      ELSE 'Available'
    END AS status, COUNT(*) AS count
    FROM inventory i WHERE i.pharmacy_id = ? GROUP BY status
  `).all(pid);
  const publishedVsUnpublished = db.prepare(`
    SELECT CASE WHEN ${publishedProductSql('i', 'm')} THEN 1 ELSE 0 END AS deployed, COUNT(*) AS count
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? GROUP BY 1
  `).all(pid);
  const reservationTrend = db.prepare(`
    SELECT date(r.reserved_at, 'localtime') AS day, COUNT(*) AS count
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND date(r.reserved_at, 'localtime') >= date('now', 'localtime', '-29 days')
    GROUP BY day ORDER BY day
  `).all(pid);
  const topReservedMedicines = db.prepare(`
    SELECT m.name AS medicine_name, SUM(r.quantity) AS quantity_reserved,
      i.stock_quantity, i.low_stock_threshold,
      ${availableUnits} AS available_quantity
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND r.status <> 'cancelled'
    GROUP BY i.id ORDER BY quantity_reserved DESC, m.name ASC LIMIT 5
  `).all(pid);
  const recentReservations = db.prepare(`
    SELECT r.id, r.quantity, r.reserved_at, r.status,
      u.name AS customer_name, m.name AS medicine_name
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN users u ON u.id = r.customer_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? ORDER BY r.reserved_at DESC LIMIT 8
  `).all(pid);
  const outOfStockMedicines = db.prepare(`
    SELECT i.id, m.name AS medicine_name, i.stock_quantity,
      ${availableUnits} AS available_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND ${availableUnits} = 0 ORDER BY m.name LIMIT 5
  `).all(pid);
  const lowStockMedicines = db.prepare(`
    SELECT i.id, m.name AS medicine_name, i.stock_quantity, i.low_stock_threshold,
      ${availableUnits} AS available_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ?
      AND ${availableUnits} > 0
      AND ${availableUnits} <= i.low_stock_threshold
    ORDER BY available_quantity ASC, m.name LIMIT 5
  `).all(pid);
  const unpublishedMedicines = db.prepare(`
    SELECT i.id, m.name AS medicine_name, f.name AS folder_name
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    LEFT JOIN folders f ON f.id = i.folder_id
    WHERE i.pharmacy_id = ? AND NOT ${publishedProductSql('i', 'm')} ORDER BY m.name LIMIT 5
  `).all(pid);

  res.json({
    pharmacy,
    activeDeployedFolder,
    stats: {
      lowStock: lowStock.count,
      outOfStock: outStock.count,
      pendingReservations: pendingReservations.count,
      confirmedReservations: confirmedReservations.count,
      readyForPickupReservations: readyForPickupReservations.count,
      completedPickups: completedPickups.count,
      totalItems: totalItems.count,
      totalMedicines: totalMedicines.count,
      totalStock: Number(totalStock.total || 0),
      reservedStock: Number(reservedStock.total || 0),
      expiringSoon: expiringSoon.count,
      expired: expiredBatches.count,
      availableItems: availableItems.count,
      todaysReservations: todaysReservations.count,
      unpublishedItems: unpublishedItems.count,
      deployedItems: deployedItems.count,
      deployedFolders: deployedFolders.count,
      totalFolders: totalFolders.count,
      deployedThisMonth: deployedThisMonth.count,
      estimatedInventoryValue: +estimatedInventoryValue.total.toFixed(2),
      salesToday: Number(sales.today || 0),
      salesThisWeek: Number(sales.thisWeek || 0),
      salesThisMonth: Number(sales.thisMonth || 0),
      unreadNotifications: unreadNotifications.count,
    },
    inventoryByCategory,
    stockByStatus,
    publishedVsUnpublished,
    reservationTrend,
    topReservedMedicines,
    recentReservations,
    attention: { outOfStockMedicines, lowStockMedicines, unpublishedMedicines, expiringProducts },
  });
});


// ---- Folders ----

// GET /api/pharmacy/folders — each folder with its product count & value
router.get('/folders', (req, res) => {
  const pid = myPharmacyId(req);
  const folders = db.prepare(`
    SELECT f.*, COUNT(i.id) AS product_count,
      SUM(CASE WHEN i.deployed = 1 THEN 1 ELSE 0 END) AS published_count,
      SUM(CASE WHEN i.deployed = 0 THEN 1 ELSE 0 END) AS unpublished_count,
      COALESCE(SUM(i.price * i.stock_quantity),0) AS estimated_value
    FROM folders f LEFT JOIN inventory i ON i.folder_id = f.id
    WHERE f.pharmacy_id = ? GROUP BY f.id ORDER BY f.created_at DESC
  `).all(pid);
  const unassigned = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = ? AND folder_id IS NULL
  `).get(pid);
  res.json({ folders, unassignedCount: unassigned.count });
});

// POST /api/pharmacy/folders  { name }
router.post('/folders', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(422).json({ error: 'Folder name is required.' });
  const info = db.prepare(`INSERT INTO folders (pharmacy_id, name, status) VALUES (?, ?, 'draft')`).run(myPharmacyId(req), name);
  res.status(201).json({ id: info.lastInsertRowid });
});

// PUT /api/pharmacy/folders/:id  { name }
router.put('/folders/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  const name = (req.body.name || '').trim();
  if (!name) return res.status(422).json({ error: 'Folder name is required.' });
  db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(name, folder.id);
  res.json({ ok: true });
});

// DELETE /api/pharmacy/folders/:id — products are unassigned and unpublished, never deleted
router.delete('/folders/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  const tx = db.transaction(() => {
    const items = db.prepare('SELECT * FROM inventory WHERE folder_id = ? AND deployed = 1').all(folder.id);
    items.forEach(item => {
      db.prepare('UPDATE inventory SET folder_id = NULL, deployed = 0, deployed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(item.id);
      savePublishingHistory({ ...item, medicine_name: db.prepare('SELECT name FROM medicines WHERE id = ?').get(item.medicine_id).name }, 'undeployed');
    });
    db.prepare('UPDATE inventory SET folder_id = NULL WHERE folder_id = ?').run(folder.id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
  });
  tx();
  res.json({ ok: true });
});

// POST /api/pharmacy/folders/:id/ready — mark draft folder as ready to publish
router.post('/folders/:id/ready', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  if (folder.status === 'archived') return res.status(422).json({ error: 'Archived folders cannot be marked ready.' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(folder.id).c;
  if (!count) return res.status(422).json({ error: 'Add at least one product to this folder first.' });
  db.prepare(`UPDATE folders SET status = 'ready' WHERE id = ?`).run(folder.id);
  res.json({ ok: true });
});

// POST /api/pharmacy/folders/:id/deploy — bulk-publishes valid products in a folder
router.post('/folders/:id/deploy', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  if (folder.status === 'archived') return res.status(422).json({ error: 'Archived folders cannot be published.' });
  const ids = db.prepare('SELECT id FROM inventory WHERE folder_id = ? AND deployed = 0 ORDER BY id').all(folder.id).map(item => item.id);
  if (!ids.length) return res.status(422).json({ error: 'This folder has no unpublished products.' });
  const result = publishInventoryIds(ids, folder.pharmacy_id, req.session.user.id, { recordProductHistory: false });
  if (result.issues) return res.status(422).json({ error: 'Some products need attention before they can be published.', product_issues: result.issues });
  if (result.error) return res.status(422).json({ error: result.error });
  const count = result.published_count;
  db.transaction(() => {
    db.prepare(`
      INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?,?,?,?,'deployed')
    `).run(folder.pharmacy_id, folder.id, folder.name, count);
  })();
  res.json({ ok: true, product_count: count });
});

// POST /api/pharmacy/inventory/:id/deploy { folder_id } — compatibility route for moving and publishing one product.
router.post('/inventory/:id/deploy', (req, res) => {
  const pid = myPharmacyId(req);
  const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(req.params.id, pid);
  if (!item) return res.status(404).json({ error: 'Inventory item not found.' });
  const folderId = Number(req.body.folder_id);
  if (!Number.isInteger(folderId) || folderId <= 0) return res.status(422).json({ error: 'Choose a destination folder.' });
  const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND pharmacy_id = ?').get(folderId, pid);
  if (!folder || folder.status === 'archived') return res.status(422).json({ error: 'Choose a valid, non-archived folder.' });

  const issues = getPublishingIssues(item.id, pid);
  if (issues?.length) return res.status(422).json({ error: 'This product needs attention before it can be published.', issues });
  const oldFolderId = item.folder_id;
  const tx = db.transaction(() => {
    db.prepare('UPDATE inventory SET folder_id = ?, deployed = 1, deployed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(folder.id, item.id);
    savePublishingHistory({ ...item, medicine_name: db.prepare('SELECT name FROM medicines WHERE id = ?').get(item.medicine_id).name }, 'deployed');
    updateFolderPublishingStatus(oldFolderId);
    updateFolderPublishingStatus(folder.id);
  });
  tx.immediate();
  res.json({ ok: true, folder_id: folder.id, folder_name: folder.name });
});

// POST /api/pharmacy/folders/:id/undeploy — pulls every product in the folder back out of customer view
router.post('/folders/:id/undeploy', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  const publishedCount = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ? AND deployed = 1').get(folder.id).c;
  if (!Number(publishedCount)) return res.status(422).json({ error: 'This folder has no published products.' });
  const count = publishedCount;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE folders SET status = 'ready' WHERE id = ?`).run(folder.id);
    const items = db.prepare('SELECT * FROM inventory WHERE folder_id = ? AND deployed = 1').all(folder.id);
    items.forEach(item => {
      db.prepare(`UPDATE inventory SET deployed = 0, deployed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(item.id);
      db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
        VALUES (?, ?, 'inventory', ?, 'product_unpublished', ?)
      `).run(folder.pharmacy_id, req.session.user.id, item.id, `Unpublished with folder "${folder.name}"; inventory and stock were retained.`);
    });
    db.prepare(`
      INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?,?,?,?,'undeployed')
    `).run(folder.pharmacy_id, folder.id, folder.name, count);
  });
  tx();
  res.json({ ok: true });
});

// POST /api/pharmacy/folders/:id/archive — retires a folder (undeploys it and marks archived)
router.post('/folders/:id/archive', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  const wasDeployed = folder.status === 'deployed';
  const count = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(folder.id).c;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE folders SET status = 'archived' WHERE id = ?`).run(folder.id);
    const items = db.prepare('SELECT * FROM inventory WHERE folder_id = ? AND deployed = 1').all(folder.id);
    items.forEach(item => {
      db.prepare(`UPDATE inventory SET deployed = 0, deployed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(item.id);
      db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
        VALUES (?, ?, 'inventory', ?, 'product_unpublished', ?)
      `).run(folder.pharmacy_id, req.session.user.id, item.id, `Unpublished when folder "${folder.name}" was archived; inventory and stock were retained.`);
    });
    if (wasDeployed) {
      db.prepare(`
        INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?,?,?,?,'undeployed')
      `).run(folder.pharmacy_id, folder.id, folder.name, count);
    }
  });
  tx();
  res.json({ ok: true });
});

// GET /api/pharmacy/deploy-log?month=YYYY-MM&folder_id=&q= — publishing history
router.get('/deploy-log', (req, res) => {
  const pid = myPharmacyId(req);
  const { month, folder_id, q } = req.query;
  const folderClauses = ['pharmacy_id = ?'];
  const folderParams = [pid];
  if (month) { folderClauses.push(`strftime('%Y-%m', created_at) = ?`); folderParams.push(month); }
  if (folder_id) { folderClauses.push('folder_id = ?'); folderParams.push(folder_id); }
  if (q) { folderClauses.push('folder_name LIKE ?'); folderParams.push(`%${q}%`); }
  const folderHistory = db.prepare(`
    SELECT * FROM folder_deploy_log WHERE ${folderClauses.join(' AND ')}
  `).all(...folderParams);

  const withFolderProducts = folderHistory.map(h => {
    const products = db.prepare(`
      SELECT m.name, i.brand FROM inventory i JOIN medicines m ON m.id = i.medicine_id WHERE i.folder_id = ?
    `).all(h.folder_id);
    return { ...h, products };
  });

  const productClauses = ['d.pharmacy_id = ?'];
  const productParams = [pid];
  if (month) { productClauses.push(`strftime('%Y-%m', d.created_at) = ?`); productParams.push(month); }
  if (folder_id) { productClauses.push('i.folder_id = ?'); productParams.push(folder_id); }
  if (q) {
    productClauses.push('(d.medicine_name LIKE ? OR COALESCE(f.name, \'\') LIKE ?)');
    productParams.push(`%${q}%`, `%${q}%`);
  }
  const productHistory = db.prepare(`
    SELECT d.id, d.pharmacy_id, i.folder_id, COALESCE(f.name, d.medicine_name) AS folder_name,
      d.medicine_name, d.brand, d.action, d.created_at
    FROM deploy_log d
    LEFT JOIN inventory i ON i.id = d.inventory_id
    LEFT JOIN folders f ON f.id = i.folder_id
    WHERE ${productClauses.join(' AND ')}
  `).all(...productParams).map(row => ({
    ...row,
    product_count: 1,
    products: [{ name: row.medicine_name, brand: row.brand }],
  }));
  const withProducts = [...withFolderProducts, ...productHistory]
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 50);

  const visiblePublishedProduct = publishedProductSql('i', 'm');
  const deployedValue = db.prepare(`
    SELECT COALESCE(SUM(price * stock_quantity), 0) AS total, COUNT(*) AS count
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND ${visiblePublishedProduct}
  `).get(pid);

  res.json({
    history: withProducts,
    deployedStats: { estimatedValue: +deployedValue.total.toFixed(2), deployedCount: deployedValue.count },
  });
});

// ---- Inventory ----

// GET /api/pharmacy/inventory
router.get('/inventory', (req, res) => {
  const pid = myPharmacyId(req);
  const eligibleQuantity = eligibleBatchQuantitySql('i');
  const customerVisible = publishedProductSql('i', 'm');
  const rows = db.prepare(`
    SELECT i.*, m.name AS medicine_name, m.category, f.name AS folder_name, f.status AS folder_status,
      CASE WHEN ${customerVisible} THEN 1 ELSE 0 END AS customer_visible,
      COALESCE((SELECT SUM(quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')), 0) AS reserved_quantity,
      ${eligibleQuantity} AS eligible_batch_quantity,
      (SELECT COALESCE(SUM(current_quantity), 0) FROM medicine_batches b WHERE b.inventory_id = i.id) AS batch_quantity,
      (SELECT MIN(b.expiration_date) FROM medicine_batches b
        WHERE b.inventory_id = i.id AND b.current_quantity > 0 AND b.expiration_date IS NOT NULL
          AND b.status NOT IN ('depleted','recalled','archived')) AS next_expiration_date,
      (SELECT COUNT(*) FROM medicine_batches b WHERE b.inventory_id = i.id AND b.status IN ('expired','expiring_soon')) AS batch_alert_count
    FROM inventory i
    JOIN medicines m ON m.id = i.medicine_id
    LEFT JOIN folders f ON f.id = i.folder_id
    LEFT JOIN medicine_batches b ON b.inventory_id = i.id
    WHERE i.pharmacy_id = ?
    GROUP BY i.id
    ORDER BY m.name ASC
  `).all(pid).map(item => ({
    ...item,
    reserved_quantity: Number(item.reserved_quantity || 0),
    eligible_batch_quantity: Number(item.eligible_batch_quantity || 0),
    available_quantity: Math.max(0, Math.min(Number(item.stock_quantity || 0), Number(item.eligible_batch_quantity || 0)) - Number(item.reserved_quantity || 0)),
    ...inventoryIntegrity(db, item.id, item.stock_quantity),
    publish_issues: getPublishingIssues(item.id, pid) || [],
  }));
  const medicines = db.prepare('SELECT * FROM medicines ORDER BY name ASC').all();
  const folders = db.prepare(`SELECT id, name, status FROM folders WHERE pharmacy_id = ? ORDER BY name ASC`).all(pid);
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE pharmacy_id = ? ORDER BY name ASC').all(pid);
  const batches = db.prepare(`
    SELECT b.*, m.name AS medicine_name, s.name AS supplier_name,
      CASE
        WHEN b.current_quantity > 0 AND (b.status = 'expired' OR (b.expiration_date IS NOT NULL
          AND date(b.expiration_date) < date('now','localtime'))) THEN 'expired'
        WHEN b.current_quantity > 0 AND b.expiration_date IS NOT NULL
          AND date(b.expiration_date) <= date('now','localtime','+30 days') THEN 'within_30_days'
        WHEN b.current_quantity > 0 AND b.expiration_date IS NOT NULL
          AND date(b.expiration_date) <= date('now','localtime','+90 days') THEN 'within_90_days'
        ELSE NULL
      END AS expiration_warning
    FROM medicine_batches b
    JOIN medicines m ON m.id = b.medicine_id
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.pharmacy_id = ? ORDER BY b.expiration_date ASC, b.created_at DESC
  `).all(pid);
  res.json({ inventory: rows, medicines, folders, suppliers, batches });
});

router.post('/inventory/publish', (req, res) => {
  const inventoryIds = normalizeInventoryIds(req.body.inventory_ids ?? req.body.inventory_id);
  if (!inventoryIds) return res.status(422).json({ error: 'Select between 1 and 100 valid products to publish.' });
  const result = publishInventoryIds(inventoryIds, myPharmacyId(req), req.session.user.id);
  if (result.error) return res.status(404).json({ error: result.error });
  if (result.issues) {
    return res.status(422).json({
      error: 'Some products need attention before they can be published.',
      product_issues: result.issues,
    });
  }
  res.json({ ok: true, published_count: result.published_count });
});

router.post('/inventory/unpublish', (req, res) => {
  const inventoryIds = normalizeInventoryIds(req.body.inventory_ids ?? req.body.inventory_id);
  if (!inventoryIds) return res.status(422).json({ error: 'Select between 1 and 100 valid products to unpublish.' });
  const pid = myPharmacyId(req);
  const tx = db.transaction(() => {
    const folders = new Set();
    let unpublishedCount = 0;
    const items = inventoryIds.map(id => db.prepare('SELECT i.*, m.name AS medicine_name FROM inventory i JOIN medicines m ON m.id = i.medicine_id WHERE i.id = ? AND i.pharmacy_id = ?').get(id, pid));
    if (items.some(item => !item)) return { error: 'One or more selected products are not in this pharmacy inventory.' };
    for (const item of items) {
      const id = item.id;
      if (item.deployed) {
        db.prepare(`UPDATE inventory SET deployed = 0, deployed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(id);
        savePublishingHistory(item, 'undeployed');
        db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
          VALUES (?, ?, 'inventory', ?, 'product_unpublished', ?)
        `).run(pid, req.session.user.id, id, 'Product unpublished; inventory and stock were retained.');
        unpublishedCount += 1;
      }
      if (item.folder_id) folders.add(item.folder_id);
    }
    folders.forEach(updateFolderPublishingStatus);
    return { unpublished_count: unpublishedCount };
  });
  const result = tx.immediate();
  if (result.error) return res.status(404).json({ error: result.error });
  res.json({ ok: true, unpublished_count: result.unpublished_count });
});

router.post('/medicines', (req, res) => {
  const name = String(req.body.name || '').trim();
  const category = String(req.body.category || '').trim() || null;
  if (!name) return res.status(422).json({ error: 'Medicine name is required.' });

  const existing = db.prepare('SELECT * FROM medicines WHERE lower(name) = lower(?) LIMIT 1').get(name);
  if (existing) {
    return res.json({ id: existing.id, created: false });
  }

  const info = db.prepare('INSERT INTO medicines (name, category) VALUES (?, ?)').run(name, category);
  res.status(201).json({ id: info.lastInsertRowid, created: true });
});

// POST /api/pharmacy/inventory  { medicine_id, brand, price, stock_quantity, low_stock_threshold, folder_id, batch_number, expiration_date }
router.post('/inventory', (req, res) => {
  const { medicine_id, brand, price, stock_quantity, low_stock_threshold, folder_id, batch_number, expiration_date, medicine_name, category } = req.body;
  const pid = myPharmacyId(req);
  let resolvedMedicineId = medicine_id ? Number(medicine_id) : null;

  if (!resolvedMedicineId && medicine_name) {
    const med = db.prepare('SELECT * FROM medicines WHERE lower(name) = lower(?) LIMIT 1').get(medicine_name.trim());
    resolvedMedicineId = med ? med.id : null;
    if (med && !String(med.category || '').trim() && String(category || '').trim()) {
      db.prepare('UPDATE medicines SET category = ? WHERE id = ?').run(String(category).trim(), med.id);
    }
  }

  if (!resolvedMedicineId && medicine_name) {
    const created = db.prepare('INSERT INTO medicines (name, category) VALUES (?, ?)').run(String(medicine_name).trim(), (category || '').trim() || null);
    resolvedMedicineId = created.lastInsertRowid;
  }

  if (!resolvedMedicineId || price == null || stock_quantity == null) {
    return res.status(422).json({ error: 'Medicine name, price and stock_quantity are required.' });
  }

  let resolvedFolderId = null;
  if (folder_id) {
    const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(folder_id);
    if (!folder || folder.pharmacy_id !== pid) {
      return res.status(422).json({ error: 'Invalid folder.' });
    }
    resolvedFolderId = folder.id;
  }

  const initialStock = Number(stock_quantity);
  if (!Number.isInteger(initialStock) || initialStock < 0) {
    return res.status(422).json({ error: 'Initial stock must be a non-negative whole number.' });
  }
  try {
    const insertedId = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO inventory (pharmacy_id, medicine_id, folder_id, price, stock_quantity, low_stock_threshold, brand)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(pid, resolvedMedicineId, resolvedFolderId, price, initialStock, low_stock_threshold || 10, (brand || '').trim() || null);
      const id = Number(info.lastInsertRowid);
      let batchId = null;
      const batch = initialStock > 0
        ? ((batch_number || '').trim() || `OPENING-${id}-${Date.now()}`)
        : null;
      if (initialStock > 0) {
        const batchInsert = db.prepare(`
          INSERT INTO medicine_batches (pharmacy_id, medicine_id, inventory_id, batch_number, expiration_date, quantity_received, current_quantity, date_received)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(pid, resolvedMedicineId, id, batch, expiration_date || null, initialStock, initialStock, new Date().toISOString());
        batchId = Number(batchInsert.lastInsertRowid);
        db.prepare(`INSERT INTO stock_transactions (
          pharmacy_id, medicine_id, inventory_id, batch_id, transaction_type, quantity,
          previous_quantity, new_quantity, reason, reference_number, staff_user_id, remarks
        ) VALUES (?, ?, ?, ?, 'stock_in', ?, 0, ?, 'initial_stock', ?, ?, 'Initial product stock receipt')`).run(
          pid, resolvedMedicineId, id, batchId, initialStock, initialStock, batch || null, req.session.user.id
        );
      }
      db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
        VALUES (?, ?, 'inventory', ?, 'product_created', ?)
      `).run(pid, req.session.user.id, id, `Created product with ${initialStock} initial stock unit(s).`);
      return id;
    })();
    res.status(201).json({ id: insertedId });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(422).json({ error: 'This medicine is already in your inventory. Edit it instead.' });
    }
    res.status(500).json({ error: 'Could not add inventory item.' });
  }
});

// PUT /api/pharmacy/inventory/:id
router.put('/inventory/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your pharmacy inventory.' });

  const { price, stock_quantity, low_stock_threshold, brand, category, expiration_date, expiration_change_reason } = req.body;
  if (stock_quantity !== undefined) {
    return res.status(422).json({ error: 'Stock cannot be edited here. Use a recorded stock movement.' });
  }
  const expirationProvided = expiration_date !== undefined;
  let batchToUpdate = null;
  if (expirationProvided) {
    const nextExpiration = String(expiration_date || '').trim() || null;
    if (nextExpiration && !validInventoryDate(nextExpiration)) {
      return res.status(422).json({ error: 'Expiration must be a valid calendar date.' });
    }
    batchToUpdate = db.prepare(`
      SELECT * FROM medicine_batches
      WHERE inventory_id = ? AND current_quantity > 0
        AND status NOT IN ('depleted','recalled','archived')
      ORDER BY CASE WHEN expiration_date IS NULL THEN 1 ELSE 0 END, date(expiration_date) ASC, id ASC
      LIMIT 1
    `).get(item.id);
    if (!batchToUpdate) return res.status(422).json({ error: 'No stocked batch is available to edit. Record a stock receipt first.' });
    const normalizedExpiration = nextExpiration;
    if (normalizedExpiration !== batchToUpdate.expiration_date) {
      if (!String(expiration_change_reason || '').trim()) {
        return res.status(422).json({ error: 'A reason is required when changing a batch expiration date.' });
      }
      if (normalizedExpiration && batchToUpdate.manufacturing_date
          && normalizedExpiration < batchToUpdate.manufacturing_date) {
        return res.status(422).json({ error: 'Expiration cannot be earlier than the batch manufacturing date.' });
      }
    }
  }
  db.transaction(() => {
    db.prepare(`
      UPDATE inventory SET price = ?, low_stock_threshold = ?, brand = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      price != null ? price : item.price,
      low_stock_threshold != null ? low_stock_threshold : item.low_stock_threshold,
      brand !== undefined ? ((brand || '').trim() || null) : item.brand,
      item.id
    );
    if (category !== undefined) {
      db.prepare('UPDATE medicines SET category = ? WHERE id = ?').run(String(category || '').trim() || null, item.medicine_id);
    }
    if (batchToUpdate && expirationProvided) {
      const nextExpiration = String(expiration_date || '').trim() || null;
      if (nextExpiration !== batchToUpdate.expiration_date) {
        const today = new Date().toISOString().slice(0, 10);
        const status = !nextExpiration ? 'active'
          : nextExpiration < today ? 'expired'
            : nextExpiration <= new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10) ? 'expiring_soon'
              : 'active';
        db.prepare(`
          UPDATE medicine_batches
          SET expiration_date = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND inventory_id = ?
        `).run(nextExpiration, status, batchToUpdate.id, item.id);
        db.prepare(`
          INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
          VALUES (?, ?, 'medicine_batch', ?, 'batch_expiration_updated', ?)
        `).run(
          item.pharmacy_id, req.session.user.id, batchToUpdate.id,
          `Changed expiration for batch ${batchToUpdate.batch_number} from ${batchToUpdate.expiration_date || 'not recorded'} to ${nextExpiration || 'not recorded'}. Reason: ${String(expiration_change_reason || '').trim()}`
        );
      }
    }
  })();
  res.json({ ok: true });
});

router.post('/inventory/reconcile-batches', (req, res) => {
  const pid = myPharmacyId(req);
  const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(req.body.inventory_id, pid);
  if (!item) return res.status(404).json({ error: 'Inventory item not found.' });
  const reason = String(req.body.reason || '').trim();
  if (!reason) return res.status(422).json({ error: 'A reason is required to reconcile batch integrity.' });

  const transaction = db.transaction(() => {
    const current = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(item.id, pid);
    const batchTotal = Number(db.prepare(`
      SELECT COALESCE(SUM(current_quantity), 0) AS total
      FROM medicine_batches WHERE inventory_id = ?
    `).get(item.id).total);
    const reserved = Number(db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations
      WHERE inventory_id = ? AND status IN ('pending','confirmed','ready_for_pickup')
    `).get(item.id).total);
    if (batchTotal < reserved) {
      return { error: 'Batch quantity is below active reservations. Resolve reservations before reconciling.', status: 422 };
    }
    const previous = Number(current.stock_quantity);
    const delta = batchTotal - previous;
    if (delta === 0) return { error: 'Inventory already matches its batch total.', status: 422 };
    db.prepare(`UPDATE inventory SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(batchTotal, item.id);
    db.prepare(`
      INSERT INTO stock_transactions (
        pharmacy_id, medicine_id, inventory_id, transaction_type, quantity,
        previous_quantity, new_quantity, reason, staff_user_id, remarks
      ) VALUES (?, ?, ?, 'adjustment', ?, ?, ?, 'batch_reconciliation', ?, ?)
    `).run(
      pid, item.medicine_id, item.id, delta, previous, batchTotal, req.session.user.id,
      `Reconciled physical stock to batch total. Reason: ${reason}`
    );
    db.prepare(`
      INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'inventory', ?, 'batch_integrity_reconciled', ?)
    `).run(pid, req.session.user.id, item.id, `Physical stock changed from ${previous} to ${batchTotal} to match batches. Reason: ${reason}`);
    return { previous_quantity: previous, batch_quantity: batchTotal, adjustment: delta };
  });
  const result = transaction.immediate();
  if (result.error) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, ...result });
});

// PUT /api/pharmacy/inventory/:id/move  { folder_id }  — move a product into a folder, or null to unassign.
// Moving a deployed item out of its deployed folder automatically un-publishes it, since
// deployment status belongs to the folder, not the individual item.
router.put('/inventory/:id/move', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your pharmacy inventory.' });

  let targetFolder = null;
  if (req.body.folder_id) {
    targetFolder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.body.folder_id);
    if (!targetFolder || targetFolder.pharmacy_id !== myPharmacyId(req) || targetFolder.status === 'archived') {
      return res.status(422).json({ error: 'Invalid folder.' });
    }
  }
  const oldFolderId = item.folder_id;
  db.transaction(() => {
    db.prepare('UPDATE inventory SET folder_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(targetFolder ? targetFolder.id : null, item.id);
    updateFolderPublishingStatus(oldFolderId);
    updateFolderPublishingStatus(targetFolder?.id);
  })();
  res.json({ ok: true });
});

// DELETE /api/pharmacy/inventory/:id
router.delete('/inventory/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your pharmacy inventory.' });
  if (Number(item.stock_quantity) > 0) {
    return res.status(422).json({ error: 'Record a stock-out or adjustment before removing a product with physical stock.' });
  }
  const batchRecords = db.prepare('SELECT COUNT(*) AS count FROM medicine_batches WHERE inventory_id = ?').get(item.id);
  if (Number(batchRecords.count) > 0) {
    return res.status(422).json({ error: 'Products with batch history cannot be removed; reconcile their stock instead.' });
  }
  const linkedRecords = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM stock_transactions WHERE inventory_id = ?) +
      (SELECT COUNT(*) FROM reservations WHERE inventory_id = ?) AS total
  `).get(item.id, item.id);
  if (Number(linkedRecords.total) > 0) {
    return res.status(422).json({ error: 'Products with transaction or reservation history cannot be removed.' });
  }
  db.prepare('DELETE FROM inventory WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

router.post('/suppliers', (req, res) => {
  const pid = myPharmacyId(req);
  const { name, contact_person, phone, email, address, status, notes } = req.body;
  if (!name || !String(name).trim()) return res.status(422).json({ error: 'Supplier name is required.' });
  const info = db.prepare(`
    INSERT INTO suppliers (pharmacy_id, name, contact_person, phone, email, address, status, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(pid, String(name).trim(), (contact_person || '').trim() || null, (phone || '').trim() || null, (email || '').trim() || null, (address || '').trim() || null, status || 'active', (notes || '').trim() || null);
  res.status(201).json({ id: info.lastInsertRowid });
});

router.get('/suppliers', (req, res) => {
  const pid = myPharmacyId(req);
  const medicineId = req.query.medicine_id ? Number(req.query.medicine_id) : null;
  if (req.query.medicine_id && (!Number.isInteger(medicineId) || medicineId < 1)) {
    return res.status(422).json({ error: 'Medicine ID must be a positive whole number.' });
  }
  const rows = db.prepare(`
    SELECT s.*,
      (SELECT COUNT(DISTINCT b.inventory_id) FROM medicine_batches b
       WHERE b.supplier_id = s.id AND (? IS NULL OR b.medicine_id = ?)) AS products_supplied,
      COALESCE(
        (SELECT MAX(b.date_received) FROM medicine_batches b WHERE b.supplier_id = s.id),
        (SELECT MAX(t.created_at) FROM stock_transactions t
         WHERE t.supplier_id = s.id AND t.transaction_type = 'stock_in')
      ) AS last_delivery_date,
      (SELECT COUNT(*) FROM stock_transactions delivery
       WHERE delivery.supplier_id = s.id AND delivery.transaction_type = 'stock_in') AS delivery_count
    FROM suppliers s
    WHERE s.pharmacy_id = ?
      AND (? IS NULL OR EXISTS (
        SELECT 1 FROM medicine_batches matching
        WHERE matching.supplier_id = s.id AND matching.medicine_id = ?
      ))
    ORDER BY s.name COLLATE NOCASE
  `).all(medicineId, medicineId, pid, medicineId, medicineId);
  res.json({ suppliers: rows });
});

router.get('/suppliers/:id', (req, res) => {
  const pid = myPharmacyId(req);
  const supplier = db.prepare('SELECT * FROM suppliers WHERE id = ? AND pharmacy_id = ?')
    .get(req.params.id, pid);
  if (!supplier) return res.status(404).json({ error: 'Supplier not found.' });
  const products = db.prepare(`
    SELECT i.id AS inventory_id, m.id AS medicine_id, m.name AS medicine_name,
      i.brand, m.category, SUM(b.quantity_received) AS units_received,
      MAX(b.date_received) AS last_delivery_date
    FROM medicine_batches b
    JOIN inventory i ON i.id = b.inventory_id
    JOIN medicines m ON m.id = b.medicine_id
    WHERE b.pharmacy_id = ? AND b.supplier_id = ?
    GROUP BY i.id ORDER BY m.name COLLATE NOCASE
  `).all(pid, supplier.id);
  const deliveries = db.prepare(`
    SELECT t.id, t.quantity, t.created_at, t.reference_number, t.remarks,
      t.batch_id, b.batch_number, m.id AS medicine_id, m.name AS medicine_name,
      u.name AS staff_name
    FROM stock_transactions t
    JOIN medicines m ON m.id = t.medicine_id
    LEFT JOIN medicine_batches b ON b.id = t.batch_id
    LEFT JOIN users u ON u.id = t.staff_user_id
    WHERE t.pharmacy_id = ? AND t.supplier_id = ? AND t.transaction_type = 'stock_in'
    ORDER BY t.created_at DESC, t.id DESC LIMIT 100
  `).all(pid, supplier.id);
  const deliveryCount = db.prepare(`
    SELECT COUNT(*) AS total FROM stock_transactions
    WHERE pharmacy_id = ? AND supplier_id = ? AND transaction_type = 'stock_in'
  `).get(pid, supplier.id).total;
  res.json({
    supplier,
    products,
    deliveries,
    delivery_count: Number(deliveryCount),
    last_delivery_date: deliveries[0]?.created_at || null,
    total_purchases: null,
  });
});

router.post('/inventory/stock-in', (req, res) => {
  const pid = myPharmacyId(req);
  const {
    inventory_id, medicine_id, batch_number, supplier_id, quantity, purchase_price,
    selling_price, manufacturing_date, expiration_date, storage_location, supplier_reference, remarks,
  } = req.body;
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(422).json({ error: 'A positive whole quantity is required.' });
  const item = inventory_id
    ? db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(inventory_id, pid)
    : null;
  if (inventory_id && !item) return res.status(404).json({ error: 'Medicine not found in your inventory.' });
  const targetMedicineId = Number(item?.medicine_id || medicine_id);
  if (!targetMedicineId || !db.prepare('SELECT id FROM medicines WHERE id = ?').get(targetMedicineId)) {
    return res.status(404).json({ error: 'Medicine not found in your inventory.' });
  }
  const targetInventoryId = inventory_id ? Number(inventory_id) : db.prepare('SELECT id FROM inventory WHERE pharmacy_id = ? AND medicine_id = ?').get(pid, targetMedicineId)?.id;
  if (!targetInventoryId) return res.status(404).json({ error: 'Create the product in inventory before receiving stock.' });
  const resolvedSupplier = supplier_id ? Number(supplier_id) : null;
  const batch = (batch_number || '').trim();
  if (!batch) return res.status(422).json({ error: 'Batch number is required.' });
  for (const [name, value] of [['purchase price', purchase_price], ['selling price', selling_price]]) {
    if (value != null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0)) {
      return res.status(422).json({ error: `${name} must be a non-negative amount.` });
    }
  }
  if (!validInventoryDate(manufacturing_date) || !validInventoryDate(expiration_date)) {
    return res.status(422).json({ error: 'Manufacturing and expiration dates must be valid calendar dates.' });
  }
  if (manufacturing_date && expiration_date && manufacturing_date > expiration_date) {
    return res.status(422).json({ error: 'Manufacturing date cannot be later than the expiration date.' });
  }
  if (resolvedSupplier && !db.prepare('SELECT id FROM suppliers WHERE id = ? AND pharmacy_id = ?').get(resolvedSupplier, pid)) {
    return res.status(422).json({ error: 'Choose a supplier belonging to your pharmacy.' });
  }
  const existingBatch = db.prepare('SELECT * FROM medicine_batches WHERE pharmacy_id = ? AND batch_number = ?').get(pid, batch);
  if (existingBatch && Number(existingBatch.inventory_id) !== targetInventoryId) {
    return res.status(422).json({ error: 'This batch number is already assigned to another product.' });
  }
  if (existingBatch && ['expired', 'recalled', 'archived'].includes(existingBatch.status)) {
    return res.status(422).json({ error: 'Expired, recalled, or archived batches cannot receive additional stock.' });
  }
  if (existingBatch?.manufacturing_date && manufacturing_date && manufacturing_date !== existingBatch.manufacturing_date) {
    return res.status(422).json({ error: 'A batch manufacturing date cannot be changed during a stock receipt.' });
  }
  const effectiveExpiration = expiration_date || existingBatch?.expiration_date;
  if (effectiveExpiration && effectiveExpiration < new Date().toISOString().slice(0, 10)) {
    return res.status(422).json({ error: 'Stock cannot be received into a batch that has already expired.' });
  }
  if (existingBatch && expiration_date && existingBatch.expiration_date && expiration_date !== existingBatch.expiration_date) {
    return res.status(422).json({ error: 'A batch expiration date cannot be changed during a stock receipt.' });
  }
  const transactionType = req.body.transaction_type === 'return' ? 'return' : 'stock_in';
  const tx = db.transaction(() => {
    const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(targetInventoryId, pid);
    if (!item) throw new Error('Inventory item not found.');
    const previousQty = Number(item.stock_quantity || 0);
    db.prepare(`
      INSERT INTO medicine_batches (pharmacy_id, medicine_id, inventory_id, supplier_id, batch_number, supplier_reference, manufacturing_date, expiration_date, quantity_received, current_quantity, purchase_price, selling_price, date_received, storage_location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pharmacy_id, batch_number) DO UPDATE SET
        inventory_id = excluded.inventory_id,
        supplier_id = COALESCE(excluded.supplier_id, supplier_id),
        supplier_reference = COALESCE(excluded.supplier_reference, supplier_reference),
        manufacturing_date = COALESCE(excluded.manufacturing_date, manufacturing_date),
        expiration_date = COALESCE(excluded.expiration_date, expiration_date),
        quantity_received = quantity_received + excluded.quantity_received,
        current_quantity = current_quantity + excluded.current_quantity,
        purchase_price = COALESCE(excluded.purchase_price, purchase_price),
        selling_price = COALESCE(excluded.selling_price, selling_price),
        date_received = excluded.date_received,
        storage_location = COALESCE(excluded.storage_location, storage_location),
        notes = COALESCE(excluded.notes, notes),
        status = 'active',
        updated_at = CURRENT_TIMESTAMP
    `).run(
      pid, targetMedicineId, targetInventoryId, resolvedSupplier, batch,
      (supplier_reference || '').trim() || null, manufacturing_date || null, expiration_date || null,
      qty, qty, purchase_price !== '' && purchase_price != null ? Number(purchase_price) : null,
      selling_price !== '' && selling_price != null ? Number(selling_price) : null,
      new Date().toISOString(), (storage_location || '').trim() || null, (remarks || '').trim() || null
    );
    const batchRow = db.prepare('SELECT id FROM medicine_batches WHERE pharmacy_id = ? AND batch_number = ?').get(pid, batch);
    const updated = db.prepare(`
      UPDATE inventory SET stock_quantity = stock_quantity + ?,
        price = COALESCE(?, price), updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND pharmacy_id = ? AND medicine_id = ?
    `).run(qty, selling_price !== '' && selling_price != null ? Number(selling_price) : null, targetInventoryId, pid, targetMedicineId);
    if (!updated.changes) throw new Error('Inventory item changed before stock could be received.');
    db.prepare(`INSERT INTO stock_transactions (
      pharmacy_id, medicine_id, inventory_id, batch_id, supplier_id, transaction_type, quantity,
      previous_quantity, new_quantity, reason, reference_number, staff_user_id, remarks
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      pid, targetMedicineId, targetInventoryId, batchRow.id, resolvedSupplier, transactionType, qty,
      previousQty, previousQty + qty, transactionType, (supplier_reference || '').trim() || batch,
      req.session.user.id, (remarks || '').trim() || (transactionType === 'return' ? 'Returned stock' : 'Stock-in')
    );

    db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'inventory', ?, ?, ?)
    `).run(
      pid, req.session.user.id, targetInventoryId, transactionType,
      `${transactionType === 'return' ? 'Returned' : 'Received'} ${qty} units for batch ${batch}; supplier ${resolvedSupplier || 'not specified'}; purchase price ${purchase_price != null && purchase_price !== '' ? purchase_price : 'not specified'}; selling price ${selling_price != null && selling_price !== '' ? selling_price : 'not specified'}; supplier reference ${(supplier_reference || '').trim() || 'not specified'}; storage ${(storage_location || '').trim() || 'not specified'}. ${(remarks || '').trim()}`
    );
  });
  tx.immediate();
  res.json({ ok: true, message: `${transactionType === 'return' ? 'Return' : 'Stock-In'} completed successfully. +${qty} units added.` });
});

router.post('/inventory/stock-out', (req, res) => {
  const pid = myPharmacyId(req);
  const { inventory_id, quantity, reason, reference_number, remarks, batch_id } = req.body;
  const inventory = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(inventory_id, pid);
  if (!inventory) return res.status(404).json({ error: 'Inventory item not found.' });
  const qty = Number(quantity);
  if (!Number.isInteger(qty) || qty <= 0) return res.status(422).json({ error: 'A positive whole quantity is required.' });
  const allowedReasons = ['sold', 'damaged', 'expired', 'returned', 'lost', 'other'];
  const reasonCode = String(reason || '').trim().toLowerCase();
  if (!allowedReasons.includes(reasonCode)) return res.status(422).json({ error: 'Choose a valid reason for removing stock.' });
  const requestedBatch = batch_id
    ? db.prepare('SELECT * FROM medicine_batches WHERE id = ? AND inventory_id = ? AND pharmacy_id = ?').get(batch_id, inventory.id, pid)
    : null;
  if (batch_id && !requestedBatch) return res.status(422).json({ error: 'Choose a valid batch for this stock-out.' });
  if (reasonCode === 'expired' && !requestedBatch) return res.status(422).json({ error: 'Choose the expired batch to dispose.' });
  if (reasonCode !== 'expired' && requestedBatch) {
    return res.status(422).json({ error: 'Non-expired stock-outs follow FEFO automatically; do not specify a batch.' });
  }
  if (reasonCode === 'expired') {
    const isExpired = requestedBatch.status === 'expired'
      || (requestedBatch.expiration_date && requestedBatch.expiration_date < new Date().toISOString().slice(0, 10));
    if (!isExpired) return res.status(422).json({ error: 'Only expired batches can be removed with the expired reason.' });
  }
  const transactionType = reasonCode === 'damaged' || reasonCode === 'expired' ? reasonCode : 'stock_out';
  const reserved = db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations WHERE inventory_id = ? AND status IN ('pending','confirmed','ready_for_pickup')`).get(inventory.id).total;
  const available = Math.max(0, Number(inventory.stock_quantity || 0) - Number(reserved || 0));
  if (qty > available) return res.status(422).json({ error: 'Insufficient available stock.' });
  const tx = db.transaction(() => {
    const currentInventory = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(inventory.id, pid);
    if (!currentInventory) return { error: 'Inventory item is no longer available.' };
    const activeReserved = Number(db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations
      WHERE inventory_id = ? AND status IN ('pending','confirmed','ready_for_pickup')
    `).get(inventory.id).total);
    const currentAvailable = Math.max(0, Number(currentInventory.stock_quantity) - activeReserved);
    if (qty > currentAvailable) return { error: 'Insufficient available stock.' };
    const allocations = consumeBatchStock(currentInventory.id, qty, reasonCode === 'expired'
      ? { batchId: requestedBatch.id, allowExpired: true }
      : {});
    if (!allocations?.length) {
      return { error: reasonCode === 'expired'
        ? 'The selected expired batch does not have enough stock.'
        : 'Insufficient valid, unexpired batch stock.' };
    }
    const previous = Number(currentInventory.stock_quantity || 0);
    const inventoryUpdate = db.prepare(`
      UPDATE inventory SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND pharmacy_id = ? AND stock_quantity >= ?
    `).run(qty, currentInventory.id, pid, qty);
    if (!inventoryUpdate.changes) throw new Error('Physical stock changed during stock-out.');
    let remainingPhysical = previous;
    allocations.forEach(allocation => {
      const nextPhysical = remainingPhysical - allocation.quantity;
      db.prepare(`INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, batch_id, transaction_type, quantity, previous_quantity, new_quantity, reason, reference_number, staff_user_id, remarks)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pid, currentInventory.medicine_id, currentInventory.id, allocation.batch.id, transactionType,
        allocation.quantity, remainingPhysical, nextPhysical, reasonCode,
        (reference_number || '').trim() || null, req.session.user.id,
        (remarks || '').trim() || `Stock removed: ${reasonCode}; FEFO batch ${allocation.batch.batch_number}`
      );
      remainingPhysical = nextPhysical;
    });
    db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'inventory', ?, ?, ?)
    `).run(
      pid, req.session.user.id, currentInventory.id, transactionType,
      `Removed ${qty} units for reason "${reasonCode}" from ${allocations.map(allocation => `${allocation.batch.batch_number} (${allocation.quantity})`).join(', ')}. Reference: ${(reference_number || '').trim() || 'none'}. ${(remarks || '').trim()}`
    );
    return { ok: true };
  });
  const result = tx.immediate();
  if (result?.error) return res.status(422).json({ error: result.error });
  res.json({ ok: true, message: `${transactionType} completed. -${qty} units removed.` });
});

router.post('/inventory/adjust', (req, res) => {
  const pid = myPharmacyId(req);
  const { inventory_id, adjustment, reason, remarks } = req.body;
  const inventory = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(inventory_id, pid);
  if (!inventory) return res.status(404).json({ error: 'Inventory item not found.' });
  const delta = Number(adjustment);
  if (!Number.isInteger(delta) || delta === 0) return res.status(422).json({ error: 'Adjustment must be a non-zero whole number.' });
  if (!String(reason || '').trim()) return res.status(422).json({ error: 'A reason is required for every manual stock adjustment.' });
  const nextStock = Number(inventory.stock_quantity) + delta;
  if (nextStock < 0) return res.status(422).json({ error: 'Adjustment would create negative stock.' });
  const reserved = Number(db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations WHERE inventory_id = ? AND status IN ('pending','confirmed','ready_for_pickup')`).get(inventory.id).total);
  if (nextStock < reserved) return res.status(422).json({ error: 'Adjustment would reduce physical stock below reserved stock.' });
  const batches = db.prepare(`
    SELECT * FROM medicine_batches
    WHERE inventory_id = ? AND current_quantity > 0 AND status NOT IN ('recalled','archived','depleted')
    ORDER BY CASE WHEN expiration_date IS NULL THEN 1 ELSE 0 END, expiration_date ASC, id ASC
  `).all(inventory.id);
  if (delta < 0 && batches.reduce((total, batch) => total + Number(batch.current_quantity), 0) < -delta) {
    return res.status(422).json({ error: 'Batch stock is insufficient for this adjustment; reconcile batch quantities first.' });
  }
  const tx = db.transaction(() => {
    const prev = Number(inventory.stock_quantity || 0);
    let batchId = null;
    if (delta > 0) {
      const batchNumber = `ADJ-${inventory.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const created = db.prepare(`
        INSERT INTO medicine_batches (
          pharmacy_id, medicine_id, inventory_id, batch_number,
          quantity_received, current_quantity, date_received, notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        pid, inventory.medicine_id, inventory.id, batchNumber, delta, delta,
        new Date().toISOString(), `Adjustment: ${String(reason).trim()}`
      );
      batchId = Number(created.lastInsertRowid);
    } else {
      let remaining = -delta;
      for (const batch of batches) {
        if (remaining <= 0) break;
        const removed = Math.min(remaining, Number(batch.current_quantity));
        const nextBatchQty = Number(batch.current_quantity) - removed;
        db.prepare(`
          UPDATE medicine_batches SET current_quantity = ?, status = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND current_quantity >= ?
        `).run(
          nextBatchQty,
          nextBatchQty === 0 ? (batch.status === 'expired' ? 'expired' : 'depleted') : batch.status,
          batch.id, removed
        );
        if (remaining === -delta) batchId = Number(batch.id);
        else batchId = null;
        remaining -= removed;
      }
    }
    db.prepare('UPDATE inventory SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextStock, inventory.id);
    db.prepare(`INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, batch_id, transaction_type, quantity, previous_quantity, new_quantity, reason, staff_user_id, remarks)
      VALUES (?, ?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?)
    `).run(pid, inventory.medicine_id, inventory.id, batchId, delta, prev, nextStock, String(reason).trim(), req.session.user.id, (remarks || '').trim() || 'Manual stock adjustment');
    db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'inventory', ?, 'adjustment', ?)
    `).run(pid, req.session.user.id, inventory.id, `Adjusted stock by ${delta}; reason: ${String(reason).trim()}. ${(remarks || '').trim()}`);
  });
  tx.immediate();
  res.json({ ok: true, message: `Stock adjusted by ${delta}.` });
});

router.get('/inventory/history', (req, res) => {
  const pid = myPharmacyId(req);
  const rows = db.prepare(`
    SELECT t.*, m.name AS medicine_name, i.medicine_id, b.batch_number,
      COALESCE(t.supplier_id, b.supplier_id) AS supplier_id,
      s.name AS supplier_name, u.name AS staff_name
    FROM stock_transactions t
    JOIN medicines m ON m.id = t.medicine_id
    LEFT JOIN inventory i ON i.id = t.inventory_id
    LEFT JOIN medicine_batches b ON b.id = t.batch_id
    LEFT JOIN suppliers s ON s.id = COALESCE(t.supplier_id, b.supplier_id)
    LEFT JOIN users u ON u.id = t.staff_user_id
    WHERE t.pharmacy_id = ?
    ORDER BY t.created_at DESC, t.id DESC LIMIT 200
  `).all(pid);
  res.json({ history: rows });
});

// GET /api/pharmacy/alerts — current operational conditions and recent inventory events.
router.get('/alerts', (req, res) => {
  const pid = myPharmacyId(req);
  const eligibleQuantity = eligibleBatchQuantitySql('i');
  const inventory = db.prepare(`
    SELECT i.id AS inventory_id, i.stock_quantity, i.low_stock_threshold,
      m.id AS medicine_id, m.name AS medicine_name,
      COALESCE((SELECT SUM(quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')), 0) AS reserved_quantity,
      MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) - COALESCE((SELECT SUM(quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')), 0)) AS available_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? ORDER BY m.name COLLATE NOCASE
  `).all(pid);
  const alerts = [];
  const add = (alert) => alerts.push(alert);
  const productActions = id => [
    { label: 'View Product', url: `/pharmacy/inventory.html?product_id=${id}` },
    { label: 'Restock', url: `/pharmacy/inventory.html?action=stock-in&inventory_id=${id}` },
  ];

  inventory.forEach(item => {
    const integrity = inventoryIntegrity(db, item.inventory_id, item.stock_quantity);
    if (item.available_quantity === 0) {
      add({
        id: `out-of-stock:${item.inventory_id}`, severity: 'critical', category: 'Out of stock',
        inventory_id: item.inventory_id, medicine_name: item.medicine_name,
        date: null, reason: `No customer-available units remain; ${item.reserved_quantity} units are reserved and ${item.stock_quantity} are physically recorded.`,
        recommended_action: 'Receive stock or review batch and reservation records.',
        actions: productActions(item.inventory_id),
      });
    } else if (item.available_quantity <= item.low_stock_threshold) {
      add({
        id: `low-stock:${item.inventory_id}`, severity: 'warning', category: 'Low stock',
        inventory_id: item.inventory_id, medicine_name: item.medicine_name, date: null,
        reason: `${item.available_quantity} units are available, at or below the ${item.low_stock_threshold}-unit threshold.`,
        recommended_action: 'Review demand and replenish stock.',
        actions: productActions(item.inventory_id),
      });
    }
    if (!integrity.integrity_ok) {
      add({
        id: `inventory-mismatch:${item.inventory_id}`, severity: 'critical', category: 'Inventory mismatch',
        inventory_id: item.inventory_id, medicine_name: item.medicine_name, date: null,
        reason: `Physical stock is ${item.stock_quantity}; batch records total ${integrity.batch_quantity} (difference ${integrity.integrity_difference}).`,
        recommended_action: 'Review batch records and reconcile with an audit reason.',
        actions: [
          { label: 'View Product', url: `/pharmacy/inventory.html?product_id=${item.inventory_id}` },
          { label: 'Review Batches', url: '/pharmacy/inventory.html?tab=batches' },
        ],
      });
    }
  });

  const expired = db.prepare(`
    SELECT b.inventory_id, m.name AS medicine_name, SUM(b.current_quantity) AS units,
      COUNT(*) AS batch_count, MIN(b.expiration_date) AS date
    FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
    WHERE b.pharmacy_id = ? AND b.current_quantity > 0
      AND (b.status = 'expired' OR date(b.expiration_date) < date('now','localtime'))
    GROUP BY b.inventory_id
  `).all(pid);
  expired.forEach(item => add({
    id: `expired-stock:${item.inventory_id}`, severity: 'critical', category: 'Expired stock',
    inventory_id: item.inventory_id, medicine_name: item.medicine_name, date: item.date,
    reason: `${item.units} units across ${item.batch_count} batch(es) have expired and remain in stock.`,
    recommended_action: 'Quarantine and record disposal of expired batches.',
    actions: [
      { label: 'View Product', url: `/pharmacy/inventory.html?product_id=${item.inventory_id}` },
      { label: 'Review Expiration', url: '/pharmacy/inventory.html?tab=expiration' },
    ],
  }));

  const expiring = db.prepare(`
    SELECT b.inventory_id, m.name AS medicine_name, SUM(b.current_quantity) AS units,
      COUNT(*) AS batch_count, MIN(b.expiration_date) AS date
    FROM medicine_batches b JOIN medicines m ON m.id = b.medicine_id
    WHERE b.pharmacy_id = ? AND b.current_quantity > 0
      AND b.expiration_date IS NOT NULL
      AND date(b.expiration_date) BETWEEN date('now','localtime') AND date('now','localtime','+30 days')
      AND b.status NOT IN ('depleted','recalled','archived','expired')
    GROUP BY b.inventory_id
  `).all(pid);
  expiring.forEach(item => add({
    id: `expiring-within-30-days:${item.inventory_id}`, severity: 'warning', category: 'Expiring within 30 days',
    inventory_id: item.inventory_id, medicine_name: item.medicine_name, date: item.date,
    reason: `${item.units} units across ${item.batch_count} batch(es) are due to expire; earliest expiration is ${item.date}.`,
    recommended_action: 'Prioritize FEFO dispensing and plan replenishment.',
    actions: [
      { label: 'View Product', url: `/pharmacy/inventory.html?product_id=${item.inventory_id}` },
      { label: 'Review Expiration', url: '/pharmacy/inventory.html?tab=expiration' },
    ],
  }));

  const searchRows = db.prepare(`
    SELECT CAST(searched.value AS INTEGER) AS medicine_id, COUNT(*) AS search_count
    FROM search_logs sl, json_each(sl.medicine_ids) searched
    WHERE sl.searched_at >= datetime('now','-30 days')
    GROUP BY CAST(searched.value AS INTEGER)
  `).all();
  const searchesByMedicine = new Map(searchRows.map(row => [Number(row.medicine_id), Number(row.search_count)]));
  inventory.forEach(item => {
    const searchCount = searchesByMedicine.get(Number(item.medicine_id)) || 0;
    if (item.available_quantity > 0 && item.available_quantity <= item.low_stock_threshold
        && searchCount >= Math.max(10, Number(item.available_quantity) * 10)) {
      add({
        id: `high-demand-low-stock:${item.inventory_id}`, severity: 'warning', category: 'High demand + low stock',
        inventory_id: item.inventory_id, medicine_name: item.medicine_name, date: null,
        reason: `${item.available_quantity} units are available with ${searchCount} recent searches in the last 30 days.`,
        recommended_action: 'Replenish this frequently searched medicine.',
        actions: productActions(item.inventory_id),
      });
    }
  });

  const nearingExpiry = db.prepare(`
    SELECT r.id, r.inventory_id, r.quantity, r.expires_at, r.status,
      m.name AS medicine_name, u.name AS customer_name
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    JOIN users u ON u.id = r.customer_id
    WHERE i.pharmacy_id = ? AND r.status = 'pending'
      AND r.expires_at IS NOT NULL
      AND datetime(r.expires_at) > datetime('now')
      AND datetime(r.expires_at) <= datetime('now','+6 hours')
    ORDER BY r.expires_at ASC
  `).all(pid);
  nearingExpiry.forEach(item => add({
    id: `reservation-nearing-expiry:${item.id}`, severity: 'warning', category: 'Pending reservation nearing expiry',
    inventory_id: item.inventory_id, reservation_id: item.id, medicine_name: item.medicine_name, date: item.expires_at,
    reason: `Reservation #${item.id} for ${item.customer_name} (${item.quantity} units) expires at ${item.expires_at}.`,
    recommended_action: 'Confirm or cancel the reservation before its hold expires.',
    actions: [{ label: 'Review Reservation', url: '/pharmacy/reservations.html?status=pending' }],
  }));

  const newReservations = db.prepare(`
    SELECT r.id, r.inventory_id, r.quantity, r.reserved_at AS date, m.name AS medicine_name
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND datetime(r.reserved_at) >= datetime('now','-24 hours')
    ORDER BY r.reserved_at DESC LIMIT 20
  `).all(pid);
  newReservations.forEach(item => add({
    id: `new-reservation:${item.id}`, severity: 'information', category: 'New reservation',
    inventory_id: item.inventory_id, reservation_id: item.id, medicine_name: item.medicine_name,
    date: item.date, reason: `Reservation #${item.id} requests ${item.quantity} unit(s).`,
    recommended_action: 'Review the reservation and confirm or cancel it.',
    actions: [{ label: 'View Reservation', url: '/pharmacy/reservations.html?status=pending' }],
  }));

  const received = db.prepare(`
    SELECT t.id, t.inventory_id, t.quantity, t.created_at AS date, t.reference_number,
      m.name AS medicine_name, s.name AS supplier_name
    FROM stock_transactions t JOIN inventory i ON i.id = t.inventory_id
    JOIN medicines m ON m.id = t.medicine_id
    LEFT JOIN suppliers s ON s.id = t.supplier_id
    WHERE t.pharmacy_id = ? AND t.transaction_type = 'stock_in'
      AND datetime(t.created_at) >= datetime('now','-24 hours')
    ORDER BY t.created_at DESC, t.id DESC LIMIT 20
  `).all(pid);
  received.forEach(item => add({
    id: `stock-received:${item.id}`, severity: 'information', category: 'Stock received',
    inventory_id: item.inventory_id, medicine_name: item.medicine_name, date: item.date,
    reason: `${item.quantity} units received${item.supplier_name ? ` from ${item.supplier_name}` : ''}${item.reference_number ? ` (reference ${item.reference_number})` : ''}.`,
    recommended_action: 'Verify the batch details and updated availability.',
    actions: [{ label: 'View Product', url: `/pharmacy/inventory.html?product_id=${item.inventory_id}` }],
  }));

  const publishing = db.prepare(`
    SELECT id, folder_id, folder_name, product_count, action, created_at AS date
    FROM folder_deploy_log WHERE pharmacy_id = ?
      AND datetime(created_at) >= datetime('now','-7 days')
    ORDER BY created_at DESC, id DESC LIMIT 20
  `).all(pid);
  publishing.forEach(item => add({
    id: `product-publishing:${item.id}`, severity: 'information', category: 'Product publishing result',
    date: item.date, reason: `${item.product_count} product(s) in ${item.folder_name} were ${item.action === 'deployed' ? 'published' : 'unpublished'}.`,
    recommended_action: 'Review customer visibility and any product validation issues.',
    actions: [{ label: 'View Publishing', url: '/pharmacy/inventory.html?tab=publishing' }],
  }));

  const severityOrder = { critical: 0, warning: 1, information: 2 };
  alerts.sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity]
    || String(b.date || '').localeCompare(String(a.date || ''))
    || a.category.localeCompare(b.category)
    || a.medicine_name?.localeCompare(b.medicine_name || '') || 0);
  res.json({ alerts });
});

// GET /api/pharmacy/sales-history?period=7|30|90|365|all
router.get('/sales-history', (req, res) => {
  const pid = myPharmacyId(req);
  const requestedPeriod = String(req.query.period || '30');
  const period = ['7', '30', '90', '365', 'all'].includes(requestedPeriod) ? requestedPeriod : '30';
  const periodFilter = period === 'all' ? '' : `AND datetime(r.completed_at) >= datetime('now', ?)`;
  const params = period === 'all' ? [pid] : [pid, `-${period} days`];

  const productTotals = db.prepare(`
    SELECT i.id AS inventory_id, m.name AS medicine_name, i.brand, i.deployed,
      SUM(r.quantity) AS units_sold,
      ROUND(SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)), 2) AS revenue,
      MAX(r.completed_at) AS last_sold_at
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed' ${periodFilter}
    GROUP BY i.id
    ORDER BY units_sold DESC, m.name ASC
  `).all(...params);
  const dailySales = db.prepare(`
    SELECT date(r.completed_at, 'localtime') AS sale_date,
      i.id AS inventory_id, m.name AS medicine_name, i.brand,
      SUM(r.quantity) AS units_sold,
      ROUND(SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)), 2) AS revenue
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed' ${periodFilter}
    GROUP BY sale_date, i.id
    ORDER BY sale_date DESC, m.name ASC
  `).all(...params);

  res.json({ period, productTotals, dailySales });
});

// GET /api/pharmacy/analytics
router.get('/analytics', (req, res) => {
  const pid = myPharmacyId(req);
  const validDate = value => typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
    && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  const { today, defaultStart } = db.prepare(`
    SELECT date('now', 'localtime') AS today,
      date('now', 'localtime', '-29 days') AS defaultStart
  `).get();
  const startDate = req.query.start_date || defaultStart;
  const endDate = req.query.end_date || today;
  if (!validDate(startDate) || !validDate(endDate)) {
    return res.status(422).json({ error: 'Use valid start_date and end_date values in YYYY-MM-DD format.' });
  }
  if (startDate > endDate) return res.status(422).json({ error: 'start_date must be on or before end_date.' });
  if ((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 > 365) {
    return res.status(422).json({ error: 'Analytics date ranges cannot exceed 366 days.' });
  }

  const salesSummary = db.prepare(`
    SELECT COUNT(*) AS completed_reservations,
      COALESCE(SUM(r.quantity), 0) AS units_sold,
      COALESCE(ROUND(SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)), 2), 0) AS revenue
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed'
      AND date(r.completed_at, 'localtime') BETWEEN date(?) AND date(?)
  `).get(pid, startDate, endDate);
  const dailySales = db.prepare(`
    SELECT date(r.completed_at, 'localtime') AS day,
      SUM(r.quantity) AS units_sold,
      ROUND(SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)), 2) AS revenue
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed'
      AND date(r.completed_at, 'localtime') BETWEEN date(?) AND date(?)
    GROUP BY day ORDER BY day
  `).all(pid, startDate, endDate);
  const weeklySales = db.prepare(`
    SELECT strftime('%Y-W%W', r.completed_at, 'localtime') AS period,
      SUM(r.quantity) AS units_sold,
      ROUND(SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)), 2) AS revenue
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed'
      AND date(r.completed_at, 'localtime') BETWEEN date(?) AND date(?)
    GROUP BY period ORDER BY period
  `).all(pid, startDate, endDate);
  const monthlySales = db.prepare(`
    SELECT strftime('%Y-%m', r.completed_at, 'localtime') AS period,
      SUM(r.quantity) AS units_sold,
      ROUND(SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)), 2) AS revenue
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed'
      AND date(r.completed_at, 'localtime') BETWEEN date(?) AND date(?)
    GROUP BY period ORDER BY period
  `).all(pid, startDate, endDate);

  const eligibleQuantity = eligibleBatchQuantitySql('i');
  const inventoryMetrics = db.prepare(`
    SELECT COUNT(*) AS products,
      COALESCE(SUM(i.stock_quantity), 0) AS total_units,
      COALESCE(ROUND(SUM(i.price * i.stock_quantity), 2), 0) AS retail_inventory_value,
      SUM(CASE WHEN MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) - COALESCE((
        SELECT SUM(r.quantity) FROM reservations r
        WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')
      ), 0)) = 0 THEN 1 ELSE 0 END) AS out_of_stock,
      SUM(CASE WHEN MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) - COALESCE((
        SELECT SUM(r.quantity) FROM reservations r
        WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')
      ), 0)) > 0
        AND MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) - COALESCE((
          SELECT SUM(r.quantity) FROM reservations r
          WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')
        ), 0)) <= i.low_stock_threshold THEN 1 ELSE 0 END) AS low_stock
    FROM inventory i WHERE i.pharmacy_id = ?
  `).get(pid);
  const expiryMetrics = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN b.current_quantity > 0 AND
        (b.status = 'expired' OR date(b.expiration_date) < date('now','localtime'))
        THEN b.current_quantity ELSE 0 END), 0) AS expired_units,
      COALESCE(SUM(CASE WHEN b.current_quantity > 0 AND b.expiration_date IS NOT NULL
        AND date(b.expiration_date) BETWEEN date('now','localtime') AND date('now','localtime','+30 days')
        AND b.status NOT IN ('depleted','recalled','archived','expired')
        THEN b.current_quantity ELSE 0 END), 0) AS expiring_within_30_days_units,
      COUNT(DISTINCT CASE WHEN b.current_quantity > 0 AND
        (b.status = 'expired' OR date(b.expiration_date) < date('now','localtime'))
        THEN b.id END) AS expired_batches,
      COUNT(DISTINCT CASE WHEN b.current_quantity > 0 AND b.expiration_date IS NOT NULL
        AND date(b.expiration_date) BETWEEN date('now','localtime') AND date('now','localtime','+30 days')
        AND b.status NOT IN ('depleted','recalled','archived','expired')
        THEN b.id END) AS expiring_within_30_days_batches
    FROM medicine_batches b WHERE b.pharmacy_id = ?
  `).get(pid);
  const integrityMismatches = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory i
    WHERE i.pharmacy_id = ? AND i.stock_quantity != (
      SELECT COALESCE(SUM(b.current_quantity), 0) FROM medicine_batches b WHERE b.inventory_id = i.id
    )
  `).get(pid).count;
  const turnoverData = db.prepare(`
    SELECT COUNT(*) AS movements FROM stock_transactions t
    WHERE t.pharmacy_id = ? AND t.transaction_type = 'stock_out'
      AND date(t.created_at, 'localtime') BETWEEN date(?) AND date(?)
  `).get(pid, startDate, endDate);

  const demandSearches = db.prepare(`
    SELECT CAST(medicine.value AS INTEGER) AS medicine_id, m.name AS medicine_name,
      COUNT(DISTINCT sl.rowid) AS searches
    FROM search_logs sl
    JOIN json_each(sl.medicine_ids) medicine
    JOIN medicines m ON m.id = CAST(medicine.value AS INTEGER)
    WHERE date(sl.searched_at, 'localtime') BETWEEN date(?) AND date(?)
      AND EXISTS (SELECT 1 FROM json_each(sl.pharmacy_ids) pharmacy
        WHERE CAST(pharmacy.value AS INTEGER) = ?)
    GROUP BY medicine_id ORDER BY searches DESC, m.name COLLATE NOCASE LIMIT 10
  `).all(startDate, endDate, pid);
  const demandReservations = db.prepare(`
    SELECT m.id AS medicine_id, m.name AS medicine_name, SUM(r.quantity) AS units_reserved,
      COUNT(*) AS reservation_count
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND date(r.reserved_at, 'localtime') BETWEEN date(?) AND date(?)
      AND r.status NOT IN ('cancelled','expired')
    GROUP BY m.id ORDER BY units_reserved DESC, m.name COLLATE NOCASE LIMIT 10
  `).all(pid, startDate, endDate);
  const dailyDemand = db.prepare(`
    WITH search_days AS (
      SELECT date(sl.searched_at, 'localtime') AS day, COUNT(DISTINCT sl.rowid) AS searches
      FROM search_logs sl
      WHERE date(sl.searched_at, 'localtime') BETWEEN date(?) AND date(?)
        AND EXISTS (SELECT 1 FROM json_each(sl.pharmacy_ids) pharmacy
          WHERE CAST(pharmacy.value AS INTEGER) = ?)
      GROUP BY day
    ), reservation_days AS (
      SELECT date(r.reserved_at, 'localtime') AS day, COUNT(*) AS reservations
      FROM reservations r JOIN inventory i ON i.id = r.inventory_id
      WHERE i.pharmacy_id = ? AND date(r.reserved_at, 'localtime') BETWEEN date(?) AND date(?)
      GROUP BY day
    )
    SELECT days.day, COALESCE(search_days.searches, 0) AS searches,
      COALESCE(reservation_days.reservations, 0) AS reservations
    FROM (
      WITH RECURSIVE dates(day) AS (
        SELECT date(?) UNION ALL SELECT date(day, '+1 day') FROM dates WHERE day < date(?)
      ) SELECT day FROM dates
    ) days
    LEFT JOIN search_days ON search_days.day = days.day
    LEFT JOIN reservation_days ON reservation_days.day = days.day
    ORDER BY days.day
  `).all(startDate, endDate, pid, pid, startDate, endDate, startDate, endDate);
  const searchByMedicine = new Map(demandSearches.map(row => [Number(row.medicine_id), Number(row.searches)]));
  const reservationByMedicine = new Map(demandReservations.map(row => [Number(row.medicine_id), Number(row.units_reserved)]));
  const demandInventory = db.prepare(`
    SELECT i.id AS inventory_id, i.medicine_id, m.name AS medicine_name,
      i.stock_quantity, i.low_stock_threshold,
      MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) - COALESCE((
        SELECT SUM(r.quantity) FROM reservations r
        WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')
      ), 0)) AS available_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ?
  `).all(pid).map(item => ({
    ...item,
    searches: searchByMedicine.get(Number(item.medicine_id)) || 0,
    units_reserved: reservationByMedicine.get(Number(item.medicine_id)) || 0,
  }));
  const highDemandLowStock = demandInventory.filter(item =>
    item.searches > 0 && item.available_quantity > 0 && item.available_quantity <= item.low_stock_threshold
  ).sort((a, b) => b.searches - a.searches);
  const searchedUnavailable = demandInventory.filter(item =>
    item.searches > 0 && item.available_quantity === 0
  ).sort((a, b) => b.searches - a.searches).slice(0, 10);
  const demandRelationship = demandSearches.map(item => ({
    ...item,
    units_reserved: reservationByMedicine.get(Number(item.medicine_id)) || 0,
    note: 'Searches and reservations are counted for the same medicine and date range; the database does not link a specific search session to a reservation.',
  }));
  const salesProducts = db.prepare(`
    SELECT i.id AS inventory_id, m.id AS medicine_id, m.name AS medicine_name,
      SUM(r.quantity) AS units_sold,
      ROUND(SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)), 2) AS revenue
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed'
      AND date(r.completed_at, 'localtime') BETWEEN date(?) AND date(?)
    GROUP BY i.id ORDER BY units_sold DESC, m.name COLLATE NOCASE
  `).all(pid, startDate, endDate);
  const stockedProducts = db.prepare(`
    SELECT i.id AS inventory_id, m.id AS medicine_id, m.name AS medicine_name,
      i.stock_quantity, MAX(0, MIN(i.stock_quantity, ${eligibleQuantity}) - COALESCE((
        SELECT SUM(r.quantity) FROM reservations r
        WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed','ready_for_pickup')
      ), 0)) AS available_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND i.stock_quantity > 0
  `).all(pid);
  const productsByInventory = new Map(salesProducts.map(item => [Number(item.inventory_id), item]));
  const slowMovingProducts = stockedProducts.filter(item => !productsByInventory.has(Number(item.inventory_id)))
    .sort((a, b) => Number(b.stock_quantity) - Number(a.stock_quantity)).slice(0, 10)
    .map(item => ({ ...item, units_sold: 0, reason: 'No completed sales recorded in this date range.' }));

  const reservationOutcomes = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN r.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN r.status = 'expired' THEN 1 ELSE 0 END) AS expired
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND date(r.reserved_at, 'localtime') BETWEEN date(?) AND date(?)
  `).get(pid, startDate, endDate);
  const adjustmentFrequency = db.prepare(`
    SELECT COUNT(*) AS count FROM stock_transactions
    WHERE pharmacy_id = ? AND transaction_type = 'adjustment'
      AND date(created_at, 'localtime') BETWEEN date(?) AND date(?)
  `).get(pid, startDate, endDate).count;
  const dayCount = (Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000 + 1;

  res.json({
    dateRange: { startDate, endDate, days: dayCount },
    sales: {
      unitsSold: Number(salesSummary.units_sold),
      revenue: Number(salesSummary.revenue),
      completedReservations: Number(salesSummary.completed_reservations),
      daily: dailySales,
      weekly: weeklySales,
      monthly: monthlySales,
      revenueSupported: salesSummary.completed_reservations > 0,
    },
    inventory: {
      ...inventoryMetrics,
      products: Number(inventoryMetrics.products || 0),
      total_units: Number(inventoryMetrics.total_units || 0),
      retail_inventory_value: Number(inventoryMetrics.retail_inventory_value || 0),
      low_stock: Number(inventoryMetrics.low_stock || 0),
      out_of_stock: Number(inventoryMetrics.out_of_stock || 0),
      expired: expiryMetrics,
      inventory_mismatches: Number(integrityMismatches),
      stock_turnover: {
        value: null,
        reason: 'Insufficient data: historical inventory snapshots are not stored, so average inventory cannot be calculated.',
        recorded_stock_out_transactions: Number(turnoverData.movements || 0),
      },
    },
    demand: {
      mostSearched: demandSearches,
      mostReserved: demandReservations,
      trends: dailyDemand,
      highDemandLowStock,
      searchedUnavailable,
      searchReservationRelationship: demandRelationship,
      relationshipNote: 'Search and reservation counts are matched by medicine and date range, not by individual customer or session.',
    },
    operations: {
      reservationTotal: Number(reservationOutcomes.total || 0),
      completed: Number(reservationOutcomes.completed || 0),
      cancelled: Number(reservationOutcomes.cancelled || 0),
      expired: Number(reservationOutcomes.expired || 0),
      completionRate: reservationOutcomes.total ? Number(reservationOutcomes.completed || 0) / Number(reservationOutcomes.total) : null,
      cancellationRate: reservationOutcomes.total ? Number(reservationOutcomes.cancelled || 0) / Number(reservationOutcomes.total) : null,
      expiredReservationRate: reservationOutcomes.total ? Number(reservationOutcomes.expired || 0) / Number(reservationOutcomes.total) : null,
      adjustmentFrequency: Number(adjustmentFrequency || 0),
    },
    products: {
      topSelling: salesProducts.slice(0, 10),
      slowMoving: slowMovingProducts,
      frequentlySearchedUnavailable: searchedUnavailable,
    },
  });
});

// GET /api/pharmacy/profile — pharmacy record linked to this staff account's registration info
router.get('/profile', (req, res) => {
  const pharmacy = db.prepare(`
    SELECT id, name, address, latitude, longitude, phone, business_email,
      owner_first_name, owner_last_name, description, hours, profile_image,
      cover_image, store_image, verified, verification_status, verification_stage,
      correction_reason, verification_reason, rejection_reason, suspension_reason,
      status_updated_at,
      (business_permit IS NOT NULL AND business_permit != '') AS has_business_permit
    FROM pharmacies WHERE id = ?
  `).get(myPharmacyId(req));
  const counts = db.prepare(`
    SELECT rating, COUNT(*) AS count FROM pharmacy_ratings
    WHERE pharmacy_id = ? GROUP BY rating
  `).all(myPharmacyId(req));
  const countByRating = new Map(counts.map(row => [row.rating, row.count]));
  const ratingDistribution = [5, 4, 3, 2, 1].map(rating => ({ rating, count: countByRating.get(rating) || 0 }));
  const reviews = db.prepare(`
    SELECT r.rating, r.comment, r.created_at, r.updated_at,
      COALESCE(NULLIF(u.username, ''), 'customer-' || u.id) AS customer_username,
      COALESCE(NULLIF(u.username, ''), 'Customer') AS customer_name
    FROM pharmacy_ratings r JOIN users u ON u.id = r.customer_id
    WHERE r.pharmacy_id = ? ORDER BY r.updated_at DESC
  `).all(myPharmacyId(req));
  res.json({ user: req.session.user, pharmacy, reviews, ratingDistribution });
});

// PUT /api/pharmacy/profile — update pharmacy information and its public images.
router.put('/profile', (req, res) => {
  const pid = myPharmacyId(req);
  const { name, phone, business_email, address, latitude, longitude, profile_image, cover_image, description, hours, owner_first_name, owner_last_name, business_permit } = req.body;
  const pharmacyName = typeof name === 'string' ? name.trim() : undefined;
  const businessEmail = typeof business_email === 'string' ? business_email.trim() : undefined;

  if (pharmacyName !== undefined && !pharmacyName) {
    return res.status(422).json({ error: 'Pharmacy name is required.' });
  }
  if (businessEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(businessEmail)) {
    return res.status(422).json({ error: 'Enter a valid business email address.' });
  }

  for (const image of [profile_image, cover_image]) {
    if (image && !/^data:image\/(png|jpe?g|webp);base64,/.test(image)) {
      return res.status(422).json({ error: 'Pharmacy photos must be PNG, JPG, or WEBP images.' });
    }
  }
  if (business_permit && !/^data:(application\/pdf|image\/(png|jpeg|webp));base64,[A-Za-z0-9+/]+={0,2}$/.test(business_permit)) {
    return res.status(422).json({ error: 'Business permit must be a PDF, PNG, JPG, or WEBP file.' });
  }

  const tx = db.transaction(() => {
    const pharmacy = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(pid);
    const lat = latitude != null && latitude !== '' ? parseFloat(latitude) : pharmacy.latitude;
    const lng = longitude != null && longitude !== '' ? parseFloat(longitude) : pharmacy.longitude;
    db.prepare(`
      UPDATE pharmacies SET name = ?, phone = ?, business_email = ?, address = ?, latitude = ?, longitude = ?, profile_image = ?, store_image = ?, cover_image = ?, description = ?, hours = ?, owner_first_name = ?, owner_last_name = ?, business_permit = ? WHERE id = ?
    `).run(
      pharmacyName !== undefined ? pharmacyName : pharmacy.name,
      phone !== undefined ? ((phone || '').trim() || null) : pharmacy.phone,
      businessEmail !== undefined ? (businessEmail || null) : pharmacy.business_email,
      address !== undefined && address.trim() ? address.trim() : pharmacy.address,
      isFinite(lat) ? lat : pharmacy.latitude,
      isFinite(lng) ? lng : pharmacy.longitude,
      profile_image !== undefined ? (profile_image || null) : pharmacy.profile_image,
      profile_image !== undefined ? (profile_image || null) : pharmacy.store_image,
      cover_image !== undefined ? (cover_image || null) : pharmacy.cover_image,
      description !== undefined ? ((description || '').trim() || null) : pharmacy.description,
      hours !== undefined ? ((hours || '').trim() || null) : pharmacy.hours,
      owner_first_name !== undefined ? ((owner_first_name || '').trim() || null) : pharmacy.owner_first_name,
      owner_last_name !== undefined ? ((owner_last_name || '').trim() || null) : pharmacy.owner_last_name,
      business_permit !== undefined ? business_permit : pharmacy.business_permit,
      pid
    );
    if (pharmacyName !== undefined) {
      db.prepare('UPDATE users SET name = ? WHERE pharmacy_id = ?').run(pharmacyName, pid);
      req.session.user.name = pharmacyName;
    }
  });
  tx();

  const pharmacy = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(pid);
  res.json({ user: req.session.user, pharmacy });
});

router.post('/verification/resubmit', (req, res) => {
  const pharmacy = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(myPharmacyId(req));
  if (!pharmacy) return res.status(404).json({ error: 'Pharmacy registration not found.' });
  if (!['CORRECTION_REQUIRED', 'REVERIFICATION_REQUIRED'].includes(pharmacy.verification_stage)) {
    return res.status(409).json({ error: 'This pharmacy does not currently have a registration correction or reverification request.' });
  }
  if (!pharmacy.name || !pharmacy.address || !pharmacy.owner_first_name || !pharmacy.owner_last_name || !pharmacy.business_permit) {
    return res.status(422).json({ error: 'Complete the required pharmacy name, address, owner information, and business permit before resubmitting.' });
  }

  const previousStatus = pharmacy.verification_stage;
  const now = new Date().toISOString();
  const actor = req.session.user;
  const actorName = actor.name || actor.username || `User ${actor.id}`;
  const note = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  const admins = db.prepare("SELECT id FROM users WHERE role = 'admin'").all();
  const saveResubmission = db.transaction(() => {
    db.prepare(`
      UPDATE pharmacies
      SET verification_stage = 'UNDER_REVIEW',
          verification_status = 'PENDING',
          verified = 0,
          correction_reason = NULL,
          rejection_reason = NULL,
          status_updated_at = ?
      WHERE id = ?
    `).run(now, pharmacy.id);
    db.prepare(`
      INSERT INTO pharmacy_verification_history (
        pharmacy_id, actor_user_id, actor_name, actor_role, action,
        previous_status, new_status, reason, created_at
      ) VALUES (?, ?, ?, 'pharmacy_staff', 'CORRECTION SUBMITTED', ?, 'UNDER_REVIEW', ?, ?)
    `).run(pharmacy.id, actor.id, actorName, previousStatus, note || null, now);
    const insertNotification = db.prepare(`
      INSERT INTO notifications (user_id, title, message, type)
      VALUES (?, 'Pharmacy registration resubmitted', ?, 'admin')
    `);
    admins.forEach(admin => insertNotification.run(
      admin.id,
      `${pharmacy.name} resubmitted its registration for review.`,
    ));
  });
  saveResubmission();
  res.json({ ok: true, status: 'UNDER_REVIEW', adminsNotified: admins.length });
});

// GET /api/pharmacy/reservations
router.get('/reservations', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, m.name AS medicine_name, u.name AS customer_name,
      u.username AS customer_username, u.email AS customer_email, u.phone AS customer_phone,
      COALESCE(r.price_at_reservation, i.price) AS price, i.stock_quantity AS physical_stock,
      COALESCE((
        SELECT SUM(active.quantity) FROM reservations active
        WHERE active.inventory_id = i.id
          AND active.status IN ('pending','confirmed','ready_for_pickup')
      ), 0) AS reserved_quantity,
      MAX(0, MIN(i.stock_quantity, ${eligibleBatchQuantitySql('i')}) - COALESCE((
        SELECT SUM(active.quantity) FROM reservations active
        WHERE active.inventory_id = i.id
          AND active.status IN ('pending','confirmed','ready_for_pickup')
      ), 0)) AS available_quantity
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    JOIN users u ON u.id = r.customer_id
    WHERE i.pharmacy_id = ?
    ORDER BY r.reserved_at DESC
  `).all(myPharmacyId(req));
  res.json({ reservations: rows });
});

function transitionReservation(req, res, toStatus, allowedFrom) {
  const reservation = db.prepare(`
    SELECT r.*, i.pharmacy_id FROM reservations r JOIN inventory i ON i.id = r.inventory_id WHERE r.id = ?
  `).get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
  if (reservation.pharmacy_id !== myPharmacyId(req)) {
    return res.status(403).json({ error: 'You can only manage your own pharmacy reservations.' });
  }
  if (!allowedFrom.includes(reservation.status)) {
    return res.status(422).json({ error: `Cannot move a ${reservation.status} reservation to ${toStatus}.` });
  }

  const tx = db.transaction(() => {
    const currentReservation = db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservation.id);
    if (!currentReservation || !allowedFrom.includes(currentReservation.status)) {
      return { error: `Reservation is no longer eligible to be ${toStatus}.` };
    }

    if (toStatus === 'completed') {
      const inventory = db.prepare('SELECT * FROM inventory WHERE id = ?').get(currentReservation.inventory_id);
      if (inventory.stock_quantity < currentReservation.quantity) {
        return { error: 'Not enough stock remains to complete this reservation.' };
      }
      const reservedByOthers = Number(db.prepare(`
        SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations
        WHERE inventory_id = ? AND status IN ('pending','confirmed','ready_for_pickup') AND id != ?
      `).get(inventory.id, currentReservation.id).total);
      if (Number(inventory.stock_quantity) - Number(currentReservation.quantity) < reservedByOthers) {
        return { error: 'Other active reservations prevent this pickup from being completed.' };
      }
      const allocations = consumeBatchStock(inventory.id, Number(currentReservation.quantity));
      if (!allocations?.length) {
        return { error: 'Not enough valid, unexpired batch stock remains to complete this reservation.' };
      }
      const newQuantity = inventory.stock_quantity - currentReservation.quantity;
      const deduction = db.prepare(`
        UPDATE inventory SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND stock_quantity >= ?
      `).run(currentReservation.quantity, inventory.id, currentReservation.quantity);
      if (!deduction.changes) throw pickupStockChanged;
      let remainingPhysical = Number(inventory.stock_quantity);
      allocations.forEach(allocation => {
        const nextPhysical = remainingPhysical - allocation.quantity;
        db.prepare(`
          INSERT INTO stock_transactions (
            pharmacy_id, medicine_id, inventory_id, batch_id, transaction_type, quantity,
            previous_quantity, new_quantity, reason, reference_number, staff_user_id, remarks
          ) VALUES (?, ?, ?, ?, 'stock_out', ?, ?, ?, 'reservation_completed', ?, ?, ?)
        `).run(
          reservation.pharmacy_id, inventory.medicine_id, inventory.id, allocation.batch.id,
          allocation.quantity, remainingPhysical, nextPhysical,
          `RES-${reservation.id}`, req.session.user.id,
          `Completed reservation #${reservation.id}; FEFO batch ${allocation.batch.batch_number}`
        );
        remainingPhysical = nextPhysical;
      });
      db.prepare(`
        INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
        VALUES (?, ?, 'inventory', ?, 'reservation_completed', ?)
      `).run(
        reservation.pharmacy_id, req.session.user.id, inventory.id,
        `Deducted ${currentReservation.quantity} units for completed reservation #${reservation.id}`
      );
    }
    const completedAt = toStatus === 'completed' ? new Date().toISOString() : null;
    const pickupDeadline = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const statusUpdate = db.prepare(`
      UPDATE reservations SET status = ?,
        completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
        expires_at = CASE WHEN ? = 'confirmed' THEN ? ELSE expires_at END
      WHERE id = ? AND status = ?
    `).run(toStatus, toStatus, completedAt, toStatus, pickupDeadline, reservation.id, currentReservation.status);
    if (!statusUpdate.changes) throw new Error('Reservation status changed during the pharmacy transition.');
    if (toStatus === 'cancelled') {
      const inventory = db.prepare('SELECT * FROM inventory WHERE id = ?').get(currentReservation.inventory_id);
      db.prepare(`INSERT INTO stock_transactions (
        pharmacy_id, medicine_id, inventory_id, transaction_type, quantity,
        previous_quantity, new_quantity, reason, reference_number, staff_user_id, remarks
      ) VALUES (?, ?, ?, 'reservation_cancellation', ?, ?, ?, 'reservation_released', ?, ?, ?)
      `).run(
        reservation.pharmacy_id, inventory.medicine_id, inventory.id, currentReservation.quantity,
        inventory.stock_quantity, inventory.stock_quantity, `RES-${reservation.id}`, req.session.user.id,
        `Released ${currentReservation.quantity} reserved units; physical stock unchanged.`
      );
      db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
        VALUES (?, ?, 'inventory', ?, 'reservation_cancellation', ?)
      `).run(
        reservation.pharmacy_id, req.session.user.id, inventory.id,
        `Reservation #${reservation.id} released ${currentReservation.quantity} units; physical stock unchanged.`
      );
    }
    const medicine = db.prepare(`
      SELECT m.name FROM inventory i JOIN medicines m ON m.id = i.medicine_id WHERE i.id = ?
    `).get(reservation.inventory_id);
    const messages = {
      confirmed: `Your reservation for ${medicine.name} has been confirmed. Please pick it up within 24 hours.`,
      ready_for_pickup: `Your reservation for ${medicine.name} is ready for pickup. Please collect it before the pickup deadline.`,
      completed: `Your reservation for ${medicine.name} has been marked as picked up. Thank you!`,
      cancelled: `Your reservation for ${medicine.name} was cancelled by the pharmacy. The reserved units are available again.`,
    };
    db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?,?,?,?)`).run(
      reservation.customer_id, `Reservation ${toStatus}`,
      `Reservation #${reservation.id}: ${messages[toStatus]}`, 'reservation'
    );
    return { ok: true };
  });
  const pickupStockChanged = new Error('Not enough stock remains to complete this reservation.');
  let result;
  try {
    result = tx.immediate();
  } catch (error) {
    if (error === pickupStockChanged) return res.status(422).json({ error: error.message });
    throw error;
  }
  if (result.error) return res.status(422).json({ error: result.error });
  res.json({ ok: true });
}

router.post('/reservations/:id/confirm', (req, res) => transitionReservation(req, res, 'confirmed', ['pending']));
router.post('/reservations/:id/ready', (req, res) => transitionReservation(req, res, 'ready_for_pickup', ['confirmed']));
router.post('/reservations/:id/complete', (req, res) => transitionReservation(req, res, 'completed', ['confirmed', 'ready_for_pickup']));
router.post('/reservations/:id/picked-up', (req, res) => transitionReservation(req, res, 'completed', ['ready_for_pickup']));
router.post('/reservations/:id/cancel', (req, res) => transitionReservation(req, res, 'cancelled', ['pending', 'confirmed', 'ready_for_pickup']));

router.post('/reservations/:id/report-issue', (req, res) => {
  const note = String(req.body.issue || '').trim();
  if (!note) return res.status(422).json({ error: 'Describe the issue before reporting it.' });
  const reservation = db.prepare(`
    SELECT r.*, i.pharmacy_id, m.name AS medicine_name FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE r.id = ?
  `).get(req.params.id);
  if (!reservation) return res.status(404).json({ error: 'Reservation not found.' });
  if (reservation.pharmacy_id !== myPharmacyId(req)) {
    return res.status(403).json({ error: 'You can only manage your own pharmacy reservations.' });
  }
  if (!['pending', 'confirmed', 'ready_for_pickup'].includes(reservation.status)) {
    return res.status(422).json({ error: 'Issues can only be reported for active reservations.' });
  }
  const tx = db.transaction(() => {
    const current = db.prepare(`
      UPDATE reservations SET issue_note = ?
      WHERE id = ? AND status IN ('pending','confirmed','ready_for_pickup')
    `).run(note, reservation.id);
    if (!current.changes) return false;
    db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'reservation', ?, 'reservation_issue_reported', ?)
    `).run(reservation.pharmacy_id, req.session.user.id, reservation.id, note);
    db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?, ?, ?, 'reservation')`)
      .run(
        reservation.customer_id,
        'Reservation update',
        `The pharmacy reported an issue with your reservation for ${reservation.medicine_name}: ${note}`
      );
    return true;
  });
  if (!tx.immediate()) return res.status(422).json({ error: 'Reservation is no longer active.' });
  res.json({ ok: true });
});

module.exports = router;
