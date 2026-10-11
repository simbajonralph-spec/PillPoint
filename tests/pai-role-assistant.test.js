const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const db = require('../db/database');
const paiRoutes = require('../routes/pai');
const { resetProviderReliabilityState } = require('../services/pai/gemini');
const {
  deterministicAdminAnswer,
  deterministicPharmacyAnswer,
  explainInsights,
} = require('../services/pai/role-assistant');

function mockGemini(t, inspectPrompt, response = { message: 'Grounded analytics response.' }, status = 200, finishReason = 'STOP') {
  resetProviderReliabilityState();
  const previousFetch = global.fetch;
  const previousApiKey = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = 'role-test-key';
  global.fetch = async (url, options) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return previousFetch(url, options);
    assert.match(String(url), /generativelanguage\.googleapis\.com/);
    assert.equal(options.headers.get('x-goog-api-key'), 'role-test-key');
    const body = JSON.parse(options.body);
    const request = body.request || body;
    const prompt = (request.contents || []).map(item => (item.parts || []).map(part => part.text).join('')).join('\n');
    const systemInstruction = request.systemInstruction?.parts?.map(part => part.text).join(' ') || '';
    if (inspectPrompt) inspectPrompt(`${systemInstruction}\n${prompt}`, request);
    if (status >= 400) {
      return new Response(JSON.stringify({ error: { code: status, message: 'provider failure' } }), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      candidates: [{ finishReason, content: { role: 'model', parts: [{ text: JSON.stringify(response) }] } }],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  t.after(() => {
    global.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKey;
  });
}

async function withPaiServer(t, sessionFactory, run) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { user: sessionFactory(req) };
    next();
  });
  app.use('/api/pai', paiRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return run(`http://127.0.0.1:${server.address().port}/api/pai`);
}

test('role assistant endpoints reject missing sessions and wrong roles', async t => {
  const cases = [
    [null, '/pharmacy-assistant', 401],
    [{ id: 1, role: 'customer' }, '/pharmacy-assistant', 403],
    [{ id: 1, role: 'admin' }, '/pharmacy-assistant', 403],
    [{ id: 1, role: 'customer' }, '/admin-assistant', 403],
    [{ id: 1, role: 'pharmacy_staff', pharmacy_id: 1 }, '/admin-assistant', 403],
  ];
  for (const [user, path, expected] of cases) {
    await withPaiServer(t, req => req.headers['x-role-case'] === 'guest' ? null : user, async base => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-role-case': user ? 'user' : 'guest' }, body: JSON.stringify({ message: 'Show stock risks' }),
      });
      assert.equal(response.status, expected);
    });
  }
});

test('pharmacy assistant uses only session pharmacy analytics and ignores client pharmacy IDs', async t => {
  const suffix = `${process.pid}-${Date.now()}`;
  const pharmacyIds = [];
  const medicineIds = [];
  for (const label of ['A', 'B']) {
    pharmacyIds.push(Number(db.prepare(`
      INSERT INTO pharmacies (name, address, latitude, longitude, verified, verification_status)
      VALUES (?, 'Test address', 1, 1, 1, 'VERIFIED')
    `).run(`PAI isolation ${label} ${suffix}`).lastInsertRowid));
    medicineIds.push(Number(db.prepare('INSERT INTO medicines (name, category) VALUES (?, ?)')
      .run(`Private Medicine ${label} ${suffix}`, 'Test').lastInsertRowid));
    db.prepare(`
      INSERT INTO inventory (pharmacy_id, medicine_id, price, stock_quantity, low_stock_threshold, deployed)
      VALUES (?, ?, 12, 3, 5, 1)
    `).run(pharmacyIds[label === 'A' ? 0 : 1], medicineIds[label === 'A' ? 0 : 1]);
  }
  t.after(() => {
    db.prepare('DELETE FROM inventory WHERE pharmacy_id IN (?, ?)').run(...pharmacyIds);
    db.prepare('DELETE FROM medicines WHERE id IN (?, ?)').run(...medicineIds);
    db.prepare('DELETE FROM pharmacies WHERE id IN (?, ?)').run(...pharmacyIds);
  });

  mockGemini(t, prompt => {
    assert.match(prompt, new RegExp(`Private Medicine A ${suffix}`));
    assert.doesNotMatch(prompt, new RegExp(`Private Medicine B ${suffix}`));
    assert.doesNotMatch(prompt, /PRIVATE CANCELLATION NOTIFICATION/);
    assert.match(prompt, /inventory_quantities/);
    assert.match(prompt, /stock_movements/);
  });
  await withPaiServer(t, () => ({ id: 22, role: 'pharmacy_staff', pharmacy_id: pharmacyIds[0] }), async base => {
    const response = await fetch(`${base}/pharmacy-assistant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: 'What needs restocking?',
        pharmacy_id: pharmacyIds[1],
        notifications: [{ message: 'PRIVATE CANCELLATION NOTIFICATION' }],
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { result: { type: 'answer', source: 'ai', message: 'Grounded analytics response.' } });
  });
});

test('admin assistant supplies system-wide analytics and requires admin role', async t => {
  mockGemini(t, prompt => {
    assert.match(prompt, /PillPoint system-wide/);
    assert.match(prompt, /demand_supply_gaps/);
    assert.match(prompt, /pharmacy_participation/);
    assert.match(prompt, /audit_summary/);
  });
  await withPaiServer(t, () => ({ id: 1, role: 'admin' }), async base => {
    const response = await fetch(`${base}/admin-assistant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'What are current availability gaps?' }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result.type, 'answer');
    assert.equal(data.result.message, 'Grounded analytics response.');
  });
});

test('pharmacy and admin assistants accept empty insight datasets', async t => {
  mockGemini(t, prompt => {
    if (prompt.includes('this authenticated pharmacy only')) {
      assert.match(prompt, /"stock_risk":\{"items":\[\]/);
    } else {
      assert.match(prompt, /"demand_supply_gaps":\[\]/);
      assert.match(prompt, /"anomalies":\[\]/);
    }
  });
  const pharmacyResult = await explainInsights({
    role: 'pharmacy_staff',
    message: 'Summarize current analytics.',
    insights: {
      insights: [],
      summary: { critical: 0, high: 0, moderate: 0 },
      stock_risk: { items: [], summary: { critical: 0, high: 0, moderate: 0 } },
      demand_analysis: { items: [], restock_recommendations: [], summary: {} },
      top_searched: [],
      expiry_risk: { items: [], summary: {} },
      price_analysis: { items: [], summary: {} },
      performance_summary: {},
      inventory_quantities: { items: [], totals: {} },
      stock_movements: { items: [] },
      data_quality: { issues: [], summary: { issue_count: 0 } },
    },
  });
  const adminResult = await explainInsights({
    role: 'admin',
    message: 'Summarize current analytics.',
    insights: {
      generated_at: new Date(0).toISOString(),
      reporting_period: 'Last 30 days',
      summary: {},
      pharmacy_participation: { summary: {}, pharmacies: [] },
      audit_summary: { event_count: 0, actions: [], statuses: [] },
      top_searched: [],
      demand_supply_gaps: [],
      pharmacy_availability: [],
      system_insights: [],
      anomalies: [],
      price_anomalies: [],
    },
  });
  assert.equal(pharmacyResult.message, 'Grounded analytics response.');
  assert.equal(adminResult.message, 'Grounded analytics response.');
});

test('deterministic pharmacy fallbacks accurately summarize empty inventory and stock risks', () => {
  const empty = {
    inventory_quantities: { inventory_count: 0, totals: {} },
    stock_risk: { items: [] },
    expiry_risk: { items: [] },
    performance_summary: {},
  };
  assert.match(deterministicPharmacyAnswer('Summarize inventory', empty), /no inventory records/i);
  assert.match(deterministicPharmacyAnswer('Any products expiring?', empty), /no inventory records/i);

  const risks = {
    inventory_quantities: { inventory_count: 2, totals: { physical_stock: 7, reserved_quantity: 2, available_quantity: 5 } },
    stock_risk: { items: [{ medicine_name: 'Test medicine', current_stock: 2, threshold: 3, severity: 'HIGH' }] },
    expiry_risk: { items: [] },
    performance_summary: { summary: '2 products need monitoring.' },
  };
  assert.match(deterministicPharmacyAnswer('What needs restocking?', risks), /Test medicine: 2 units/);
  assert.match(deterministicPharmacyAnswer('Summarize inventory', risks), /5 available units/);
  const expiry = {
    inventory_quantities: { inventory_count: 1, totals: {} },
    expiry_risk: { items: [{ medicine_name: 'Expiry medicine', current_quantity: 4, expiration_date: '2027-01-01', days_until_expiry: 12 }] },
  };
  assert.match(deterministicPharmacyAnswer('Which medicines are expiring?', expiry), /Expiry medicine: 4 units expire 2027-01-01/);
});

test('deterministic admin fallbacks report current statuses and accurate empty states', () => {
  const empty = {
    reporting_period: 'Last 30 days',
    summary: {},
    pharmacy_participation: { pharmacies: [] },
    demand_supply_gaps: [],
    top_searched: [],
  };
  assert.match(deterministicAdminAnswer('Any pending pharmacy reviews?', empty), /no pharmacy participation, inventory, audit, or medicine demand records/i);
  assert.match(deterministicAdminAnswer('Summarize system activity', empty), /no pharmacy participation, inventory, audit, or medicine demand records/i);

  const populated = {
    summary: { low_stock_alerts: 2, demand_supply_gaps: 1, anomalies_requiring_review: 1 },
    pharmacy_participation: { pharmacies: [
      { verification_status: 'VERIFIED', stale_inventory: false },
      { verification_status: 'PENDING', stale_inventory: false },
      { verification_status: 'SUSPENDED', stale_inventory: true },
    ] },
    demand_supply_gaps: [{ medicine_name: 'Medicine A', evidence: 'One recorded availability gap.' }],
    low_stock_items: [{ medicine_name: 'Medicine B' }],
    anomalies: [{ type: 'search_activity_spike' }],
    audit_summary: { event_count: 4, reporting_period: 'Last 30 days' },
  };
  assert.match(deterministicAdminAnswer('How many are pending review?', populated), /1 pending review/);
  assert.match(deterministicAdminAnswer('How many pharmacies are suspended?', populated), /1 pharmacies currently have SUSPENDED/i);
  assert.match(deterministicAdminAnswer('Summarize system activity', populated), /1 verified, 1 pending, 1 suspended/);
});

test('role assistants use a marked deterministic fallback when the Gemini key is missing', async t => {
  const previousKey = process.env.GEMINI_API_KEY;
  const previousInfo = console.info;
  delete process.env.GEMINI_API_KEY;
  console.info = () => {};
  t.after(() => {
    console.info = previousInfo;
    if (previousKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousKey;
  });
  const pharmacy = await explainInsights({
    role: 'pharmacy_staff',
    message: 'Summarize inventory',
    insights: { inventory_quantities: { inventory_count: 0, totals: {} }, stock_risk: { items: [] }, expiry_risk: { items: [] }, performance_summary: {} },
  });
  const admin = await explainInsights({
    role: 'admin',
    message: 'Summarize pharmacy reviews',
    insights: { pharmacy_participation: { pharmacies: [] }, summary: {}, demand_supply_gaps: [], top_searched: [] },
  });
  assert.equal(pharmacy.source, 'deterministic');
  assert.match(pharmacy.message, /no inventory records/i);
  assert.equal(admin.source, 'deterministic');
  assert.match(admin.message, /no pharmacy participation, inventory, audit, or medicine demand records/i);
  assert.match(admin.notice, /AI-generated explanations are temporarily unavailable/i);
});

test('Pharmacy falls back to current analytics when Gemini reports MAX_TOKENS', async t => {
  const diagnostics = [];
  const previousInfo = console.info;
  console.info = message => diagnostics.push(String(message));
  t.after(() => { console.info = previousInfo; });
  mockGemini(t, (prompt, request) => {
    assert.match(prompt, /no more than four short sentences and 900 characters/i);
    assert.equal(request.generationConfig.maxOutputTokens, 600);
  }, { message: 'A syntactically valid but truncated answer.' }, 200, 'MAX_TOKENS');

  const result = await explainInsights({
    role: 'pharmacy_staff',
    message: 'Summarize inventory',
    insights: { inventory_quantities: { inventory_count: 1, totals: { physical_stock: 4, reserved_quantity: 1, available_quantity: 3 } } },
  });
  assert.equal(result.source, 'deterministic');
  assert.match(result.message, /1 listed products; 4 physical units, 1 reserved units, and 3 available units/i);
  assert.match(result.notice, /AI-generated explanations are temporarily unavailable/i);
  assert.ok(diagnostics.some(line => line.includes('"outcome":"invalid_model_output"')
    && line.includes('"providerCode":"INVALID_RESPONSE_MAX_TOKENS"')));
  assert.ok(diagnostics.some(line => line.includes('"outcome":"deterministic_fallback"')
    && line.includes('"fallbackUsed":true')));
});

test('role assistant validates messages and falls back safely on provider failure', async t => {
  await withPaiServer(t, () => ({ id: 1, role: 'admin' }), async base => {
    for (const body of [{}, { message: 12 }, { message: ` ${'x'.repeat(501)} ` }]) {
      const response = await fetch(`${base}/admin-assistant`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      assert.equal(response.status, 422);
    }
  });

  mockGemini(t, null, null, 429);
  await withPaiServer(t, () => ({ id: 1, role: 'admin' }), async base => {
    const response = await fetch(`${base}/admin-assistant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Summarize participation' }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result.source, 'deterministic');
    assert.match(data.result.notice, /AI-generated explanations are temporarily unavailable/i);
    assert.ok(data.result.message.length > 0);
  });
});

test('Pharmacy and Admin assistants return deterministic analytics during Gemini outages', async t => {
  for (const [user, path, message] of [
    [{ id: 15, role: 'pharmacy_staff', pharmacy_id: 1 }, '/pharmacy-assistant', 'Explain low stock'],
    [{ id: 1, role: 'admin' }, '/admin-assistant', 'Summarize system availability'],
  ]) {
    mockGemini(t, null, null, 503);
    await withPaiServer(t, () => user, async base => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.result.source, 'deterministic');
      assert.match(data.result.notice, /AI-generated explanations are temporarily unavailable/i);
      assert.ok(data.result.message.length > 0);
    });
  }
});

test('pharmacy assistant returns current deterministic insights when the Gemini key is missing', async t => {
  const previousApiKey = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
  t.after(() => {
    if (previousApiKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = previousApiKey;
  });
  await withPaiServer(t, () => ({ id: 1, role: 'pharmacy_staff', pharmacy_id: 1 }), async base => {
    const response = await fetch(`${base}/pharmacy-assistant`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Explain stock risks' }),
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.result.source, 'deterministic');
    assert.match(data.result.notice, /AI-generated explanations are temporarily unavailable/i);
  });
});
