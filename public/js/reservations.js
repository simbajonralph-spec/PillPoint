(async function () {
  const user = await guardPage(['customer'], 'My Reservations', 'Track and manage your medicine reservations');
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
  let all = [];

  function render() {
    const status = filter.value;
    const rows = status ? all.filter(r => r.status === status) : all;
    if (!rows.length) {
      list.innerHTML = `<div class="empty-state"><div class="icon">&#128203;</div><h3>No reservations</h3><p>Nothing to show for this filter.</p></div>`;
      return;
    }
    list.innerHTML = `
      <table>
        <thead><tr><th>Medicine</th><th>Pharmacy</th><th>Qty</th><th>Amount Due</th><th>Reserved</th><th>Expires</th><th>Status</th><th></th></tr></thead>
        <tbody>
          ${rows.map(r => `
            <tr>
              <td>${escapeHtml(r.medicine_name)}</td>
              <td>${escapeHtml(r.pharmacy_name)}</td>
              <td>${r.quantity}</td>
              <td><strong>${money(r.price * r.quantity)}</strong><div class="text-sm muted">${money(r.price)} each</div></td>
              <td class="text-sm muted">${new Date(r.reserved_at).toLocaleString()}</td>
              <td class="text-sm muted">${r.expires_at ? new Date(r.expires_at).toLocaleDateString() : '—'}</td>
              <td>${statusBadge(r.status)}</td>
              <td>
                ${['pending', 'confirmed'].includes(r.status)
                  ? `<button class="btn btn-danger btn-sm cancel-btn" data-id="${r.id}">Cancel</button>`
                  : r.status === 'completed'
                    ? (r.customer_rating
                      ? `<span class="text-sm" aria-label="Rated ${r.customer_rating} out of 5">${'★'.repeat(r.customer_rating)}${'☆'.repeat(5 - r.customer_rating)}</span>`
                      : `<div class="rating-control"><select class="rating-select" aria-label="Rate ${escapeHtml(r.pharmacy_name)}"><option value="">Rate</option><option value="5">5 stars</option><option value="4">4 stars</option><option value="3">3 stars</option><option value="2">2 stars</option><option value="1">1 star</option></select><button class="btn btn-outline btn-sm rate-btn" data-pharmacy="${r.pharmacy_id}">Send</button></div>`)
                    : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    `;
    document.querySelectorAll('.cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await appModal({ title: 'Cancel reservation?', message: 'The reserved units will be released and become available again.', confirmText: 'Cancel reservation', danger: true })) return;
        try {
          await Api.post(`/api/customer/reservations/${btn.dataset.id}/cancel`);
          toast('Reservation cancelled.');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    document.querySelectorAll('.rate-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const rating = btn.parentElement.querySelector('.rating-select').value;
        if (!rating) { toast('Choose a rating first.', 'error'); return; }
        try {
          await Api.post(`/api/customer/pharmacies/${btn.dataset.pharmacy}/rating`, { rating: Number(rating) });
          toast('Thank you for rating this pharmacy.');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  async function load() {
    try {
      const data = await Api.get('/api/customer/reservations');
      all = data.reservations;
      render();
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  filter.addEventListener('change', render);
  load();
})();
