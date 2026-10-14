// Safe, repeatable local demo dataset. Seed-owned records use stable demo emails/names.
const DEMO_PASSWORD = 'PillPointDemo!2026';
const medicines = [
  ['Paracetamol 500mg', 'Pain Relief', 'For temporary relief of mild pain and fever.'],
  ['Cetirizine 10mg', 'Allergy', 'Antihistamine tablets for allergy symptoms.'],
  ['Ibuprofen 200mg', 'Pain Relief', 'Non-prescription pain and inflammation relief.'],
  ['Omeprazole 20mg', 'Digestive', 'Acid reduction capsules.'],
  ['Vitamin C 500mg', 'Vitamins', 'Vitamin C supplement tablets.'],
  ['Oral Rehydration Salts', 'First Aid', 'Oral rehydration sachets.'],
  ['Loratadine 10mg', 'Allergy', 'Non-drowsy antihistamine tablets.'],
  ['Antacid Chewable 500mg', 'Digestive', 'Chewable antacid tablets.'],
  ['Multivitamin Adult', 'Vitamins', 'Daily multivitamin tablets.'],
  ['Digital Thermometer', 'Healthcare Devices', 'Reusable digital body thermometer.'],
  ['Losartan 50mg', 'Maintenance', 'Prescription medicine for blood pressure management.'],
  ['Metformin 500mg', 'Maintenance', 'Prescription medicine for blood glucose management.'],
];
const branches = [
  ['Demo Harborview Pharmacy', 'Tagum City', 'Mikaela', 'Reyes'],
  ['Demo Sampaguita Drugstore', 'Tagum City', 'Andres', 'Villanueva'],
  ['Demo Sunrise Community Pharmacy', 'Tagum City', 'Lira', 'Navarro'],
  ['Demo Maharlika Health Pharmacy', 'Tagum City', 'Rafael', 'Santos'],
  ['Demo Balangay Pharmacy', 'Tagum City', 'Amihan', 'Garcia'],
  ['Demo Amihan Wellness Drugstore', 'Tagum City', 'Tomas', 'Mendoza'],
  ['Demo Bayani Care Pharmacy', 'Tagum City', 'Elena', 'Flores'],
  ['Demo Lakbay Pharmacy', 'Tagum City', 'Noel', 'Cruz'],
  ['Demo Narra Family Drugstore', 'Tagum City', 'Sofia', 'Ramos'],
  ['Demo Isla Verde Pharmacy', 'Tagum City', 'Marco', 'Dizon'],
];
const locations = [
  ['Tagum City, Davao del Norte', 7.4478, 125.8078], ['Tagum City, Davao del Norte', 7.4502, 125.8105],
  ['Tagum City, Davao del Norte', 7.4441, 125.8037], ['Tagum City, Davao del Norte', 7.4545, 125.8042],
  ['Tagum City, Davao del Norte', 7.4412, 125.8140], ['Tagum City, Davao del Norte', 7.4561, 125.8173],
  ['Tagum City, Davao del Norte', 7.4389, 125.7989], ['Tagum City, Davao del Norte', 7.4604, 125.8008],
  ['Tagum City, Davao del Norte', 7.4490, 125.7951], ['Tagum City, Davao del Norte', 7.4362, 125.8092],
];
const ratings = [[5,5,4],[5,4,4],[5,5,5],[4,4,5],[5,4,5],[4,5,4],[5,5,4]];

function seed(db, bcrypt, options = {}) {
  if (process.env.NODE_ENV === 'production' || process.env.PILLPOINT_DEMO_SEED !== 'true') {
    if (options.cli) throw new Error('Demo seeding requires PILLPOINT_DEMO_SEED=true and a non-production NODE_ENV.');
    return { skipped: true };
  }
  const now = new Date().toISOString();
  const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
  let created = { pharmacies: 0, users: 0, medicines: 0, inventory: 0, ratings: 0 };
  const run = db.transaction(() => {
    // The demo account is a stable customer used for reviews; other customers are likewise namespaced.
    function user(name, email, role, pharmacyId = null, phone = null) {
      let row = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
      if (!row) {
        const info = db.prepare(`INSERT INTO users(name,username,email,phone,password_hash,role,pharmacy_id,created_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(name, name, email, phone, hash, role, pharmacyId, now);
        created.users++;
        return Number(info.lastInsertRowid);
      }
      if (email.startsWith('demo.') || email === 'customer@pillpoint.test')
        db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash,row.id);
      if (role === 'pharmacy_staff') db.prepare('UPDATE users SET pharmacy_id = ? WHERE id = ? AND role = ?').run(pharmacyId, row.id, role);
      return row.id;
    }
    const customers = [
      ['Demo Customer One','demo.customer01@pillpoint.test'],
      ['Demo Customer Two','demo.customer02@pillpoint.test'],
      ['Demo Customer Three','demo.customer03@pillpoint.test'],
    ].map(([name,email]) => user(name,email,'customer'));
    user('Demo Customer','customer@pillpoint.test','customer',null,'+639170000001');
    const demoCustomer = db.prepare("SELECT id FROM users WHERE email='customer@pillpoint.test'").get().id;
    user('PillPoint Demo Administrator','demo.admin@pillpoint.test','admin');
    const admin = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();

    const medicineIds = medicines.map(([name,category,description]) => {
      let row = db.prepare('SELECT id FROM medicines WHERE name = ? AND category = ?').get(name,category);
      if (!row) {
        const info = db.prepare('INSERT INTO medicines(name,category,description) VALUES(?,?,?)').run(name,category,description);
        row = { id: Number(info.lastInsertRowid) }; created.medicines++;
      }
      return row.id;
    });

    branches.forEach(([name,city,first,last], index) => {
      const email = `demo.pharmacy${String(index+1).padStart(2,'0')}@pillpoint.test`;
      let userRow = db.prepare('SELECT id,pharmacy_id FROM users WHERE email = ?').get(email);
      let pharmacy = db.prepare('SELECT id FROM pharmacies WHERE name = ?').get(name);
      if (!pharmacy) {
        const [address, latitude, longitude] = locations[index];
        const pending = index >= 7;
        const info = db.prepare(`INSERT INTO pharmacies
          (name,address,latitude,longitude,phone,business_email,owner_first_name,owner_last_name,business_permit,
           verified,verification_status,verification_stage,verification_date,approved_by_admin_id,status_updated_at,
           pharmacy_logo,description,hours,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
          name, `${100 + index} Demo Avenue, ${address}`, latitude, longitude, `+63917${String(1000000+index).slice(-7)}`,
          email, first, last, `DEMO-DOC-PERMIT-${String(index+1).padStart(2,'0')}.pdf`, pending ? 0 : 1,
          pending ? 'PENDING' : 'VERIFIED', pending ? 'PENDING' : 'APPROVED', pending ? null : now,
          pending || !admin ? null : admin.id, now, '/img/logo-mark.svg',
          `Fictional demonstration community pharmacy serving ${city}.`, 'Daily: 8:00 AM – 9:00 PM', now,
        );
        pharmacy = { id: Number(info.lastInsertRowid) }; created.pharmacies++;
      } else {
        // Keep demo-owned branches and their locations/statuses stable on reseed.
        const pending = index >= 7;
        const [address,latitude,longitude]=locations[index];
        db.prepare(`UPDATE pharmacies SET address=?, latitude=?, longitude=?, business_email=?, owner_first_name=?, owner_last_name=?,
          business_permit=COALESCE(business_permit,?), verified=?, verification_status=?, verification_stage=?
          WHERE id=?`).run(`${100 + index} Demo Avenue, ${address}`,latitude,longitude,email,first,last,
          `DEMO-DOC-PERMIT-${String(index+1).padStart(2,'0')}.pdf`,pending?0:1,
          pending?'PENDING':'VERIFIED',pending?'PENDING':'APPROVED',pharmacy.id);
      }
      if (!userRow) {
        user(first+' '+last,email,'pharmacy_staff',pharmacy.id,`+63917${String(1000000+index).slice(-7)}`);
        userRow = db.prepare('SELECT id,pharmacy_id FROM users WHERE email=?').get(email);
      } else if (userRow.pharmacy_id !== pharmacy.id) {
        db.prepare("UPDATE users SET pharmacy_id=? WHERE id=? AND role='pharmacy_staff'").run(pharmacy.id,userRow.id);
      }

      // No public inventory is created for pending branches.
      if (index >= 7) return;
      const folder = db.prepare('SELECT id FROM folders WHERE pharmacy_id=? AND name=?').get(pharmacy.id,'Demo Everyday Essentials')
        || (() => { const x=db.prepare("INSERT INTO folders(pharmacy_id,name,status,deployed_at) VALUES(?,?,'deployed',?)").run(pharmacy.id,'Demo Everyday Essentials',now); return {id:Number(x.lastInsertRowid)}; })();
      medicines.forEach(([medicineName], mi) => {
        let item = db.prepare('SELECT id FROM inventory WHERE pharmacy_id=? AND medicine_id=?').get(pharmacy.id,medicineIds[mi]);
        const stock = [35, 4, 0, 22, 48, 18, 7, 26, 30, 12, 16, 14][(mi+index)%12];
        const price = Number(([12,18,22,38,25,15,20,28,95,120,85,32][mi] * (0.92 + index*0.015)).toFixed(2));
        if (!item) {
          const info=db.prepare(`INSERT INTO inventory(pharmacy_id,medicine_id,folder_id,price,stock_quantity,low_stock_threshold,brand,deployed,deployed_at)
            VALUES(?,?,?,?,?,?,?,?,?)`).run(pharmacy.id,medicineIds[mi],folder.id,price,stock,10,'DemoCare',1,now);
          item={id:Number(info.lastInsertRowid)}; created.inventory++;
        }
        const batchNumber=`DEMO-${String(index+1).padStart(2,'0')}-${String(mi+1).padStart(2,'0')}`;
        const batch=db.prepare('SELECT id FROM medicine_batches WHERE pharmacy_id=? AND batch_number=?').get(pharmacy.id,batchNumber);
        if (!batch) db.prepare(`INSERT INTO medicine_batches(pharmacy_id,medicine_id,inventory_id,batch_number,manufacturer,
          expiration_date,quantity_received,current_quantity,purchase_price,selling_price,date_received,status,storage_location,notes)
          VALUES(?,?,?,?,?,date('now','+365 days'),?,?,?,?,?,'active',?,?)`).run(pharmacy.id,medicineIds[mi],item.id,batchNumber,
          'DemoCare Laboratories',stock,stock,Math.max(1,price*.65),price,now,`Shelf ${String.fromCharCode(65+mi%6)}-${mi+1}`,'Fictional demo lot');
        db.prepare('UPDATE inventory SET stock_quantity=(SELECT COALESCE(SUM(current_quantity),0) FROM medicine_batches WHERE inventory_id=?),deployed=1,folder_id=? WHERE id=?')
          .run(item.id,folder.id,item.id);
        db.prepare(`INSERT OR IGNORE INTO inventory_audit_logs(pharmacy_id,user_id,entity_type,entity_id,action,details,created_at)
          VALUES(?,?,'inventory',?,'demo_seed','Initial fictional demonstration inventory',?)`).run(pharmacy.id,userRow.id,item.id,now);
      });
      db.prepare("INSERT OR IGNORE INTO folder_deploy_log(pharmacy_id,folder_id,folder_name,product_count,action,created_at) VALUES(?,?,?,12,'deployed',?)")
        .run(pharmacy.id,folder.id,'Demo Everyday Essentials',now);
      ratings[index].forEach((rating, ri) => {
        const exists=db.prepare('SELECT id FROM pharmacy_ratings WHERE pharmacy_id=? AND customer_id=?').get(pharmacy.id,customers[ri]);
        if (!exists) {
          db.prepare('INSERT INTO pharmacy_ratings(pharmacy_id,customer_id,rating,comment,created_at,updated_at) VALUES(?,?,?,?,?,?)')
            .run(pharmacy.id,customers[ri],rating,['Helpful staff and a clean, convenient branch.','Good selection and clear pricing.','Friendly service during my visit.'][ri],new Date(Date.now()-(ri+1)*86400000).toISOString(),now);
          created.ratings++;
        }
      });
      // One small open reservation and a real search activity row make the existing
      // customer and pharmacy dashboards useful without inventing completed sales.
      const activityItem=db.prepare(`SELECT i.id,i.price FROM inventory i
        WHERE i.pharmacy_id=? AND i.medicine_id=? AND i.stock_quantity>1 ORDER BY i.id LIMIT 1`).get(pharmacy.id,medicineIds[3]);
      if (activityItem && !db.prepare("SELECT 1 FROM reservations WHERE customer_id=? AND inventory_id=? AND issue_note='Fictional demo reservation'").get(demoCustomer,activityItem.id)) {
        db.prepare(`INSERT INTO reservations(customer_id,inventory_id,quantity,price_at_reservation,status,reserved_at,expires_at,issue_note)
          VALUES(?,?,1,?,'pending',?,?,?)`).run(demoCustomer,activityItem.id,activityItem.price,now,
          new Date(Date.now()+24*60*60*1000).toISOString(),'Fictional demo reservation');
      }
      const searchQuery=`demo medicine availability ${index+1}`;
      if (!db.prepare('SELECT 1 FROM search_logs WHERE user_id=? AND query=?').get(demoCustomer,searchQuery)) {
        db.prepare(`INSERT INTO search_logs(user_id,query,category,medicine_ids,pharmacy_ids,result_count,searched_at)
          VALUES(?,?,'Digestive',?,?,1,?)`).run(demoCustomer,searchQuery,JSON.stringify([medicineIds[3]]),JSON.stringify([pharmacy.id]),now);
      }
    });
    // Seed a customer welcome notice only when absent.
    const customer = db.prepare("SELECT id FROM users WHERE email='customer@pillpoint.test'").get();
    if (customer && !db.prepare("SELECT 1 FROM notifications WHERE user_id=? AND title='Welcome to PillPoint'").get(customer.id))
      db.prepare('INSERT INTO notifications(user_id,title,message,type) VALUES(?,?,?,?)').run(customer.id,'Welcome to PillPoint','Search for medicines and reserve them at nearby pharmacies.','info');
  });
  run();
  const totals = {
    demoPharmacies: db.prepare("SELECT COUNT(*) c FROM pharmacies WHERE name LIKE 'Demo %'").get().c,
    verified: db.prepare("SELECT COUNT(*) c FROM pharmacies WHERE name LIKE 'Demo %' AND verification_stage='APPROVED'").get().c,
    pending: db.prepare("SELECT COUNT(*) c FROM pharmacies WHERE name LIKE 'Demo %' AND verification_stage='PENDING'").get().c,
    ...created,
  };
  if (totals.demoPharmacies !== 10 || totals.verified !== 7 || totals.pending !== 3) throw new Error(`Demo pharmacy validation failed: ${JSON.stringify(totals)}`);
  console.log(`Demo seed complete: ${JSON.stringify(totals)}`);
  return totals;
}

module.exports = seed;
module.exports.DEMO_PASSWORD = DEMO_PASSWORD;

if (require.main === module) {
  require('dotenv').config();
  const db = require('./database');
  const bcrypt = require('bcryptjs');
  try { seed(db,bcrypt,{cli:true}); } finally { db.close(); }
}
