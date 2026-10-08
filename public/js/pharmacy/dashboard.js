(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Pharmacy Dashboard', 'Pharmacy Control Center');
  if (!user) return;
  const content = document.getElementById('page-content');
  content.innerHTML = skeletonLoader('cards', 4);

  try {
    const [data, inventoryData, paiData] = await Promise.all([
      Api.get('/api/pharmacy/dashboard'),
      Api.get('/api/pharmacy/inventory'),
      Api.get('/api/pai/inventory-insights').catch(error => ({
        unavailable: true,
        error: error.message || 'P.A.I. pharmacy insights are currently unavailable.',
      })),
    ]);
    const stats = data.stats;
    const paiStockRisk = paiData.stock_risk?.items || paiData.insights || [];
    const paiDemand = paiData.demand_analysis?.items || [];
    const paiExpiry = paiData.expiry_risk?.items || [];
    const paiPrices = paiData.price_analysis?.items || [];
    const paiQuality = paiData.data_quality?.issues || [];
    const paiPerformance = paiData.performance_summary || {};
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
      return { count: trendCounts.get(key) || 0, date: day };
    });
    const maxTrend = Math.max(1, ...trendDays.map(day => day.count));
    const categoryMaxValue = Math.max(1, ...data.inventoryByCategory.map(category => category.value));
    const reservationTotal = trendDays.reduce((sum, day) => sum + day.count, 0);
    const activeDeployedProducts = (inventoryData.inventory || []).filter(item =>
      item.folder_id === data.activeDeployedFolder?.id && Number(item.customer_visible) === 1
    );
    const topSearched = paiData.top_searched || paiDemand
      .filter(item => Number(item.recent_searches) > 0)
      .sort((a, b) => Number(b.recent_searches) - Number(a.recent_searches)
        || a.medicine_name.localeCompare(b.medicine_name))
      .slice(0, 5);
    const highDemandLowStock = paiData.demand_analysis?.restock_recommendations || [];
    const verificationStatus = data.pharmacy.verification_status
      || (data.pharmacy.verified ? 'VERIFIED' : 'PENDING');

    function actionCard(title, count, detail, href, tone) {
      return `
        <a class="dashboard-action-card attention-${tone}" href="${href}">
          <span class="dashboard-action-label">${escapeHtml(title)}</span>
          <strong>${Number(count || 0)}</strong>
          <span class="dashboard-action-detail">${detail}</span>
        </a>`;
    }

    function metricCard(label, value, detail) {
      return `
        <article class="card dashboard-control-metric">
          <span class="stat-label">${escapeHtml(label)}</span>
          <strong class="stat-value">${value}</strong>
          <span class="text-sm muted">${escapeHtml(detail)}</span>
        </article>`;
    }

    function entriesList(entries, renderEntry, emptyMessage) {
      return entries.length
        ? `<ul class="dashboard-demand-list">${entries.map(renderEntry).join('')}</ul>`
        : `<p class="dashboard-control-empty">${escapeHtml(emptyMessage)}</p>`;
    }

    function demandCard(title, description, entries, renderEntry, emptyMessage, id = '') {
      return `
        <article class="card dashboard-demand-card" ${id ? `id="${id}"` : ''}>
          <div class="dashboard-section-heading">
            <div><h3>${escapeHtml(title)}</h3><p>${escapeHtml(description)}</p></div>
          </div>
          ${entriesList(entries, renderEntry, emptyMessage)}
        </article>`;
    }

    function insightCard(title, entries, emptyMessage, renderEntry) {
      return `
        <article class="card dashboard-insight-card">
          <div class="dashboard-section-heading"><div><h3>${escapeHtml(title)}</h3></div></div>
          ${entriesList(entries, renderEntry, emptyMessage)}
        </article>`;
    }

    function insightBadge(severity) {
      const tone = ['CRITICAL', 'HIGH', 'REVIEW', 'UNUSUALLY_HIGH'].includes(severity)
        ? 'badge-out'
        : ['MODERATE', 'INCREASING', 'INCREASING_INTEREST'].includes(severity)
          ? 'badge-low'
          : ['STABLE', 'DECREASING', 'DECREASING_INTEREST'].includes(severity)
            ? 'badge-expired'
            : 'badge-available';
      return `<span class="badge ${tone}">${escapeHtml(severity || 'REVIEW')}</span>`;
    }

    content.innerHTML = `
      <section class="pharmacy-dashboard-header">
        <div>
          <div class="dashboard-eyebrow">PHARMACY CONTROL CENTER</div>
          <h2>${escapeHtml(data.pharmacy.name)}</h2>
          <p>${escapeHtml(data.pharmacy.address)}</p>
        </div>
        <span class="badge ${verificationStatus === 'VERIFIED' ? 'badge-verified' : 'badge-unverified'}">${verificationStatus === 'VERIFIED' ? 'Verified pharmacy' : verificationStatus === 'SUSPENDED' ? 'Suspended' : verificationStatus === 'REJECTED' ? 'Rejected' : 'Verification pending'}</span>
      </section>

      <nav class="dashboard-quick-actions dashboard-control-actions mt-16" aria-label="Pharmacy actions">
        <a class="btn btn-primary" href="/pharmacy/alerts.html">View Low Stock</a>
        <a class="btn btn-outline" href="/pharmacy/inventory.html?action=stock-in">Receive Stock</a>
        <a class="btn btn-outline" href="/pharmacy/inventory.html?action=stock-out">Stock Out</a>
        <a class="btn btn-outline" href="/pharmacy/reservations.html">View Reservations</a>
        <a class="btn btn-outline" href="/pharmacy/inventory.html?expiry=expiring">View Expiring Products</a>
        <a class="btn btn-outline" href="#restock-recommendations">View Restock Recommendations</a>
      </nav>

      <section class="dashboard-section mt-24" aria-labelledby="action-required-heading">
        <div class="dashboard-section-heading">
          <div><h2 id="action-required-heading">Action Required</h2><p>Open the relevant list to review and act on current issues.</p></div>
        </div>
        <div class="dashboard-action-grid">
          ${actionCard('Low Stock', stats.lowStock, 'Products at or below their threshold', '/pharmacy/alerts.html', 'warning')}
          ${actionCard('Out of Stock', stats.outOfStock, 'Products with no stock on hand', '/pharmacy/alerts.html', 'danger')}
          ${actionCard('Expiring Soon', stats.expiringSoon, 'Products with stocked batches expiring in 30 days', '/pharmacy/inventory.html?expiry=expiring', 'warning')}
          ${actionCard('Pending Reservations', stats.pendingReservations, 'Requests waiting for pharmacy review', '/pharmacy/reservations.html?status=pending', 'info')}
          ${actionCard('Reservations Ready for Pickup', stats.readyForPickupReservations, 'Confirmed reservations awaiting pickup', '/pharmacy/reservations.html?status=ready_for_pickup', 'info')}
        </div>
        <div class="dashboard-action-details mt-12">
          <article class="card dashboard-action-detail-card">
            <h3>Low-stock medicines</h3>
            ${entriesList(data.attention.lowStockMedicines || [],
              item => `<li><strong>${escapeHtml(item.medicine_name)}</strong><span>${Number(item.available_quantity)} available · threshold ${Number(item.low_stock_threshold)}</span></li>`,
              'No medicines are currently below their stock threshold.')}
          </article>
          <article class="card dashboard-action-detail-card">
            <h3>Expiring products</h3>
            ${entriesList(data.attention.expiringProducts || [],
              item => `<li><strong>${escapeHtml(item.medicine_name)}</strong><span>${Number(item.units_expiring)} units · ${escapeHtml(item.expiration_date)}</span></li>`,
              'No stocked batches expire within the next 30 days.')}
          </article>
        </div>
      </section>

      <section class="dashboard-section mt-24" aria-labelledby="inventory-heading">
        <div class="dashboard-section-heading">
          <div><h2 id="inventory-heading">Inventory</h2><p>Current products, stock on hand, and recorded inventory value.</p></div>
          <a class="text-sm" href="/pharmacy/inventory.html">Manage inventory</a>
        </div>
        <div class="dashboard-control-metrics dashboard-inventory-metrics">
          ${metricCard('Total Products', stats.totalItems, 'Inventory listings')}
          ${metricCard('Published Products', stats.deployedItems, 'Visible to customers')}
          ${metricCard('Unpublished Products', stats.unpublishedItems, 'Not currently published')}
          ${metricCard('Total Units', Number(stats.totalStock || 0).toLocaleString(), 'Physical stock recorded')}
          ${metricCard('Inventory Value', money(stats.estimatedInventoryValue), 'Based on current price and stock')}
        </div>
      </section>

      <section class="dashboard-section mt-24" aria-labelledby="sales-heading">
        <div class="dashboard-section-heading">
          <div><h2 id="sales-heading">Sales</h2><p>Revenue from completed reservations, using the recorded reservation price.</p></div>
          <a class="text-sm" href="/pharmacy/sales.html">Sales history</a>
        </div>
        <div class="dashboard-control-metrics dashboard-sales-metrics">
          ${metricCard("Today's Sales", money(stats.salesToday), 'Completed today')}
          ${metricCard('Weekly Sales', money(stats.salesThisWeek), 'Current week · Monday to date')}
          ${metricCard('Monthly Sales', money(stats.salesThisMonth), 'Current calendar month')}
        </div>
      </section>

      <section class="dashboard-section mt-24" aria-labelledby="demand-heading">
        <div class="dashboard-section-heading">
          <div><h2 id="demand-heading">Demand</h2><p>Recorded search and reservation activity to help prioritize replenishment.</p></div>
        </div>
        <div class="dashboard-demand-grid">
          ${demandCard('Top searched medicines', 'Pharmacy-matched searches in the last 7 days.',
            topSearched,
            item => `<li><strong>${escapeHtml(item.medicine_name)}</strong><span>${Number(item.search_count ?? item.recent_searches)} searches</span></li>`,
            paiData.unavailable ? paiData.error : 'No pharmacy-matched medicine searches were recorded in the last 7 days.')}
          ${demandCard('Top reserved medicines', 'Reservation units recorded for your products.',
            data.topReservedMedicines || [],
            item => `<li><strong>${escapeHtml(item.medicine_name)}</strong><span>${Number(item.quantity_reserved)} units reserved · ${Number(item.available_quantity ?? item.stock_quantity)} available</span></li>`,
            'No reservation activity has been recorded for your products.')}
          ${demandCard('High-demand / low-stock medicines', 'Recent search or reservation demand combined with stock at or below threshold.',
            highDemandLowStock,
            item => `<li><strong>${escapeHtml(item.medicine_name)}</strong><span>${Number(item.current_stock)} in stock · ${Number(item.recent_searches)} searches · ${Number(item.recent_demand_units)} recent demand units</span></li>`,
            paiData.unavailable ? paiData.error : 'No high-demand, low-stock products were identified from recent activity.',
            'restock-recommendations')}
        </div>
      </section>

      <section class="dashboard-section mt-24">
        <div class="dashboard-section-heading">
          <div><h2>Recent Reservations</h2><p>Latest customer activity</p></div>
          <a class="text-sm" href="/pharmacy/reservations.html">View all reservations</a>
        </div>
        ${data.recentReservations.length ? `
          <div class="card table-wrap">
            <table>
              <thead><tr><th>Customer</th><th>Medicine</th><th>Quantity</th><th>Date</th><th>Status</th><th></th></tr></thead>
              <tbody>${data.recentReservations.map(reservation => `
                <tr>
                  <td>${escapeHtml(reservation.customer_name)}</td>
                  <td>${escapeHtml(reservation.medicine_name)}</td>
                  <td>${Number(reservation.quantity)}</td>
                  <td>${new Date(reservation.reserved_at).toLocaleDateString()}</td>
                  <td>${statusBadge(reservation.status)}</td>
                  <td><a class="btn btn-outline btn-sm" href="/pharmacy/reservations.html?status=${encodeURIComponent(reservation.status)}">View</a></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>` : `<div class="card empty-state"><h3>No reservations yet</h3><p>New customer reservations will appear here.</p></div>`}
      </section>

      <section class="card dashboard-deployed-widget mt-24" aria-label="Published products" aria-expanded="false" data-deployed-card tabindex="0" role="button" ${data.activeDeployedFolder ? 'style="cursor:pointer;"' : 'style="cursor:default;"'}>
        <div class="dashboard-deployed-content">
          <span class="dashboard-deployed-icon">${iconSvg('folder', 22)}</span>
          <div>
            <div class="dashboard-deployed-label">PRODUCT PUBLISHING</div>
            <strong class="dashboard-deployed-name">${data.activeDeployedFolder ? escapeHtml(data.activeDeployedFolder.name) : 'NO CUSTOMER-VISIBLE PRODUCTS'}</strong>
            <div class="dashboard-deployed-caption">${data.activeDeployedFolder ? 'Only products that pass current stock and batch checks are shown to customers.' : 'Publish validated, in-stock products from Inventory Center.'}</div>
          </div>
        </div>
        <div class="dashboard-deployed-actions" style="display:flex; align-items:center; gap:10px;">
          ${data.activeDeployedFolder ? `<span id="deployed-folder-chevron" aria-hidden="true" style="display:inline-flex; color:#64748B; transition:transform .2s ease;">▾</span>` : ''}
          <a class="btn btn-outline btn-sm" href="/pharmacy/inventory.html">Manage Inventory</a>
        </div>
        <div id="deployed-folder-details" ${data.activeDeployedFolder ? '' : 'hidden'} style="margin-top:14px; border-top:1px solid rgba(148,163,184,.28); padding-top:14px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:10px; flex-wrap:wrap;">
            <strong style="font-size:12px; letter-spacing:.08em; color:#475569; text-transform:uppercase;">Customer-visible products in this group</strong>
            <span class="badge badge-available">${activeDeployedProducts.length} item(s)</span>
          </div>
          ${activeDeployedProducts.length
            ? `<div class="table-wrap" style="margin-top:10px;">
                <table>
                  <thead><tr><th>Medicine</th><th>Brand</th><th>Price (₱)</th><th>Stock</th><th>Status</th></tr></thead>
                  <tbody>${activeDeployedProducts.map(item => `
                    <tr>
                      <td><strong>${escapeHtml(item.medicine_name)}</strong><div class="text-sm muted">${escapeHtml(item.category || 'Medicine')}</div></td>
                      <td>${escapeHtml(item.brand || '—')}</td>
                      <td>${money(Number(item.price || 0))}</td>
                      <td>${Number(item.available_quantity ?? item.stock_quantity ?? 0)}</td>
                      <td>${stockBadge(Number(item.available_quantity ?? item.stock_quantity ?? 0), Number(item.low_stock_threshold || 10))}</td>
                    </tr>`).join('')}
                  </tbody>
                </table>
              </div>`
            : `<p class="text-sm muted">No products in this group are currently customer-visible.</p>`}
        </div>
      </section>

      <details class="dashboard-more-details mt-24">
        <summary>More pharmacy insights</summary>
        ${paiData.unavailable
          ? `<div class="alert alert-warning mt-12">${escapeHtml(paiData.error)}</div>`
          : `
            <article class="card mt-12">
              <div class="dashboard-section-heading"><div><h3>P.A.I. Pharmacy Summary</h3><p>${escapeHtml(paiPerformance.reporting_period || 'Current activity')}</p></div></div>
              <p>${escapeHtml(paiPerformance.summary || 'Summary metrics are not available.')}</p>
              <div class="dashboard-control-metrics dashboard-pai-metrics">
                ${metricCard('Reservations', Number(paiPerformance.reservation_count || 0), `${Number(paiPerformance.reservation_units || 0)} units`)}
                ${metricCard('Pharmacy-matched searches', Number(paiPerformance.pharmacy_matched_searches || 0), 'Recorded demand events')}
                ${metricCard('Low stock', Number(paiPerformance.low_stock_medicines || 0), 'Products at threshold')}
                ${metricCard('Expiry reviews', Number(paiPerformance.potential_expiry_risks || 0), 'Batch-level risk analysis')}
                ${metricCard('Stock movements', Number(paiPerformance.stock_movements_30_days || 0), 'Last 30 days')}
              </div>
            </article>
            <section class="dashboard-section mt-16">
              <div class="dashboard-section-heading"><div><h3>Inventory overview</h3><p>Stock, publication, category, and value breakdowns.</p></div></div>
              <div class="dashboard-chart-grid">
                <article class="card dashboard-chart-card">
                  <h3>Stock status</h3>
                  ${pieChart3D(stockItems, { size: 164, donut: false, shadow: false })}
                </article>
                <article class="card dashboard-chart-card">
                  <h3>Products by category</h3>
                  ${data.inventoryByCategory.length
                    ? pieChart3D(data.inventoryByCategory.map(category => ({ label: category.category, value: category.count })), { size: 164, donut: false, shadow: false })
                    : `<div class="empty-state"><p>No category data yet.</p></div>`}
                </article>
                <article class="card dashboard-chart-card">
                  <h3>Published vs unpublished</h3>
                  ${pieChart3D(publicationItems, { size: 164, donut: false, shadow: false })}
                </article>
                <article class="card dashboard-chart-card">
                  <h3>Inventory value by category</h3>
                  ${data.inventoryByCategory.length
                    ? `<div class="category-value-list">${data.inventoryByCategory.map(category => `
                        <div class="category-value-row">
                          <div><span>${escapeHtml(category.category)}</span><strong>${money(category.value)}</strong></div>
                          <span class="category-value-track"><span style="width:${Math.max(1, Math.round(category.value / categoryMaxValue * 100))}%"></span></span>
                        </div>`).join('')}</div>`
                    : `<div class="empty-state"><p>No inventory value yet.</p></div>`}
                </article>
              </div>
            </section>
            <section class="dashboard-section mt-16">
              <div class="dashboard-section-heading"><div><h3>Reservation activity</h3><p>Daily reservations over the last 30 days.</p></div></div>
              <article class="card reservation-trend-card">
                <div class="trend-summary"><strong>${reservationTotal}</strong><span>reservations in the last 30 days</span></div>
                <div class="reservation-trend" role="img" aria-label="Daily reservation counts for the last 30 days">
                  ${trendDays.map((day, index) => `<span class="trend-day" title="${day.date.toLocaleDateString()}: ${day.count} reservation(s)"><i style="height:${Math.max(day.count ? 8 : 2, Math.round(day.count / maxTrend * 100))}%"></i>${index % 5 === 0 || index === 29 ? `<small>${day.date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>` : ''}</span>`).join('')}
                </div>
              </article>
            </section>
            <div class="dashboard-insight-grid mt-16">
              ${insightCard('Stock risk', paiStockRisk, 'No stock-risk items identified.', item => `
                <li>${insightBadge(item.severity)} <strong>${escapeHtml(item.medicine_name || 'Inventory item')}</strong><span>${escapeHtml(item.evidence || item.message || '')}</span></li>`)}
              ${insightCard('Demand trends', paiDemand, 'No recent reservation, stock-out, or search activity found.', item => `
                <li>${insightBadge(item.trend)} <strong>${escapeHtml(item.medicine_name)}</strong><span>${escapeHtml(item.evidence)}</span></li>`)}
              ${insightCard('Expiry risk', paiExpiry, 'No active stocked batches are flagged for expiry review.', item => `
                <li>${insightBadge(item.severity)} <strong>${escapeHtml(item.medicine_name)} · ${escapeHtml(item.batch_number)}</strong><span>${escapeHtml(item.evidence)}</span></li>`)}
              ${insightCard('Price analysis', paiPrices, 'No material price difference detected or insufficient peer listings.', item => `
                <li>${insightBadge(item.severity)} <strong>${escapeHtml(item.medicine_name)}</strong><span>${escapeHtml(item.evidence)}</span></li>`)}
              ${insightCard('Inventory data quality', paiQuality, 'No inventory or active-batch data-quality issues found.', item => `
                <li>${insightBadge('REVIEW')} <strong>${escapeHtml(item.issue)} · ${escapeHtml(item.medicine_name)}</strong><span>${escapeHtml(item.reason)}</span></li>`)}
            </div>
          `}
      </details>

      <nav class="dashboard-quick-actions mt-24" aria-label="More pharmacy tools">
        <a class="btn btn-outline" href="/pharmacy/inventory.html?add=1">Add Medicine</a>
        <a class="btn btn-outline" href="/pharmacy/analytics.html">View Analytics</a>
        <a class="btn btn-outline" href="/pharmacy/profile.html">Pharmacy Profile</a>
      </nav>
    `;

    const deployedCard = document.querySelector('[data-deployed-card]');
    const deployedDetails = document.getElementById('deployed-folder-details');
    const deployedChevron = document.getElementById('deployed-folder-chevron');
    const toggleDeployedDetails = () => {
      if (!data.activeDeployedFolder || !deployedCard || !deployedDetails) return;
      const isExpanded = deployedCard.getAttribute('aria-expanded') === 'true';
      deployedCard.setAttribute('aria-expanded', String(!isExpanded));
      deployedDetails.hidden = isExpanded;
      if (deployedChevron) deployedChevron.style.transform = isExpanded ? 'rotate(0deg)' : 'rotate(180deg)';
    };

    if (deployedCard && data.activeDeployedFolder) {
      deployedCard.addEventListener('click', event => {
        if (event.target.closest('a')) return;
        toggleDeployedDetails();
      });
      deployedCard.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          toggleDeployedDetails();
        }
      });
      deployedDetails.hidden = true;
    }
  } catch (error) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
  }
})();
