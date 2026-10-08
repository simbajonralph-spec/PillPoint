(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Alert Center', 'Actionable inventory, expiry, demand, and reservation alerts');
  if (!user) return;
  const content = document.getElementById('page-content');
  content.innerHTML = skeletonLoader('table', 5);

  const severityLabels = {
    critical: 'Critical',
    warning: 'Warning',
    information: 'Information',
  };

  try {
    const data = await Api.get('/api/pharmacy/alerts');
    const alerts = data.alerts || [];
    const counts = alerts.reduce((result, alert) => {
      result[alert.severity] = (result[alert.severity] || 0) + 1;
      return result;
    }, {});

    content.innerHTML = `
      <div class="grid grid-3 mb-16">
        <div class="card stat-card"><div class="stat-label">Critical</div><div class="stat-value" style="color:#b42318">${counts.critical || 0}</div></div>
        <div class="card stat-card"><div class="stat-label">Warnings</div><div class="stat-value" style="color:#b54708">${counts.warning || 0}</div></div>
        <div class="card stat-card"><div class="stat-label">Information</div><div class="stat-value">${counts.information || 0}</div></div>
      </div>
      <div class="card">
        <div class="flex justify-between items-center" style="gap:12px;flex-wrap:wrap;">
          <div><div class="card-title" style="margin:0;">Operational alerts</div><p class="text-sm muted mt-8">Each current condition appears once. Recent activity is tied to its reservation, stock transaction, or publishing record.</p></div>
          <button type="button" class="btn btn-outline btn-sm" id="refresh-alerts">Refresh</button>
        </div>
        ${alerts.length ? `
          <div class="table-wrap mt-12">
            <table>
              <thead><tr><th>Severity</th><th>Medicine / Alert</th><th>Date</th><th>Reason</th><th>Recommended action</th><th>Actions</th></tr></thead>
              <tbody>
                ${alerts.map(alert => `
                  <tr>
                    <td><span class="badge alert-severity-${escapeHtml(alert.severity)}">${escapeHtml(severityLabels[alert.severity] || alert.severity)}</span></td>
                    <td><strong>${escapeHtml(alert.medicine_name || alert.category)}</strong><div class="text-sm muted">${escapeHtml(alert.category)}</div></td>
                    <td class="text-sm muted">${alert.date ? escapeHtml(new Date(alert.date).toLocaleString()) : 'Current'}</td>
                    <td>${escapeHtml(alert.reason)}</td>
                    <td>${escapeHtml(alert.recommended_action)}</td>
                    <td><div class="flex gap-8" style="flex-wrap:wrap;">${(alert.actions || []).map(action => `
                      <a class="btn ${action.label === 'Restock' ? 'btn-primary' : 'btn-outline'} btn-sm" href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a>
                    `).join('')}</div></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state mt-16"><div class="icon">&#9989;</div><h3>No active alerts</h3><p>Inventory, expiry, demand, and recent operations have no items requiring attention.</p></div>`}
      </div>
    `;
    document.getElementById('refresh-alerts').addEventListener('click', () => window.location.reload());
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }
})();
