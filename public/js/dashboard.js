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

          

      <div class="card mt-24">
        <div class="card-title">P.A.I. Assistant</div>
        <div style="display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap;">
          <div class="field" style="flex:1;min-width:220px;">
            <label>Ask PillPoint</label>
            <input id="pai-message" type="text" placeholder="Try: Find paracetamol or reserve amoxicillin" style="min-width:0;" />
          </div>
          <button id="pai-submit" class="btn btn-primary" type="button">Ask</button>
        </div>
        <div id="pai-result" class="mt-16" role="log" aria-live="polite">
          <div class="alert alert-info">P.A.I. — Pharmacy Assistant: How can I help you find a medicine or use PillPoint?</div>
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
