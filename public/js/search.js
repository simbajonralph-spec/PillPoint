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
      <div class="flex gap-12" style="align-items:center;justify-content:space-between;flex-wrap:wrap;">
        <div class="section-title" style="margin:0;">Nearby Pharmacies With This Medicine</div>
        <div class="flex gap-12" style="align-items:center;">
          <span id="location-status" class="text-sm muted" role="status" aria-live="polite">Checking current location...</span>
          <button class="btn btn-outline btn-sm" id="locate-btn" type="button">Use current location</button>
        </div>
      </div>
      <div id="pharmacy-recommendations" class="pharmacy-recommendations"></div>
      <div class="grid search-results-grid" style="gap:20px;">
        <div class="card">
          <div class="map-placeholder"><div id="leaflet-map"></div></div>
          <p class="text-sm muted mt-8">Map data &copy; OpenStreetMap contributors, rendered via Leaflet.js. Tap a pin for details.</p>
          <div id="directions-status" class="text-sm muted mt-8" role="status" aria-live="polite">Select a pharmacy and choose Directions to see a road route.</div>
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
                <td>
                  <div>${Number(r.available_stock)} available</div>
                  <div class="text-sm muted">${Number(r.stock_quantity)} physical · ${Number(r.reserved_quantity)} reserved</div>
                </td>
                <td>${stockBadge(r.available_stock, r.low_stock_threshold)}</td>
                <td>
                  <button class="btn btn-primary btn-sm reserve-btn"data-max="${r.available_stock}"
                    data-id="${r.inventory_id}" data-debug-inventory="${r.inventory_id}" data-name="${escapeHtml(r.medicine_name)}" 
                    data-pharmacy="${escapeHtml(r.pharmacy_name)}" data-price="${r.price}"
                    ${r.available_stock === 0 ? 'disabled' : ''}>
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
  const locationStatus = document.getElementById('location-status');
  const locateButton = document.getElementById('locate-btn');
  let map, markers = [], userMarker, routeLayer, routeController;
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

  function distanceFromCustomer(pharmacy) {
    const latitude = Number(pharmacy.latitude);
    const longitude = Number(pharmacy.longitude);
    if (!userLoc || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    return distanceKm(userLoc.lat, userLoc.lng, latitude, longitude);
  }

  function operatingStatus(hours) {
    if (!hours) return { rank: 1, label: 'Hours not listed' };
    if (/24\s*hours|open\s*24\s*hours/i.test(hours)) return { rank: 2, label: 'Open now' };

    const dayIndexes = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const today = new Date().getDay();
    for (const segment of hours.replace(/[–—]/g, '-').split(',')) {
      const separator = segment.indexOf(':');
      if (separator < 0) continue;
      const daysText = segment.slice(0, separator).trim().toLowerCase();
      const timesText = segment.slice(separator + 1);
      if (/daily|every day|all days/.test(daysText)) {
        if (/closed/.test(timesText.toLowerCase())) return { rank: 0, label: 'Closed now' };
        const times = [...timesText.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi)];
        if (times.length < 2) continue;
        return getOpenRangeStatus(times);
      }

      let days = [...daysText.matchAll(/\b(sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)\b/g)]
        .map(match => dayIndexes[match[1].slice(0, 3)]);
      if (daysText.includes('-') && days.length >= 2) {
        const rangeDays = [];
        let day = days[0];
        while (rangeDays.length < 7) {
          rangeDays.push(day);
          if (day === days[1]) break;
          day = (day + 1) % 7;
        }
        days = rangeDays;
      }
      if (!days.length || !days.includes(today)) continue;
      if (/closed/.test(timesText.toLowerCase())) return { rank: 0, label: 'Closed now' };
      const times = [...timesText.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)/gi)];
      if (times.length < 2) continue;
      return getOpenRangeStatus(times);
    }
    return { rank: 1, label: 'Hours unclear' };
  }

  function getOpenRangeStatus(times) {
    function minutes(match) {
      let hour = Number(match[1]) % 12;
      if (match[3].toLowerCase() === 'pm') hour += 12;
      return hour * 60 + Number(match[2] || 0);
    }
    const opensAt = minutes(times[0]);
    const closesAt = minutes(times[1]);
    const now = new Date();
    const currentMinutes = now.getHours() * 60 + now.getMinutes();
    const isOpen = closesAt > opensAt
      ? currentMinutes >= opensAt && currentMinutes < closesAt
      : currentMinutes >= opensAt || currentMinutes < closesAt;
    return { rank: isOpen ? 2 : 0, label: isOpen ? 'Open now' : 'Closed now' };
  }

  function compareListings(a, b) {
    const statusDifference = operatingStatus(b.hours).rank - operatingStatus(a.hours).rank;
    if (statusDifference) return statusDifference;
    const distanceA = distanceFromCustomer(a);
    const distanceB = distanceFromCustomer(b);
    if (distanceA !== null && distanceB !== null && distanceA !== distanceB) return distanceA - distanceB;
    if (distanceA !== null && distanceB === null) return -1;
    if (distanceA === null && distanceB !== null) return 1;
    const ratingDifference = Number(b.average_rating || 0) - Number(a.average_rating || 0);
    if (ratingDifference) return ratingDifference;
    const stockDifference = Number(b.available_stock) - Number(a.available_stock);
    if (stockDifference) return stockDifference;
    return Number(a.price) - Number(b.price);
  }

  function getRecommendations(rows) {
    const eligibleRows = rows.filter(row =>
      row.verification_status === 'VERIFIED'
      && Number(row.deployed) === 1
      && Number(row.available_stock) > 0
    );
    const byMedicine = new Map();
    eligibleRows.forEach(row => {
      if (!byMedicine.has(row.medicine_id)) byMedicine.set(row.medicine_id, []);
      byMedicine.get(row.medicine_id).push(row);
    });
    return [...byMedicine.values()]
      .map(listings => listings.sort(compareListings)[0])
      .sort((a, b) => a.medicine_name.localeCompare(b.medicine_name));
  }

  async function reserveRecommendation(listing) {
    const max = Number(listing.available_stock);
    const quantity = await appModal({
      title: 'Reserve medicine',
      message: `${listing.medicine_name} at ${listing.pharmacy_name}`,
      quantity: { value: 1, max, unitPrice: Number(listing.price), hint: `${max} units available · ${money(listing.price)} each` },
      confirmText: 'Place reservation',
    });
    if (quantity == null) return;
    try {
      await Api.post('/api/customer/reservations', { inventory_id: listing.inventory_id, quantity });
      toast('Reservation placed! Check "My Reservations" for status.');
      qInput.value = listing.medicine_name;
      categorySelect.value = '';
      runSearch();
    } catch (err) { toast(err.message, 'error'); }
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
        <div style="font-size:12px;margin-top:4px;">${escapeHtml(r.medicine_name)}: <strong>${money(r.price)}</strong> (${r.available_stock} available)</div>
        <a href="/pharmacy-profile.html?id=${r.pharmacy_id}" style="display:inline-block;margin-top:8px;font-size:12px;font-weight:700;color:#14B8A6;">View Profile &rarr;</a>
      </div>
    `;
  }

  function clearRoute() {
    if (routeController) routeController.abort();
    routeController = null;
    if (routeLayer) map.removeLayer(routeLayer);
    routeLayer = null;
  }

  async function showDirections(pharmacy) {
    const status = document.getElementById('directions-status');
    const destinationLat = Number(pharmacy.latitude);
    const destinationLng = Number(pharmacy.longitude);
    if (!userLoc) {
      status.textContent = 'Your current location is unavailable. Allow location access and try again.';
      return;
    }
    if (!Number.isFinite(destinationLat) || !Number.isFinite(destinationLng)
      || Math.abs(destinationLat) > 90 || Math.abs(destinationLng) > 180) {
      status.textContent = `Directions unavailable: ${pharmacy.pharmacy_name} has no valid map coordinates.`;
      return;
    }

    clearRoute();
    const controller = new AbortController();
    routeController = controller;
    status.textContent = `Getting road directions to ${pharmacy.pharmacy_name}...`;
    const url = `https://router.project-osrm.org/route/v1/driving/${userLoc.lng},${userLoc.lat};${destinationLng},${destinationLat}?overview=full&geometries=geojson&steps=false`;
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) throw new Error('The routing service is unavailable.');
      const data = await response.json();
      const route = data.code === 'Ok' && data.routes?.[0];
      if (!route || !Array.isArray(route.geometry?.coordinates) || !route.geometry.coordinates.length) {
        status.textContent = `No road route was found to ${pharmacy.pharmacy_name}.`;
        return;
      }

      routeLayer = L.geoJSON(route.geometry, {
        style: { color: '#0F766E', weight: 6, opacity: 0.85 },
      }).addTo(map);
      map.fitBounds(routeLayer.getBounds(), { padding: [36, 36], maxZoom: 15 });
      const distance = `${(route.distance / 1000).toFixed(1)} km`;
      const duration = Number.isFinite(route.duration)
        ? ` · about ${Math.max(1, Math.round(route.duration / 60))} min`
        : '';
      status.textContent = `Road route to ${pharmacy.pharmacy_name}: ${distance}${duration}.`;
    } catch (error) {
      if (error.name === 'AbortError') return;
      status.textContent = 'Could not load road directions. Check your connection and try again.';
    } finally {
      if (routeController === controller) routeController = null;
    }
  }

  function showResultsOnMap(rows) {
    clearRoute();
    markers.forEach(m => map.removeLayer(m));
    markers = [];
    const recommendations = getRecommendations(rows);
    const recommendationPanel = document.getElementById('pharmacy-recommendations');
    recommendationPanel.innerHTML = recommendations.length ? `
      <div class="recommendation-heading">Recommended by medicine availability, operating status, distance, rating, stock, and price</div>
      <div class="recommendation-list">${recommendations.map((r, index) => {
        const distance = distanceFromCustomer(r);
        const open = operatingStatus(r.hours);
        return `
          <article class="recommendation-result">
            <div class="recommendation-result-heading">
              <strong>${escapeHtml(r.medicine_name)}</strong>
              <span class="badge badge-available">Recommended</span>
            </div>
            <div><strong>${escapeHtml(r.pharmacy_name)}</strong> · ${escapeHtml(r.address)}</div>
            <div class="text-sm muted">${money(r.price)} · ${Number(r.available_stock)} available · ${r.average_rating ? `★ ${r.average_rating} (${r.rating_count} ratings)` : 'Not yet rated'} · ${distance === null ? 'Distance unavailable' : `${distance.toFixed(1)} km away`}</div>
            <div class="text-sm muted">${escapeHtml(r.pharmacy_status || 'Medicine available')} · ${escapeHtml(open.label)} · ${escapeHtml(r.hours || 'Operating hours not listed')} · ${Number(r.latitude)}, ${Number(r.longitude)}</div>
            <div class="flex gap-8 mt-8">
              <button class="btn btn-primary btn-sm recommendation-reserve" type="button" data-index="${index}">Reserve</button>
              <button class="btn btn-outline btn-sm recommendation-directions" type="button" data-index="${index}">Directions</button>
            </div>
          </article>
        `;
      }).join('')}</div>
    ` : '<div class="text-sm muted mt-12">Search for a medicine with an available verified listing to see a pharmacy recommendation.</div>';
    recommendationPanel.querySelectorAll('.recommendation-reserve').forEach(button => {
      button.addEventListener('click', () => reserveRecommendation(recommendations[Number(button.dataset.index)]));
    });
    recommendationPanel.querySelectorAll('.recommendation-directions').forEach(button => {
      button.addEventListener('click', () => showDirections(recommendations[Number(button.dataset.index)]));
    });

    // One marker per pharmacy (a pharmacy may appear multiple times if it stocks
    // several matching rows — keep only its cheapest offer for the marker/list).
    const byPharmacy = {};
    rows.forEach(r => {
      if (!byPharmacy[r.pharmacy_id] || r.price < byPharmacy[r.pharmacy_id].price) byPharmacy[r.pharmacy_id] = r;
    });
    const pharmacyRows = Object.values(byPharmacy);
    pharmacyRows.sort(compareListings);

    list.innerHTML = `${pharmacyRows.map((r, index) => `
      <div class="pharmacy-list-card">
        <a href="/pharmacy-profile.html?id=${r.pharmacy_id}" class="pharmacy-list-link">
          <div class="pharmacy-card-cover">${r.cover_image ? `<img src="${escapeHtml(r.cover_image)}" alt="" />` : `<div class="pharmacy-card-cover-fallback">${escapeHtml(r.pharmacy_name)}</div>`}</div>
          <div class="pharmacy-card-body">
            <div class="pharmacy-card-heading">
              <div class="pharmacy-avatar-small">${(r.profile_image || r.store_image) ? `<img src="${escapeHtml(r.profile_image || r.store_image)}" alt="" />` : `<span class="pharmacy-avatar-name">${escapeHtml(r.pharmacy_name)}</span>`}</div>
              <div class="pharmacy-card-name"><strong>${escapeHtml(r.pharmacy_name)}</strong><span class="text-sm muted">${(r.verification_status || (r.verified ? 'VERIFIED' : 'PENDING')) === 'VERIFIED' ? 'Verified' : 'Pending verification'}</span></div>
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
        <button class="btn btn-outline btn-sm pharmacy-directions-btn" type="button" data-index="${index}">Directions</button>
      </div>
    `).join('')}`;

    list.querySelectorAll('.pharmacy-directions-btn').forEach(button => {
      button.addEventListener('click', () => {
        const pharmacy = pharmacyRows[Number(button.dataset.index)];
        if (pharmacy) showDirections(pharmacy);
      });
    });

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

  function locateCustomer() {
    if (!navigator.geolocation) {
      locationStatus.textContent = 'Location unavailable. Showing the default map area.';
      return;
    }

    locateButton.disabled = true;
    locationStatus.textContent = 'Requesting current location...';
    navigator.geolocation.getCurrentPosition(
      (position) => {
        userLoc = { lat: position.coords.latitude, lng: position.coords.longitude };
        if (userMarker) userMarker.setLatLng([userLoc.lat, userLoc.lng]);
        else {
          userMarker = L.circleMarker([userLoc.lat, userLoc.lng], {
            color: '#0F766E',
            fillColor: '#14B8A6',
            fillOpacity: 1,
            radius: 9,
            weight: 3,
          }).addTo(map).bindTooltip('You are here', { permanent: true, direction: 'top' });
          userMarker.bindPopup('You are here');
        }
        locationStatus.textContent = 'Current location active';
        map.setView([userLoc.lat, userLoc.lng], 14);
        if (lastResults.length) showResultsOnMap(lastResults);
        locateButton.disabled = false;
      },
      () => {
        locationStatus.textContent = userLoc
          ? 'Could not refresh location. Using the last known location.'
          : 'Location unavailable. Showing the default map area.';
        locateButton.disabled = false;
      },
      { enableHighAccuracy: false, maximumAge: 60000, timeout: 10000 }
    );
  }

  locateButton.addEventListener('click', locateCustomer);
  locateCustomer();

  runSearch();
})();
