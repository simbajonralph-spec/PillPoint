(async function () {
  const user = await guardPage(['customer'], 'Search Medicines', 'Find medicine availability and see nearby pharmacies on the map');
  if (!user) return;

  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="card fade-in-up" id="search-panel">
      <div class="filters-row">
        <div class="field grow">
          <label>Medicine name</label>
          <input type="text" id="q" placeholder="e.g. Paracetamol" />
        </div>
        <div class="field">
          <label>Category</label>
          <select id="category"><option value="">All categories</option></select>
        </div>
        <div class="field" style="align-self:flex-end;">
          <button class="btn btn-primary" id="search-btn">Search</button>
        </div>
      </div>
    </div>
    <div class="card mt-16" id="ai-search-panel">
      <div class="card-title">P.A.I. Smart Search</div>
      <div class="filters-row">
        <div class="field grow">
          <label>Ask PillPoint</label>
          <input type="text" id="pai-q" placeholder="Try: paracetamol or under 50" />
        </div>
        <div class="field" style="align-self:flex-end;">
          <button class="btn btn-secondary" id="pai-search-btn" type="button">AI Find</button>
        </div>
      </div>
      <div id="pai-results" class="mt-16"></div>
    </div>
    <div class="card mt-16" id="results-panel">
      <div class="card-title">Available Medicines</div>
      <div id="shortage-notice"></div>
      <div id="results" class="table-wrap"></div>
    </div>

    <div class="map-slide-region" id="map-region">
      <div class="section-title">Nearby Pharmacies With This Medicine</div>
      <div class="grid search-results-grid" style="gap:20px;">
        <div class="card">
          <div class="map-placeholder"><div id="leaflet-map"></div></div>
          <p class="text-sm muted mt-8">Map data &copy; OpenStreetMap contributors, rendered via Leaflet.js. Tap a pin for details.</p>
        </div>
        <div class="card">
          <div id="pharmacy-list"></div>
        </div>
      </div>
    </div>
  `;

  // ---------- Medicine search ----------
  const qInput = document.getElementById('q');
  const categorySelect = document.getElementById('category');
  const results = document.getElementById('results');
  const shortageNotice = document.getElementById('shortage-notice');
  const mapRegion = document.getElementById('map-region');
  let lastResults = [];

  async function runSearch(verifiedSearchData = null) {
    results.innerHTML = skeletonLoader('table', 3);
    try {
      let data = verifiedSearchData && Array.isArray(verifiedSearchData.results) ? verifiedSearchData : null;
      if (!data) {
        const params = new URLSearchParams({ q: qInput.value.trim(), category: categorySelect.value });
        data = await Api.get('/api/customer/medicines/search?' + params.toString());
      }
      lastResults = data.results;

      if (categorySelect.children.length === 1) {
        data.categories.forEach(c => {
          const opt = document.createElement('option');
          opt.value = c; opt.textContent = c;
          categorySelect.appendChild(opt);
        });
      }

      if (data.shortageMedicineIds?.length) {
        const names = [...new Set(data.results.filter(r => data.shortageMedicineIds.includes(r.medicine_id)).map(r => r.medicine_name))];
        shortageNotice.innerHTML = `<div class="alert alert-error mt-16">Shortage notice: ${escapeHtml(names.join(', '))} ${names.length > 1 ? 'are' : 'is'} currently out of stock at every pharmacy we track.</div>`;
      } else {
        shortageNotice.innerHTML = '';
      }

      if (!data.results.length) {
        results.innerHTML = `<div class="empty-state"><div class="icon">&#128269;</div><h3>No results</h3><p>Try a different medicine name or category.</p></div>`;
        mapRegion.classList.remove('open');
        return;
      }

      results.innerHTML = `
        <table>
          <thead><tr><th>Medicine</th><th>Pharmacy</th><th>Brand</th><th>Price</th><th>Stock</th><th>Status</th><th></th></tr></thead>
          <tbody>
            ${data.results.map(r => `
              <tr>
                <td>
                  <div style="font-weight:600">${escapeHtml(r.medicine_name)}</div>
                  <div class="text-sm muted">${escapeHtml(r.category || '')}</div>
                </td>
                <td>
                  <a href="/pharmacy-profile.html?id=${r.pharmacy_id}" style="color:inherit;text-decoration:none;">
                    <span style="font-weight:600;">${escapeHtml(r.pharmacy_name)}</span>
                  </a>
                  ${(r.verification_status || (r.verified ? 'VERIFIED' : 'PENDING')) === 'VERIFIED' ? '<span class="badge badge-verified" style="margin-left:6px;">Verified</span>' : ''}
                  <div class="text-sm muted">${r.average_rating ? `★ ${r.average_rating} · ${r.rating_count} rating${r.rating_count === 1 ? '' : 's'}` : 'Not yet rated'}</div>
                  <div class="text-sm muted">${escapeHtml(r.address)}</div>
                </td>
                <td class="text-sm muted">${escapeHtml(r.brand || '—')}</td>
                <td>${money(r.price)}</td>
                <td>${r.stock_quantity}</td>
                <td>${stockBadge(r.stock_quantity, r.low_stock_threshold)}</td>
                <td>
                  <button class="btn btn-primary btn-sm reserve-btn"
                    data-id="${r.inventory_id}" data-name="${escapeHtml(r.medicine_name)}" data-max="${r.stock_quantity}"
                    data-pharmacy="${escapeHtml(r.pharmacy_name)}" data-price="${r.price}"
                    ${r.stock_quantity === 0 ? 'disabled' : ''}>
                    Reserve
                  </button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      `;

      document.querySelectorAll('.reserve-btn').forEach(btn => btn.addEventListener('click', async () => {
        const price = Number(btn.dataset.price);
        const max = Number(btn.dataset.max);
        const quantity = await appModal({
          title: 'Reserve medicine',
          message: `${btn.dataset.name} at ${btn.dataset.pharmacy}`,
          quantity: { value: 1, max, unitPrice: price, hint: `${max} units available · ${money(price)} each` },
          confirmText: 'Place reservation',
        });
        if (quantity == null) return;
        try {
          await Api.post('/api/customer/reservations', { inventory_id: btn.dataset.id, quantity });
          toast('Reservation placed! Check "My Reservations" for status.');
          runSearch();
        } catch (err) { toast(err.message, 'error'); }
      }));

      // Slide the map up, focused on pharmacies that actually carry this medicine.
      mapRegion.classList.add('open');
      setTimeout(() => { showResultsOnMap(data.results); if (map) map.invalidateSize(); }, 60);
    } catch (err) {
      results.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  document.getElementById('search-btn').addEventListener('click', runSearch);
  categorySelect.addEventListener('change', runSearch);
  qInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });

  async function runPaiSearch() {
    const prompt = document.getElementById('pai-q').value.trim();
    const paiResults = document.getElementById('pai-results');
    if (!prompt) {
      paiResults.innerHTML = '<div class="alert alert-error">Please enter a medicine name or search phrase.</div>';
      return;
    }

    paiResults.innerHTML = '<div class="alert alert-info">Searching verified medicines...</div>';

    try {
      const data = await Api.get('/api/pai/search?q=' + encodeURIComponent(prompt));
      if (data.type === 'suggestion') {
        paiResults.innerHTML = `
          <div class="alert alert-warning">${escapeHtml(data.message)}</div>
          <div class="flex gap-12 mt-12">
            ${(data.suggestions || []).map(item => `<button class="btn btn-secondary btn-sm pai-suggestion" type="button" data-name="${escapeHtml(item.name)}">${escapeHtml(item.name)}</button>`).join('')}
          </div>
        `;
        paiResults.querySelectorAll('.pai-suggestion').forEach(button => button.addEventListener('click', () => {
          document.getElementById('pai-q').value = button.dataset.name;
          runPaiSearch();
        }));
        await runSearch({ results: [], categories: [], shortageMedicineIds: [] });
        return;
      }

      const watchAction = data.can_watch && data.medicine_id
        ? `<button class="btn btn-outline btn-sm mt-12" id="pai-watch-btn" type="button">Notify me when available</button>`
        : '';
      paiResults.innerHTML = `<div class="alert ${data.results?.length ? 'alert-info' : 'alert-warning'}">${escapeHtml(data.message)}</div>${watchAction}`;

      if (data.medicine_name) qInput.value = data.medicine_name;
      categorySelect.value = '';
      await runSearch(data);

      const watchButton = document.getElementById('pai-watch-btn');
      if (watchButton) {
        watchButton.addEventListener('click', async () => {
          watchButton.disabled = true;
          try {
            const watch = await Api.post('/api/pai/availability-watch', {
              medicine_id: data.medicine_id,
              pharmacy_id: data.pharmacy_id || null,
            });
            paiResults.innerHTML = `<div class="alert alert-success">${escapeHtml(watch.message)}</div>`;
          } catch (err) {
            watchButton.disabled = false;
            paiResults.insertAdjacentHTML('beforeend', `<div class="alert alert-error mt-12">${escapeHtml(err.message)}</div>`);
          }
        });
      }
    } catch (err) {
      paiResults.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  document.getElementById('pai-search-btn').addEventListener('click', runPaiSearch);
  document.getElementById('pai-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') runPaiSearch(); });

  // ---------- Map ----------
  const list = document.getElementById('pharmacy-list');
  let map, markers = [];
  let userLoc = null;

  function initMap() {
    map = L.map('leaflet-map').setView([8.9475, 125.5406], 13);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
  }

  function distanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function markerPopupHtml(r) {
    const dist = userLoc ? `${distanceKm(userLoc.lat, userLoc.lng, r.latitude, r.longitude).toFixed(1)} km away` : '';
    return `
      <div style="min-width:190px;">
        ${r.store_image ? `<img src="${r.store_image}" style="width:100%;height:80px;object-fit:cover;border-radius:6px;margin-bottom:6px;" />` : ''}
        ${r.cover_image ? `<img src="${escapeHtml(r.cover_image)}" style="width:100%;height:80px;object-fit:cover;border-radius:6px;margin-bottom:6px;" alt="" />` : ''}
        <div style="display:flex;align-items:center;gap:8px;">
          ${r.profile_image || r.store_image ? `<img src="${escapeHtml(r.profile_image || r.store_image)}" style="width:36px;height:36px;object-fit:cover;border-radius:50%;" alt="" />` : ''}
          <div style="font-weight:700;">${escapeHtml(r.pharmacy_name)}</div>
        </div>
        <div style="font-size:12px;color:#64748B;">${escapeHtml(r.address)}</div>
        ${dist ? `<div style="font-size:12px;font-weight:600;color:#0F766E;margin-top:4px;">${dist}</div>` : ''}
        <div style="font-size:12px;margin-top:4px;">${escapeHtml(r.medicine_name)}: <strong>${money(r.price)}</strong> (${r.stock_quantity} in stock)</div>
        <a href="/pharmacy-profile.html?id=${r.pharmacy_id}" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:700;color:#14B8A6;">View Profile &rarr;</a>
      </div>
    `;
  }

  function showResultsOnMap(rows) {
    markers.forEach(m => map.removeLayer(m));
    markers = [];

    // One marker per pharmacy (a pharmacy may appear multiple times if it stocks
    // several matching rows — keep only its cheapest offer for the marker/list).
    const byPharmacy = {};
    rows.forEach(r => {
      if (!byPharmacy[r.pharmacy_id] || r.price < byPharmacy[r.pharmacy_id].price) byPharmacy[r.pharmacy_id] = r;
    });
    const pharmacyRows = Object.values(byPharmacy);
    pharmacyRows.sort((a, b) => (b.average_rating || 0) - (a.average_rating || 0)
      || (userLoc ? distanceKm(userLoc.lat, userLoc.lng, a.latitude, a.longitude) - distanceKm(userLoc.lat, userLoc.lng, b.latitude, b.longitude) : 0));
    const topRatedId = pharmacyRows.find(r => r.average_rating > 0)?.pharmacy_id;

    list.innerHTML = `${topRatedId ? '<div class="alert alert-success text-sm">Top rated pharmacy</div>' : ''}${pharmacyRows.map(r => `
      <a href="/pharmacy-profile.html?id=${r.pharmacy_id}" class="pharmacy-list-card">
        <div class="pharmacy-card-cover">${r.cover_image ? `<img src="${escapeHtml(r.cover_image)}" alt="" />` : `<div class="pharmacy-card-cover-fallback">${escapeHtml(r.pharmacy_name)}</div>`}</div>
        <div class="pharmacy-card-body">
          <div class="pharmacy-card-heading">
            <div class="pharmacy-avatar-small">${(r.profile_image || r.store_image) ? `<img src="${escapeHtml(r.profile_image || r.store_image)}" alt="" />` : `<span class="pharmacy-avatar-name">${escapeHtml(r.pharmacy_name)}</span>`}</div>
            <div class="pharmacy-card-name"><strong>${escapeHtml(r.pharmacy_name)}</strong><span class="text-sm muted">${(r.verification_status || (r.verified ? 'VERIFIED' : 'PENDING')) === 'VERIFIED' ? 'Verified' : 'Pending verification'}</span></div>
            ${r.pharmacy_id === topRatedId ? '<span class="badge badge-available">Top rated</span>' : ''}
          </div>
          <div class="pharmacy-card-rating">
            <span class="review-stars">${'★'.repeat(Math.round(r.average_rating || 0))}${'☆'.repeat(5 - Math.round(r.average_rating || 0))}</span>
            <strong>${r.average_rating || '—'}</strong>
            <span class="text-sm muted">${r.rating_count} review${r.rating_count === 1 ? '' : 's'}</span>
          </div>
          <p class="pharmacy-card-description">${escapeHtml(r.description || `${r.medicine_name} available for reservation`)}</p>
          <div class="text-sm muted">${escapeHtml(r.address)}</div>
          <div class="pharmacy-card-meta"><span>${escapeHtml(r.pharmacy_status || 'Available')}</span>${userLoc ? `<span>${distanceKm(userLoc.lat, userLoc.lng, r.latitude, r.longitude).toFixed(1)} km away</span>` : ''}</div>
        </div>
      </a>
    `).join('')}`;

    const bounds = [];
    pharmacyRows.forEach(r => {
      const marker = L.marker([r.latitude, r.longitude]).addTo(map).bindPopup(markerPopupHtml(r));
      markers.push(marker);
      bounds.push([r.latitude, r.longitude]);
    });
    if (userLoc) bounds.push([userLoc.lat, userLoc.lng]);
    if (bounds.length) map.fitBounds(bounds, { padding: [30, 30], maxZoom: 15 });
  }

  initMap();

  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        userLoc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        map.setView([userLoc.lat, userLoc.lng], 14);
        L.circleMarker([userLoc.lat, userLoc.lng], { color: '#14B8A6', radius: 8 }).addTo(map).bindPopup('You are here');
        if (lastResults.length) showResultsOnMap(lastResults);
      },
      () => { /* user denied location — map still centers on the city default */ }
    );
  }

  runSearch();
})();
