(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Reservations', 'Process reservation holds, pickup deadlines, and customer updates');
  if (!user) return;
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="card">
      <div class="filters-row">
        <div class="field">
          <label>Filter by status</label>
          <select id="status-filter">
            <option value="">All</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
            <option value="ready_for_pickup">Ready for Pickup</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
            <option value="expired">Expired</option>
          </select>
        </div>
      </div>
      <div id="list" class="table-wrap"></div>
    </div>
  `;
  const list = document.getElementById('list');
  const filter = document.getElementById('status-filter');
  const requestedStatus = new URLSearchParams(window.location.search).get('status');
  if (['pending', 'confirmed', 'ready_for_pickup', 'completed', 'cancelled', 'expired'].includes(requestedStatus)) filter.value = requestedStatus;
  let all = [];

  function actionsFor(r) {
    if (r.status === 'pending') return `
      <button class="btn btn-primary btn-sm act-btn" data-id="${r.id}" data-action="confirm">Confirm</button>
      <button class="btn btn-outline btn-sm act-btn" data-id="${r.id}" data-action="report-issue">Report Issue</button>
      <button class="btn btn-danger btn-sm act-btn" data-id="${r.id}" data-action="cancel">Reject / Cancel</button>`;
    if (r.status === 'confirmed') return `
      <button class="btn btn-primary btn-sm act-btn" data-id="${r.id}" data-action="ready">Mark Ready</button>
      <button class="btn btn-outline btn-sm act-btn" data-id="${r.id}" data-action="report-issue">Report Issue</button>
      <button class="btn btn-danger btn-sm act-btn" data-id="${r.id}" data-action="cancel">Reject / Cancel</button>`;
    if (r.status === 'ready_for_pickup') return `
      <button class="btn btn-primary btn-sm act-btn" data-id="${r.id}" data-action="picked-up">Mark Picked Up</button>
      <button class="btn btn-outline btn-sm act-btn" data-id="${r.id}" data-action="report-issue">Report Issue</button>
      <button class="btn btn-danger btn-sm act-btn" data-id="${r.id}" data-action="cancel">Cancel</button>`;
    return '';
  }

  function render() {
    const status = filter.value;
    const rows = status ? all.filter(r => r.status === status) : all;
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state"><h3>No reservations</h3><p>Nothing to show for this filter.</p></div>`;
      return;
    }
    list.innerHTML = `
      <table>
        <thead><tr><th>Customer</th><th>Medicine</th><th>Qty / Price</th><th>Reservation time</th><th>Action deadline</th><th>Stock impact</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>
                <strong>${escapeHtml(r.customer_name)}</strong>
                <div class="text-sm muted">Username: ${r.customer_username ? `@${escapeHtml(r.customer_username)}` : 'Not provided'}</div>
                <div class="text-sm muted">Email: ${escapeHtml(r.customer_email || 'Not provided')}</div>
                <div class="text-sm muted">Phone: ${escapeHtml(r.customer_phone || 'Not provided')}</div>
              </td>
              <td>${escapeHtml(r.medicine_name)}</td>
              <td>${r.quantity}<div class="text-sm muted">${money(r.price * r.quantity)} total</div></td>
              <td class="text-sm muted">${new Date(r.reserved_at).toLocaleString()}</td>
              <td class="text-sm muted">${r.expires_at ? `${r.status === 'pending' ? 'Confirm by ' : 'Pick up by '}${new Date(r.expires_at).toLocaleString()}` : '—'}</td>
              <td class="text-sm muted">${r.quantity} held for this reservation<div>${r.reserved_quantity} reserved · ${r.available_quantity} available of ${r.physical_stock}</div></td>
              <td>${r.status === 'ready_for_pickup' ? '<span class="badge badge-ready-for-pickup">Ready for Pickup</span>' : statusBadge(r.status)}</td>
              <td>${actionsFor(r)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
    document.querySelectorAll('.act-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'cancel' && !await appModal({ title: 'Cancel reservation?', message: 'The reserved units will be released and become available again.', confirmText: 'Cancel reservation', danger: true })) return;
        let endpoint = action;
        if (action === 'report-issue') {
          const issue = await appModal({ title: 'Report reservation issue', input: { label: 'Issue for the customer', value: '' }, confirmText: 'Send update' });
          if (!issue || !issue.trim()) return;
          endpoint = action;
          try {
            await Api.post(`/api/pharmacy/reservations/${btn.dataset.id}/${endpoint}`, { issue: issue.trim() });
            toast('Issue recorded and customer notified.');
            load();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        try {
          await Api.post(`/api/pharmacy/reservations/${btn.dataset.id}/${endpoint}`);
          toast('Reservation updated.');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  async function load() {
    try {
      const data = await Api.get('/api/pharmacy/reservations');
      all = data.reservations;
      render();
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  filter.addEventListener('change', render);
  load();
})();
