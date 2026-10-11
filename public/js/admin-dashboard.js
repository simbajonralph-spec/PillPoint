(async function () {
  const user = await guardPage(['admin'], 'Admin Dashboard', 'System-wide overview');
  if (!user) return;

  const content = document.getElementById('page-content');
  content.classList.add('admin-dashboard');
  document.getElementById('app-shell')?.classList.add('admin-dashboard-shell');
  content.innerHTML = skeletonLoader('cards', 4);

  try {
    const [data, paiData] = await Promise.all([
      Api.get('/api/admin/dashboard'),
      Api.get('/api/pai/admin-insights').catch(error => ({ unavailable: true, error: error.message || 'P.A.I. admin insights are currently unavailable.' })),
    ]);
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    const recent = data.recentReservations || [];
    const locations = data.pharmacyLocations || [];
    const integrityIssues = Number(data.inventoryIntegrity.batchQuantityMismatches || 0)
      + Number(data.inventoryIntegrity.activeBatchesMissingExpiry || 0)
      + Number(data.inventoryIntegrity.expiredBatchesWithStock || 0);

    content.innerHTML = `
      <section class="admin-welcome">
        <div class="admin-welcome-copy"><span class="admin-sun" aria-hidden="true">${iconSvg('pill', 25)}</span><div><h2>${greeting}, ${escapeHtml(user.name || 'PillPoint Admin')}!</h2><p>Here’s what’s happening across your pharmacy system today.</p></div></div>
        <label class="admin-dashboard-search"><span>${iconSvg('search', 17)}</span><input id="admin-dashboard-search" type="search" placeholder="Search medicine, pharmacy, or report…" aria-label="Search dashboard" /><kbd>Ctrl + K</kbd></label>
      </section>

      <section class="admin-metric-grid" aria-label="System summary">
        ${metricCard('pill', 'Total Medicines', data.totals.medicines, 'In the PillPoint catalog', 'green')}
        ${metricCard('building', 'Active Pharmacies', data.totals.verifiedPharmacies, 'Verified pharmacy partners', 'blue')}
        ${metricCard('triangle', 'Low Stock Medicines', data.stats.lowStockAlerts, 'Listings at or below threshold', 'amber', '/admin/inventory.html')}
        ${metricCard('bell', 'Pending Reservations', data.stats.pendingReservations, 'Awaiting pharmacy action', 'rose')}
      </section>

      <div class="admin-dashboard-main-grid">
        <section class="card admin-reservations-card">
          <div class="admin-section-heading"><span class="admin-heading-icon teal">${iconSvg('clipboard', 21)}</span><div><h2>Recent Reservations</h2><p>Latest customer reservations across all pharmacies</p></div><a class="admin-view-link" href="/admin/audit-logs.html">View activity <span aria-hidden="true">→</span></a></div>
          ${recent.length ? `<div class="admin-table-wrap"><table class="admin-reservation-table"><thead><tr><th>Date &amp; time</th><th>Medicine</th><th>Pharmacy</th><th>Status</th><th></th></tr></thead><tbody>${recent.map(item => `
            <tr data-dashboard-search="${escapeHtml(`${item.medicine_name} ${item.category || ''} ${item.pharmacy_name} ${item.pharmacy_address || ''} ${item.status}`.toLowerCase())}">
              <td class="admin-date-cell">${escapeHtml(formatDate(item.reserved_at))}</td>
              <td><strong>${escapeHtml(item.medicine_name)}</strong><small>${escapeHtml(item.category || 'Medicine')}</small></td>
              <td><strong>${escapeHtml(item.pharmacy_name)}</strong><small>${escapeHtml(item.pharmacy_address || '')}</small></td>
              <td>${statusBadge(item.status)}</td>
              <td><a class="admin-icon-link" href="/admin/audit-logs.html" aria-label="View reservation activity">${iconSvg('eye', 17)}<span>View</span><b aria-hidden="true">›</b></a></td>
            </tr>`).join('')}</tbody></table></div>` : `<div class="admin-empty-state">${iconSvg('clipboard', 30)}<strong>No reservations yet</strong><span>Customer reservations will appear here.</span></div>`}
        </section>

        <section class="card admin-map-card">
          <div class="admin-section-heading"><span class="admin-heading-icon teal">${iconSvg('pin', 21)}</span><div><h2>Pharmacy Network</h2><p>Verified pharmacy locations</p></div><a class="admin-view-link" href="/admin/pharmacies.html">View all <span aria-hidden="true">→</span></a></div>
          <div class="admin-map-frame"><div id="admin-pharmacy-map" aria-label="Map of verified pharmacies"></div>${!locations.length ? '<div class="admin-map-empty">No verified pharmacy locations yet.</div>' : ''}</div>
          <div class="admin-map-footer"><span class="admin-map-dot"></span><span><strong>${data.totals.verifiedPharmacies}</strong> verified pharmacies</span><span class="admin-map-divider"></span><span>${locations.length} mapped</span></div>
        </section>
      </div>

      <section class="admin-bottom-metrics" aria-label="More system indicators">
        <article class="admin-bottom-card health"><span class="admin-bottom-icon">${iconSvg('shield', 22)}</span><div><strong>System Status</strong><span>${integrityIssues ? `${integrityIssues} inventory integrity item${integrityIssues === 1 ? '' : 's'} need review` : 'Inventory checks clear'}</span><b class="admin-online"><i></i> Online</b></div></article>
        <article class="admin-bottom-card inventory"><span class="admin-bottom-icon">${iconSvg('box', 22)}</span><div><strong>Total Inventory</strong><b>${formatNumber(data.systemOverview.inventoryUnits)}</b><span>units across verified pharmacies</span></div></article>
        <article class="admin-bottom-card customers"><span class="admin-bottom-icon">${iconSvg('user', 22)}</span><div><strong>Active Customers</strong><b>${formatNumber(data.systemOverview.activeCustomers)}</b><span>active in the last 30 days</span></div></article>
        <article class="admin-bottom-card shortages"><span class="admin-bottom-icon">${iconSvg('triangle', 22)}</span><div><strong>System-wide Shortages</strong><b>${formatNumber(data.shortageCount)}</b><span>catalog medicines with no verified stock</span><a href="/admin/shortages.html" aria-label="View shortages">${iconSvg('chevron', 17)}</a></div></article>
      </section>

      <section class="admin-action-section">
        <div class="admin-section-heading admin-action-heading"><span class="admin-heading-icon amber">${iconSvg('triangle', 21)}</span><div><h2>Action Required</h2><p>Items that may need administrator attention</p></div></div>
        <div class="admin-action-grid">
          ${actionCard('Pending pharmacy verification', data.actionRequired.pendingPharmacies.length, data.actionRequired.pendingPharmacies.slice(0, 3).map(item => item.name), '/admin/pharmacies.html', 'Review pharmacies')}
          ${actionCard('Low-stock listings', data.stats.lowStockAlerts, data.actionRequired.lowStockItems.slice(0, 3).map(item => `${item.medicine_name} · ${item.pharmacy_name}`), '/admin/inventory.html', 'Review inventory')}
          ${actionCard('Expiring batches', data.stats.expiringSoon, data.actionRequired.expiringMedicineBatches.slice(0, 3).map(item => `${item.medicine_name} · ${item.expiration_date}`), '/admin/inventory.html', 'Review batches')}
          ${actionCard('Inventory integrity', integrityIssues, integrityIssues ? ['Batch quantities or expiry details need review'] : ['No integrity issues found'], '/admin/inventory.html', 'Review inventory')}
        </div>
      </section>

      <details class="admin-insights card" id="pai-insights">
        <summary><span class="admin-heading-icon violet">${iconSvg('activity', 20)}</span><span><strong>P.A.I. Admin Insights</strong><small>Evidence-based system signals and recommendations</small></span><b aria-hidden="true">⌄</b></summary>
        ${paiData.unavailable ? `<div class="alert alert-warning mt-16">${escapeHtml(paiData.error)}</div>` : `
          <div class="admin-insight-badges"><span>Search events: ${Number(paiData.summary?.search_events_30_days || 0)}</span><span>Low-stock listings: ${Number(paiData.summary?.low_stock_alerts || 0)}</span><span>Supply signals: ${Number(paiData.summary?.demand_supply_gaps || 0)}</span><span>Review signals: ${Number(paiData.summary?.anomalies_requiring_review || 0) + Number(paiData.summary?.price_anomalies || 0)}</span></div>
          <div class="admin-insight-grid">${(paiData.system_insights || []).slice(0, 4).map(item => `<article><strong>${escapeHtml(item.insight)}</strong><p>${escapeHtml(item.evidence)}</p><small>${escapeHtml(item.recommendation)}</small></article>`).join('') || '<p class="admin-muted">No system insight met the current review criteria.</p>'}</div>
          <button type="button" id="pai-admin-report-btn" class="btn btn-primary mt-16">Generate P.A.I. System Report</button><div id="pai-admin-report" class="mt-16" aria-live="polite"></div>`}
      </details>
    `;

    const search = document.getElementById('admin-dashboard-search');
    const filterRows = () => {
      const term = search.value.trim().toLowerCase();
      document.querySelectorAll('.admin-reservation-table tbody tr').forEach(row => {
        row.hidden = !!term && !row.dataset.dashboardSearch.includes(term);
      });
    };
    search.addEventListener('input', filterRows);
    document.addEventListener('keydown', event => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        search.focus();
      }
    });
    mountPharmacyMap(locations);
    bindPaiReport();
  } catch (error) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message || 'The admin dashboard could not be loaded.')}</div>`;
  }

  function metricCard(icon, label, value, detail, tone, href = null) {
    const card = `<article class="admin-metric-card ${tone}"><span class="admin-metric-icon">${iconSvg(icon, 23)}</span><div class="admin-metric-label">${label}</div><strong>${formatNumber(value)}</strong><small>${detail}</small><span class="admin-sparkline" aria-hidden="true"></span></article>`;
    return href ? `<a class="admin-metric-link" href="${href}">${card}</a>` : card;
  }

  function actionCard(title, count, items, href, linkText) {
    return `<article class="admin-action-card"><div><strong>${escapeHtml(title)}</strong><span class="admin-action-count ${count ? 'has-items' : ''}">${formatNumber(count)}</span></div>${count ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '<p>Nothing needs attention right now.</p>'}<a href="${href}">${linkText} <span aria-hidden="true">→</span></a></article>`;
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString();
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value || '—') : date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function mountPharmacyMap(locations) {
    const element = document.getElementById('admin-pharmacy-map');
    if (!element || !window.L) return;
    const map = L.map(element, { scrollWheelZoom: false }).setView([8.9475, 125.5406], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
    const bounds = [];
    locations.forEach(pharmacy => {
      const lat = Number(pharmacy.latitude);
      const lng = Number(pharmacy.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
      L.marker([lat, lng]).addTo(map).bindPopup(`<strong>${escapeHtml(pharmacy.name)}</strong><br>${escapeHtml(pharmacy.address || '')}`);
      bounds.push([lat, lng]);
    });
    if (bounds.length > 1) map.fitBounds(bounds, { padding: [18, 18], maxZoom: 13 });
    setTimeout(() => map.invalidateSize(), 100);
  }

  function bindPaiReport() {
    const button = document.getElementById('pai-admin-report-btn');
    if (!button) return;
    button.addEventListener('click', async () => {
      const region = document.getElementById('pai-admin-report');
      button.disabled = true;
      region.innerHTML = '<div class="alert alert-info">Generating a report from current PillPoint records…</div>';
      try {
        const report = await Api.post('/api/pai/admin-report', {});
        region.innerHTML = `<article class="admin-report-card"><strong>${escapeHtml(report.title)}</strong><p>${escapeHtml(report.reporting_period)} · ${escapeHtml(new Date(report.generated_at).toLocaleString())}</p>${Object.entries(report.sections || {}).map(([key, section]) => `<div><b>${escapeHtml(key.replaceAll('_', ' '))}</b><span>${escapeHtml(section.evidence || '')}</span>${section.reason ? `<small>${escapeHtml(section.reason)}</small>` : ''}</div>`).join('')}<small>${escapeHtml(report.disclaimer || '')}</small></article>`;
      } catch (error) {
        region.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message || 'Report generation failed.')}</div>`;
      } finally {
        button.disabled = false;
      }
    });
  }
})();
