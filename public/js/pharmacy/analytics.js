(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Pharmacy Analytics', 'Sales, inventory health, customer demand, and operational performance');
  if (!user) return;

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
    return `<div class="card stat-card"><div class="stat-label">${escapeHtml(label)}</div><div class="stat-value">${escapeHtml(String(value))}</div>${note ? `<div class="text-sm muted mt-8">${escapeHtml(note)}</div>` : ''}</div>`;
  }

  function section(title, description, body) {
    return `<section class="mt-24"><div class="section-title">${escapeHtml(title)}</div>${description ? `<p class="text-sm muted mb-12">${escapeHtml(description)}</p>` : ''}${body}</section>`;
  }

  function table(headers, rows, emptyText = 'Insufficient data') {
    if (!rows.length) return `<div class="empty-state"><p>${escapeHtml(emptyText)}</p></div>`;
    return `<div class="table-wrap"><table><thead><tr>${headers.map(header => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  function simpleBars(rows, nameKey, valueKey, valueLabel, maximum = null) {
    if (!rows.length) return `<div class="empty-state"><p>Insufficient data</p></div>`;
    const max = maximum || Math.max(1, ...rows.map(row => Number(row[valueKey] || 0)));
    return `<div class="analytics-bars">${rows.map(row => {
      const value = Number(row[valueKey] || 0);
      const width = Math.max(value > 0 ? 2 : 0, Math.min(100, value / max * 100));
      return `<div class="analytics-bar-row"><div class="analytics-bar-heading"><span>${escapeHtml(String(row[nameKey]))}</span><strong>${escapeHtml(valueLabel(value))}</strong></div><div class="analytics-bar-track"><span style="width:${width}%"></span></div></div>`;
    }).join('')}</div>`;
  }

  function render(data) {
    const sales = data.sales;
    const inv = data.inventory;
    const operations = data.operations;
    const demand = data.demand;
    const products = data.products;
    const windowText = `${dateLabel(data.dateRange.startDate)} – ${dateLabel(data.dateRange.endDate)} (${number(data.dateRange.days)} days)`;

    const salesBody = `
      <div class="grid grid-3">
        ${metricCard('Revenue', sales.revenueSupported ? cash(sales.revenue) : 'Insufficient data', 'Completed reservations in selected range')}
        ${metricCard('Units sold', number(sales.unitsSold), 'Completed reservation quantities')}
        ${metricCard('Completed sales', number(sales.completedReservations))}
      </div>
      <div class="grid grid-3 mt-16">
        <div class="card"><div class="card-title">Daily sales</div>${table(['Date', 'Units sold', 'Revenue'], sales.daily.map(row => `<tr><td>${dateLabel(row.day)}</td><td>${number(row.units_sold)}</td><td>${cash(row.revenue)}</td></tr>`))}</div>
        <div class="card"><div class="card-title">Weekly sales</div>${table(['Week', 'Units sold', 'Revenue'], sales.weekly.map(row => `<tr><td>${escapeHtml(row.period)}</td><td>${number(row.units_sold)}</td><td>${cash(row.revenue)}</td></tr>`))}</div>
        <div class="card"><div class="card-title">Monthly sales</div>${table(['Month', 'Units sold', 'Revenue'], sales.monthly.map(row => `<tr><td>${escapeHtml(row.period)}</td><td>${number(row.units_sold)}</td><td>${cash(row.revenue)}</td></tr>`))}</div>
      </div>
      <div class="card mt-16"><div class="card-title">Daily units sold</div>${simpleBars(sales.daily, 'day', 'units_sold', number)}</div>
      <div class="card mt-16"><div class="card-title">Top-selling products</div>${table(['Medicine', 'Units sold', 'Revenue', 'Action'], products.topSelling.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.units_sold)}</td><td>${cash(row.revenue)}</td><td><a class="btn btn-outline btn-sm" href="/pharmacy/inventory.html?product_id=${row.inventory_id}">View Product</a></td></tr>`))}</div>
    `;

    const inventoryBody = `
      <p class="text-sm muted">Current inventory snapshot; these balances are not historical for the selected date range.</p>
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
      <div class="card mt-16"><div class="card-title">Recorded stock-out activity</div><p>${number(inv.stock_turnover.recorded_stock_out_transactions)} stock-out transactions in the selected date range. This count is not a turnover rate; historical average inventory is not stored.</p></div>
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
      <div class="card mt-16"><div class="card-title">Search and reservation relationship by medicine</div><p class="text-sm muted">${escapeHtml(demand.relationshipNote)}</p>${table(['Medicine', 'Searches', 'Units reserved'], demand.searchReservationRelationship.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.searches)}</td><td>${number(row.units_reserved)}</td></tr>`))}</div>
      <div class="card mt-16"><div class="card-title">Daily demand trend</div><p class="text-sm muted">Search events are counted when the pharmacy appears in the recorded search results; reservations are counted when placed.</p>${table(['Date', 'Searches', 'Reservations'], demand.trends.map(row => `<tr><td>${dateLabel(row.day)}</td><td>${number(row.searches)}</td><td>${number(row.reservations)}</td></tr>`))}</div>
    `;

    const operationsBody = `
      <div class="grid grid-4">
        ${metricCard('Reservation completion rate', percent(operations.completionRate), `${number(operations.completed)} completed / ${number(operations.reservationTotal)} reservations placed`)}
        ${metricCard('Cancellation rate', percent(operations.cancellationRate), `${number(operations.cancelled)} cancelled`)}
        ${metricCard('Expired reservation rate', percent(operations.expiredReservationRate), `${number(operations.expired)} expired`)}
        ${metricCard('Stock adjustments', number(operations.adjustmentFrequency), 'Adjustment transactions recorded')}
      </div>
      <p class="text-sm muted mt-12">Rates use reservations created within the selected date range as the denominator, including pending and confirmed reservations.</p>
    `;

    const productBody = `
      <div class="grid grid-2">
        <div class="card"><div class="card-title">Top-selling</div>${table(['Medicine', 'Units sold', 'Revenue'], products.topSelling.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.units_sold)}</td><td>${cash(row.revenue)}</td></tr>`))}</div>
        <div class="card"><div class="card-title">Slow-moving inventory</div><p class="text-sm muted">Products with physical stock but no completed sales recorded in the selected period.</p>${table(['Medicine', 'Physical units', 'Available units', 'Recorded sales'], products.slowMoving.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.stock_quantity)}</td><td>${number(row.available_quantity)}</td><td>${row.reason}</td></tr>`))}</div>
      </div>
      <div class="card mt-16"><div class="card-title">Frequently searched but unavailable</div>${table(['Medicine', 'Searches', 'Available', 'Action'], products.frequentlySearchedUnavailable.map(row => `<tr><td>${escapeHtml(row.medicine_name)}</td><td>${number(row.searches)}</td><td>${number(row.available_quantity)}</td><td><a class="btn btn-outline btn-sm" href="/pharmacy/inventory.html?product_id=${row.inventory_id}">View Product</a></td></tr>`))}</div>
    `;

    content.innerHTML = `
      <div class="card">
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
      ${section('1. Sales', 'Completed reservation sales; daily, weekly, and monthly values share the selected date range.', salesBody)}
      ${section('2. Inventory', 'Live stock health and expiry snapshot, with recorded movement activity for the selected date range.', inventoryBody)}
      ${section('3. Customer demand', 'Recorded medicine searches and reservations for this pharmacy; search events are not individually linked to reservations.', demandBody)}
      ${section('4. Operations', 'Reservation outcomes and stock adjustment activity for reservations created in the selected date range.', operationsBody)}
      ${section('5. Products', 'Sales performance, products without recorded sales, and searched medicines that currently have no available stock.', productBody)}
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
