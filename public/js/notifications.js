(async function () {
  const user = await guardPage(null, 'Notifications', 'Application and email-logged notifications');
  if (!user) return;

  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="flex justify-between items-center mt-8">
      <div class="notification-filters">
        <label class="text-sm" for="status-filter">Show</label>
        <select id="status-filter"><option value="all">All notifications</option><option value="unread">Unread</option><option value="read">Read</option></select>
        <select id="type-filter"><option value="all">All types</option></select>
      </div>
      <button class="btn btn-outline btn-sm" id="mark-all">Mark all as read</button>
    </div>
    <div id="list" class="mt-16"></div>
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
    if (!visible.length) {
      list.innerHTML = `<div class="empty-state"><div class="icon">&#128276;</div><h3>No notifications</h3><p>Nothing matches this filter.</p></div>`;
      return;
    }
    list.innerHTML = visible.map(n => `
      <div class="card" style="margin-bottom:12px; ${n.is_read ? '' : 'border-left:4px solid var(--teal);'}">
        <div class="flex justify-between items-center">
          <div style="font-weight:700">${escapeHtml(n.title)}</div>
          <div class="text-sm muted">${new Date(n.created_at).toLocaleString()}</div>
        </div>
        <p class="text-sm mt-8" style="color:var(--text)">${escapeHtml(n.message)}</p>
        ${n.is_read ? '' : `<button class="btn btn-outline btn-sm mt-16 read-btn" data-id="${n.id}">Mark as read</button>`}
      </div>
    `).join('');
    document.querySelectorAll('.read-btn').forEach(b => {
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
