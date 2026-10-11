(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Pharmacy Analytics', 'Sales, inventory health, customer demand, and operational performance');
  if (!user) return;
  document.body.classList.add('pharmacy-analytics-page');

  const content = document.getElementById('page-content');
  const params = new URLSearchParams(window.location.search);
  const today = new Date();
  const endDefault = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const start = new Date(today);
  start.setDate(start.getDate() - 29);
  const startDefault = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;

  const number = value => Number(value || 0).toLocaleString();
  const percent = value => value == null ? 'Insufficient data' : `${(Number(value) * 100).toFixed(1)}%`;
  const cash = value => value == null ? 'Insufficient data' : money(Number(value));
  const dateLabel = value => value ? escapeHtml(new Date(`${value.slice(0, 10)}T00:00:00`).toLocaleDateString()) : '—';

  function metricCard(label, value, note = '') {
    return `<div class="card stat-card analytics-metric-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div>${note ? `<div class="text-sm muted mt-8">${escapeHtml(note)}</div>` : ''}</div>`;
  }

  function section(title, description, body) {
    return `<section class="analytics-section"><header class="analytics-section-heading"><div class="analytics-section-marker"></div><div><h2>${escapeHtml(title)}</h2>${description ? `<p>${escapeHtml(description)}</p>` : ''}</div></header><div class="analytics-section-content">${body}</div></section>`;
  }

  function table(headers, rows, emptyText = 'Insufficient data') {
    if (!rows.length) return `<div class="empty-state"><p>${escapeHtml(emptyText)}</p></div>`;
    return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function demandTrend(rows) {
    if (!rows.length) return '<div class="empty-state"><p>Not enough trend data</p></div>';
    const width = 640;
    const height = 150;
    const padX = 10;
    const padY = 14;
    const scaleMax = Math.max(1, ...rows.flatMap(row => [Number(row.searches || 0), Number(row.reservations || 0)]));
    const pointsFor = key => {
      const values = rows.map(row => Number(row[key] || 0));
      return values.map((value, index) => {
        const x = padX + (rows.length < 2 ? 0 : index * (width - padX * 2) / (rows.length - 1));
        const y = height - padY - value / scaleMax * (height - padY * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
    };
    const ticks = [rows[0], rows[Math.floor((rows.length - 1) / 2)], rows[rows.length - 1]];
    return `<div class="analytics-demand-chart"><div class="analytics-chart-legend"><span><i class="search-line"></i>Searches</span><span><i class="reservation-line"></i>Reservations</span></div><svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Daily searches and reservations trend"><line x1="0" y1="${height * .25}" x2="${width}" y2="${height * .25}"/><line x1="0" y1="${height * .55}" x2="${width}" y2="${height * .55}"/><line x1="0" y1="${height * .85}" x2="${width}" y2="${height * .85}"/><polyline class="search-series" points="${pointsFor('searches')}"/><polyline class="reservation-series" points="${pointsFor('reservations')}"/></svg><div class="analytics-chart-dates">${ticks.map(row => `<span>${dateLabel(row.day)}</span>`).join('')}</div></div>`;
  }

  function render(data) {
    const inv = data.inventory;
    const operations = data.operations;
    const demand = data.demand;
    const products = data.products;
    const windowText = `${dateLabel(data.dateRange.startDate)} – ${dateLabel(data.dateRange.endDate)} (${number(data.dateRange.days)} days)`;

    const inventoryBody = `
      <div class="grid grid-4 mt-12">
        ${metricCard('Total units', number(inv.total_units))}
        ${metricCard('Retail inventory value', cash(inv.retail_inventory_value), 'Current selling price × physical units; not purchase cost')}
        ${metricCard('Low stock products', number(inv.low_stock))}
        ${metricCard('Out of stock products', number(inv.out_of_stock))}
      </div>
      <div class="grid grid-4 mt-16">
        ${metricCard('Expired units', number(inv.expired.expired_units), `${number(inv.expired.expired_batches)} batches`)}
        ${metricCard('Expiring within 30 days', number(inv.expired.expiring_within_30_days_units), `${number(inv.expired.expiring_within_30_days_batches)} batches`)}
        ${metricCard('Inventory mismatches', number(inv.inventory_mismatches))}
        ${metricCard('Stock turnover', 'Insufficient data', inv.stock_turnover.reason)}
      </div>
      <div class="card mt-16 analytics-note-card"><span class="analytics-note-value">${number(inv.stock_turnover.recorded_stock_out_transactions)}</span><span>stock-out transactions in this period</span><small>Turnover rate unavailable without historical inventory averages.</small></div>
    `;

    const demandBody = `
      <div class="grid grid-2">
        <div class="card"><div class="card-title">Most searched medicines</div>${table(['Medicine', 'Searches'], demand.mostSearched.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.searches)}</td></tr>`))}</div>
        <div class="card"><div class="card-title">Most reserved medicines</div>${table(['Medicine', 'Units reserved', 'Reservations'], demand.mostReserved.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.units_reserved)}</td><td>${number(row.reservation_count)}</td></tr>`))}</div>
      </div>
      <div class="grid grid-2 mt-16">
        <div class="card"><div class="card-title">High demand + low stock</div>${table(['Medicine', 'Searches', 'Units reserved', 'Available', 'Action'], demand.highDemandLowStock.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.searches)}</td><td>${number(row.units_reserved)}</td><td>${number(row.available_quantity)}</td><td><a class="btn btn-primary btn-sm" href="/pharmacy/inventory.html?action=stock-in&inventory_id=${row.inventory_id}">Restock</a></td></tr>`))}</div>
        <div class="card"><div class="card-title">Frequently searched but unavailable</div>${table(['Medicine', 'Searches', 'Available', 'Action'], products.frequentlySearchedUnavailable.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.searches)}</td><td>${number(row.available_quantity)}</td><td><a class="btn btn-outline btn-sm" href="/pharmacy/inventory.html?product_id=${row.inventory_id}">View Product</a></td></tr>`))}</div>
      </div>
      <div class="card mt-16"><div class="card-title">Demand trend</div>${demandTrend(demand.trends)}</div>
    `;

    const operationsBody = `
      <div class="grid grid-4">
        ${metricCard('Reservation completion rate', percent(operations.completionRate), `${number(operations.completed)} completed / ${number(operations.reservationTotal)} reservations placed`)}
        ${metricCard('Cancellation rate', percent(operations.cancellationRate), `${number(operations.cancelled)} cancelled`)}
        ${metricCard('Expired reservation rate', percent(operations.expiredReservationRate), `${number(operations.expired)} expired`)}
        ${metricCard('Stock adjustments', number(operations.adjustmentFrequency), 'Adjustment transactions recorded')}
      </div>
    `;

    const productBody = `
      <div class="card"><div class="card-title">Slow-moving inventory</div>${table(['Medicine', 'Physical units', 'Available units', 'Recorded sales'], products.slowMoving.map(row => `<tr><td><strong>${escapeHtml(row.medicine_name)}</strong></td><td>${number(row.stock_quantity)}</td><td>${number(row.available_quantity)}</td><td>${escapeHtml(row.reason)}</td></tr>`))}</div>
    `;

    content.innerHTML = `
      <div class="card analytics-filter-card">
        <div class="flex justify-between items-center" style="gap:16px;flex-wrap:wrap;">
          <div><div class="card-title" style="margin:0;">Analytics date range</div><p class="text-sm muted mt-8">Activity analytics use this period. Current stock and expiry values are a live snapshot.</p></div>
          <form id="analytics-date-filter" class="flex items-end gap-8" style="flex-wrap:wrap;">
            <div class="field"><label for="analytics-start">From</label><input id="analytics-start" name="start_date" type="date" value="${escapeHtml(data.dateRange.startDate)}" required /></div>
            <div class="field"><label for="analytics-end">To</label><input id="analytics-end" name="end_date" type="date" value="${escapeHtml(data.dateRange.endDate)}" required /></div>
            <button type="submit" class="btn btn-primary">Apply</button>
            <button type="button" class="btn btn-outline" id="analytics-last-30">Last 30 days</button>
          </form>
        </div>
        <p class="text-sm muted mt-8">Showing ${windowText}. Maximum date range: 366 days.</p>
      </div>
      <div class="analytics-dashboard-grid">
        ${section('Inventory health', 'Live stock and expiry', inventoryBody)}
        ${section('Customer demand', 'Searches and reservations', demandBody)}
        ${section('Operations', 'Reservation outcomes', operationsBody)}
        ${section('Product performance', 'Stock with no recent sales', productBody)}
      </div>
    `;

    document.getElementById('analytics-date-filter').addEventListener('submit', event => {
      event.preventDefault();
      const query = new URLSearchParams(new FormData(event.currentTarget));
      window.location.href = `${window.location.pathname}?${query.toString()}`;
    });
    document.getElementById('analytics-last-30').addEventListener('click', () => {
      const end = new Date();
      const start = new Date(end);
      start.setDate(start.getDate() - 29);
      const format = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      window.location.href = `${window.location.pathname}?start_date=${format(start)}&end_date=${format(end)}`;
    });
  }

  content.innerHTML = skeletonLoader('cards', 5);
  try {
    const startDate = params.get('start_date') || startDefault;
    const endDate = params.get('end_date') || endDefault;
    const data = await Api.get(`/api/pharmacy/analytics?start_date=${encodeURIComponent(startDate)}&end_date=${encodeURIComponent(endDate)}`);
    if (!data?.dateRange?.startDate || !data?.dateRange?.endDate
        || !data.sales || !data.inventory || !data.demand || !data.operations || !data.products) {
      throw new Error('The analytics API is out of date. Restart the PillPoint server to load the updated analytics endpoint, then refresh this page.');
    }
    render(data);
  } catch (error) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
  }
})();
