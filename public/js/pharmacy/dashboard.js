(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Pharmacy Dashboard', 'Overview of your pharmacy');
  if (!user) return;
  const content = document.getElementById('page-content');
  content.innerHTML = skeletonLoader('cards', 4);
  try {
    const [data, paiData] = await Promise.all([
      Api.get('/api/pharmacy/dashboard'),
      Api.get('/api/pai/inventory-insights').catch(error => ({
        unavailable: true,
        error: error.message || 'P.A.I. pharmacy insights are currently unavailable.',
      }))
    ]);
    const stockItems = [
      { label: 'Available', value: 0, color: '#10B981' },
      { label: 'Low Stock', value: 0, color: '#F59E0B' },
      { label: 'Out of Stock', value: 0, color: '#EF4444' },
    ];
    data.stockByStatus.forEach(item => {
      const match = stockItems.find(stock => stock.label === item.status);
      if (match) match.value = item.count;
    });
    const publicationItems = [
      { label: 'Published', value: 0, color: '#10B981' },
      { label: 'Unpublished', value: 0, color: '#64748B' },
    ];
    data.publishedVsUnpublished.forEach(item => {
      publicationItems[item.deployed ? 0 : 1].value = item.count;
    });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const trendCounts = new Map(data.reservationTrend.map(item => [item.day, item.count]));
    const trendDays = Array.from({ length: 30 }, (_, index) => {
      const day = new Date(today);
      day.setDate(today.getDate() - (29 - index));
      const key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
      return { key, count: trendCounts.get(key) || 0, date: day };
    });
    const maxTrend = Math.max(1, ...trendDays.map(day => day.count));
    const categoryMaxValue = Math.max(1, ...data.inventoryByCategory.map(category => category.value));
    const reservationTotal = trendDays.reduce((sum, day) => sum + day.count, 0);
    const metricCards = [
      ['Total Medicines', data.stats.totalItems, 'pill'],
      ['Available Medicines', data.stats.availableItems, 'check'],
      ['Low Stock', data.stats.lowStock, 'warning'],
      ['Out of Stock', data.stats.outOfStock, 'empty'],
      ['Pending Reservations', data.stats.pendingReservations, 'pending'],
      ["Today's Reservations", data.stats.todaysReservations, 'today'],
      ['Completed Pickups', data.stats.completedPickups, 'pickup'],
      ['Inventory Value', money(data.stats.estimatedInventoryValue), 'value'],
    ];

    function attentionPanel(title, count, entries, link, tone, getDetail) {
      return `
        <section class="attention-panel attention-${tone}">
          <div class="attention-heading"><span>${escapeHtml(title)}</span><strong>${count}</strong></div>
          ${entries.length
            ? `<ul>${entries.map(entry => `<li><span>${escapeHtml(entry.medicine_name)}</span><small>${getDetail(entry)}</small></li>`).join('')}</ul>`
            : `<p class="attention-clear">No items need attention</p>`}
          <a class="btn btn-outline btn-sm" href="${link}">View / Manage</a>
        </section>`;
    }

    function paiBadge(severity) {
      const tone = severity === 'CRITICAL' || severity === 'HIGH' || severity === 'REVIEW' || severity === 'UNUSUALLY_HIGH'
        ? 'badge-out'
        : severity === 'MODERATE' || severity === 'POSSIBLY_OUTDATED' || severity === 'INCREASING' || severity === 'INCREASING_INTEREST'
          ? 'badge-low'
          : severity === 'NO_RECENT_DEMAND' || severity === 'STABLE' || severity === 'DECREASING_INTEREST'
            ? 'badge-expired'
            : 'badge-available';
      return `<span class="badge ${tone}">${escapeHtml(severity || 'REVIEW')}</span>`;
    }

    function paiPanel(title, description, entries, emptyMessage, renderEntry) {
      return `
        <section class="card dashboard-table-card">
          <div class="dashboard-section-heading"><div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div><strong>${entries.length}</strong></div>
          ${entries.length
            ? `<div class="grid" style="gap:12px;">${entries.map(renderEntry).join('')}</div>`
            : `<div class="empty-state"><p>${escapeHtml(emptyMessage)}</p></div>`}
        </section>`;
    }

    const paiStockRisk = paiData.stock_risk?.items || paiData.insights || [];
    const paiDemand = paiData.demand_analysis?.items || [];
    const paiExpiry = paiData.expiry_risk?.items || [];
    const paiPrices = paiData.price_analysis?.items || [];
    const paiQuality = paiData.data_quality?.issues || [];
    const paiPerformance = paiData.performance_summary || {};

    content.innerHTML = `
      <section class="pharmacy-dashboard-header">
        <div>
          <div class="dashboard-eyebrow">PHARMACY DASHBOARD</div>
          <h2>${escapeHtml(data.pharmacy.name)}</h2>
          <p>${escapeHtml(data.pharmacy.address)}</p>
        </div>
        <span class="badge ${data.pharmacy.verification_status === 'VERIFIED' ? 'badge-verified' : 'badge-unverified'}">${data.pharmacy.verification_status === 'VERIFIED' ? 'Verified pharmacy' : data.pharmacy.verification_status === 'SUSPENDED' ? 'Suspended' : data.pharmacy.verification_status === 'REJECTED' ? 'Rejected' : 'Verification pending'}</span>
      </section>

      <section class="card dashboard-deployed-widget mt-16" aria-label="Deployed folder">
        <div class="dashboard-deployed-content">
          <span class="dashboard-deployed-icon">${iconSvg('folder', 22)}</span>
          <div>
            <div class="dashboard-deployed-label">DEPLOYED FOLDER</div>
            <strong class="dashboard-deployed-name">${data.activeDeployedFolder ? escapeHtml(data.activeDeployedFolder.name) : 'NO DEPLOYED PRODUCT'}</strong>
            <div class="dashboard-deployed-caption">${data.activeDeployedFolder ? 'Products in this folder are visible to customers.' : 'Deploy a folder to make its products visible to customers.'}</div>
          </div>
        </div>
        <a class="btn btn-outline btn-sm" href="/pharmacy/inventory.html">Manage Inventory</a>
      </section>

      <section class="dashboard-kpis mt-24" aria-label="Pharmacy key metrics">
        ${metricCards.map(([label, value, icon]) => `
          <article class="card dashboard-kpi">
            <span class="kpi-mark kpi-${icon}" aria-hidden="true"></span>
            <span class="stat-label">${label}</span>
            <strong class="stat-value">${value}</strong>
          </article>`).join('')}
      </section>

      <section class="dashboard-section mt-24">
        <div class="dashboard-section-heading">
          <div><h2>Needs Attention</h2><p>Issues that may need staff action</p></div>
          <a class="text-sm" href="/pharmacy/alerts.html">All stock alerts</a>
        </div>
        <div class="attention-grid">
          ${attentionPanel('Out-of-Stock Medicines', data.stats.outOfStock, data.attention.outOfStockMedicines, '/pharmacy/alerts.html', 'danger', item => '0 in stock')}
          ${attentionPanel('Low-Stock Medicines', data.stats.lowStock, data.attention.lowStockMedicines, '/pharmacy/alerts.html', 'warning', item => `${item.stock_quantity} left · alert at ${item.low_stock_threshold}`)}
          ${attentionPanel('Pending Reservations', data.stats.pendingReservations, data.stats.pendingReservations ? [{ medicine_name: 'Review pending requests', stock_quantity: data.stats.pendingReservations }] : [], '/pharmacy/reservations.html?status=pending', 'info', item => `${item.stock_quantity} awaiting review`)}
          ${attentionPanel('Unpublished Medicines', data.stats.unpublishedItems, data.attention.unpublishedMedicines, '/pharmacy/inventory.html', 'neutral', item => escapeHtml(item.folder_name || 'Not assigned to a folder'))}
        </div>
      </section>

      <section class="dashboard-section mt-24">
        <div class="dashboard-section-heading"><div><h2>Inventory Overview</h2><p>Stock health, category mix and publication status</p></div></div>
        <div class="dashboard-chart-grid">
          <article class="card dashboard-chart-card">
            <h3>Stock Status</h3>
            ${pieChart3D(stockItems, { size: 164, donut: false, shadow: false })}
          </article>
          <article class="card dashboard-chart-card">
            <h3>Medicines by Category</h3>
            ${data.inventoryByCategory.length
              ? pieChart3D(data.inventoryByCategory.map(category => ({ label: category.category, value: category.count })), { size: 164, donut: false, shadow: false })
              : `<div class="empty-state" style="padding:24px;"><p class="text-sm">Add medicines to see this breakdown.</p></div>`}
          </article>
          <article class="card dashboard-chart-card">
            <h3>Published vs Unpublished</h3>
            ${pieChart3D(publicationItems, { size: 164, donut: false, shadow: false })}
          </article>
          <article class="card dashboard-chart-card">
            <h3>Inventory Value by Category</h3>
            ${data.inventoryByCategory.length
              ? `<div class="category-value-list">${data.inventoryByCategory.map(category => `
                  <div class="category-value-row">
                    <div><span>${escapeHtml(category.category)}</span><strong>${money(category.value)}</strong></div>
                    <span class="category-value-track"><span style="width:${Math.max(1, Math.round(category.value / categoryMaxValue * 100))}%"></span></span>
                  </div>`).join('')}</div>`
              : `<div class="empty-state" style="padding:24px;"><p class="text-sm">No inventory value yet.</p></div>`}
          </article>
        </div>
      </section>

      <section class="dashboard-section mt-24">
        <div class="dashboard-section-heading">
          <div><h2>Reservation Activity</h2><p>Daily reservations over the last 30 days</p></div>
          <a class="text-sm" href="/pharmacy/analytics.html">More analytics</a>
        </div>
        <article class="card reservation-trend-card">
          <div class="trend-summary"><strong>${reservationTotal}</strong><span>reservations in the last 30 days</span></div>
          <div class="reservation-status-strip">
            <span><strong>${data.stats.pendingReservations}</strong> Pending</span>
            <span><strong>${data.stats.confirmedReservations}</strong> Confirmed</span>
            <span><strong>${data.stats.completedPickups}</strong> Completed pickups</span>
            <span><strong>${data.stats.todaysReservations}</strong> Today</span>
          </div>
          <div class="reservation-trend" role="img" aria-label="Daily reservation counts for the last 30 days">
            ${trendDays.map((day, index) => `<span class="trend-day" title="${day.date.toLocaleDateString()}: ${day.count} reservation(s)"><i style="height:${Math.max(day.count ? 8 : 2, Math.round(day.count / maxTrend * 100))}%"></i>${index % 5 === 0 || index === 29 ? `<small>${day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>` : ''}</span>`).join('')}
          </div>
        </article>
      </section>

      <div class="dashboard-data-grid mt-24">
        <section class="card dashboard-table-card">
          <div class="dashboard-section-heading"><div><h2>Top Reserved Medicines</h2><p>Demand compared with current stock</p></div></div>
          ${data.topReservedMedicines.length ? `
            <div class="table-wrap"><table>
              <thead><tr><th>Medicine</th><th>Qty. Reserved</th><th>Current Stock</th><th>Demand</th></tr></thead>
              <tbody>${data.topReservedMedicines.map(item => {
                const demand = item.stock_quantity === 0 ? 'Out of stock' : item.quantity_reserved > item.stock_quantity ? 'Restock soon' : item.stock_quantity <= item.low_stock_threshold ? 'Low stock' : 'In stock';
                const tone = item.stock_quantity === 0 || demand === 'Restock soon' ? 'badge-out' : item.stock_quantity <= item.low_stock_threshold ? 'badge-low' : 'badge-available';
                return `<tr><td>${escapeHtml(item.medicine_name)}</td><td>${item.quantity_reserved}</td><td>${item.stock_quantity}</td><td><span class="badge ${tone}">${demand}</span></td></tr>`;
              }).join('')}</tbody>
            </table></div>` : `<div class="empty-state"><h3>No reservation demand yet</h3><p>Medicines will appear here as customers reserve them.</p></div>`}
        </section>
        <section class="card dashboard-table-card">
          <div class="dashboard-section-heading"><div><h2>Recent Reservations</h2><p>Latest customer activity</p></div><a class="text-sm" href="/pharmacy/reservations.html">View all</a></div>
          ${data.recentReservations.length ? `
            <div class="table-wrap"><table>
              <thead><tr><th>Customer</th><th>Medicine</th><th>Quantity</th><th>Date</th><th>Status</th><th>Action</th></tr></thead>
              <tbody>${data.recentReservations.map(reservation => `
                <tr><td>${escapeHtml(reservation.customer_name)}</td><td>${escapeHtml(reservation.medicine_name)}</td><td>${reservation.quantity}</td>
                  <td>${new Date(reservation.reserved_at).toLocaleDateString()}</td><td>${statusBadge(reservation.status)}</td>
                  <td><a class="btn btn-outline btn-sm" href="/pharmacy/reservations.html">View</a></td></tr>`).join('')}
              </tbody>
            </table></div>` : `<div class="empty-state"><h3>No reservations yet</h3><p>New customer reservations will appear here.</p></div>`}
        </section>
      </div>

      <section class="dashboard-section mt-24">
        <div class="dashboard-section-heading">
          <div><h2>P.A.I. Pharmacy Insights</h2><p>Advisory analysis grounded in your PillPoint inventory, reservations, batches and activity</p></div>
        </div>
        ${paiData.unavailable
          ? `<div class="alert alert-warning">${escapeHtml(paiData.error)}</div>`
          : `
            <article class="card mt-12">
              <div class="dashboard-section-heading"><div><h3>P.A.I. Pharmacy Summary</h3><p>${escapeHtml(paiPerformance.reporting_period || 'Current activity')}</p></div></div>
              <p>${escapeHtml(paiPerformance.summary || 'Summary metrics are not available.')}</p>
              <div class="dashboard-kpis mt-16">
                <article class="card dashboard-kpi"><span class="stat-label">Reservations</span><strong class="stat-value">${Number(paiPerformance.reservation_count || 0)}</strong><span class="text-sm muted">${Number(paiPerformance.reservation_units || 0)} units</span></article>
                <article class="card dashboard-kpi"><span class="stat-label">Pharmacy-matched searches</span><strong class="stat-value">${Number(paiPerformance.pharmacy_matched_searches || 0)}</strong></article>
                <article class="card dashboard-kpi"><span class="stat-label">Low stock</span><strong class="stat-value">${Number(paiPerformance.low_stock_medicines || 0)}</strong></article>
                <article class="card dashboard-kpi"><span class="stat-label">Expiry reviews</span><strong class="stat-value">${Number(paiPerformance.potential_expiry_risks || 0)}</strong></article>
                <article class="card dashboard-kpi"><span class="stat-label">Stock movements (30 days)</span><strong class="stat-value">${Number(paiPerformance.stock_movements_30_days || 0)}</strong></article>
              </div>
              ${paiPerformance.top_reserved_medicines?.length
                ? `<div class="mt-12"><strong>Most reserved this month</strong><ul>${paiPerformance.top_reserved_medicines.map(item => `<li>${escapeHtml(item.medicine_name)} — ${Number(item.quantity_reserved)} units</li>`).join('')}</ul></div>`
                : ''}
            </article>
            <div class="grid mt-16" style="grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
              ${paiPanel('Stock risk', 'Estimated days of supply from recent reservations, stock-out transactions and current stock.', paiStockRisk.slice(0, 6), 'No stock-risk items were identified from the current inventory and recent demand.', item => `
                <article class="card" style="padding:16px;">
                  <div class="flex gap-12" style="justify-content:space-between;">${paiBadge(item.severity)}<span class="text-sm muted">${item.estimated_days == null ? 'Days of stock: not estimated' : `${Number(item.estimated_days).toFixed(1)} estimated days`}</span></div>
                  <strong class="block mt-8">${escapeHtml(item.medicine_name || 'Inventory item')}</strong>
                  <p class="text-sm mt-8">${escapeHtml(item.evidence || item.message || '')}</p>
                  ${item.recommendation ? `<p class="text-sm muted mt-8">${escapeHtml(item.recommendation)}</p>` : ''}
                </article>`)}
              ${paiPanel('Demand analysis', 'Reservation units, stock-out transactions and pharmacy-matched search activity compared across equal 7-day periods; trends are not guarantees.', paiDemand.slice(0, 6), 'No recent reservation, stock-out or matching search activity was found for tracked medicines.', item => `
                <article class="card" style="padding:16px;">
                  <div class="flex gap-12" style="justify-content:space-between;">${paiBadge(item.trend)}${item.change_percent == null ? '' : `<span class="text-sm muted">${Number(item.change_percent) > 0 ? '+' : ''}${Number(item.change_percent)}% reservation units</span>`}</div>
                  <strong class="block mt-8">${escapeHtml(item.medicine_name)}</strong>
                  <p class="text-sm mt-8">${escapeHtml(item.evidence)}</p>
                  <p class="text-sm muted mt-8">${escapeHtml(item.recommendation)}</p>
                </article>`)}
              ${paiPanel('Expiry risk', 'Batch-level evidence uses recorded expiration dates, reservations and stock-out transactions.', paiExpiry.slice(0, 6), 'No active stocked batches were found expiring within 30 days.', item => `
                <article class="card" style="padding:16px;">
                  <div class="flex gap-12" style="justify-content:space-between;">${paiBadge(item.severity)}<span class="text-sm muted">${Number(item.days_until_expiry)} days</span></div>
                  <strong class="block mt-8">${escapeHtml(item.medicine_name)} · Batch ${escapeHtml(item.batch_number)}</strong>
                  <p class="text-sm mt-8">${escapeHtml(item.evidence)}</p>
                  <p class="text-sm muted mt-8">${escapeHtml(item.recommendation)}</p>
                </article>`)}
              ${paiPanel('Price analysis', 'Compared only with current verified, deployed, in-stock PillPoint listings for the same medicine.', paiPrices.slice(0, 6), 'No material price difference was detected, or there were not enough peer listings for a comparison.', item => `
                <article class="card" style="padding:16px;">
                  <div class="flex gap-12" style="justify-content:space-between;">${paiBadge(item.severity)}<span class="text-sm muted">${Number(item.deviation_percent) > 0 ? '+' : ''}${Number(item.deviation_percent)}%</span></div>
                  <strong class="block mt-8">${escapeHtml(item.medicine_name)}</strong>
                  <p class="text-sm mt-8">Your listing: ${money(item.listed_price)} · peer median: ${money(item.peer_median_price)} (${Number(item.peer_listing_count)} listings)${item.price_age_days == null ? '' : ` · updated ${Number(item.price_age_days)} days ago`}</p>
                  <p class="text-sm">${escapeHtml(item.evidence)}</p>
                  <p class="text-sm muted mt-8">${escapeHtml(item.recommendation)}</p>
                </article>`)}
              ${paiPanel('Inventory data quality', 'Review data inconsistencies without automatic changes.', paiQuality.slice(0, 8), 'No inventory or active-batch data-quality issues were found.', item => `
                <article class="card" style="padding:16px;">
                  ${paiBadge('REVIEW')}
                  <strong class="block mt-8">${escapeHtml(item.issue)} — ${escapeHtml(item.medicine_name)}</strong>
                  <p class="text-sm mt-8">${escapeHtml(item.reason)}</p>
                  <p class="text-sm muted mt-8">Suggested correction: ${escapeHtml(item.suggested_correction)}</p>
                </article>`)}
            </div>
          `}
      </section>

      <section class="dashboard-section mt-24">
        <div class="dashboard-section-heading"><div><h2>Quick Actions</h2><p>Go directly to common pharmacy tasks</p></div></div>
        <nav class="dashboard-quick-actions" aria-label="Pharmacy quick actions">
          <a class="btn btn-primary" href="/pharmacy/inventory.html?add=1">+ Add Medicine</a>
          <a class="btn btn-outline" href="/pharmacy/inventory.html">Manage Inventory</a>
          <a class="btn btn-outline" href="/pharmacy/reservations.html">View Reservations</a>
          <a class="btn btn-outline" href="/pharmacy/alerts.html">Stock Alerts</a>
          <a class="btn btn-outline" href="/pharmacy/analytics.html">View Analytics</a>
        </nav>
      </section>
    `;
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
})();
