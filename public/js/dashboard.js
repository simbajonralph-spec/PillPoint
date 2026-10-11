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
        <details class="card customer-assistant-details"><summary>Ask the PillPoint assistant</summary><div class="customer-assistant-form"><input id="pai-message" type="text" aria-label="Ask PillPoint" placeholder="Find a medicine or ask a question"/><button id="pai-submit" class="btn btn-primary" type="button">Ask</button></div><div id="pai-result" role="log" aria-live="polite"><div class="alert alert-info">How can I help you find a medicine or use PillPoint?</div></div></details>
        <details class="card customer-pharmacy-details"><summary>Top rated pharmacies <span>${data.topRatedPharmacies.length}</span></summary>${data.topRatedPharmacies.length ? `<div class="top-rated-pharmacies">${data.topRatedPharmacies.map(pharmacy => `<a class="card top-rated-card" href="/pharmacy-profile.html?id=${pharmacy.id}"><div class="top-rated-avatar">${pharmacy.profile_image || pharmacy.cover_image ? `<img src="${escapeHtml(pharmacy.profile_image || pharmacy.cover_image)}" alt="" />` : '<span aria-hidden="true">Rx</span>'}</div><div class="top-rated-details"><strong>${escapeHtml(pharmacy.name)}</strong><span class="text-sm muted">${escapeHtml(pharmacy.address)}</span><span class="top-rated-score"><span class="customer-sprite sprite-star" aria-hidden="true"></span> ${pharmacy.average_rating} ratings</span></div></a>`).join('')}</div>` : '<p class="customer-empty-note">Verified pharmacy partners will appear here after customers leave ratings.</p>'}</details>
      </section>
    `;
    bindPaiAssistant();
    loadNearbyMap();
  } catch (err) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
  }

  function bindPaiAssistant() {
    const input = document.getElementById('pai-message');
    const submit = document.getElementById('pai-submit');
    const resultBox = document.getElementById('pai-result');
    let lastAssistantResults = [];

    function reservationReview(item, quantity) {
      const startingQuantity = quantity || 1;
      const availableStock = Number(item.available_stock);
      document.getElementById('pai-reservation-confirmation')?.remove();
      resultBox.insertAdjacentHTML('beforeend', `
        <section class="card mt-12" id="pai-reservation-confirmation">
          <div class="card-title">Review reservation</div>
          <p>You are about to reserve <strong>${escapeHtml(item.medicine_name)}</strong> at
            <strong>${escapeHtml(item.pharmacy_name)}</strong> for ${money(item.price)} each.</p>
          <div class="field mt-12">
            <label for="pai-reservation-quantity">Quantity</label>
            <input id="pai-reservation-quantity" type="number" min="1" max="${availableStock}" value="${Number(startingQuantity)}" />
            <div class="text-sm muted">${availableStock} available (${Number(item.stock_quantity)} physical, ${Number(item.reserved_quantity)} reserved). Your reservation is not created until you confirm.</div>
          </div>
          <div class="flex gap-12 mt-12">
            <button class="btn btn-primary" id="pai-reservation-confirm" type="button">Confirm reservation</button>
            <button class="btn btn-outline" id="pai-reservation-cancel" type="button">Cancel</button>
          </div>
          <div id="pai-reservation-message" class="mt-12"></div>
        </section>
      `);

      document.getElementById('pai-reservation-cancel').addEventListener('click', () => {
        document.getElementById('pai-reservation-confirmation')?.remove();
      });
      document.getElementById('pai-reservation-confirm').addEventListener('click', async (event) => {
        const button = event.currentTarget;
        const quantityInput = document.getElementById('pai-reservation-quantity');
        const quantity = Number(quantityInput.value);
        const message = document.getElementById('pai-reservation-message');
        if (!Number.isInteger(quantity) || quantity < 1 || quantity > availableStock) {
          message.innerHTML = '<div class="alert alert-error">Enter a whole quantity within the currently listed stock.</div>';
          return;
        }

        button.disabled = true;
        try {
          await Api.post('/api/customer/reservations', { inventory_id: item.inventory_id, quantity });
          message.innerHTML = '<div class="alert alert-success">Reservation placed. Check My Reservations for its status.</div>';
          lastAssistantResults = [];
        } catch (err) {
          message.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
          button.disabled = false;
        }
      });
    }

    function renderListings(message, items, quantity = 1) {
      lastAssistantResults = items || [];
      resultBox.innerHTML = `
        <div class="alert alert-info">${escapeHtml(message)}</div>
        ${lastAssistantResults.length ? `<div class="mt-12">${lastAssistantResults.map((item, index) => `
          <article class="card" style="padding:12px 14px; margin-bottom:10px;">
            <div style="font-weight:700;">${escapeHtml(item.medicine_name)}</div>
            <div class="text-sm muted">${escapeHtml(item.pharmacy_name)} · ${escapeHtml(item.address)}</div>
            <div class="text-sm muted">${Number(item.available_stock)} available · ${Number(item.stock_quantity)} physical · ${Number(item.reserved_quantity)} reserved · ${escapeHtml(item.verification_status || 'VERIFIED')}</div>
            <div style="font-weight:700; margin-top:6px;">${money(item.price)}</div>
            <button class="btn btn-outline btn-sm mt-8 pai-review-reservation" type="button" data-index="${index}">Review reservation</button>
          </article>
        `).join('')}</div>` : ''}
      `;
      resultBox.querySelectorAll('.pai-review-reservation').forEach(button => {
        button.addEventListener('click', () => {
          const item = lastAssistantResults[Number(button.dataset.index)];
          if (item) reservationReview(item, quantity);
        });
      });
    }

    async function runAssistant() {
      const message = (input.value || '').trim();
      if (!message) {
        resultBox.innerHTML = '<div class="alert alert-error">Type a question or medicine name first.</div>';
        return;
      }

      resultBox.innerHTML = '<div class="empty-state" style="padding:20px;"><p class="text-sm">Checking PillPoint data…</p></div>';
      try {
        const response = await Api.post('/api/pai/assistant', {
          message,
          context_inventory_ids: lastAssistantResults.map(item => item.inventory_id),
        });
        const data = response.result;

        if (data.type === 'search_result' || data.type === 'already_available') {
          renderListings(data.message, data.results);
          return;
        }

        if (data.type === 'reservation_options') {
          if (data.results?.length) {
            renderListings(data.message, data.results, data.quantity);
          } else {
            lastAssistantResults = [];
            resultBox.innerHTML = `
              <div class="alert alert-warning">${escapeHtml(data.message)}</div>
              ${(data.can_watch && data.medicine_id) ? `<button class="btn btn-outline mt-12" type="button" id="pai-set-watch">Set availability alert</button>` : ''}
              ${(data.suggestions || []).map(item => `<button class="btn btn-secondary btn-sm pai-suggestion" type="button" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`).join(' ')}
            `;
            bindWatchButton(data);
            bindSuggestions();
          }
          return;
        }

        if (data.type === 'not_available' && data.can_watch && data.medicine_id) {
          lastAssistantResults = [];
          resultBox.innerHTML = `
            <div class="alert alert-warning">${escapeHtml(data.message)}</div>
            <button class="btn btn-outline mt-12" type="button" id="pai-set-watch">Notify me when available</button>
          `;
          bindWatchButton(data);
          return;
        }

        if (data.type === 'availability_watch_confirmation') {
          resultBox.innerHTML = `
            <div class="alert alert-info">${escapeHtml(data.message)}</div>
            <button class="btn btn-primary mt-12" type="button" id="pai-set-watch">Set availability alert</button>
          `;
          bindWatchButton(data);
          return;
        }

        if (data.type === 'reservation_options' || data.type === 'suggestion' || data.type === 'not_found') {
          resultBox.innerHTML = `
            <div class="alert alert-warning">${escapeHtml(data.message)}</div>
            <div class="flex gap-12 mt-12">
              ${(data.suggestions || []).map(item => `<button class="btn btn-secondary btn-sm pai-suggestion" type="button" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`).join('')}
            </div>
          `;
          bindSuggestions();
          return;
        }

        if (data.type === 'medicine_information') {
          const medicine = data.medicine || {};
          resultBox.innerHTML = `
            <div class="alert alert-info">${escapeHtml(data.message)}</div>
            ${medicine.description ? `<div class="card mt-12" style="padding:12px 14px;"><strong>${escapeHtml(medicine.name)}</strong>${medicine.category ? `<div class="text-sm muted">${escapeHtml(medicine.category)}</div>` : ''}<p class="mt-8">${escapeHtml(medicine.description)}</p></div>` : ''}
          `;
          return;
        }

        if (data.type === 'navigation') {
          resultBox.innerHTML = `
            <div class="alert alert-info">${escapeHtml(data.message)}</div>
            <div class="flex gap-12 mt-12">${(data.links || []).map(link => `
              <a class="btn btn-outline btn-sm" href="${['/search.html', '/reservations.html', '/notifications.html'].includes(link.href) ? link.href : '/'}">${escapeHtml(link.label)}</a>
            `).join('')}</div>
          `;
          return;
        }

        resultBox.innerHTML = `<div class="alert ${data.type === 'safety' ? 'alert-warning' : 'alert-info'}">${escapeHtml(data.message)}</div>`;
      } catch (err) {
        resultBox.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
      }
    }

    function bindSuggestions() {
      resultBox.querySelectorAll('.pai-suggestion').forEach(button => {
        button.addEventListener('click', () => {
          input.value = `Find ${button.dataset.name}`;
          runAssistant();
        });
      });
    }

    function bindWatchButton(data) {
      const button = document.getElementById('pai-set-watch');
      if (!button) return;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await Api.post('/api/pai/availability-watch', {
            medicine_id: data.medicine_id,
            pharmacy_id: data.pharmacy_id || null,
          });
          resultBox.innerHTML = `<div class="alert alert-success">${escapeHtml(result.message)}</div>`;
        } catch (err) {
          resultBox.insertAdjacentHTML('beforeend', `<div class="alert alert-error mt-12">${escapeHtml(err.message)}</div>`);
          button.disabled = false;
        }
      });
    }

    submit.addEventListener('click', runAssistant);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') runAssistant();
    });
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
