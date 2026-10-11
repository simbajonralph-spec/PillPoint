(async function () {
  const user = await guardPage(['customer'], 'Dashboard', 'Welcome back');
  if (!user) return;

  const content = document.getElementById('page-content');
  content.innerHTML = skeletonLoader('cards', 4);

  try {
    const data = await Api.get('/api/customer/dashboard');
    const counts = {};
    data.statusCounts.forEach(s => counts[s.status] = s.count);
    content.innerHTML = `
      <div class="card mt-8 card-hero" style="background:linear-gradient(135deg,var(--navy),#142234);color:#fff;border:none;">
        <h2 style="color:#fff;">Welcome back, ${escapeHtml(data.user.name)}</h2>
        <p class="mt-8" style="color:#a6b2c4;">Find medicine and manage your reservations.</p>
        <a href="/search.html" class="btn btn-primary mt-16" style="display:inline-flex;">Search Medicines</a>
      </div>

      <div class="grid grid-4 mt-24">
        <div class="card stat-card"><div class="stat-icon">&#9203;</div><div class="stat-label">Pending</div><div class="stat-value">${counts.pending || 0}</div></div>
        <div class="card stat-card"><div class="stat-icon">&#9989;</div><div class="stat-label">Confirmed</div><div class="stat-value">${counts.confirmed || 0}</div></div>
        <div class="card stat-card"><div class="stat-icon">&#128230;</div><div class="stat-label">Completed</div><div class="stat-value">${counts.completed || 0}</div></div>
        <div class="card stat-card"><div class="stat-icon">&#128276;</div><div class="stat-label">Unread Notifications</div><div class="stat-value">${data.unreadNotifications}</div></div>
      </div>

           <div class="mt-24">
        <div class="card-title" style="margin-top:0;">Recent Reservations</div>
        <div class="card">
          ${data.recentReservations.length ? `
            <div class="table-wrap">
              <table>
                <thead><tr><th>Medicine</th><th>Qty</th><th>Pharmacy</th><th>Status</th><th>Reserved</th></tr></thead>
                <tbody>
                  ${data.recentReservations.map(r => `
                    <tr>
                      <td>${escapeHtml(r.medicine_name)}</td>
                      <td>${r.quantity}</td>
                      <td>${escapeHtml(r.pharmacy_name)}</td>
                      <td>${statusBadge(r.status)}</td>
                      <td class="muted text-sm">${new Date(r.reserved_at).toLocaleString()}</td>
                    </tr>`).join('')}
                </tbody>
              </table>
            </div>
          ` : `
            <div class="empty-state">
              <div class="icon">&#128203;</div>
              <h3>No reservations yet</h3>
              <p>Search for a medicine and reserve it at a nearby pharmacy.</p>
            </div>
          `}
        </div>
      </div>

          

      <div class="section-title">Top Rated Pharmacies</div>
      ${data.topRatedPharmacies.length ? `
        <div class="top-rated-pharmacies">
          ${data.topRatedPharmacies.map(pharmacy => `
            <a class="card top-rated-card" href="/pharmacy-profile.html?id=${pharmacy.id}">
              <div class="top-rated-avatar">
                ${pharmacy.profile_image || pharmacy.cover_image
                  ? `<img src="${escapeHtml(pharmacy.profile_image || pharmacy.cover_image)}" alt="" />`
                  : '<span aria-hidden="true">Rx</span>'}
              </div>
              <div class="top-rated-details">
                <strong>${escapeHtml(pharmacy.name)}</strong>
                <span class="text-sm muted">${escapeHtml(pharmacy.address)}</span>
                <span class="top-rated-score"><span aria-hidden="true">${'★'.repeat(Math.round(pharmacy.average_rating))}</span> ${pharmacy.average_rating} · ${pharmacy.rating_count} rating${pharmacy.rating_count === 1 ? '' : 's'}</span>
              </div>
            </a>`).join('')}
        </div>
      ` : `
        <div class="card empty-state">
          <div class="icon">&#9733;</div>
          <p>Verified pharmacy partners will appear here after customers leave ratings.</p>
        </div>
      `}

      <div class="section-title">Nearby Pharmacies</div>
      <div class="card"><div class="map-placeholder"><div id="dashboard-map"></div></div></div>
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
