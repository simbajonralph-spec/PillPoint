(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Sales History', 'Completed reservation sales by product and date');
  if (!user) return;
  document.body.classList.add('pharmacy-sales-page');

  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="sales-history-workspace">
      <div class="card sales-period-card">
        <div class="sales-period-copy"><span class="sales-period-mark"></span><div><div class="sales-period-title">Sales overview</div><p>Review completed reservation sales across your selected period.</p></div></div>
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
      <div id="summary" class="grid grid-2 sales-summary-grid"></div>
      <section class="card sales-history-panel"><header class="sales-panel-heading"><div><h2>Units sold by product line</h2><p>Completed sales grouped by medicine and deployment status.</p></div><span class="sales-panel-icon">${iconSvg('chart', 20)}</span></header><div id="product-totals" class="table-wrap"></div></section>
      <section class="card sales-history-panel"><header class="sales-panel-heading"><div><h2>Sales history by day</h2><p>Daily product quantities and revenue.</p></div><span class="sales-panel-icon">${iconSvg('calendar', 20)}</span></header><div id="daily-sales" class="table-wrap"></div></section>
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
        <article class="card stat-card sales-summary-card" data-tone="teal"><span class="sales-summary-icon">${iconSvg('package', 22)}</span><div><div class="stat-label">Units sold</div><div class="stat-value">${units.toLocaleString()}</div><div class="sales-summary-note">Across the selected period</div></div></article>
        <article class="card stat-card sales-summary-card" data-tone="green"><span class="sales-summary-icon">${iconSvg('wallet', 22)}</span><div><div class="stat-label">Sales revenue</div><div class="stat-value">${money(revenue)}</div><div class="sales-summary-note">From completed reservations</div></div></article>
      `;

      const maxUnits = Math.max(1, ...data.productTotals.map(product => Number(product.units_sold || 0)));
      productTotals.innerHTML = data.productTotals.length ? `
        <table>
          <thead><tr><th>Product line</th><th>Deployment</th><th>Units sold</th><th>Revenue</th><th>Last sale</th></tr></thead>
          <tbody>${data.productTotals.map(product => `
            <tr>
              <td><strong>${escapeHtml(product.medicine_name)}</strong>${product.brand ? `<div class="text-sm muted">${escapeHtml(product.brand)}</div>` : ''}<span class="sales-product-track"><span style="width:${Math.max(2, Number(product.units_sold || 0) / maxUnits * 100)}%"></span></span></td>
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
