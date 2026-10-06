// layout.js — builds the role-aware sidebar + topbar app shell

const NAV = {
  customer: [
    { href: '/dashboard.html', label: 'Dashboard', icon: 'home' },
    { href: '/search.html', label: 'Search & Nearby', icon: 'search' },
    { href: '/reservations.html', label: 'My Reservations', icon: 'clipboard' },
    { href: '/notifications.html', label: 'Notifications', icon: 'bell' },
    { href: '/profile.html', label: 'Profile', icon: 'user' },
  ],
  pharmacy_staff: [
    { href: '/pharmacy/dashboard.html', label: 'Dashboard', icon: 'home' },
    { href: '/pharmacy/inventory.html', label: 'My Inventory', icon: 'pill' },
    { href: '/pharmacy/reservations.html', label: 'Reservations', icon: 'clipboard' },
    { href: '/pharmacy/alerts.html', label: 'Stock Alerts', icon: 'triangle' },
    { href: '/pharmacy/analytics.html', label: 'Analytics', icon: 'chart' },
    { href: '/pharmacy/sales.html', label: 'Sales History', icon: 'chart' },
    { href: '/notifications.html', label: 'Notifications', icon: 'bell' },
    { href: '/profile.html', label: 'Pharmacy Profile', icon: 'building' },
  ],
  admin: [
    { href: '/admin/dashboard.html', label: 'Dashboard', icon: 'home' },
    { href: '/admin/pharmacies.html', label: 'Manage Pharmacies', icon: 'building' },
    { href: '/admin/inventory.html', label: 'Inventory Monitoring', icon: 'pill' },
    { href: '/admin/shortages.html', label: 'Shortages', icon: 'triangle' },
    { href: '/admin/audit-logs.html', label: 'Audit Logs', icon: 'clipboard' },
    { href: '/notifications.html', label: 'Notifications', icon: 'bell' },
    { href: '/profile.html', label: 'Profile', icon: 'user' },
  ],
};

function buildShell(user, pageTitle, pageSub) {
  const items = NAV[user.role] || [];
  const path = window.location.pathname;
  const navHtml = items.map(i => `
    <a href="${i.href}" class="${path === i.href ? 'active' : ''}">
      <span class="icon">${iconSvg(i.icon)}</span>${i.label}
    </a>`).join('');

  document.body.insertAdjacentHTML('afterbegin', `
    <div class="app-shell" id="app-shell">
      <aside class="sidebar" id="app-sidebar" aria-label="Main navigation">
        <div class="brand">
          <img src="/img/logo-mark.svg" alt="PillPoint" class="brand-badge" width="34" height="34" />
          <div class="brand-name">PillPoint</div>
        </div>
        <nav>${navHtml}</nav>
        <div class="divider"></div>
        <button type="button" class="sidebar-logout" id="logout-link">
          <span class="icon">${iconSvg('logout')}</span>Logout
        </button>
        <div class="user-box">
          <div class="user-name">${escapeHtml(user.role === 'pharmacy_staff' ? (user.pharmacy_name || user.name) : user.name)}</div>
          <div class="user-role">${escapeHtml(user.role.replace('_', ' '))}</div>
        </div>
      </aside>
      <button type="button" class="nav-scrim" id="nav-scrim" aria-label="Close navigation" tabindex="-1"></button>
      <div class="main">
        <div class="topbar">
          <button type="button" class="menu-toggle" id="menu-toggle" aria-label="Open navigation" aria-expanded="false" aria-controls="app-sidebar">
            ${iconSvg('menu')}
          </button>
          <div class="topbar-heading">
            <h1>${pageTitle}</h1>
            ${pageSub ? `<div class="sub">${pageSub}</div>` : ''}
          </div>
          <div class="topbar-actions">
            <a class="topbar-icon" href="/notifications.html" aria-label="Notifications" title="Notifications">
              ${iconSvg('bell')}<span class="notification-count" id="topbar-notification-count" hidden></span>
            </a>
            ${user.role === 'pharmacy_staff' ? `
            <a class="topbar-pharmacy-profile" id="topbar-pharmacy-profile" href="/profile.html" aria-label="Open ${escapeHtml(user.pharmacy_name || user.name)} Pharmacy Profile">
              <span class="topbar-profile-avatar">${user.pharmacy_profile_image ? `<img src="${escapeHtml(user.pharmacy_profile_image)}" alt="" />` : '<span aria-hidden="true">Rx</span>'}</span>
              <span class="topbar-user-name">${escapeHtml(user.pharmacy_name || user.name)}</span>
            </a>` : `<div class="topbar-user">
              <button type="button" class="topbar-profile-toggle" id="topbar-user-toggle" aria-label="Open user menu" aria-haspopup="menu" aria-expanded="false" aria-controls="topbar-user-menu">
                <span class="topbar-profile-avatar">${user.profile_image ? `<img src="${escapeHtml(user.profile_image)}" alt="" />` : iconSvg('user', 18)}</span>
                <span class="topbar-user-name">${escapeHtml(user.name)}</span>
              </button>
              <div class="topbar-user-menu" id="topbar-user-menu" role="menu" hidden>
                <a href="/profile.html" role="menuitem">${iconSvg('user', 16)}Profile</a>
                <button type="button" id="topbar-logout" role="menuitem">${iconSvg('logout', 16)}Log out</button>
              </div>
            </div>`}
          </div>
        </div>
        <div class="content" id="page-content"></div>
      </div>
    </div>
  `);

  async function logout(e) {
    e.preventDefault();
    await Api.post('/api/auth/logout');
    window.location.href = '/login.html';
  }
  document.getElementById('logout-link').addEventListener('click', logout);
  const topbarLogout = document.getElementById('topbar-logout');
  if (topbarLogout) topbarLogout.addEventListener('click', logout);

  const shell = document.getElementById('app-shell');
  const sidebar = document.getElementById('app-sidebar');
  const main = shell.querySelector('.main');
  const menuToggle = document.getElementById('menu-toggle');
  const userToggle = document.getElementById('topbar-user-toggle');
  const userMenu = document.getElementById('topbar-user-menu');
  const setDrawerOpen = open => {
    shell.classList.toggle('nav-open', open);
    document.body.classList.toggle('nav-open', open);
    menuToggle.setAttribute('aria-expanded', String(open));
    const mobile = window.matchMedia('(max-width: 800px)').matches;
    sidebar.inert = mobile && !open;
    sidebar.setAttribute('aria-hidden', String(mobile && !open));
    main.inert = mobile && open;
    if (open) sidebar.querySelector('nav a')?.focus();
  };
  setDrawerOpen(false);
  window.addEventListener('resize', () => {
    const open = shell.classList.contains('nav-open') && window.matchMedia('(max-width: 800px)').matches;
    setDrawerOpen(open);
  });
  menuToggle.addEventListener('click', () => setDrawerOpen(!shell.classList.contains('nav-open')));
  document.getElementById('nav-scrim').addEventListener('click', () => {
    setDrawerOpen(false);
    menuToggle.focus();
  });
  if (userToggle && userMenu) {
    userToggle.addEventListener('click', () => {
      const open = userMenu.hidden;
      userMenu.hidden = !open;
      userToggle.setAttribute('aria-expanded', String(open));
    });
  }
  document.addEventListener('click', event => {
    if (!event.target.closest('.topbar-user')) {
      if (!userMenu || !userToggle) return;
      userMenu.hidden = true;
      userToggle.setAttribute('aria-expanded', 'false');
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Tab' && shell.classList.contains('nav-open')) {
      const focusable = [...sidebar.querySelectorAll('a[href], button:not(:disabled)')];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    if (event.key === 'Escape') {
      if (shell.classList.contains('nav-open')) {
        setDrawerOpen(false);
        menuToggle.focus();
      }
      if (userMenu && userToggle) {
        userMenu.hidden = true;
        userToggle.setAttribute('aria-expanded', 'false');
      }
    }
  });

  document.addEventListener('pillpoint:notifications-updated', (event) => {
    updateNotificationBadge(event.detail);
  });
  Api.get('/api/notifications').then(data => {
    updateNotificationBadge(data.notifications);
  }).catch(() => {});
  setInterval(() => {
    Api.get('/api/notifications').then(data => {
      updateNotificationBadge(data.notifications);
    }).catch(() => {});
  }, 30000);
}

function updateNotificationBadge(notifications) {
  const count = document.getElementById('topbar-notification-count');
  if (!count) return;
  const unread = notifications.filter(notification => !notification.is_read).length;
  count.textContent = unread;
  count.hidden = unread === 0;
  count.parentElement.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
}

// Guards a page: redirects to login if not authenticated, or to the correct
// dashboard if authenticated with a different role. Returns the user object.
async function guardPage(allowedRoles, pageTitle, pageSub) {
  let data;
  try {
    data = await Api.get('/api/auth/me');
  } catch (e) {
    window.location.href = '/login.html';
    return null;
  }
  if (!data.user) {
    window.location.href = '/login.html';
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(data.user.role)) {
    window.location.href = roleHome(data.user.role);
    return null;
  }
  buildShell(data.user, pageTitle, pageSub);
  return data.user;
}

function roleHome(role) {
  if (role === 'pharmacy_staff') return '/pharmacy/dashboard.html';
  if (role === 'admin') return '/admin/dashboard.html';
  return '/dashboard.html';
}
