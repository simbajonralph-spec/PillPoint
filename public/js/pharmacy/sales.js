(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Sales History', 'Completed reservation sales by product and date');
  if (!user) return;

  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="card">
      <div class="filters-row">
        <div class="field">
          <label for="period-filter">Sales period</label>
          <select id="period-filter">
            <option value="7">Last 7 days</option>
            <option value="30" selected>Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="365">Last 12 months</option>
            <option value="all">All time</option>
          </select>
        </div>
      </div>
      <div id="summary" class="grid grid-2 mt-16"></div>
      <div class="section-title">Units sold by product line</div>
      <div id="product-totals" class="table-wrap"></div>
      <div class="section-title">Sales history by day</div>
      <div id="daily-sales" class="table-wrap"></div>
    </div>
  `;

  const periodFilter = document.getElementById('period-filter');
  const summary = document.getElementById('summary');
  const productTotals = document.getElementById('product-totals');
  const dailySales = document.getElementById('daily-sales');

  async function load() {
    productTotals.innerHTML = '<p class="muted">Loading sales history…</p>';
    dailySales.innerHTML = '';
    try {
      const data = await Api.get(`/api/pharmacy/sales-history?period=${periodFilter.value}`);
      const units = data.productTotals.reduce((total, product) => total + product.units_sold, 0);
      const revenue = data.productTotals.reduce((total, product) => total + product.revenue, 0);
      summary.innerHTML = `
        <article class="card stat-card"><div class="stat-label">Units sold</div><div class="stat-value">${units}</div></article>
        <article class="card stat-card"><div class="stat-label">Sales revenue</div><div class="stat-value">${money(revenue)}</div></article>
      `;

      productTotals.innerHTML = data.productTotals.length ? `
        <table>
          <thead><tr><th>Product line</th><th>Deployment</th><th>Units sold</th><th>Revenue</th><th>Last sale</th></tr></thead>
          <tbody>${data.productTotals.map(product => `
            <tr>
              <td><strong>${escapeHtml(product.medicine_name)}</strong>${product.brand ? `<div class="text-sm muted">${escapeHtml(product.brand)}</div>` : ''}</td>
              <td>${product.deployed ? 'Currently deployed' : 'Not currently deployed'}</td>
              <td>${product.units_sold}</td>
              <td>${money(product.revenue)}</td>
              <td class="text-sm muted">${product.last_sold_at ? new Date(product.last_sold_at).toLocaleString() : '—'}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      ` : '<div class="empty-state"><h3>No completed sales</h3><p>Completed reservation sales will appear here.</p></div>';

      dailySales.innerHTML = data.dailySales.length ? `
        <table>
          <thead><tr><th>Date</th><th>Product line</th><th>Units sold</th><th>Revenue</th></tr></thead>
          <tbody>${data.dailySales.map(sale => `
            <tr>
              <td>${escapeHtml(sale.sale_date)}</td>
              <td><strong>${escapeHtml(sale.medicine_name)}</strong>${sale.brand ? `<div class="text-sm muted">${escapeHtml(sale.brand)}</div>` : ''}</td>
              <td>${sale.units_sold}</td>
              <td>${money(sale.revenue)}</td>
            </tr>`).join('')}
          </tbody>
        </table>
      ` : '<p class="text-sm muted">No daily sales in this period.</p>';
    } catch (err) {
      summary.innerHTML = '';
      productTotals.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  periodFilter.addEventListener('change', load);
  load();
})();
