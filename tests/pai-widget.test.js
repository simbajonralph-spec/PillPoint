const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

function readPublic(relativePath) {
  return fs.readFileSync(path.join(publicDir, relativePath), 'utf8');
}

test('authenticated Customer, Pharmacy, and Admin pages all load the shared authenticated layout', () => {
  const pages = [
    'dashboard.html', 'search.html', 'reservations.html', 'notifications.html', 'profile.html',
    'pharmacy/dashboard.html', 'pharmacy/inventory.html', 'pharmacy/analytics.html',
    'pharmacy/reservations.html', 'pharmacy/alerts.html', 'pharmacy/suppliers.html', 'pharmacy/sales.html',
    'admin/dashboard.html', 'admin/pharmacies.html', 'admin/inventory.html', 'admin/shortages.html', 'admin/audit-logs.html',
  ];
  pages.forEach(page => assert.match(readPublic(page), /<script src="\/js\/layout\.js(?:\?[^\"]*)?"><\/script>/, page));

  const layout = readPublic('js/layout.js');
  assert.match(layout, /mountPaiAssistant\(user, path\);/);
  assert.match(layout, /\['customer', 'pharmacy_staff', 'admin'\]\.includes\(user\.role\)/);
  assert.doesNotMatch(layout, /pagesWithExistingPai/);
  assert.match(layout, /pai-assistant-script/);
  assert.match(layout, /script\.onload = \(\) => window\.PaiAssistant\?\.init\(\{ role: user\.role \}\)/);
});

test('floating assistant uses the exact JPEG path and connects all three role chats once', () => {
  const assistant = readPublic('js/pai-assistant.js');
  assert.match(assistant, /const ICON_URL = '\/img\/pai-icon\.jpg';/);
  assert.match(assistant, /customer: 'Customer assistant'/);
  assert.match(assistant, /pharmacy_staff: '\/api\/pai\/pharmacy-assistant'/);
  assert.match(assistant, /admin: '\/api\/pai\/admin-assistant'/);
  assert.match(assistant, /Api\.post\('\/api\/pai\/assistant'/);
  assert.match(assistant, /if \(document\.getElementById\('pai-assistant-root'\)\) return;/);
  assert.match(assistant, /aria-expanded="false"/);
  assert.match(assistant, /event\.key === 'Escape'/);
  assert.match(assistant, /appModal\(/, 'customer reservations require explicit review and confirmation');
  assert.match(assistant, /appendResponseProvenance/);
  assert.match(assistant, /AI-generated explanation based on current PillPoint data/);

  const css = readPublic('css/pai-assistant.css');
  assert.match(css, /\.pai-chat-notice/);
  assert.match(css, /\.pai-assistant-root\s*\{[\s\S]*position:\s*fixed/);
  assert.match(css, /@media \(max-width: 640px\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /z-index:\s*60/);
});

test('customer dashboard no longer renders the obsolete embedded P.A.I. card', () => {
  const dashboard = readPublic('js/dashboard.js');
  assert.doesNotMatch(dashboard, /pai-message|pai-submit|pai-result|bindPaiAssistant/);
  assert.match(dashboard, /Recent Reservations/);
  assert.match(dashboard, /Top Rated Pharmacies/);
  assert.match(dashboard, /dashboard-map/);
});

test('the supplied P.A.I. asset is a JPEG at the requested lowercase URL path', () => {
  const icon = fs.readFileSync(path.join(publicDir, 'img', 'pai-icon.jpg'));
  assert.ok(icon.length > 4);
  assert.equal(icon[0], 0xff);
  assert.equal(icon[1], 0xd8);
  assert.equal(icon[icon.length - 2], 0xff);
  assert.equal(icon[icon.length - 1], 0xd9);
});
