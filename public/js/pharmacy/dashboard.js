(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Pharmacy Dashboard', 'Pharmacy Control Center');
  if (!user) return;
  const content = document.getElementById('page-content');
  content.innerHTML = skeletonLoader('cards', 4);

  // Live clock in the header
  function startClock(el) {
    function tick() {
      const now = new Date();
      const dateStr = now.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = now.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
      el.textContent = `${dateStr}  ${timeStr}`;
    }
    tick();
    setInterval(tick, 1000);
  }

  // Inline SVG donut chart
  function donutChart(published, unpublished, total, size = 120) {
    const r = 42;
    const cx = size / 2;
    const cy = size / 2;
    const circ = 2 * Math.PI * r;
    const other = Math.max(0, total - published - unpublished);
    const segments = [
      { value: published, color: '#14B8A6' },
      { value: unpublished, color: '#64748b' },
      { value: other, color: '#334155' },
    ];
    let offset = 0;
    const arcs = segments.map(seg => {
      const pct = total > 0 ? seg.value / total : 0;
      const dash = pct * circ;
      const gap = circ - dash;
      const arc = `<circle
        r="${r}" cx="${cx}" cy="${cy}"
        fill="none" stroke="${seg.color}" stroke-width="18"
        stroke-dasharray="${dash.toFixed(2)} ${gap.toFixed(2)}"
        stroke-dashoffset="${(-offset * circ / total + circ / 4).toFixed(2)}"
        transform="rotate(-90 ${cx} ${cy})"
      />`;
      offset += seg.value;
      return arc;
    });
    return `
      <svg class="inv-donut-svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <circle r="${r}" cx="${cx}" cy="${cy}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="18"/>
        ${arcs.join('')}
        <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="#ffffff" font-size="20" font-weight="800">${total}</text>
        <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="#64748b" font-size="10">Total Units</text>
      </svg>`;
  }

  // Mini SVG line chart for sales trend
  function miniLineChart(values, w = 240, h = 72) {
    if (!values.length) return `<svg width="${w}" height="${h}"></svg>`;
    const max = Math.max(...values, 1);
    const pts = values.map((v, i) => {
      const x = (i / (values.length - 1)) * (w - 20) + 10;
      const y = h - 10 - (v / max) * (h - 20);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const polyline = pts.join(' ');
    const firstPt = pts[0].split(',');
    const lastPt = pts[pts.length - 1].split(',');
    const area = `M${firstPt[0]},${h - 5} ${pts.map(p => `L${p}`).join(' ')} L${lastPt[0]},${h - 5} Z`;
    return `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg">
        <defs>
          <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#14B8A6" stop-opacity="0.3"/>
            <stop offset="100%" stop-color="#14B8A6" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <path d="${area}" fill="url(#areaGrad)"/>
        <polyline points="${polyline}" fill="none" stroke="#14B8A6" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        ${pts.map(p => `<circle cx="${p.split(',')[0]}" cy="${p.split(',')[1]}" r="2.5" fill="#14B8A6"/>`).join('')}
      </svg>`;
  }

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
    const paiDemand = paiData.demand_analysis?.items || [];
    const topSearched = paiData.top_searched || paiDemand
      .filter(item => Number(item.recent_searches) > 0)
      .sort((a, b) => Number(b.recent_searches) - Number(a.recent_searches) || a.medicine_name.localeCompare(b.medicine_name))
      .slice(0, 5);

    const verificationStatus = data.pharmacy.verification_stage
      || (data.pharmacy.verification_status === 'VERIFIED'
        ? 'APPROVED'
        : data.pharmacy.verification_status || (data.pharmacy.verified ? 'APPROVED' : 'PENDING'));

    const verificationLabels = {
      PENDING: 'Pending verification',
      UNDER_REVIEW: 'Under review',
      CORRECTION_REQUIRED: 'Correction required',
      APPROVED: 'Approved',
      VERIFIED: 'Approved',
      REJECTED: 'Rejected',
      SUSPENDED: 'Suspended',
      REVERIFICATION_REQUIRED: 'Reverification required',
    };

    const isApproved = ['APPROVED', 'VERIFIED'].includes(verificationStatus);
    const isBad = ['SUSPENDED', 'REJECTED', 'CORRECTION_REQUIRED', 'REVERIFICATION_REQUIRED'].includes(verificationStatus);
    const verBadge = isApproved
      ? `<span class="badge-approved-dark">✓ ${escapeHtml(verificationLabels[verificationStatus] || verificationStatus)}</span>`
      : isBad
        ? `<span class="badge-danger-dark">${escapeHtml(verificationLabels[verificationStatus] || verificationStatus)}</span>`
        : `<span class="badge-pending-dark">${escapeHtml(verificationLabels[verificationStatus] || verificationStatus)}</span>`;

    // Inventory stats for donut
    let totalUnits = Number(stats.totalStock || 0);
    let published = Number(stats.deployedItems || 0);
    let unpublished = Number(stats.unpublishedItems || 0);

    // Sales trend from last 7 days (use reservation trend if available)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const trendCounts = new Map((data.reservationTrend || []).map(item => [item.day, item.count]));
    const weekDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const trendValues = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(today);
      d.setDate(today.getDate() - (6 - i));
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      return trendCounts.get(key) || 0;
    });

    // Low stock medicines list
    const lowStockItems = data.attention.lowStockMedicines || [];

    // Stock icon pill SVG
    const pillIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 20H4a2 2 0 0 1-2-2V5c0-1.1.9-2 2-2h3.93a2 2 0 0 1 1.66.9l.82 1.2a2 2 0 0 0 1.66.9H20a2 2 0 0 1 2 2v3"/><circle cx="18" cy="18" r="3"/><path d="M22 22l-1.5-1.5"/></svg>`;
    const chevronRight = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;
    const pinIcon = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/></svg>`;
    const calIcon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`;
    const fireIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 3z"/></svg>`;
    const boxIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z"/><path d="m3.3 7 8.7 5 8.7-5M12 22V12"/></svg>`;
    const clockIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    const clipboardIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/></svg>`;
    const arrowsIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
    const sparkleIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`;
    const chartIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>`;
    const plusIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    const userIcon = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;

    function stockBadgeClass(qty, threshold) {
      if (qty <= 0) return 'dark-badge-low';
      if (qty <= threshold) return 'dark-badge-warning';
      return 'dark-badge-ok';
    }
    function stockBadgeLabel(qty, threshold) {
      if (qty <= 0) return 'Out of Stock';
      if (qty <= threshold) return 'Low Stock';
      return 'In Stock';
    }

    content.innerHTML = `
      <!-- === HEADER === -->
      <div class="dash-header-dark">
        <div style="position:relative;z-index:1;">
          <div class="dash-header-eyebrow">PHARMACY CONTROL CENTER</div>
          <h2 class="dash-header-name">
            ${escapeHtml(data.pharmacy.name)}
            ${isApproved ? '<span class="dash-header-verified-icon">✓</span>' : ''}
          </h2>
          <div class="dash-header-address">${pinIcon} ${escapeHtml(data.pharmacy.address)}</div>
        </div>
        <div class="dash-header-right">
          <div class="dash-datetime-widget">
            ${calIcon}
            <span id="dash-clock">Loading…</span>
          </div>
          ${verBadge}
        </div>
      </div>

      ${['CORRECTION_REQUIRED', 'REVERIFICATION_REQUIRED'].includes(verificationStatus) ? `
        <div class="dark-alert-warning" style="margin-bottom:18px;">
          <strong>${escapeHtml(verificationLabels[verificationStatus])}</strong>
          <p style="margin-top:6px;font-size:13px;color:#e2e8f0;">${escapeHtml(data.pharmacy.correction_reason || 'Please review your latest notification, update your Pharmacy Profile, and resubmit for verification.')}</p>
          <a class="btn btn-sm btn-primary" href="/profile.html" style="margin-top:10px;display:inline-flex;">Review and resubmit</a>
        </div>` : ''}

      <!-- === ACTION REQUIRED === -->
      <div class="dash-action-heading">
        <div class="dash-action-heading-left">
          <h2>${fireIcon} Action Required</h2>
          <div class="dash-action-heading-sub">Review and take action on the following items.</div>
        </div>
        <a class="dash-action-view-all" href="/pharmacy/alerts.html">View all →</a>
      </div>
      <div class="dash-action-grid">
        <a class="dash-action-tile" href="/pharmacy/alerts.html">
          <div class="dash-action-tile-top">
            <span class="dash-action-tile-icon tone-red">${fireIcon}</span>
            <span class="dash-action-tile-arrow">${chevronRight}</span>
          </div>
          <div class="dash-action-tile-count">${Number(stats.lowStock || 0)}</div>
          <div class="dash-action-tile-label">Low Stock</div>
          <div class="dash-action-tile-detail">Products at or below their threshold</div>
        </a>
        <a class="dash-action-tile" href="/pharmacy/alerts.html">
          <div class="dash-action-tile-top">
            <span class="dash-action-tile-icon tone-orange">${boxIcon}</span>
            <span class="dash-action-tile-arrow">${chevronRight}</span>
          </div>
          <div class="dash-action-tile-count">${Number(stats.outOfStock || 0)}</div>
          <div class="dash-action-tile-label">Out of Stock</div>
          <div class="dash-action-tile-detail">Products with no stock on hand</div>
        </a>
        <a class="dash-action-tile" href="/pharmacy/inventory.html?expiry=expiring">
          <div class="dash-action-tile-top">
            <span class="dash-action-tile-icon tone-purple">${clockIcon}</span>
            <span class="dash-action-tile-arrow">${chevronRight}</span>
          </div>
          <div class="dash-action-tile-count">${Number(stats.expiringSoon || 0)}</div>
          <div class="dash-action-tile-label">Expiring Soon</div>
          <div class="dash-action-tile-detail">Products with stocked batches expiring in 30 days</div>
        </a>
        <a class="dash-action-tile" href="/pharmacy/reservations.html?status=pending">
          <div class="dash-action-tile-top">
            <span class="dash-action-tile-icon tone-blue">${clipboardIcon}</span>
            <span class="dash-action-tile-arrow">${chevronRight}</span>
          </div>
          <div class="dash-action-tile-count">${Number(stats.pendingReservations || 0)}</div>
          <div class="dash-action-tile-label">Pending Reservations</div>
          <div class="dash-action-tile-detail">Requests waiting for pharmacy review</div>
        </a>
        <a class="dash-action-tile" href="/pharmacy/reservations.html?status=ready_for_pickup">
          <div class="dash-action-tile-top">
            <span class="dash-action-tile-icon tone-teal">${clipboardIcon}</span>
            <span class="dash-action-tile-arrow">${chevronRight}</span>
          </div>
          <div class="dash-action-tile-count">${Number(stats.readyForPickupReservations || 0)}</div>
          <div class="dash-action-tile-label">Reservations Ready for Pickup</div>
          <div class="dash-action-tile-detail">Confirmed reservations awaiting pickup</div>
        </a>
      </div>

      <!-- === MAIN 3-COLUMN GRID === -->
      <div class="dash-main-grid">

        <!-- Low-Stock Medicines -->
        <div class="dark-card">
          <div class="dark-section-head">
            <h3>${fireIcon} Low-Stock Medicines</h3>
            <a class="dark-section-link" href="/pharmacy/alerts.html">View all →</a>
          </div>
          ${lowStockItems.length
            ? `<ul class="dark-medicine-list">
                ${lowStockItems.slice(0, 5).map(item => {
                  const qty = Number(item.available_quantity);
                  const thr = Number(item.low_stock_threshold);
                  return `
                    <li class="dark-medicine-item">
                      <span class="dark-medicine-thumb">${pillIcon}</span>
                      <div class="dark-medicine-info">
                        <div class="dark-medicine-name">${escapeHtml(item.medicine_name)}</div>
                        <div class="dark-medicine-sub">${qty} available · threshold ${thr}</div>
                      </div>
                      <span class="${stockBadgeClass(qty, thr)}">${stockBadgeLabel(qty, thr)}</span>
                      <span class="dark-medicine-arrow">${chevronRight}</span>
                    </li>`;
                }).join('')}
              </ul>`
            : `<div class="dark-reservations-empty">
                ${pillIcon}
                <p>No medicines are currently below their stock threshold.</p>
              </div>`
          }
        </div>

        <!-- Inventory Overview -->
        <div class="dark-card">
          <div class="dark-section-head">
            <h3>${chartIcon} Inventory Overview</h3>
            <a class="dark-section-link" href="/pharmacy/inventory.html">View details →</a>
          </div>
          <div class="inv-overview-stats">
            <span class="inv-stat-chip">${boxIcon} <span>Total Products</span> <strong>${stats.totalItems || 0}</strong></span>
            <span class="inv-stat-chip">${sparkleIcon} <span>Published</span> <strong>${stats.deployedItems || 0}</strong></span>
            <span class="inv-stat-chip">${clockIcon} <span>Unpublished</span> <strong>${stats.unpublishedItems || 0}</strong></span>
            <span class="inv-stat-chip">${boxIcon} <span>Total Units</span> <strong>${Number(stats.totalStock || 0).toLocaleString()}</strong></span>
          </div>
          <div class="inv-donut-wrap">
            ${donutChart(published, unpublished, totalUnits)}
            <div class="inv-donut-legend">
              <div class="inv-legend-item">
                <span class="inv-legend-dot" style="background:#14B8A6;"></span>
                <span class="inv-legend-label">Published</span>
                <span class="inv-legend-right">
                  <span class="inv-legend-pct">${totalUnits > 0 ? Math.round(published / totalUnits * 100) : 0}%</span>
                  <span class="inv-legend-count">${published}</span>
                </span>
              </div>
              <div class="inv-legend-item">
                <span class="inv-legend-dot" style="background:#64748b;"></span>
                <span class="inv-legend-label">Unpublished</span>
                <span class="inv-legend-right">
                  <span class="inv-legend-pct">${totalUnits > 0 ? Math.round(unpublished / totalUnits * 100) : 0}%</span>
                  <span class="inv-legend-count">${unpublished}</span>
                </span>
              </div>
              <div class="inv-legend-item">
                <span class="inv-legend-dot" style="background:#334155;"></span>
                <span class="inv-legend-label">Other</span>
                <span class="inv-legend-right">
                  <span class="inv-legend-pct">${totalUnits > 0 ? Math.round(Math.max(0, totalUnits - published - unpublished) / totalUnits * 100) : 0}%</span>
                  <span class="inv-legend-count">${Math.max(0, totalUnits - published - unpublished)}</span>
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Sales Overview -->
        <div class="dark-card">
          <div class="dark-section-head">
            <h3>${chartIcon} Sales Overview</h3>
            <a class="dark-section-link" href="/pharmacy/sales.html">View sales history →</a>
          </div>
          <div class="sales-metric-chips">
            <div class="sales-chip">
              <div class="sales-chip-label">Today's Sales</div>
              <div class="sales-chip-value">${money(stats.salesToday)}</div>
              <div class="sales-chip-sub">Completed today</div>
            </div>
            <div class="sales-chip">
              <div class="sales-chip-label">Weekly Sales</div>
              <div class="sales-chip-value">${money(stats.salesThisWeek)}</div>
              <div class="sales-chip-sub">Current week</div>
            </div>
            <div class="sales-chip">
              <div class="sales-chip-label">Monthly Sales</div>
              <div class="sales-chip-value">${money(stats.salesThisMonth)}</div>
              <div class="sales-chip-sub">Current month</div>
            </div>
          </div>
          <div class="sales-trend-label">Sales Trend</div>
          <div class="sales-mini-chart">
            ${miniLineChart(trendValues)}
          </div>
          <div style="display:flex;justify-content:space-between;margin-top:4px;font-size:10px;color:#64748b;">
            ${weekDays.map(d => `<span>${d}</span>`).join('')}
          </div>
        </div>
      </div>

      <!-- === BOTTOM 3-COLUMN GRID === -->
      <div class="dash-bottom-grid">

        <!-- Demand -->
        <div class="dark-card">
          <div class="dark-section-head">
            <h3>${sparkleIcon} Demand</h3>
          </div>
          <div style="font-size:12px;color:#64748b;margin-bottom:10px;">Top medicines by reservation activity</div>
          ${(data.topReservedMedicines || []).length
            ? `<ul class="dark-demand-list">
                ${(data.topReservedMedicines || []).slice(0, 6).map(item => `
                  <li class="dark-demand-item">
                    <span class="dark-demand-name">${escapeHtml(item.medicine_name)}</span>
                    <span class="dark-demand-count">${Number(item.quantity_reserved)} reservations</span>
                  </li>`).join('')}
              </ul>`
            : `<div class="dark-reservations-empty">
                ${clipboardIcon}
                <p>No reservation activity recorded yet.</p>
              </div>`
          }
        </div>

        <!-- Recent Reservations -->
        <div class="dark-card">
          <div class="dark-section-head">
            <h3>${clipboardIcon} Recent Reservations</h3>
            <a class="dark-section-link" href="/pharmacy/reservations.html">View all →</a>
          </div>
          <div style="font-size:12px;color:#64748b;margin-bottom:10px;">Latest customer activity</div>
          ${data.recentReservations.length
            ? `<ul class="dark-res-list">
                ${data.recentReservations.slice(0, 5).map(r => `
                  <li class="dark-res-item">
                    <div class="dark-res-info">
                      <div class="dark-res-name">${escapeHtml(r.customer_name)} · ${escapeHtml(r.medicine_name)}</div>
                      <div class="dark-res-meta">Qty ${Number(r.quantity)} · ${new Date(r.reserved_at).toLocaleDateString()} · ${statusBadge(r.status)}</div>
                    </div>
                    <span class="dark-medicine-arrow">${chevronRight}</span>
                  </li>`).join('')}
              </ul>`
            : `<div class="dark-reservations-empty">
                ${clipboardIcon}
                <p>No reservations yet</p>
                <p style="font-size:11px;">New customer reservations will appear here.</p>
              </div>`
          }
        </div>

        <!-- Quick Actions -->
        <div class="dark-card">
          <div class="dark-section-head">
            <h3>${sparkleIcon} Quick Actions</h3>
          </div>
          <div style="font-size:12px;color:#64748b;margin-bottom:12px;">Manage your pharmacy operations</div>
          <div class="dash-quick-actions-card">
            <a class="dash-quick-action-btn" href="/pharmacy/inventory.html?add=1">
              <span class="dash-quick-action-icon c-green">${plusIcon}</span>
              Add Medicine
            </a>
            <a class="dash-quick-action-btn" href="/pharmacy/analytics.html">
              <span class="dash-quick-action-icon c-blue">${chartIcon}</span>
              View Analytics
            </a>
            <a class="dash-quick-action-btn" href="/profile.html">
              <span class="dash-quick-action-icon c-purple">${userIcon}</span>
              Pharmacy Profile
            </a>
          </div>
        </div>
      </div>

      <!-- Hidden anchor for restock recommendations link -->
      <div id="restock-recommendations" style="margin-top:24px;"></div>
    `;

    // Start the live clock
    const clockEl = document.getElementById('dash-clock');
    if (clockEl) startClock(clockEl);

  } catch (error) {
    content.innerHTML = `<div class="dark-alert-error">${escapeHtml(error.message)}</div>`;
  }
})();
