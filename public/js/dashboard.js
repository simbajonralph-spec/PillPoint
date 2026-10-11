(async function () {
  const user = await guardPage(['customer'], 'Dashboard', 'Your PillPoint overview');
  if (!user) return;

  const content = document.getElementById('page-content');
  content.innerHTML = skeletonLoader('cards', 4);

  try {
    const data = await Api.get('/api/customer/dashboard');
    const counts = {};
    data.statusCounts.forEach(s => counts[s.status] = s.count);
    const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 18 ? 'Good afternoon' : 'Good evening';
    content.innerHTML = `
      <section class="customer-welcome"><div><span class="customer-welcome-icon"><img class="customer-dashboard-image-icon" src="/icons/good_morning.png" alt="" /></span><div><h2>${greeting}, ${escapeHtml(data.user.name)}!</h2><p>Your health is our priority. Find the right medicine, nearby and hassle-free.</p></div></div></section>
      <section class="customer-stat-grid" aria-label="Reservation summary">
        <div class="customer-stat-card pending"><span class="customer-stat-icon"><img class="customer-dashboard-image-icon" src="/icons/pending.png" alt="" /></span><strong>Pending</strong><b>${counts.pending || 0}</b><small>No pending reservations</small></div>
        <div class="customer-stat-card confirmed"><span class="customer-stat-icon"><img class="customer-dashboard-image-icon" src="/icons/confirmed.png" alt="" /></span><strong>Confirmed</strong><b>${counts.confirmed || 0}</b><small>No confirmed reservations</small></div>
        <div class="customer-stat-card completed"><span class="customer-stat-icon"><img class="customer-dashboard-image-icon" src="/icons/completed.png" alt="" /></span><strong>Completed</strong><b>${counts.completed || 0}</b><small>No completed reservations</small></div>
        <div class="customer-stat-card notifications"><span class="customer-stat-icon"><img class="customer-dashboard-image-icon" src="/icons/unread_notifications.png" alt="" /></span><strong>Unread Notifications</strong><b>${data.unreadNotifications || 0}</b><small>${data.unreadNotifications ? `You have ${data.unreadNotifications} new notification${data.unreadNotifications === 1 ? '' : 's'}` : 'You are all caught up'}</small></div>
      </section>
      <div class="customer-dashboard-grid">
        <section class="card customer-map-card">
          <div class="customer-section-heading"><span class="customer-section-icon"><img class="customer-dashboard-image-icon" src="/icons/nearby_pharmacy.png" alt="" /></span><div><h2>Nearby Pharmacies</h2><p>Find trusted pharmacies near you and get your medicines faster.</p></div><a class="btn btn-outline" href="/search.html">View All <span class="customer-arrow" aria-hidden="true"></span></a></div>
          <div class="customer-map-frame"><div id="dashboard-map"></div></div>
        </section>
        <aside class="customer-dashboard-side">
          <section class="customer-medicine-cta"><span class="customer-cta-icon"><img class="customer-dashboard-image-icon" src="/icons/need_medicine.png" alt="" /></span><div><h2>Need Medicine?</h2><p>Search for a medicine, find nearby pharmacies, and reserve it before you go.</p><a class="customer-search-button" href="/search.html"><span class="customer-sprite sprite-search" aria-hidden="true"></span> Search Medicines <span class="customer-arrow" aria-hidden="true"></span></a></div></section>
          <section class="card customer-quick-actions"><h2><span class="customer-sprite sprite-lightning" aria-hidden="true"></span> Quick Actions</h2>
            <a href="/search.html"><i class="customer-sprite sprite-search"></i><span><strong>Search & Nearby</strong><small>Find medicines and nearby pharmacies</small></span><b class="customer-arrow" aria-hidden="true"></b></a>
            <a href="/reservations.html"><i class="customer-sprite sprite-clipboard"></i><span><strong>My Reservations</strong><small>View and manage your bookings</small></span><b class="customer-arrow" aria-hidden="true"></b></a>
            <a href="/notifications.html"><i class="customer-sprite sprite-bell"></i><span><strong>Notifications</strong><small>Check your latest updates</small></span><b class="customer-arrow" aria-hidden="true"></b></a>
            <a href="/profile.html"><i class="customer-sprite sprite-user"></i><span><strong>Profile</strong><small>Manage your account information</small></span><b class="customer-arrow" aria-hidden="true"></b></a>
          </section>
        </aside>
      </div>
      <section class="customer-health-banner"><span class="customer-health-mark"><img class="customer-dashboard-image-icon" src="/icons/quality_medicine_close_to_you.png" alt="" /></span><div><strong>Quality Medicines. Closer to You.</strong><p>PillPoint connects you with trusted pharmacies in your area,<br class="desktop-break"> so you can get the care you need, when you need it.</p></div><span class="customer-health-pulse"><img class="customer-dashboard-image-icon" src="/icons/health_made_easier.png" alt="" /></span><img class="customer-health-caption" src="/icons/health_made_easier_text.png?v=teal" alt="Health made easier" /></section>
      <section class="customer-secondary-content">
        <details class="card customer-reservations-details"><summary>Recent reservations <span>${data.recentReservations.length}</span></summary>${data.recentReservations.length ? `<div class="table-wrap"><table><thead><tr><th>Medicine</th><th>Qty</th><th>Pharmacy</th><th>Status</th><th>Reserved</th></tr></thead><tbody>${data.recentReservations.map(r => `<tr><td>${escapeHtml(r.medicine_name)}</td><td>${r.quantity}</td><td>${escapeHtml(r.pharmacy_name)}</td><td>${statusBadge(r.status)}</td><td class="muted text-sm">${new Date(r.reserved_at).toLocaleString()}</td></tr>`).join('')}</tbody></table></div>` : `<div class="empty-state"><h3>No reservations yet</h3><p>Search for a medicine and reserve it at a nearby pharmacy.</p></div>`}</details>

        <details class="card customer-pharmacy-details"><summary>Top rated pharmacies <span>${data.topRatedPharmacies.length}</span></summary>${data.topRatedPharmacies.length ? `<div class="top-rated-pharmacies">${data.topRatedPharmacies.map(pharmacy => `<a class="card top-rated-card" href="/pharmacy-profile.html?id=${pharmacy.id}"><div class="top-rated-avatar">${pharmacy.profile_image || pharmacy.cover_image ? `<img src="${escapeHtml(pharmacy.profile_image || pharmacy.cover_image)}" alt="" />` : '<span aria-hidden="true">Rx</span>'}</div><div class="top-rated-details"><strong>${escapeHtml(pharmacy.name)}</strong><span class="text-sm muted">${escapeHtml(pharmacy.address)}</span><span class="top-rated-score"><span class="customer-sprite sprite-star" aria-hidden="true"></span> ${pharmacy.average_rating} ratings</span></div></a>`).join('')}</div>` : '<p class="customer-empty-note">Verified pharmacy partners will appear here after customers leave ratings.</p>'}</details>
      </section>
    `;
    loadNearbyMap();
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }

  async function loadNearbyMap() {
    const map = L.map('dashboard-map').setView([8.9475, 125.5406], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    const render = async (location) => {
      const params = location ? `?lat=${location.lat}&lng=${location.lng}` : '';
      const result = await Api.get('/api/customer/pharmacies/nearby' + params);
      const bounds = [];
      result.pharmacies.forEach(pharmacy => {
        const marker = L.marker([pharmacy.latitude, pharmacy.longitude]).addTo(map);
        marker.bindPopup(`<strong>${escapeHtml(pharmacy.name)}</strong><br>${escapeHtml(pharmacy.address)}<br>${pharmacy.average_rating ? `★ ${pharmacy.average_rating} (${pharmacy.rating_count})` : 'Not yet rated'}`);
        bounds.push([pharmacy.latitude, pharmacy.longitude]);
      });
      if (bounds.length) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
      setTimeout(() => map.invalidateSize(), 50);
    };
    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(pos => render({ lat: pos.coords.latitude, lng: pos.coords.longitude }), () => render(null));
    } else render(null);
  }
})();
