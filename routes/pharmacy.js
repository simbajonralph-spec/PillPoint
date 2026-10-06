const express = require('express');
const db = require('../db/database');
const { requireAuth, requireRole } = require('../middleware');
const router = express.Router();

router.use(requireAuth, requireRole('pharmacy_staff'));

function myPharmacyId(req) {
  return req.session.user.pharmacy_id;
}

// GET /api/pharmacy/dashboard
router.get('/dashboard', (req, res) => {
  const pid = myPharmacyId(req);
  const pharmacy = db.prepare('SELECT id, name, address, verified FROM pharmacies WHERE id = ?').get(pid);
  const lowStock = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = ? AND stock_quantity > 0 AND stock_quantity <= low_stock_threshold
  `).get(pid);
  const outStock = db.prepare(`SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = ? AND stock_quantity = 0`).get(pid);
  const pendingReservations = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'pending'
  `).get(pid);
  const confirmedReservations = db.prepare(`
    SELECT COUNT(*) AS count FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'confirmed'
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
    WHERE i.pharmacy_id = ? AND r.status IN ('pending','confirmed')
  `).get(pid);
  const availableItems = db.prepare(`
    SELECT COUNT(*) AS count FROM inventory
    WHERE pharmacy_id = ? AND stock_quantity > low_stock_threshold
  `).get(pid);
  const expiringSoon = db.prepare(`
    SELECT COUNT(*) AS count FROM medicine_batches
    WHERE pharmacy_id = ? AND expiration_date IS NOT NULL AND expiration_date > date('now')
      AND expiration_date <= date('now', '+30 days') AND status != 'expired'
  `).get(pid);
  const expiredBatches = db.prepare(`
    SELECT COUNT(*) AS count FROM medicine_batches
    WHERE pharmacy_id = ? AND expiration_date IS NOT NULL AND expiration_date <= date('now')
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
  const unreadNotifications = db.prepare(`
    SELECT COUNT(*) AS count FROM notifications WHERE user_id = ? AND is_read = 0
  `).get(req.session.user.id);
  const deployedItems = db.prepare('SELECT COUNT(*) AS count FROM inventory WHERE pharmacy_id = ? AND deployed = 1').get(pid);
  const deployedFolders = db.prepare(`SELECT COUNT(*) AS count FROM folders WHERE pharmacy_id = ? AND status = 'deployed'`).get(pid);
  const activeDeployedFolder = db.prepare(`
    SELECT id, name, deployed_at FROM folders
    WHERE pharmacy_id = ? AND status = 'deployed'
    ORDER BY deployed_at DESC, id DESC LIMIT 1
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
      WHEN stock_quantity = 0 THEN 'Out of Stock'
      WHEN stock_quantity <= low_stock_threshold THEN 'Low Stock'
      ELSE 'Available'
    END AS status, COUNT(*) AS count
    FROM inventory WHERE pharmacy_id = ? GROUP BY status
  `).all(pid);
  const publishedVsUnpublished = db.prepare(`
    SELECT deployed, COUNT(*) AS count FROM inventory WHERE pharmacy_id = ? GROUP BY deployed
  `).all(pid);
  const reservationTrend = db.prepare(`
    SELECT date(r.reserved_at, 'localtime') AS day, COUNT(*) AS count
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND date(r.reserved_at, 'localtime') >= date('now', 'localtime', '-29 days')
    GROUP BY day ORDER BY day
  `).all(pid);
  const topReservedMedicines = db.prepare(`
    SELECT m.name AS medicine_name, SUM(r.quantity) AS quantity_reserved,
      i.stock_quantity, i.low_stock_threshold
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
    SELECT i.id, m.name AS medicine_name, i.stock_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND i.stock_quantity = 0 ORDER BY m.name LIMIT 5
  `).all(pid);
  const lowStockMedicines = db.prepare(`
    SELECT i.id, m.name AS medicine_name, i.stock_quantity, i.low_stock_threshold
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND i.stock_quantity > 0 AND i.stock_quantity <= i.low_stock_threshold
    ORDER BY i.stock_quantity ASC, m.name LIMIT 5
  `).all(pid);
  const unpublishedMedicines = db.prepare(`
    SELECT i.id, m.name AS medicine_name, f.name AS folder_name
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    LEFT JOIN folders f ON f.id = i.folder_id
    WHERE i.pharmacy_id = ? AND i.deployed = 0 ORDER BY m.name LIMIT 5
  `).all(pid);

  res.json({
    pharmacy,
    activeDeployedFolder,
    stats: {
      lowStock: lowStock.count,
      outOfStock: outStock.count,
      pendingReservations: pendingReservations.count,
      confirmedReservations: confirmedReservations.count,
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
      unreadNotifications: unreadNotifications.count,
    },
    inventoryByCategory,
    stockByStatus,
    publishedVsUnpublished,
    reservationTrend,
    topReservedMedicines,
    recentReservations,
    attention: { outOfStockMedicines, lowStockMedicines, unpublishedMedicines },
  });
});

// ---- Folders ----

// GET /api/pharmacy/folders — each folder with its product count & value
router.get('/folders', (req, res) => {
  const pid = myPharmacyId(req);
  const folders = db.prepare(`
    SELECT f.*, COUNT(i.id) AS product_count, COALESCE(SUM(i.price * i.stock_quantity),0) AS estimated_value
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

// DELETE /api/pharmacy/folders/:id — items inside are unassigned (not deleted) and undeployed
router.delete('/folders/:id', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  const tx = db.transaction(() => {
    db.prepare('UPDATE inventory SET folder_id = NULL, deployed = 0 WHERE folder_id = ?').run(folder.id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
  });
  tx();
  res.json({ ok: true });
});

// POST /api/pharmacy/folders/:id/ready — mark draft folder as ready to deploy
router.post('/folders/:id/ready', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  if (folder.status !== 'draft') return res.status(422).json({ error: 'Only draft folders can be marked ready.' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(folder.id).c;
  if (!count) return res.status(422).json({ error: 'Add at least one product to this folder first.' });
  db.prepare(`UPDATE folders SET status = 'ready' WHERE id = ?`).run(folder.id);
  res.json({ ok: true });
});

// POST /api/pharmacy/folders/:id/deploy — deploys every product inside the folder at once
router.post('/folders/:id/deploy', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  if (folder.status === 'deployed') return res.status(422).json({ error: 'This folder is already deployed.' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(folder.id).c;
  if (!count) return res.status(422).json({ error: 'Add at least one product to this folder before deploying.' });

  const currentDeployed = db.prepare('SELECT * FROM folders WHERE pharmacy_id = ? AND status = ? AND id != ?').all(myPharmacyId(req), 'deployed', folder.id);

  const tx = db.transaction(() => {
    currentDeployed.forEach(previousFolder => {
      const previousCount = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(previousFolder.id).c;
      db.prepare(`UPDATE folders SET status = 'ready', deployed_at = NULL WHERE id = ?`).run(previousFolder.id);
      db.prepare(`UPDATE inventory SET deployed = 0, deployed_at = NULL WHERE folder_id = ?`).run(previousFolder.id);
      db.prepare(`INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?, ?, ?, ?, 'undeployed')`).run(previousFolder.pharmacy_id, previousFolder.id, previousFolder.name, previousCount);
    });
    db.prepare(`UPDATE folders SET status = 'deployed', deployed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(folder.id);
    db.prepare(`UPDATE inventory SET deployed = 1, deployed_at = CURRENT_TIMESTAMP WHERE folder_id = ?`).run(folder.id);
    db.prepare(`
      INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?,?,?,?,'deployed')
    `).run(folder.pharmacy_id, folder.id, folder.name, count);
  });
  tx();
  res.json({ ok: true, product_count: count });
});

// POST /api/pharmacy/inventory/:id/deploy { folder_id } — move an item and deploy its destination folder atomically.
router.post('/inventory/:id/deploy', (req, res) => {
  const pid = myPharmacyId(req);
  const item = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(req.params.id, pid);
  if (!item) return res.status(404).json({ error: 'Inventory item not found.' });
  const folderId = Number(req.body.folder_id);
  if (!Number.isInteger(folderId) || folderId <= 0) return res.status(422).json({ error: 'Choose a destination folder.' });
  const folder = db.prepare('SELECT * FROM folders WHERE id = ? AND pharmacy_id = ?').get(folderId, pid);
  if (!folder || folder.status === 'archived') return res.status(422).json({ error: 'Choose a valid, non-archived folder.' });

  const previousDeployed = db.prepare(`SELECT * FROM folders WHERE pharmacy_id = ? AND status = 'deployed' AND id != ?`).all(pid, folder.id);
  const wasDeployed = folder.status === 'deployed';
  const tx = db.transaction(() => {
    if (item.folder_id !== folder.id) {
      db.prepare('UPDATE inventory SET folder_id = ?, deployed = 0, deployed_at = NULL WHERE id = ?').run(folder.id, item.id);
    }
    previousDeployed.forEach(previousFolder => {
      const previousCount = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(previousFolder.id).c;
      db.prepare(`UPDATE folders SET status = 'ready', deployed_at = NULL WHERE id = ?`).run(previousFolder.id);
      db.prepare(`UPDATE inventory SET deployed = 0, deployed_at = NULL WHERE folder_id = ?`).run(previousFolder.id);
      db.prepare(`INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?, ?, ?, ?, 'undeployed')`).run(pid, previousFolder.id, previousFolder.name, previousCount);
    });
    db.prepare(`UPDATE folders SET status = 'deployed', deployed_at = CURRENT_TIMESTAMP WHERE id = ?`).run(folder.id);
    db.prepare(`UPDATE inventory SET deployed = 1, deployed_at = CURRENT_TIMESTAMP WHERE folder_id = ?`).run(folder.id);
    const productCount = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(folder.id).c;
    if (!wasDeployed || item.folder_id !== folder.id) {
      db.prepare(`INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?, ?, ?, ?, 'deployed')`).run(pid, folder.id, folder.name, productCount);
    }
  });
  tx();
  res.json({ ok: true, folder_id: folder.id, folder_name: folder.name });
});

// POST /api/pharmacy/folders/:id/undeploy — pulls every product in the folder back out of customer view
router.post('/folders/:id/undeploy', (req, res) => {
  const folder = db.prepare('SELECT * FROM folders WHERE id = ?').get(req.params.id);
  if (!folder) return res.status(404).json({ error: 'Folder not found.' });
  if (folder.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your folder.' });
  if (folder.status !== 'deployed') return res.status(422).json({ error: 'This folder is not currently deployed.' });
  const count = db.prepare('SELECT COUNT(*) AS c FROM inventory WHERE folder_id = ?').get(folder.id).c;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE folders SET status = 'ready' WHERE id = ?`).run(folder.id);
    db.prepare(`UPDATE inventory SET deployed = 0 WHERE folder_id = ?`).run(folder.id);
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
    db.prepare(`UPDATE inventory SET deployed = 0 WHERE folder_id = ?`).run(folder.id);
    if (wasDeployed) {
      db.prepare(`
        INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?,?,?,?,'undeployed')
      `).run(folder.pharmacy_id, folder.id, folder.name, count);
    }
  });
  tx();
  res.json({ ok: true });
});

// GET /api/pharmacy/deploy-log?month=YYYY-MM&folder_id=&q= — folder-level deployment history
router.get('/deploy-log', (req, res) => {
  const pid = myPharmacyId(req);
  const { month, folder_id, q } = req.query;
  const clauses = ['pharmacy_id = ?'];
  const params = [pid];
  if (month) { clauses.push(`strftime('%Y-%m', created_at) = ?`); params.push(month); }
  if (folder_id) { clauses.push('folder_id = ?'); params.push(folder_id); }
  if (q) { clauses.push('folder_name LIKE ?'); params.push(`%${q}%`); }

  const history = db.prepare(`
    SELECT * FROM folder_deploy_log WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT 50
  `).all(...params);

  // For each deploy event, list which products were in that folder (current contents —
  // a simple, honest approximation since individual items aren't versioned).
  const withProducts = history.map(h => {
    const products = db.prepare(`
      SELECT m.name, i.brand FROM inventory i JOIN medicines m ON m.id = i.medicine_id WHERE i.folder_id = ?
    `).all(h.folder_id);
    return { ...h, products };
  });

  const deployedValue = db.prepare(`
    SELECT COALESCE(SUM(price * stock_quantity), 0) AS total, COUNT(*) AS count
    FROM inventory WHERE pharmacy_id = ? AND deployed = 1
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
  const rows = db.prepare(`
    SELECT i.*, m.name AS medicine_name, m.category, f.name AS folder_name, f.status AS folder_status,
      COALESCE((SELECT SUM(quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed')), 0) AS reserved_quantity,
      MAX(CASE WHEN b.expiration_date IS NOT NULL THEN b.expiration_date END) AS next_expiration_date,
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
    available_quantity: Math.max(0, Number(item.stock_quantity || 0) - Number(item.reserved_quantity || 0)),
  }));
  const medicines = db.prepare('SELECT * FROM medicines ORDER BY name ASC').all();
  const folders = db.prepare(`SELECT id, name, status FROM folders WHERE pharmacy_id = ? ORDER BY name ASC`).all(pid);
  const suppliers = db.prepare('SELECT * FROM suppliers WHERE pharmacy_id = ? ORDER BY name ASC').all(pid);
  const batches = db.prepare(`
    SELECT b.*, m.name AS medicine_name, s.name AS supplier_name
    FROM medicine_batches b
    JOIN medicines m ON m.id = b.medicine_id
    LEFT JOIN suppliers s ON s.id = b.supplier_id
    WHERE b.pharmacy_id = ? ORDER BY b.expiration_date ASC, b.created_at DESC
  `).all(pid);
  res.json({ inventory: rows, medicines, folders, suppliers, batches });
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

  try {
    const info = db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, folder_id, price, stock_quantity, low_stock_threshold, brand)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(pid, resolvedMedicineId, resolvedFolderId, price, stock_quantity, low_stock_threshold || 10, (brand || '').trim() || null);

    const insertedId = Number(info.lastInsertRowid);
    const batch = (batch_number || '').trim();
    if (batch) {
      db.prepare(`
        INSERT INTO medicine_batches (pharmacy_id, medicine_id, inventory_id, batch_number, expiration_date, quantity_received, current_quantity, date_received)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(pharmacy_id, batch_number) DO UPDATE SET
          inventory_id = excluded.inventory_id,
          expiration_date = excluded.expiration_date,
          quantity_received = quantity_received + excluded.quantity_received,
          current_quantity = current_quantity + excluded.current_quantity,
          updated_at = CURRENT_TIMESTAMP
      `).run(pid, resolvedMedicineId, insertedId, batch, expiration_date || null, Number(stock_quantity), Number(stock_quantity), new Date().toISOString());
    }

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

  const { price, stock_quantity, low_stock_threshold, brand } = req.body;
  db.prepare(`
    UPDATE inventory SET price = ?, stock_quantity = ?, low_stock_threshold = ?, brand = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(
    price != null ? price : item.price,
    stock_quantity != null ? stock_quantity : item.stock_quantity,
    low_stock_threshold != null ? low_stock_threshold : item.low_stock_threshold,
    brand !== undefined ? ((brand || '').trim() || null) : item.brand,
    item.id
  );
  res.json({ ok: true });
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
    if (!targetFolder || targetFolder.pharmacy_id !== myPharmacyId(req)) {
      return res.status(422).json({ error: 'Invalid folder.' });
    }
  }
  const deployed = targetFolder && targetFolder.status === 'deployed' ? 1 : 0;
  db.prepare(`
    UPDATE inventory SET folder_id = ?, deployed = ?, deployed_at = ? WHERE id = ?
  `).run(targetFolder ? targetFolder.id : null, deployed, deployed ? new Date().toISOString() : null, item.id);
  res.json({ ok: true });
});

// DELETE /api/pharmacy/inventory/:id
router.delete('/inventory/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  if (item.pharmacy_id !== myPharmacyId(req)) return res.status(403).json({ error: 'Not your pharmacy inventory.' });
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

router.post('/inventory/stock-in', (req, res) => {
  const pid = myPharmacyId(req);
  const { inventory_id, medicine_id, batch_number, supplier_id, quantity, purchase_price, selling_price, manufacturing_date, expiration_date, storage_location, supplier_reference, remarks } = req.body;
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(422).json({ error: 'A valid quantity is required.' });
  const targetMedicineId = Number(inventory_id ? db.prepare('SELECT medicine_id FROM inventory WHERE id = ? AND pharmacy_id = ?').get(inventory_id, pid)?.medicine_id : medicine_id);
  if (!targetMedicineId) return res.status(404).json({ error: 'Medicine not found in your inventory.' });
  const targetInventoryId = inventory_id ? Number(inventory_id) : db.prepare('SELECT id FROM inventory WHERE pharmacy_id = ? AND medicine_id = ?').get(pid, targetMedicineId)?.id;
  const resolvedSupplier = supplier_id ? Number(supplier_id) : null;
  const batch = (batch_number || '').trim();
  if (!batch) return res.status(422).json({ error: 'Batch number is required.' });
  const tx = db.transaction(() => {
    if (targetInventoryId) {
      const item = db.prepare('SELECT * FROM inventory WHERE id = ?').get(targetInventoryId);
      const previousQty = Number(item.stock_quantity || 0);
      db.prepare('UPDATE inventory SET stock_quantity = stock_quantity + ?, price = COALESCE(?, price), updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, selling_price != null ? Number(selling_price) : null, targetInventoryId);
      db.prepare(`INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, transaction_type, quantity, previous_quantity, new_quantity, reference_number, staff_user_id, remarks)
        VALUES (?, ?, ?, 'stock_in', ?, ?, ?, ?, ?, ?)
      `).run(pid, targetMedicineId, targetInventoryId, qty, previousQty, previousQty + qty, batch, req.session.user.id, remarks || 'Stock-in');
    }

    const batchRow = db.prepare(`
      INSERT INTO medicine_batches (pharmacy_id, medicine_id, inventory_id, supplier_id, batch_number, supplier_reference, manufacturing_date, expiration_date, quantity_received, current_quantity, purchase_price, selling_price, date_received, storage_location, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pharmacy_id, batch_number) DO UPDATE SET
        inventory_id = excluded.inventory_id,
        supplier_id = excluded.supplier_id,
        supplier_reference = excluded.supplier_reference,
        manufacturing_date = excluded.manufacturing_date,
        expiration_date = excluded.expiration_date,
        quantity_received = quantity_received + excluded.quantity_received,
        current_quantity = current_quantity + excluded.current_quantity,
        purchase_price = COALESCE(excluded.purchase_price, purchase_price),
        selling_price = COALESCE(excluded.selling_price, selling_price),
        date_received = COALESCE(date_received, excluded.date_received),
        storage_location = COALESCE(excluded.storage_location, storage_location),
        notes = COALESCE(excluded.notes, notes),
        updated_at = CURRENT_TIMESTAMP
    `).run(pid, targetMedicineId, targetInventoryId || null, resolvedSupplier, batch, (supplier_reference || '').trim() || null, manufacturing_date || null, expiration_date || null, qty, qty, purchase_price != null ? Number(purchase_price) : null, selling_price != null ? Number(selling_price) : null, new Date().toISOString(), (storage_location || '').trim() || null, (remarks || '').trim() || null);

    db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'inventory', ?, 'stock_in', ?)
    `).run(pid, req.session.user.id, targetInventoryId || targetMedicineId, `Stock-in of ${qty} units for batch ${batch}`);
  });
  tx();
  res.json({ ok: true, message: `Stock-In completed successfully. +${qty} units added.` });
});

router.post('/inventory/stock-out', (req, res) => {
  const pid = myPharmacyId(req);
  const { inventory_id, quantity, reason, reference_number, remarks } = req.body;
  const inventory = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(inventory_id, pid);
  if (!inventory) return res.status(404).json({ error: 'Inventory item not found.' });
  const qty = Number(quantity);
  if (!qty || qty <= 0) return res.status(422).json({ error: 'A valid quantity is required.' });
  const reserved = db.prepare(`SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations WHERE inventory_id = ? AND status IN ('pending','confirmed')`).get(inventory.id).total;
  const available = Math.max(0, Number(inventory.stock_quantity || 0) - Number(reserved || 0));
  if (qty > available) return res.status(422).json({ error: 'Insufficient available stock.' });
  const tx = db.transaction(() => {
    const previous = Number(inventory.stock_quantity || 0);
    db.prepare('UPDATE inventory SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(qty, inventory.id);
    db.prepare(`INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, transaction_type, quantity, previous_quantity, new_quantity, reason, reference_number, staff_user_id, remarks)
      VALUES (?, ?, ?, 'stock_out', ?, ?, ?, ?, ?, ?, ?)
    `).run(pid, inventory.medicine_id, inventory.id, qty, previous, previous - qty, reason || 'stock_out', reference_number || null, req.session.user.id, remarks || 'Stock-out');
    db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'inventory', ?, 'stock_out', ?)
    `).run(pid, req.session.user.id, inventory.id, `Stock-out of ${qty} units`);
  });
  tx();
  res.json({ ok: true, message: `Stock-out completed. -${qty} units removed.` });
});

router.post('/inventory/adjust', (req, res) => {
  const pid = myPharmacyId(req);
  const { inventory_id, adjustment, reason, remarks } = req.body;
  const inventory = db.prepare('SELECT * FROM inventory WHERE id = ? AND pharmacy_id = ?').get(inventory_id, pid);
  if (!inventory) return res.status(404).json({ error: 'Inventory item not found.' });
  const delta = Number(adjustment);
  if (!Number.isFinite(delta) || delta === 0) return res.status(422).json({ error: 'Adjustment must be a non-zero number.' });
  const nextStock = Number(inventory.stock_quantity) + delta;
  if (nextStock < 0) return res.status(422).json({ error: 'Adjustment would create negative stock.' });
  const tx = db.transaction(() => {
    const prev = Number(inventory.stock_quantity || 0);
    db.prepare('UPDATE inventory SET stock_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(nextStock, inventory.id);
    db.prepare(`INSERT INTO stock_transactions (pharmacy_id, medicine_id, inventory_id, transaction_type, quantity, previous_quantity, new_quantity, reason, staff_user_id, remarks)
      VALUES (?, ?, ?, 'adjustment', ?, ?, ?, ?, ?, ?)
    `).run(pid, inventory.medicine_id, inventory.id, delta, prev, nextStock, reason || 'inventory_adjustment', req.session.user.id, remarks || 'Manual stock adjustment');
    db.prepare(`INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
      VALUES (?, ?, 'inventory', ?, 'adjustment', ?)
    `).run(pid, req.session.user.id, inventory.id, `Adjusted stock by ${delta}`);
  });
  tx();
  res.json({ ok: true, message: `Stock adjusted by ${delta}.` });
});

router.get('/inventory/history', (req, res) => {
  const pid = myPharmacyId(req);
  const rows = db.prepare(`
    SELECT t.*, m.name AS medicine_name, i.medicine_id
    FROM stock_transactions t
    JOIN medicines m ON m.id = t.medicine_id
    LEFT JOIN inventory i ON i.id = t.inventory_id
    WHERE t.pharmacy_id = ?
    ORDER BY t.created_at DESC LIMIT 50
  `).all(pid);
  res.json({ history: rows });
});

// GET /api/pharmacy/alerts — low stock / out of stock items
router.get('/alerts', (req, res) => {
  const rows = db.prepare(`
    SELECT i.*, m.name AS medicine_name,
      COALESCE((SELECT SUM(quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed')), 0) AS reserved_quantity,
      (i.stock_quantity - COALESCE((SELECT SUM(quantity) FROM reservations r WHERE r.inventory_id = i.id AND r.status IN ('pending','confirmed')), 0)) AS available_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND (i.stock_quantity <= i.low_stock_threshold OR i.stock_quantity = 0)
    ORDER BY i.stock_quantity ASC
  `).all(myPharmacyId(req));
  res.json({ alerts: rows });
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
  const byStatus = db.prepare(`
    SELECT r.status, COUNT(*) AS count FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id WHERE i.pharmacy_id = ? GROUP BY r.status
  `).all(pid);
  const topMedicines = db.prepare(`
    SELECT m.name, SUM(r.quantity) AS total_reserved
    FROM reservations r
    JOIN inventory i ON i.id = r.inventory_id
    JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND r.status IN ('confirmed','completed')
    GROUP BY m.name ORDER BY total_reserved DESC LIMIT 5
  `).all(pid);

  const inventoryByCategory = db.prepare(`
    SELECT COALESCE(m.category, 'Uncategorized') AS category, COUNT(*) AS count, COALESCE(SUM(i.price * i.stock_quantity),0) AS value
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? GROUP BY category ORDER BY count DESC
  `).all(pid);

  const deployedVsNot = db.prepare(`
    SELECT deployed, COUNT(*) AS count FROM inventory WHERE pharmacy_id = ? GROUP BY deployed
  `).all(pid);

  const weekdayRows = db.prepare(`
    SELECT r.reserved_at FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.reserved_at >= datetime('now', '-56 days')
  `).all(pid);
  const weekdayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  weekdayRows.forEach(r => {
    const jsDay = new Date(r.reserved_at).getDay();
    const idx = jsDay === 0 ? 6 : jsDay - 1;
    weekdayCounts[idx]++;
  });

  // Revenue trend (completed reservations) over the last 6 months.
  const monthlyRows = db.prepare(`
    SELECT strftime('%Y-%m', r.completed_at) AS ym,
      SUM(r.quantity * COALESCE(r.price_at_reservation, i.price)) AS revenue
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND r.status = 'completed' AND r.completed_at >= datetime('now', '-6 months')
    GROUP BY ym ORDER BY ym ASC
  `).all(pid);

  const stockLevels = db.prepare(`
    SELECT m.name AS medicine_name, i.stock_quantity, i.low_stock_threshold
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? ORDER BY i.stock_quantity ASC, m.name ASC LIMIT 8
  `).all(pid);
  const ratingDistribution = db.prepare(`
    SELECT rating, COUNT(*) AS count FROM pharmacy_ratings
    WHERE pharmacy_id = ? GROUP BY rating ORDER BY rating
  `).all(pid);
  const dailyReservations = db.prepare(`
    SELECT date(r.reserved_at, 'localtime') AS day, COUNT(*) AS count
    FROM reservations r JOIN inventory i ON i.id = r.inventory_id
    WHERE i.pharmacy_id = ? AND date(r.reserved_at, 'localtime') >= date('now', 'localtime', '-13 days')
    GROUP BY day ORDER BY day
  `).all(pid);
  const lowStockMedicines = db.prepare(`
    SELECT m.name AS medicine_name, i.stock_quantity
    FROM inventory i JOIN medicines m ON m.id = i.medicine_id
    WHERE i.pharmacy_id = ? AND i.stock_quantity > 0 AND i.stock_quantity <= i.low_stock_threshold
    ORDER BY i.stock_quantity ASC, m.name ASC LIMIT 8
  `).all(pid);

  res.json({
    byStatus,
    topMedicines,
    inventoryByCategory,
    deployedVsNot,
    reservationStats: { labels: weekdayLabels, counts: weekdayCounts },
    monthlyRevenue: monthlyRows,
    stockLevels,
    ratingDistribution,
    dailyReservations,
    lowStockMedicines,
  });
});

// GET /api/pharmacy/profile — pharmacy record linked to this staff account's registration info
router.get('/profile', (req, res) => {
  const pharmacy = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(myPharmacyId(req));
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
  const { name, phone, business_email, address, latitude, longitude, profile_image, cover_image, description, hours, owner_first_name, owner_last_name } = req.body;
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

  const tx = db.transaction(() => {
    const pharmacy = db.prepare('SELECT * FROM pharmacies WHERE id = ?').get(pid);
    const lat = latitude != null && latitude !== '' ? parseFloat(latitude) : pharmacy.latitude;
    const lng = longitude != null && longitude !== '' ? parseFloat(longitude) : pharmacy.longitude;
    db.prepare(`
      UPDATE pharmacies SET name = ?, phone = ?, business_email = ?, address = ?, latitude = ?, longitude = ?, profile_image = ?, store_image = ?, cover_image = ?, description = ?, hours = ?, owner_first_name = ?, owner_last_name = ? WHERE id = ?
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

// GET /api/pharmacy/reservations
router.get('/reservations', (req, res) => {
  const rows = db.prepare(`
    SELECT r.*, m.name AS medicine_name, u.name AS customer_name,
      u.username AS customer_username, u.email AS customer_email, u.phone AS customer_phone
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
      const newQuantity = inventory.stock_quantity - currentReservation.quantity;
      const deduction = db.prepare(`
        UPDATE inventory SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND stock_quantity >= ?
      `).run(currentReservation.quantity, inventory.id, currentReservation.quantity);
      if (!deduction.changes) return { error: 'Not enough stock remains to complete this reservation.' };
      db.prepare(`
        INSERT INTO stock_transactions (
          pharmacy_id, medicine_id, inventory_id, transaction_type, quantity,
          previous_quantity, new_quantity, reason, reference_number, staff_user_id, remarks
        ) VALUES (?, ?, ?, 'stock_out', ?, ?, ?, 'reservation_completed', ?, ?, ?)
      `).run(
        reservation.pharmacy_id, inventory.medicine_id, inventory.id, currentReservation.quantity,
        inventory.stock_quantity, inventory.stock_quantity - currentReservation.quantity,
        `RES-${reservation.id}`, req.session.user.id, `Completed reservation #${reservation.id}`
      );
      db.prepare(`
        INSERT INTO inventory_audit_logs (pharmacy_id, user_id, entity_type, entity_id, action, details)
        VALUES (?, ?, 'inventory', ?, 'reservation_completed', ?)
      `).run(
        reservation.pharmacy_id, req.session.user.id, inventory.id,
        `Deducted ${currentReservation.quantity} units for completed reservation #${reservation.id}`
      );
    }
    const completedAt = toStatus === 'completed' ? new Date().toISOString() : null;
    const statusUpdate = db.prepare(`
      UPDATE reservations SET status = ?,
        completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END
      WHERE id = ? AND status = ?
    `).run(toStatus, toStatus, completedAt, reservation.id, currentReservation.status);
    if (!statusUpdate.changes) throw new Error('Reservation status changed during the pharmacy transition.');
    const medicine = db.prepare(`
      SELECT m.name FROM inventory i JOIN medicines m ON m.id = i.medicine_id WHERE i.id = ?
    `).get(reservation.inventory_id);
    const messages = {
      confirmed: `Your reservation for ${medicine.name} has been confirmed. Please pick it up before it expires.`,
      completed: `Your reservation for ${medicine.name} has been marked as picked up. Thank you!`,
      cancelled: `Your reservation for ${medicine.name} was cancelled by the pharmacy. The reserved units are available again.`,
    };
    db.prepare(`INSERT INTO notifications (user_id, title, message, type) VALUES (?,?,?,?)`).run(
      reservation.customer_id, `Reservation ${toStatus}`,
      `Reservation #${reservation.id}: ${messages[toStatus]}`, 'reservation'
    );
    return { ok: true };
  });
  const result = tx.immediate();
  if (result.error) return res.status(422).json({ error: result.error });
  res.json({ ok: true });
}

router.post('/reservations/:id/confirm', (req, res) => transitionReservation(req, res, 'confirmed', ['pending']));
router.post('/reservations/:id/complete', (req, res) => transitionReservation(req, res, 'completed', ['confirmed']));
router.post('/reservations/:id/cancel', (req, res) => transitionReservation(req, res, 'cancelled', ['pending', 'confirmed']));

module.exports = router;
