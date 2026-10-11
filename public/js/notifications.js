(async function () {
  const user = await guardPage(null, 'Notifications', 'Application and email-logged notifications');
  if (!user) return;
  if (user.role === 'pharmacy_staff') document.body.classList.add('pharmacy-notifications-page');
  else if (user.role === 'customer') document.body.classList.add('customer-notifications-page');
  else if (user.role === 'admin') {
    document.body.classList.add('admin-notifications-page');
    document.getElementById('app-shell')?.classList.add('admin-notifications-shell');
  }

  const content = document.getElementById('page-content');
  content.innerHTML = `
    <section class="customer-notification-toolbar">
      <div class="notification-filters">
        <label for="status-filter">Show</label>
        <select id="status-filter"><option value="all">All notifications</option><option value="unread">Unread</option><option value="read">Read</option></select>
        <select id="type-filter" aria-label="Filter by notification type"><option value="all">All types</option></select>
      </div>
      <button class="btn btn-outline btn-sm" id="mark-all" type="button">Mark all as read</button>
    </section>
    <section class="customer-notification-feed">
      <header class="customer-notification-feed-heading"><div><h2>Recent updates</h2><p>Stay up to date with your reservations and account.</p></div><span id="notification-count">Loading notifications...</span></header>
      <div id="list" class="customer-notification-list"></div>
    </section>
  `;

  const list = document.getElementById('list');
  const statusFilter = document.getElementById('status-filter');
  const typeFilter = document.getElementById('type-filter');
  let notifications = [];

  function render() {
    const visible = notifications.filter(n => {
      const statusMatches = statusFilter.value === 'all' || (statusFilter.value === 'unread' ? !n.is_read : !!n.is_read);
      return statusMatches && (typeFilter.value === 'all' || n.type === typeFilter.value);
    });
    document.getElementById('notification-count').textContent = `${visible.length} shown · ${notifications.length} total`;
    document.getElementById('mark-all').disabled = !notifications.some(n => !n.is_read);
    if (!visible.length) {
      list.innerHTML = `<div class="customer-notification-empty"><img src="/icons/unread_notifications.png" alt="" /><h3>No notifications</h3><p>Nothing matches this filter.</p></div>`;
      return;
    }
    list.innerHTML = visible.map(n => `
      <article class="card notification-card ${n.is_read ? 'notification-read' : 'notification-unread'}">
        <span class="customer-notification-icon"><img src="/icons/unread_notifications.png" alt="" /></span>
        <div class="customer-notification-content">
          <div class="notification-card-heading">
            <div class="notification-title">${escapeHtml(n.title)}</div>
            <div class="text-sm muted notification-date">${new Date(n.created_at).toLocaleString()}</div>
          </div>
          <p class="text-sm mt-8 notification-message">${escapeHtml(n.message)}</p>
          ${n.is_read ? '' : `<button class="btn btn-outline btn-sm mt-16 read-btn" data-id="${n.id}">Mark as read</button>`}
        </div>
      </article>
    `).join('');    document.querySelectorAll('.read-btn').forEach(b => {
      b.addEventListener('click', async () => {
        try {
          await Api.post(`/api/notifications/${b.dataset.id}/read`);
          await load();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    });
  }

  let isLoading = false;
  async function load() {
    if (isLoading) return;
    isLoading = true;
    try {
      const data = await Api.get('/api/notifications');
      notifications = data.notifications;
      document.dispatchEvent(new CustomEvent('pillpoint:notifications-updated', { detail: notifications }));
      const selectedType = typeFilter.value;
      const knownTypes = [...new Set(notifications.map(n => n.type).filter(Boolean))];
      typeFilter.innerHTML = '<option value="all">All types</option>' + knownTypes.map(type => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`).join('');
      if (knownTypes.includes(selectedType)) typeFilter.value = selectedType;
      render();
    } catch (err) {
      list.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    } finally {
      isLoading = false;
    }
  }

  document.getElementById('mark-all').addEventListener('click', async () => {
    try {
      await Api.post('/api/notifications/read-all');
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  statusFilter.addEventListener('change', render);
  typeFilter.addEventListener('change', render);
  load();
  setInterval(load, 30000);
})();
