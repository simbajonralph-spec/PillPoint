(async function () {
  const user = await guardPage(['pharmacy_staff'], 'Supplier Center', 'Supplier contacts, products supplied, and traceable delivery history');
  if (!user) return;
  const content = document.getElementById('page-content');
  const params = new URLSearchParams(window.location.search);
  const supplierId = params.get('id');
  const medicineId = params.get('medicine_id');
  content.innerHTML = skeletonLoader('table', 4);

  function displayDate(value) {
    return value ? escapeHtml(new Date(value).toLocaleString()) : '—';
  }

  async function renderList() {
    const query = medicineId ? `?medicine_id=${encodeURIComponent(medicineId)}` : '';
    const [supplierData, inventoryData] = await Promise.all([
      Api.get(`/api/pharmacy/suppliers${query}`),
      Api.get('/api/pharmacy/inventory'),
    ]);
    const matchedMedicine = medicineId
      ? inventoryData.inventory.find(item => Number(item.medicine_id) === Number(medicineId))
      : null;
    content.innerHTML = `
      <div class="card">
        <div class="flex justify-between items-center" style="gap:12px;flex-wrap:wrap;">
          <div>
            <div class="card-title" style="margin:0;">${medicineId ? `Suppliers for ${escapeHtml(matchedMedicine?.medicine_name || 'selected medicine')}` : 'Suppliers'}</div>
            <p class="text-sm muted mt-8">Supplier data is reused during Stock IN. Deliveries are traced to the supplier selected for the received batch.</p>
          </div>
          <div class="flex gap-8" style="flex-wrap:wrap;">
            ${medicineId ? '<a class="btn btn-outline" href="/pharmacy/suppliers.html">All suppliers</a>' : ''}
            <button class="btn btn-primary" type="button" id="add-supplier">+ Add Supplier</button>
          </div>
        </div>
        ${supplierData.suppliers.length ? `
          <div class="table-wrap mt-16">
            <table>
              <thead><tr><th>Supplier</th><th>Contact</th><th>Phone</th><th>Email</th><th>Products supplied</th><th>Recent deliveries</th><th>Last delivery</th><th></th></tr></thead>
              <tbody>${supplierData.suppliers.map(supplier => `
                <tr>
                  <td><strong>${escapeHtml(supplier.name)}</strong><div class="text-sm muted">${escapeHtml(supplier.status)}</div></td>
                  <td>${escapeHtml(supplier.contact_person || '—')}</td>
                  <td>${supplier.phone ? `<a href="tel:${escapeHtml(supplier.phone)}">${escapeHtml(supplier.phone)}</a>` : '—'}</td>
                  <td>${supplier.email ? `<a href="mailto:${escapeHtml(supplier.email)}">${escapeHtml(supplier.email)}</a>` : '—'}</td>
                  <td>${Number(supplier.products_supplied)}</td>
                  <td>${Number(supplier.delivery_count)}</td>
                  <td>${displayDate(supplier.last_delivery_date)}</td>
                  <td><a class="btn btn-outline btn-sm" href="/pharmacy/suppliers.html?id=${supplier.id}">View Supplier</a></td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="empty-state mt-16"><h3>${medicineId ? 'No suppliers recorded for this medicine' : 'No suppliers yet'}</h3><p>Add supplier records here, then select them on Stock IN to preserve delivery provenance.</p></div>`}
      </div>
    `;
    document.getElementById('add-supplier').addEventListener('click', async () => {
      const fields = await appModal({
        title: 'Add supplier',
        fields: [
          { name: 'name', label: 'Supplier name', required: true, maxLength: 160 },
          { name: 'contact_person', label: 'Contact person', maxLength: 160 },
          { name: 'phone', label: 'Phone', maxLength: 60 },
          { name: 'email', label: 'Email', type: 'email', maxLength: 254 },
          { name: 'address', label: 'Address', maxLength: 500 },
          { name: 'notes', label: 'Notes', type: 'textarea', rows: 3, maxLength: 1000 },
        ],
        confirmText: 'Save supplier',
      });
      if (!fields) return;
      try {
        const result = await Api.post('/api/pharmacy/suppliers', fields);
        toast('Supplier saved.');
        window.location.href = `/pharmacy/suppliers.html?id=${result.id}`;
      } catch (error) {
        toast(error.message, 'error');
      }
    });
  }

  async function renderProfile() {
    const data = await Api.get(`/api/pharmacy/suppliers/${encodeURIComponent(supplierId)}`);
    const supplier = data.supplier;
    content.innerHTML = `
      <div class="flex justify-between items-center mb-16" style="gap:12px;flex-wrap:wrap;">
        <a class="btn btn-outline" href="/pharmacy/suppliers.html">← Supplier list</a>
        <a class="btn btn-primary" href="/pharmacy/inventory.html?action=stock-in&supplier_id=${encodeURIComponent(supplier.id)}">Receive Stock</a>
      </div>
      <div class="card">
        <div class="card-title">${escapeHtml(supplier.name)}</div>
        <div class="grid grid-3">
          <div><div class="text-sm muted">Contact</div><strong>${escapeHtml(supplier.contact_person || '—')}</strong></div>
          <div><div class="text-sm muted">Phone</div><strong>${supplier.phone ? `<a href="tel:${escapeHtml(supplier.phone)}">${escapeHtml(supplier.phone)}</a>` : '—'}</strong></div>
          <div><div class="text-sm muted">Email</div><strong>${supplier.email ? `<a href="mailto:${escapeHtml(supplier.email)}">${escapeHtml(supplier.email)}</a>` : '—'}</strong></div>
          <div><div class="text-sm muted">Address</div><strong>${escapeHtml(supplier.address || '—')}</strong></div>
          <div><div class="text-sm muted">Last delivery</div><strong>${displayDate(data.last_delivery_date)}</strong></div>
          <div><div class="text-sm muted">Total purchases</div><strong>Not available</strong><div class="text-sm muted">Purchase totals are not stored per delivery.</div></div>
        </div>
        ${supplier.notes ? `<p class="text-sm muted mt-12">${escapeHtml(supplier.notes)}</p>` : ''}
      </div>
      <div class="card mt-16">
        <div class="card-title">Products supplied <span class="text-sm muted">(${data.products.length})</span></div>
        ${data.products.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Medicine</th><th>Brand</th><th>Category</th><th>Units received</th><th>Last delivery</th><th></th></tr></thead>
          <tbody>${data.products.map(product => `
            <tr><td><strong>${escapeHtml(product.medicine_name)}</strong></td>
              <td>${escapeHtml(product.brand || '—')}</td><td>${escapeHtml(product.category || '—')}</td>
              <td>${Number(product.units_received)}</td><td>${displayDate(product.last_delivery_date)}</td>
              <td><a class="btn btn-outline btn-sm" href="/pharmacy/inventory.html?product_id=${product.inventory_id}">View Product</a></td></tr>`).join('')}
          </tbody>
        </table></div>` : `<div class="empty-state"><p>No stock-in transactions are linked to this supplier yet.</p></div>`}
      </div>
      <div class="card mt-16">
        <div class="card-title">Delivery history <span class="text-sm muted">(${data.delivery_count}${data.deliveries.length === 100 ? '+' : ''})</span></div>
        ${data.deliveries.length ? `<div class="table-wrap"><table>
          <thead><tr><th>Date</th><th>Medicine</th><th>Batch</th><th>Quantity</th><th>Reference</th><th>Recorded by</th></tr></thead>
          <tbody>${data.deliveries.map(delivery => `
            <tr><td>${displayDate(delivery.created_at)}</td>
              <td>${escapeHtml(delivery.medicine_name)}</td><td>${escapeHtml(delivery.batch_number || '—')}</td>
              <td>${Number(delivery.quantity)}</td><td>${escapeHtml(delivery.reference_number || '—')}</td>
              <td>${escapeHtml(delivery.staff_name || '—')}</td></tr>`).join('')}
          </tbody>
        </table></div>` : `<div class="empty-state"><p>No deliveries have been recorded for this supplier.</p></div>`}
      </div>
    `;
  }

  try {
    if (supplierId) await renderProfile();
    else await renderList();
  } catch (error) {
    content.innerHTML = `<div class="alert alert-error">${escapeHtml(error.message)}</div>`;
  }
})();
