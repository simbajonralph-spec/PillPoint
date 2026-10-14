const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db/database');
const seed = require('../db/seed');
const bcrypt = require('bcryptjs');
const express = require('express');
const session = require('express-session');
const authRoutes = require('../routes/auth');

test('demo seed creates seven approved and three pending branches and is idempotent', async () => {
  const prior = process.env.PILLPOINT_DEMO_SEED;
  process.env.PILLPOINT_DEMO_SEED = 'true';
  try {
    const communityRatingsBefore = db.prepare(`SELECT COUNT(*) count
      FROM pharmacy_ratings r JOIN pharmacies p ON p.id=r.pharmacy_id
      JOIN users u ON u.id=r.customer_id
      WHERE p.name LIKE 'Demo %'
        AND u.email NOT IN (
          'demo.customer01@pillpoint.test',
          'demo.customer02@pillpoint.test',
          'demo.customer03@pillpoint.test'
        )`).get().count;
    const first = seed(db, bcrypt);
    const snapshot = db.prepare(`SELECT
      (SELECT COUNT(*) FROM pharmacies WHERE name LIKE 'Demo %') pharmacies,
      (SELECT COUNT(*) FROM pharmacies WHERE name LIKE 'Demo %' AND address LIKE '%Tagum City, Davao del Norte%') tagum,
      (SELECT COUNT(*) FROM users WHERE email LIKE 'demo.pharmacy__@pillpoint.test' AND role='pharmacy_staff') accounts,
      (SELECT COUNT(*) FROM inventory i JOIN pharmacies p ON p.id=i.pharmacy_id WHERE p.name LIKE 'Demo %' AND p.verification_stage='APPROVED') inventory,
      (SELECT COUNT(*) FROM pharmacy_ratings r JOIN pharmacies p ON p.id=r.pharmacy_id
        JOIN users u ON u.id=r.customer_id
        WHERE p.name LIKE 'Demo %'
          AND u.email IN (
            'demo.customer01@pillpoint.test',
            'demo.customer02@pillpoint.test',
            'demo.customer03@pillpoint.test'
          )) ratings,
      (SELECT COUNT(*) FROM pharmacy_ratings r JOIN pharmacies p ON p.id=r.pharmacy_id
        JOIN users u ON u.id=r.customer_id
        WHERE p.name LIKE 'Demo %'
          AND u.email NOT IN (
            'demo.customer01@pillpoint.test',
            'demo.customer02@pillpoint.test',
            'demo.customer03@pillpoint.test'
          )) communityRatings,
      (SELECT COUNT(*) FROM reservations WHERE issue_note='Fictional demo reservation') reservations,
      (SELECT COUNT(*) FROM search_logs WHERE query LIKE 'demo medicine availability %') searches`).get();
    assert.equal(first.demoPharmacies, 10);
    assert.equal(first.verified, 7);
    assert.equal(first.pending, 3);
    assert.equal(snapshot.pharmacies, 10);
    assert.equal(snapshot.tagum, 10);
    assert.equal(snapshot.accounts, 10);
    assert.equal(snapshot.inventory, 84);
    assert.equal(snapshot.ratings, 21);
    assert.equal(snapshot.communityRatings, communityRatingsBefore);
    assert.equal(snapshot.reservations, 7);
    assert.equal(snapshot.searches, 7);
    const beforeCounts = { ...snapshot };
    seed(db, bcrypt);
    const after = db.prepare(`SELECT
      (SELECT COUNT(*) FROM pharmacies WHERE name LIKE 'Demo %') pharmacies,
      (SELECT COUNT(*) FROM pharmacies WHERE name LIKE 'Demo %' AND address LIKE '%Tagum City, Davao del Norte%') tagum,
      (SELECT COUNT(*) FROM users WHERE email LIKE 'demo.pharmacy__@pillpoint.test' AND role='pharmacy_staff') accounts,
      (SELECT COUNT(*) FROM inventory i JOIN pharmacies p ON p.id=i.pharmacy_id WHERE p.name LIKE 'Demo %' AND p.verification_stage='APPROVED') inventory,
      (SELECT COUNT(*) FROM pharmacy_ratings r JOIN pharmacies p ON p.id=r.pharmacy_id
        JOIN users u ON u.id=r.customer_id
        WHERE p.name LIKE 'Demo %'
          AND u.email IN (
            'demo.customer01@pillpoint.test',
            'demo.customer02@pillpoint.test',
            'demo.customer03@pillpoint.test'
          )) ratings,
      (SELECT COUNT(*) FROM pharmacy_ratings r JOIN pharmacies p ON p.id=r.pharmacy_id
        JOIN users u ON u.id=r.customer_id
        WHERE p.name LIKE 'Demo %'
          AND u.email NOT IN (
            'demo.customer01@pillpoint.test',
            'demo.customer02@pillpoint.test',
            'demo.customer03@pillpoint.test'
          )) communityRatings,
      (SELECT COUNT(*) FROM reservations WHERE issue_note='Fictional demo reservation') reservations,
      (SELECT COUNT(*) FROM search_logs WHERE query LIKE 'demo medicine availability %') searches`).get();
    assert.deepEqual(after, beforeCounts);
    for (let index = 1; index <= 7; index++) {
      const account = db.prepare('SELECT password_hash, pharmacy_id FROM users WHERE email=?').get(`demo.pharmacy${String(index).padStart(2,'0')}@pillpoint.test`);
      assert.ok(account?.pharmacy_id);
      assert.equal(bcrypt.compareSync(seed.DEMO_PASSWORD, account.password_hash), true);
      assert.ok(db.prepare('SELECT 1 FROM inventory WHERE pharmacy_id=?').get(account.pharmacy_id));
    }
    const app=express();
    app.use(express.json());
    app.use(session({secret:'demo-seed-test-secret',resave:false,saveUninitialized:false}));
    app.use('/api/auth',authRoutes);
    const server=app.listen(0,'127.0.0.1');
    await new Promise(resolve=>server.once('listening',resolve));
    try {
      for (let index=1;index<=7;index++) {
        const response=await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`,{
          method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({email:`demo.pharmacy${String(index).padStart(2,'0')}@pillpoint.test`,password:seed.DEMO_PASSWORD}),
        });
        const body=await response.json();
        assert.equal(response.status,200,JSON.stringify(body));
        assert.equal(body.user.role,'pharmacy_staff');
        assert.equal(body.user.pharmacy_id,db.prepare('SELECT pharmacy_id FROM users WHERE email=?').get(`demo.pharmacy${String(index).padStart(2,'0')}@pillpoint.test`).pharmacy_id);
      }
    } finally {
      await new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    }
    const pendingVisible = db.prepare(`SELECT COUNT(*) c FROM inventory i JOIN pharmacies p ON p.id=i.pharmacy_id
      WHERE p.name LIKE 'Demo %' AND p.verification_stage='PENDING'`).get().c;
    assert.equal(pendingVisible, 0);
  } finally {
    if (prior === undefined) delete process.env.PILLPOINT_DEMO_SEED;
    else process.env.PILLPOINT_DEMO_SEED = prior;
  }
});

test('demo seed refuses production environment', () => {
  const prior = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    assert.throws(() => seed(db,bcrypt,{cli:true}), /non-production/);
  } finally {
    if (prior === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prior;
  }
});
