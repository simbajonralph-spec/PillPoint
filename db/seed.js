// db/seed.js — populates initial demo data (pharmacies, medicines, inventory, users)
module.exports = function seed(db, bcrypt) {
  const insertPharmacy = db.prepare(`
    INSERT INTO pharmacies (name,address,latitude,longitude,phone,verified,description,hours)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  const pharmacies = [
    ['HealthPlus Pharmacy', '123 Rizal St, Butuan City', 8.9475, 125.5406, '0917-000-1111', 1, 'A full-service community pharmacy offering prescription and over-the-counter medicines, health screenings, and friendly pharmacist consultations.', 'Mon–Sat: 8:00 AM – 9:00 PM, Sun: 9:00 AM – 6:00 PM'],
    ['MediCare Drugstore', '45 Montilla Blvd, Butuan City', 8.9502, 125.5432, '0917-000-2222', 1, 'Trusted neighborhood drugstore known for competitive prices and a wide maintenance-medicine selection.', 'Daily: 7:00 AM – 10:00 PM'],
    ['CityWell Pharmacy', '9 J.C. Aquino Ave, Butuan City', 8.9440, 125.5380, '0917-000-3333', 0, 'A newly registered pharmacy focused on fast, reliable service in the city center.', 'Mon–Fri: 8:00 AM – 8:00 PM'],
    ['GreenLeaf Drugstore', '77 San Francisco St, Butuan City', 8.9518, 125.5350, '0917-000-4444', 1, 'Family-owned drugstore with a focus on wellness products and personalized care.', 'Mon–Sun: 8:00 AM – 9:00 PM'],
  ];
  const pharmacyIds = pharmacies.map(p => insertPharmacy.run(...p).lastInsertRowid);

  const insertMedicine = db.prepare(`INSERT INTO medicines (name,category,description) VALUES (?,?,?)`);
  const medicines = [
    ['Paracetamol 500mg', 'Pain Relief', 'Fever and pain reliever'],
    ['Amoxicillin 500mg', 'Antibiotic', 'Broad-spectrum antibiotic'],
    ['Cetirizine 10mg', 'Allergy', 'Antihistamine for allergy relief'],
    ['Losartan 50mg', 'Maintenance', 'Blood pressure medication'],
    ['Metformin 500mg', 'Maintenance', 'Blood sugar management'],
    ['Ibuprofen 200mg', 'Pain Relief', 'Anti-inflammatory pain reliever'],
    ['Salbutamol Inhaler', 'Respiratory', 'Relief for asthma symptoms'],
    ['Omeprazole 20mg', 'Digestive', 'Acid reflux treatment'],
  ];
  const medicineIds = medicines.map(m => insertMedicine.run(...m).lastInsertRowid);

  const brands = ['Biogesic', 'Rite Med', 'Generico', 'MedRite', 'PharmaCore', 'Wellcare', 'TrustMed', 'CarePlus'];

  // Each pharmacy gets a couple of folders: one already deployed (so the demo
  // has visible customer-facing products) and one still in draft, to show the
  // folder-based deploy workflow.
  const insertFolder = db.prepare(`
    INSERT INTO folders (pharmacy_id, name, status, deployed_at) VALUES (?,?,?,?)
  `);
  const insertInventory = db.prepare(`
    INSERT INTO inventory (pharmacy_id, medicine_id, folder_id, price, stock_quantity, low_stock_threshold, brand, deployed, deployed_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  const insertFolderLog = db.prepare(`
    INSERT INTO folder_deploy_log (pharmacy_id, folder_id, folder_name, product_count, action) VALUES (?,?,?,?,'deployed')
  `);

  pharmacyIds.forEach((pid, pi) => {
    const liveFolderId = insertFolder.run(pid, 'Everyday Essentials', 'deployed', new Date().toISOString()).lastInsertRowid;
    const draftFolderId = insertFolder.run(pid, 'New Arrivals', 'draft', null).lastInsertRowid;
    let liveCount = 0;

    medicineIds.forEach((mid, mi) => {
      // skip a few combos so not every pharmacy has every medicine
      if ((pi + mi) % 5 === 4) return;
      const basePrice = [8, 15, 12, 20, 18, 6, 250, 35][mi];
      const price = +(basePrice * (0.9 + ((pi * 3 + mi) % 4) * 0.08)).toFixed(2);
      const stockOptions = [0, 3, 8, 25, 60, 120];
      const stock = stockOptions[(pi * 2 + mi) % stockOptions.length];
      const brand = brands[(pi * 2 + mi) % brands.length];
      // Most items live in the already-deployed folder so the customer demo
      // isn't empty; a few sit in the draft folder to show the deploy workflow.
      const inDraft = (pi + mi) % 4 === 3;
      const folderId = inDraft ? draftFolderId : liveFolderId;
      const deployed = inDraft ? 0 : 1;
      if (!inDraft) liveCount++;
      insertInventory.run(pid, mid, folderId, price, stock, 10, brand, deployed, deployed ? new Date().toISOString() : null);
    });

    insertFolderLog.run(pid, liveFolderId, 'Everyday Essentials', liveCount);
  });

  const insertUser = db.prepare(`INSERT INTO users (name,email,password_hash,role,pharmacy_id) VALUES (?,?,?,?,?)`);
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  insertUser.run('Juan Dela Cruz', 'customer@pillpoint.test', hash('password'), 'customer', null);
  insertUser.run('Maria Santos', 'staff@pillpoint.test', hash('password'), 'pharmacy_staff', pharmacyIds[0]);
  insertUser.run('PillPoint Admin', 'PillPointAdmin@gmail.com', hash('PillPointAdmin123!'), 'admin', null);

  const insertNotif = db.prepare(`INSERT INTO notifications (user_id,title,message,type) VALUES (?,?,?,?)`);
  insertNotif.run(1, 'Welcome to PillPoint', 'Search for medicines and reserve them at nearby pharmacies.', 'info');

  console.log('Seed complete. Demo logins:');
  console.log('  Customer:        customer@pillpoint.test / password');
  console.log('  Pharmacy Staff:  staff@pillpoint.test / password  (HealthPlus Pharmacy — sample data)');
  console.log('  Admin:           PillPointAdmin@gmail.com / PillPointAdmin123!');
};
