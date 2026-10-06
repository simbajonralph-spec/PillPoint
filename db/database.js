// db/database.js
// Sets up (and if needed, creates + seeds) the SQLite database.
// Using better-sqlite3: a real embedded SQL database (single file: pillpoint.db)
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'pillpoint.db');
const isNew = !fs.existsSync(DB_PATH);

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  username TEXT,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  profile_image TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer','pharmacy_staff','admin')),
  pharmacy_id INTEGER,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id)
);

CREATE TABLE IF NOT EXISTS pharmacies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  phone TEXT,
  business_email TEXT,
  owner_first_name TEXT,
  owner_last_name TEXT,
  business_permit TEXT,
  verified INTEGER NOT NULL DEFAULT 0,
  verification_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(verification_status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  verification_date TEXT,
  verification_reason TEXT,
  rejection_reason TEXT,
  suspension_reason TEXT,
  approved_by_admin_id INTEGER,
  status_updated_at TEXT,
  store_image TEXT,
  profile_image TEXT,
  cover_image TEXT,
  description TEXT,
  hours TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (approved_by_admin_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS medicines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  category TEXT,
  description TEXT
);

-- Folders let a pharmacy group products together and deploy/undeploy them as
-- one unit, instead of toggling visibility per product.
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','ready','deployed','archived')),
  deployed_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id)
);

CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  medicine_id INTEGER NOT NULL,
  folder_id INTEGER,
  price REAL NOT NULL,
  stock_quantity INTEGER NOT NULL DEFAULT 0,
  low_stock_threshold INTEGER NOT NULL DEFAULT 10,
  brand TEXT,
  deployed INTEGER NOT NULL DEFAULT 0,
  deployed_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id),
  FOREIGN KEY (medicine_id) REFERENCES medicines(id),
  FOREIGN KEY (folder_id) REFERENCES folders(id),
  UNIQUE(pharmacy_id, medicine_id)
);

-- Log of every deploy/undeploy action, used for the "recent deploy history" panel.
CREATE TABLE IF NOT EXISTS deploy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  inventory_id INTEGER NOT NULL,
  medicine_name TEXT NOT NULL,
  brand TEXT,
  price REAL NOT NULL,
  stock_quantity INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('deployed','undeployed')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id)
);

-- Deployment history is now recorded at the folder level (a folder deploy
-- publishes every product inside it in one action).
CREATE TABLE IF NOT EXISTS folder_deploy_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  folder_id INTEGER NOT NULL,
  folder_name TEXT NOT NULL,
  product_count INTEGER NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('deployed','undeployed')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id),
  FOREIGN KEY (folder_id) REFERENCES folders(id)
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  inventory_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  price_at_reservation REAL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','completed','cancelled','expired')),
  reserved_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  completed_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES users(id),
  FOREIGN KEY (inventory_id) REFERENCES inventory(id)
);

CREATE TABLE IF NOT EXISTS search_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  query TEXT,
  category TEXT,
  medicine_ids TEXT NOT NULL DEFAULT '[]',
  pharmacy_ids TEXT NOT NULL DEFAULT '[]',
  result_count INTEGER NOT NULL DEFAULT 0,
  searched_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT DEFAULT 'info',
  is_read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS medicine_availability_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL,
  medicine_id INTEGER NOT NULL,
  pharmacy_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  notified_at TEXT,
  FOREIGN KEY (customer_id) REFERENCES users(id),
  FOREIGN KEY (medicine_id) REFERENCES medicines(id),
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id)
);

CREATE TABLE IF NOT EXISTS pharmacy_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  customer_id INTEGER NOT NULL,
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pharmacy_id, customer_id),
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id),
  FOREIGN KEY (customer_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  contact_person TEXT,
  phone TEXT,
  email TEXT,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id)
);

CREATE TABLE IF NOT EXISTS medicine_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  medicine_id INTEGER NOT NULL,
  inventory_id INTEGER,
  supplier_id INTEGER,
  batch_number TEXT NOT NULL,
  manufacturer TEXT,
  supplier_reference TEXT,
  manufacturing_date TEXT,
  expiration_date TEXT,
  quantity_received INTEGER NOT NULL DEFAULT 0,
  current_quantity INTEGER NOT NULL DEFAULT 0,
  purchase_price REAL,
  selling_price REAL,
  date_received TEXT DEFAULT CURRENT_TIMESTAMP,
  storage_location TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','expiring_soon','expired','depleted','recalled','archived')),
  notes TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pharmacy_id, batch_number),
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id),
  FOREIGN KEY (medicine_id) REFERENCES medicines(id),
  FOREIGN KEY (inventory_id) REFERENCES inventory(id),
  FOREIGN KEY (supplier_id) REFERENCES suppliers(id)
);

CREATE TABLE IF NOT EXISTS stock_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  medicine_id INTEGER NOT NULL,
  inventory_id INTEGER,
  batch_id INTEGER,
  transaction_type TEXT NOT NULL CHECK(transaction_type IN ('stock_in','stock_out','reservation','reservation_cancellation','adjustment','damaged','expired','return','deployment','undeployment')),
  quantity INTEGER NOT NULL DEFAULT 0,
  previous_quantity INTEGER,
  new_quantity INTEGER,
  reason TEXT,
  reference_number TEXT,
  staff_user_id INTEGER,
  remarks TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id),
  FOREIGN KEY (medicine_id) REFERENCES medicines(id),
  FOREIGN KEY (inventory_id) REFERENCES inventory(id),
  FOREIGN KEY (batch_id) REFERENCES medicine_batches(id),
  FOREIGN KEY (staff_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS inventory_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id INTEGER NOT NULL,
  user_id INTEGER,
  entity_type TEXT NOT NULL,
  entity_id INTEGER,
  action TEXT NOT NULL,
  details TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pharmacy_id) REFERENCES pharmacies(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  admin_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id INTEGER,
  target_name TEXT,
  description TEXT,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'SUCCESS' CHECK(status IN ('SUCCESS','FAILED','INFO')),
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (admin_id) REFERENCES users(id)
);
`);

const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
if (!userCols.includes('username')) db.exec('ALTER TABLE users ADD COLUMN username TEXT');
if (!userCols.includes('phone')) db.exec('ALTER TABLE users ADD COLUMN phone TEXT');
if (!userCols.includes('profile_image')) db.exec('ALTER TABLE users ADD COLUMN profile_image TEXT');
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique ON users(username) WHERE username IS NOT NULL AND username <> ''");

const reservationCols = db.prepare("PRAGMA table_info(reservations)").all().map(c => c.name);
if (!reservationCols.includes('price_at_reservation')) db.exec('ALTER TABLE reservations ADD COLUMN price_at_reservation REAL');
if (!reservationCols.includes('expires_at')) db.exec('ALTER TABLE reservations ADD COLUMN expires_at TEXT');
db.exec('UPDATE reservations SET price_at_reservation = (SELECT price FROM inventory WHERE inventory.id = reservations.inventory_id) WHERE price_at_reservation IS NULL');
const reservationTableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'reservations'").get().sql;
if (!reservationTableSql.includes("'expired'") || !reservationCols.includes('completed_at')) {
  const completedAt = reservationCols.includes('completed_at') ? 'completed_at' : 'NULL';
  const rebuildReservations = db.transaction(() => {
    db.exec(`
      CREATE TABLE reservations_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER NOT NULL,
        inventory_id INTEGER NOT NULL,
        quantity INTEGER NOT NULL,
        price_at_reservation REAL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','confirmed','completed','cancelled','expired')),
        reserved_at TEXT DEFAULT CURRENT_TIMESTAMP,
        expires_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (customer_id) REFERENCES users(id),
        FOREIGN KEY (inventory_id) REFERENCES inventory(id)
      )
    `);
    db.exec(`
      INSERT INTO reservations_new (id, customer_id, inventory_id, quantity, price_at_reservation, status, reserved_at, expires_at, completed_at)
      SELECT id, customer_id, inventory_id, quantity, price_at_reservation, status, reserved_at, expires_at, ${completedAt}
      FROM reservations
    `);
    db.exec('DROP TABLE reservations');
    db.exec('ALTER TABLE reservations_new RENAME TO reservations');
  });
  rebuildReservations();
}
db.exec(`
  UPDATE reservations
  SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', reserved_at, '+24 hours')
  WHERE status = 'pending';
  UPDATE reservations SET completed_at = reserved_at
  WHERE status = 'completed' AND completed_at IS NULL;
`);

// Lightweight migration: if this is an existing pre-deploy-feature database,
// add the new inventory columns instead of forcing a full reseed.
const inventoryCols = db.prepare("PRAGMA table_info(inventory)").all().map(c => c.name);
if (!inventoryCols.includes('brand')) db.exec("ALTER TABLE inventory ADD COLUMN brand TEXT");
if (!inventoryCols.includes('deployed')) db.exec("ALTER TABLE inventory ADD COLUMN deployed INTEGER NOT NULL DEFAULT 0");
if (!inventoryCols.includes('deployed_at')) db.exec("ALTER TABLE inventory ADD COLUMN deployed_at TEXT");
if (!inventoryCols.includes('folder_id')) db.exec("ALTER TABLE inventory ADD COLUMN folder_id INTEGER REFERENCES folders(id)");

db.exec(`
UPDATE folders SET status = 'ready', deployed_at = NULL
WHERE status = 'deployed' AND id != (
  SELECT active.id FROM folders active
  WHERE active.pharmacy_id = folders.pharmacy_id AND active.status = 'deployed'
  ORDER BY COALESCE(active.deployed_at, active.created_at) DESC, active.id DESC LIMIT 1
);
UPDATE inventory SET deployed = 0, deployed_at = NULL
WHERE folder_id IS NULL OR folder_id IN (SELECT id FROM folders WHERE status != 'deployed');
UPDATE inventory SET deployed = 1
WHERE folder_id IN (SELECT id FROM folders WHERE status = 'deployed');
CREATE UNIQUE INDEX IF NOT EXISTS folders_one_deployed_per_pharmacy
ON folders(pharmacy_id) WHERE status = 'deployed';
`);

const pharmacyCols = db.prepare("PRAGMA table_info(pharmacies)").all().map(c => c.name);
if (!pharmacyCols.includes('store_image')) db.exec("ALTER TABLE pharmacies ADD COLUMN store_image TEXT");
if (!pharmacyCols.includes('business_email')) db.exec('ALTER TABLE pharmacies ADD COLUMN business_email TEXT');
if (!pharmacyCols.includes('profile_image')) db.exec("ALTER TABLE pharmacies ADD COLUMN profile_image TEXT");
if (!pharmacyCols.includes('cover_image')) db.exec("ALTER TABLE pharmacies ADD COLUMN cover_image TEXT");
if (!pharmacyCols.includes('description')) db.exec("ALTER TABLE pharmacies ADD COLUMN description TEXT");
if (!pharmacyCols.includes('hours')) db.exec("ALTER TABLE pharmacies ADD COLUMN hours TEXT");
if (!pharmacyCols.includes('owner_first_name')) db.exec('ALTER TABLE pharmacies ADD COLUMN owner_first_name TEXT');
if (!pharmacyCols.includes('owner_last_name')) db.exec('ALTER TABLE pharmacies ADD COLUMN owner_last_name TEXT');
if (!pharmacyCols.includes('business_permit')) db.exec('ALTER TABLE pharmacies ADD COLUMN business_permit TEXT');
if (!pharmacyCols.includes('verification_status')) db.exec("ALTER TABLE pharmacies ADD COLUMN verification_status TEXT NOT NULL DEFAULT 'PENDING'");
if (!pharmacyCols.includes('verification_date')) db.exec('ALTER TABLE pharmacies ADD COLUMN verification_date TEXT');
if (!pharmacyCols.includes('verification_reason')) db.exec('ALTER TABLE pharmacies ADD COLUMN verification_reason TEXT');
if (!pharmacyCols.includes('rejection_reason')) db.exec('ALTER TABLE pharmacies ADD COLUMN rejection_reason TEXT');
if (!pharmacyCols.includes('suspension_reason')) db.exec('ALTER TABLE pharmacies ADD COLUMN suspension_reason TEXT');
if (!pharmacyCols.includes('approved_by_admin_id')) db.exec('ALTER TABLE pharmacies ADD COLUMN approved_by_admin_id INTEGER');
if (!pharmacyCols.includes('status_updated_at')) db.exec('ALTER TABLE pharmacies ADD COLUMN status_updated_at TEXT');

const adminAuditCols = db.prepare("PRAGMA table_info(admin_audit_logs)").all().map(c => c.name);
if (adminAuditCols.length && !adminAuditCols.includes('reason')) db.exec('ALTER TABLE admin_audit_logs ADD COLUMN reason TEXT');

const ratingCols = db.prepare("PRAGMA table_info(pharmacy_ratings)").all().map(c => c.name);
if (!ratingCols.includes('comment')) db.exec('ALTER TABLE pharmacy_ratings ADD COLUMN comment TEXT');

const supplierCols = db.prepare("PRAGMA table_info(suppliers)").all().map(c => c.name);
if (!supplierCols.includes('status')) db.exec("ALTER TABLE suppliers ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");

const batchCols = db.prepare("PRAGMA table_info(medicine_batches)").all().map(c => c.name);
if (!batchCols.includes('supplier_id')) db.exec('ALTER TABLE medicine_batches ADD COLUMN supplier_id INTEGER');
if (!batchCols.includes('supplier_reference')) db.exec('ALTER TABLE medicine_batches ADD COLUMN supplier_reference TEXT');
if (!batchCols.includes('storage_location')) db.exec('ALTER TABLE medicine_batches ADD COLUMN storage_location TEXT');
if (!batchCols.includes('status')) db.exec("ALTER TABLE medicine_batches ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");

const transactionCols = db.prepare("PRAGMA table_info(stock_transactions)").all().map(c => c.name);
if (!transactionCols.includes('batch_id')) db.exec('ALTER TABLE stock_transactions ADD COLUMN batch_id INTEGER');
if (!transactionCols.includes('reference_number')) db.exec('ALTER TABLE stock_transactions ADD COLUMN reference_number TEXT');

const pharmacyStatusUpdate = db.transaction(() => {
  db.exec(`
    UPDATE pharmacies
    SET verification_status = CASE
      WHEN verified = 1 THEN 'VERIFIED'
      WHEN verified = 0 AND COALESCE(rejection_reason, '') <> '' THEN 'REJECTED'
      WHEN verified = 0 AND COALESCE(suspension_reason, '') <> '' THEN 'SUSPENDED'
      ELSE 'PENDING'
    END,
    status_updated_at = COALESCE(status_updated_at, created_at)
    WHERE verification_status IS NULL OR verification_status = '';
  `);
  db.exec(`
    UPDATE pharmacies
    SET verification_status = 'VERIFIED', verified = 1
    WHERE verified = 1 AND (verification_status IS NULL OR verification_status = 'PENDING');
  `);
  db.exec(`
    UPDATE pharmacies
    SET verified = CASE WHEN verification_status = 'VERIFIED' THEN 1 ELSE 0 END
    WHERE verified IS NULL OR verified <> CASE WHEN verification_status = 'VERIFIED' THEN 1 ELSE 0 END;
  `);
});
pharmacyStatusUpdate();

db.exec(`
  CREATE INDEX IF NOT EXISTS medicine_availability_watch_customer_active
  ON medicine_availability_watch(customer_id, active);

  CREATE TRIGGER IF NOT EXISTS notify_availability_watch_after_inventory_insert
  AFTER INSERT ON inventory
  WHEN NEW.deployed = 1 AND NEW.stock_quantity > 0
    AND EXISTS (
      SELECT 1 FROM pharmacies p
      WHERE p.id = NEW.pharmacy_id
        AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    )
  BEGIN
    INSERT INTO notifications (user_id, title, message, type)
    SELECT w.customer_id, 'Medicine available',
      m.name || ' is now available at ' || p.name || '. Open PillPoint search to see current details.',
      'availability'
    FROM medicine_availability_watch w
    JOIN medicines m ON m.id = w.medicine_id
    JOIN pharmacies p ON p.id = NEW.pharmacy_id
    WHERE w.active = 1 AND w.medicine_id = NEW.medicine_id
      AND (w.pharmacy_id IS NULL OR w.pharmacy_id = NEW.pharmacy_id);

    UPDATE medicine_availability_watch
    SET active = 0, notified_at = CURRENT_TIMESTAMP
    WHERE active = 1 AND medicine_id = NEW.medicine_id
      AND (pharmacy_id IS NULL OR pharmacy_id = NEW.pharmacy_id)
      AND EXISTS (
        SELECT 1 FROM pharmacies p
        WHERE p.id = NEW.pharmacy_id
          AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      );
  END;

  CREATE TRIGGER IF NOT EXISTS notify_availability_watch_after_inventory_update
  AFTER UPDATE OF medicine_id, pharmacy_id, deployed, stock_quantity ON inventory
  WHEN NEW.deployed = 1 AND NEW.stock_quantity > 0
    AND EXISTS (
      SELECT 1 FROM pharmacies p
      WHERE p.id = NEW.pharmacy_id
        AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    )
    AND (
      OLD.deployed != 1 OR OLD.stock_quantity <= 0
      OR OLD.pharmacy_id != NEW.pharmacy_id OR OLD.medicine_id != NEW.medicine_id
      OR NOT EXISTS (
        SELECT 1 FROM pharmacies p
        WHERE p.id = OLD.pharmacy_id
          AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      )
    )
  BEGIN
    INSERT INTO notifications (user_id, title, message, type)
    SELECT w.customer_id, 'Medicine available',
      m.name || ' is now available at ' || p.name || '. Open PillPoint search to see current details.',
      'availability'
    FROM medicine_availability_watch w
    JOIN medicines m ON m.id = w.medicine_id
    JOIN pharmacies p ON p.id = NEW.pharmacy_id
    WHERE w.active = 1 AND w.medicine_id = NEW.medicine_id
      AND (w.pharmacy_id IS NULL OR w.pharmacy_id = NEW.pharmacy_id);

    UPDATE medicine_availability_watch
    SET active = 0, notified_at = CURRENT_TIMESTAMP
    WHERE active = 1 AND medicine_id = NEW.medicine_id
      AND (pharmacy_id IS NULL OR pharmacy_id = NEW.pharmacy_id)
      AND EXISTS (
        SELECT 1 FROM pharmacies p
        WHERE p.id = NEW.pharmacy_id
          AND COALESCE(p.verification_status, CASE WHEN p.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
      );
  END;

  CREATE TRIGGER IF NOT EXISTS notify_availability_watch_after_pharmacy_verification
  AFTER UPDATE OF verification_status, verified ON pharmacies
  WHEN COALESCE(NEW.verification_status, CASE WHEN NEW.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) = 'VERIFIED'
    AND COALESCE(OLD.verification_status, CASE WHEN OLD.verified = 1 THEN 'VERIFIED' ELSE 'PENDING' END) != 'VERIFIED'
  BEGIN
    INSERT INTO notifications (user_id, title, message, type)
    SELECT w.customer_id, 'Medicine available',
      m.name || ' is now available at ' || NEW.name || '. Open PillPoint search to see current details.',
      'availability'
    FROM medicine_availability_watch w
    JOIN medicines m ON m.id = w.medicine_id
    JOIN inventory i ON i.medicine_id = w.medicine_id AND i.pharmacy_id = NEW.id
    WHERE w.active = 1 AND i.deployed = 1 AND i.stock_quantity > 0
      AND (w.pharmacy_id IS NULL OR w.pharmacy_id = NEW.id);

    UPDATE medicine_availability_watch
    SET active = 0, notified_at = CURRENT_TIMESTAMP
    WHERE active = 1
      AND (pharmacy_id IS NULL OR pharmacy_id = NEW.id)
      AND EXISTS (
        SELECT 1 FROM inventory i
        WHERE i.medicine_id = medicine_availability_watch.medicine_id
          AND i.pharmacy_id = NEW.id AND i.deployed = 1 AND i.stock_quantity > 0
      );
  END;
`);

if (isNew) {
  console.log('New database detected — seeding sample data...');
  require('./seed')(db, bcrypt);
}

module.exports = db;
