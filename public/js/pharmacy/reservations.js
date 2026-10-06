(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Reservations', 'Confirm, complete, or cancel customer reservations');
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
  if (['pending', 'confirmed', 'completed', 'cancelled', 'expired'].includes(requestedStatus)) filter.value = requestedStatus;
  let all = [];

  function actionsFor(r) {
    if (r.status === 'pending') return `
      <button class="btn btn-primary btn-sm act-btn" data-id="${r.id}" data-action="confirm">Confirm</button>
      <button class="btn btn-danger btn-sm act-btn" data-id="${r.id}" data-action="cancel">Cancel</button>`;
    if (r.status === 'confirmed') return `
      <button class="btn btn-primary btn-sm act-btn" data-id="${r.id}" data-action="complete">Mark Picked Up</button>
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
        <thead><tr><th>Customer contact</th><th>Medicine</th><th>Qty</th><th>Reserved</th><th>Status</th><th></th></tr></thead>
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
              <td>${r.quantity}</td>
              <td class="text-sm muted">${new Date(r.reserved_at).toLocaleString()}</td>
              <td>${statusBadge(r.status)}</td>
              <td>${actionsFor(r)}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
    document.querySelectorAll('.act-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        if (action === 'cancel' && !await appModal({ title: 'Cancel reservation?', message: 'The reserved units will be released and become available again.', confirmText: 'Cancel reservation', danger: true })) return;
        try {
          await Api.post(`/api/pharmacy/reservations/${btn.dataset.id}/${action}`);
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
