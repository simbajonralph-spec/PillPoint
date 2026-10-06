(async function () {
  const user = await guardPage(['pharmacy_staff'], 'My Inventory', 'Organize products into folders and deploy them together');
  if (!user) return;
  document.body.classList.add('inventory-page');
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="mt-8">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:12px;">
        <div>
          <div class="page-subtitle">Manage medicines, stock, batches, and deployment</div>
        </div>
        <div class="flex gap-8" style="flex-wrap:wrap;">
          <button class="btn btn-outline" id="add-folder-btn">+ Add Folder</button>
          <button class="btn btn-primary" id="add-btn">+ Add Medicine</button>
          <button class="btn btn-outline" id="stock-in-btn">Stock-In</button>
          <button class="btn btn-outline" id="stock-out-btn">Stock-Out</button>
          <button class="btn btn-outline" id="adjust-stock-btn">Adjust Stock</button>
        </div>
      </div>
      <div id="summary-cards" class="grid mt-16" style="grid-template-columns: repeat(4, minmax(170px, 1fr)); gap:14px;"></div>
      <div id="add-folder-form" class="card mt-16" style="display:none;"></div>
      <div id="add-form" class="card mt-16" style="display:none;"></div>
      <div class="card mt-16">
        <div class="inventory-overview-head">
          <div class="card-title" style="margin:0;">Inventory Overview</div>
          <div class="inventory-toolbar" role="search">
            <label class="inventory-search-control">
              ${iconSvg('search', 18)}
              <input id="inventory-search" type="search" aria-label="Search inventory" placeholder="Search medicines, batches, brands" />
            </label>
            <label class="sr-only" for="inventory-category-filter">Category</label>
            <select id="inventory-category-filter" aria-label="Filter by category"><option value="all">All Categories</option></select>
            <label class="sr-only" for="inventory-status-filter">Stock status</label>
            <select id="inventory-status-filter" aria-label="Filter by stock status"><option value="all">All Stock Status</option><option value="available">Available</option><option value="low">Low Stock</option><option value="out">Out of Stock</option></select>
            <label class="sr-only" for="inventory-expiry-filter">Expiration</label>
            <select id="inventory-expiry-filter" aria-label="Filter by expiration"><option value="all">All Expiration</option><option value="normal">Normal</option><option value="expiring">Expiring Soon</option><option value="expired">Expired</option></select>
          </div>
        </div>
      </div>
      <div id="inventory-table" class="card mt-16"></div>
    </div>

    <div class="grid mt-16" style="grid-template-columns: 2fr 1fr; gap:18px; align-items:flex-start;">
      <div>
        <div class="card-title" style="margin-top:0;">Folders</div>
        <div id="folders-list"></div>
      </div>
      <div>
        <div class="card-title" style="margin-top:0;">Recent Deploy History</div>
        <div class="card stat-card" style="margin-bottom:14px;">
          <div class="stat-label">Estimated Value of Deployed Stock</div>
          <div class="stat-value" id="deployed-value">—</div>
          <div class="text-sm muted" id="deployed-count"></div>
        </div>
        <div class="card mb-12" style="margin-bottom:12px;">
          <div class="field"><label>Filter by Month</label><input type="month" id="filter-month" /></div>
          <div class="field"><label>Filter by Folder</label><select id="filter-folder"><option value="">All folders</option></select></div>
          <div class="field"><label>Search Product/Folder</label><input type="text" id="filter-q" placeholder="e.g. Paracetamol" /></div>
        </div>
        <div class="card" style="padding:0;">
          <div id="deploy-history"></div>
        </div>
      </div>
    </div>
  `;

  const foldersList = document.getElementById('folders-list');
  const addForm = document.getElementById('add-form');
  const addFolderForm = document.getElementById('add-folder-form');
  let allMedicines = [];
  let allFolders = [];
  const expanded = new Set();

  function wireOverflowMenus(root) {
    root.querySelectorAll('.inventory-menu').forEach(menu => {
      menu.addEventListener('toggle', () => {
        const panel = menu.querySelector('.inventory-menu-popover');
        if (!menu.open || !panel) {
          if (panel) panel.removeAttribute('style');
          return;
        }
        panel.style.position = 'fixed';
        panel.style.visibility = 'hidden';
        panel.style.left = '0';
        panel.style.top = '0';
        const trigger = menu.querySelector('summary').getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        const left = Math.max(8, Math.min(trigger.right - panelRect.width, window.innerWidth - panelRect.width - 8));
        const top = trigger.bottom + panelRect.height + 8 <= window.innerHeight
          ? trigger.bottom + 4
          : Math.max(8, trigger.top - panelRect.height - 4);
        panel.style.left = `${left}px`;
        panel.style.top = `${top}px`;
        panel.style.visibility = '';
      });
    });
  }

  document.addEventListener('click', event => {
    if (!event.target.closest('.inventory-menu')) {
      document.querySelectorAll('.inventory-menu[open]').forEach(menu => { menu.open = false; });
    }
  });
  window.addEventListener('scroll', () => {
    document.querySelectorAll('.inventory-menu[open]').forEach(menu => { menu.open = false; });
  }, true);

  function statusBadge(status) {
    const map = {
      draft: '<span class="badge badge-draft">Draft</span>',
      ready: '<span class="badge badge-ready">Ready to Deploy</span>',
      deployed: '<span class="badge badge-deployed">Deployed</span>',
      archived: '<span class="badge badge-archived">Archived</span>',
    };
    return map[status] || status;
  }

  // ---- Add Folder ----
  document.getElementById('add-folder-btn').addEventListener('click', () => {
    addFolderForm.style.display = addFolderForm.style.display === 'none' ? 'block' : 'none';
    addFolderForm.innerHTML = `
      <div class="card-title">New Folder</div>
      <div class="field"><label>Folder Name</label><input type="text" id="folder-name" placeholder="e.g. Cold & Flu Bundle" /></div>
      <button class="btn btn-primary" id="save-folder">Create Folder</button>
      <button class="btn btn-outline" id="cancel-folder">Cancel</button>
    `;
    document.getElementById('cancel-folder').addEventListener('click', () => addFolderForm.style.display = 'none');
    document.getElementById('save-folder').addEventListener('click', async () => {
      const name = document.getElementById('folder-name').value.trim();
      if (!name) { toast('Folder name is required.', 'error'); return; }
      try {
        await Api.post('/api/pharmacy/folders', { name });
        toast('Folder created.');
        addFolderForm.style.display = 'none';
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  // ---- Add Medicine (to a folder or unassigned) ----
  function renderAddForm() {
    addForm.innerHTML = `
      <div class="card-title">Add Medicine to Inventory</div>
      <div class="grid grid-4">
        <div class="field">
          <label>Medicine</label>
          <input id="medicine_name" list="medicine-datalist" type="text" placeholder="Enter medicine name or search" />
          <datalist id="medicine-datalist">${allMedicines.map(m => `<option value="${escapeHtml(m.name)}"></option>`).join('')}</datalist>
        </div>
        <div class="field">
          <label>Folder</label>
          <select id="folder_id">
            <option value="">Inventory Table</option>
            ${allFolders.map(f => `<option value="${f.id}">${escapeHtml(f.name)} (${f.status})</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Brand</label><input type="text" id="brand" placeholder="e.g. Biogesic" /></div>
        <div class="field"><label>Price (₱)</label><input type="number" id="price" min="0" step="0.01" /></div>
      </div>
      <div class="grid grid-4">
        <div class="field"><label>Stock Quantity</label><input type="number" id="stock_quantity" min="0" /></div>
        <div class="field"><label>Low Stock Alert Below</label><input type="number" id="low_stock_threshold" value="10" min="0" /></div>
        <div class="field"><label>Batch Number</label><input type="text" id="batch_number" placeholder="LOT-0001" /></div>
        <div class="field"><label>Expiration Date</label><input type="date" id="expiration_date" /></div>
      </div>
      <button class="btn btn-primary" id="save-add">Add to Inventory</button>
      <button class="btn btn-outline" id="cancel-add">Cancel</button>
      <p class="text-sm muted mt-16">Products become visible to customers only when the <strong>folder</strong> they belong to is deployed.</p>
    `;
    document.getElementById('cancel-add').addEventListener('click', () => addForm.style.display = 'none');
    document.getElementById('save-add').addEventListener('click', async () => {
      const medicineName = (document.getElementById('medicine_name')?.value || '').trim();
      if (!medicineName) {
        toast('Medicine name is required.', 'error');
        return;
      }

      try {
        await Api.post('/api/pharmacy/inventory', {
          medicine_name: medicineName,
          folder_id: document.getElementById('folder_id').value || null,
          brand: document.getElementById('brand').value.trim(),
          price: parseFloat(document.getElementById('price').value),
          stock_quantity: parseInt(document.getElementById('stock_quantity').value, 10),
          low_stock_threshold: parseInt(document.getElementById('low_stock_threshold').value, 10),
          batch_number: document.getElementById('batch_number').value.trim(),
          expiration_date: document.getElementById('expiration_date').value || null,
        });
        toast('Medicine added to inventory.');
        addForm.style.display = 'none';
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  document.getElementById('add-btn').addEventListener('click', () => {
    addForm.style.display = addForm.style.display === 'none' ? 'block' : 'none';
  });

  function productRow(item) {
    return `
      <tr>
        <td>
          <div style="font-weight:600">${escapeHtml(item.medicine_name)}</div>
          <div class="text-sm muted">${escapeHtml(item.category || '')}</div>
        </td>
        <td><input type="text" class="edit-brand" data-id="${item.id}" value="${escapeHtml(item.brand || '')}" placeholder="Brand" style="width:100px;padding:6px;border:1px solid var(--border);border-radius:6px;" /></td>
        <td><input type="number" class="edit-price" data-id="${item.id}" value="${item.price}" step="0.01" style="width:80px;padding:6px;border:1px solid var(--border);border-radius:6px;" /></td>
        <td><input type="number" class="edit-stock" data-id="${item.id}" value="${item.stock_quantity}" style="width:70px;padding:6px;border:1px solid var(--border);border-radius:6px;" /></td>
        <td>${stockBadge(item.stock_quantity, item.low_stock_threshold)}</td>
        <td style="white-space:nowrap;">
          <button class="btn btn-outline btn-sm save-btn" data-id="${item.id}">Save</button>
          <select class="move-folder-select" data-id="${item.id}" style="padding:5px;border:1px solid var(--border);border-radius:6px;font-size:12px;">
            <option value="">Inventory Table</option>
            ${allFolders.map(f => `<option value="${f.id}" ${item.folder_id === f.id ? 'selected' : ''}>${escapeHtml(f.name)}</option>`).join('')}
          </select>
          <button class="btn btn-danger btn-sm delete-btn" data-id="${item.id}">Delete</button>
        </td>
      </tr>
    `;
  }

  function folderCard(folder) {
    const products = folder._products || [];
    const isOpen = expanded.has(folder.id);
    const isUnassigned = folder.id === 'unassigned';
    const canDeploy = folder.status !== 'deployed' && folder.status !== 'archived' && folder.product_count > 0;
    const canUndeploy = folder.status === 'deployed';
    const canReady = folder.status === 'draft' && folder.product_count > 0;
    const canArchive = folder.status !== 'archived';
    return `
      <div class="folder-card fade-in-up">
        <div class="folder-head" data-toggle="${folder.id}">
          <div class="folder-head-left">
            <span class="folder-chevron ${isOpen ? 'open' : ''}">&#9656;</span>
            <div class="folder-icon">&#128193;</div>
            <div>
              <div class="folder-name">${escapeHtml(folder.name)}</div>
              <div class="folder-meta">${folder.product_count} product(s) &middot; ${money(folder.estimated_value)} est. value</div>
            </div>
          </div>
          <div class="folder-head-actions">
            ${statusBadge(folder.status)}
            ${!isUnassigned ? `
              <details class="inventory-menu folder-menu">
                <summary aria-label="Folder actions" title="Folder actions">${iconSvg('more', 18)}</summary>
                <div class="inventory-menu-popover">
                  ${canReady ? `<button type="button" data-folder-action="ready" data-id="${folder.id}">Mark ready</button>` : ''}
                  ${canDeploy ? `<button type="button" data-folder-action="deploy" data-id="${folder.id}">Deploy folder</button>` : ''}
                  ${canUndeploy ? `<button type="button" data-folder-action="undeploy" data-id="${folder.id}">Undeploy</button>` : ''}
                  ${canArchive ? `<button type="button" data-folder-action="archive" data-id="${folder.id}">Archive</button>` : ''}
                  <button type="button" data-folder-action="rename" data-id="${folder.id}" data-name="${escapeHtml(folder.name)}">Rename</button>
                  <button type="button" class="danger-action" data-folder-action="delete" data-id="${folder.id}">Delete</button>
                </div>
              </details>` : ''}
          </div>
        </div>
        <div class="folder-body ${isOpen ? 'open' : ''}" id="folder-body-${folder.id}">
          ${products.length ? `
            <table>
              <thead><tr><th>Medicine</th><th>Brand</th><th>Price (₱)</th><th>Stock</th><th>Status</th><th></th></tr></thead>
              <tbody>${products.map(productRow).join('')}</tbody>
            </table>
          ` : `<p class="text-sm muted">No products in this folder yet. Use "+ Add Medicine" above and assign it here.</p>`}
        </div>
      </div>
    `;
  }

  function wireProductRows() {
    document.querySelectorAll('.save-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        const price = parseFloat(document.querySelector(`.edit-price[data-id="${id}"]`).value);
        const stock_quantity = parseInt(document.querySelector(`.edit-stock[data-id="${id}"]`).value, 10);
        const brand = document.querySelector(`.edit-brand[data-id="${id}"]`).value;
        try {
          await Api.put(`/api/pharmacy/inventory/${id}`, { price, stock_quantity, brand });
          toast('Inventory updated.');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    document.querySelectorAll('.move-folder-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        try {
          await Api.put(`/api/pharmacy/inventory/${sel.dataset.id}/move`, { folder_id: sel.value || null });
          toast('Product moved.');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
    document.querySelectorAll('.delete-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!await appModal({ title: 'Remove medicine?', message: 'This medicine will be removed from your inventory.', confirmText: 'Remove', danger: true })) return;
        try {
          await Api.del(`/api/pharmacy/inventory/${btn.dataset.id}`);
          toast('Removed from inventory.');
          load();
        } catch (err) { toast(err.message, 'error'); }
      });
    });
  }

  function wireFolderActions() {
    document.querySelectorAll('[data-toggle]').forEach(head => {
      head.addEventListener('click', (e) => {
        if (e.target.closest('button') || e.target.closest('select') || e.target.closest('.inventory-menu')) return;
        const id = Number(head.dataset.toggle);
        if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
        render();
      });
    });
    document.querySelectorAll('[data-folder-action]').forEach(btn => btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      try {
        if (btn.dataset.folderAction === 'ready') {
          await Api.post(`/api/pharmacy/folders/${id}/ready`);
          toast('Folder marked ready to deploy.');
        } else if (btn.dataset.folderAction === 'deploy') {
          const res = await Api.post(`/api/pharmacy/folders/${id}/deploy`);
          toast(`Folder deployed — ${res.product_count} product(s) now visible to customers.`);
          loadDeployHistory();
        } else if (btn.dataset.folderAction === 'undeploy') {
          if (!await appModal({ title: 'Undeploy folder?', message: 'Its products will no longer be visible to customers.', confirmText: 'Undeploy', danger: true })) return;
          await Api.post(`/api/pharmacy/folders/${id}/undeploy`);
          toast('Folder undeployed.');
          loadDeployHistory();
        } else if (btn.dataset.folderAction === 'archive') {
          if (!await appModal({ title: 'Archive folder?', message: 'It will be hidden from customers and marked archived.', confirmText: 'Archive', danger: true })) return;
          await Api.post(`/api/pharmacy/folders/${id}/archive`);
          toast('Folder archived.');
          loadDeployHistory();
        } else if (btn.dataset.folderAction === 'rename') {
          const name = await appModal({ title: 'Rename folder', input: { label: 'Folder name', value: btn.dataset.name }, confirmText: 'Save name' });
          if (!name) return;
          await Api.put(`/api/pharmacy/folders/${id}`, { name: name.trim() });
          toast('Folder renamed.');
        } else if (btn.dataset.folderAction === 'delete') {
          if (!await appModal({ title: 'Delete folder?', message: 'Its products will become unassigned and unpublished, but will not be deleted.', confirmText: 'Delete folder', danger: true })) return;
          await Api.del(`/api/pharmacy/folders/${id}`);
          toast('Folder deleted.');
        }
        load();
      } catch (err) { toast(err.message, 'error'); }
    }));
  }

  let inventoryRows = [];
  let inventoryPage = 1;
  const inventoryPageSize = 10;

  function summarizeInventory(rows) {
    const uniqueMedicineIds = new Set(rows.map(item => item.medicine_id));
    const totalStock = rows.reduce((sum, item) => sum + Number(item.stock_quantity || 0), 0);
    const lowStock = rows.filter(item => Number(item.stock_quantity || 0) > 0 && Number(item.stock_quantity || 0) <= Number(item.low_stock_threshold || 10)).length;
    const outOfStock = rows.filter(item => Number(item.stock_quantity || 0) === 0).length;
    const reserved = rows.reduce((sum, item) => sum + Number(item.reserved_quantity || 0), 0);
    const inventoryValue = rows.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.stock_quantity || 0), 0);
    const expiringSoon = rows.filter(item => Number(item.stock_quantity || 0) > 0 && item.next_expiration_date).filter(item => {
      const d = new Date(item.next_expiration_date);
      const msLeft = d.getTime() - Date.now();
      return msLeft > 0 && msLeft <= 30 * 24 * 60 * 60 * 1000;
    }).length;
    const expired = rows.filter(item => item.next_expiration_date).filter(item => new Date(item.next_expiration_date).getTime() <= Date.now()).length;
    return { totalMedicines: uniqueMedicineIds.size, totalStock, lowStock, outOfStock, reserved, inventoryValue, expiringSoon, expired };
  }

  function renderSummaryCards() {
    const stats = summarizeInventory(inventoryRows);
    const cards = [
      { label: 'Total Medicines', value: `${stats.totalMedicines} Medicines`, tone: 'teal' },
      { label: 'Total Stock', value: `${stats.totalStock} Units`, tone: 'blue' },
      { label: 'Low Stock', value: `${stats.lowStock} Medicines`, tone: 'amber' },
      { label: 'Out of Stock', value: `${stats.outOfStock} Medicines`, tone: 'rose' },
      { label: 'Expiring Soon', value: `${stats.expiringSoon} Batches`, tone: 'orange' },
      { label: 'Expired', value: `${stats.expired} Batches`, tone: 'red' },
      { label: 'Reserved Stock', value: `${stats.reserved} Units`, tone: 'purple' },
      { label: 'Inventory Value', value: money(stats.inventoryValue), tone: 'green' },
    ];
    const summaryBox = document.getElementById('summary-cards');
    summaryBox.innerHTML = cards.map(card => `
      <div class="card stat-card" data-tone="${card.tone}" style="padding:14px 16px;">
        <div class="stat-label">${escapeHtml(card.label)}</div>
        <div class="stat-value" style="font-size:1.7rem; margin-top:8px;">${escapeHtml(card.value)}</div>
      </div>
    `).join('');
  }

  function getFilteredRows() {
    const q = document.getElementById('inventory-search')?.value.trim().toLowerCase() || '';
    const category = document.getElementById('inventory-category-filter')?.value || 'all';
    const status = document.getElementById('inventory-status-filter')?.value || 'all';
    const expiry = document.getElementById('inventory-expiry-filter')?.value || 'all';

    return inventoryRows.filter(item => {
      const haystack = [item.medicine_name, item.brand, item.category, item.batch_number, item.folder_name].filter(Boolean).join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (category !== 'all' && item.category !== category) return false;
      const stockQty = Number(item.stock_quantity || 0);
      const statusMatch = (() => {
        if (status === 'available') return stockQty > 0 && stockQty > Number(item.low_stock_threshold || 10);
        if (status === 'low') return stockQty > 0 && stockQty <= Number(item.low_stock_threshold || 10) && stockQty > 0;
        if (status === 'out') return stockQty === 0;
        return true;
      })();
      if (!statusMatch) return false;
      const expiryMatch = (() => {
        const date = item.next_expiration_date ? new Date(item.next_expiration_date) : null;
        if (!date || !Number.isFinite(date.getTime())) return expiry === 'all';
        const ms = date.getTime() - Date.now();
        const days = ms / (1000 * 60 * 60 * 24);
        if (expiry === 'normal') return days > 60;
        if (expiry === 'expiring') return days <= 60 && days > 0;
        if (expiry === 'expired') return days <= 0;
        return true;
      })();
      if (!expiryMatch) return false;
      return true;
    });
  }

  function renderInventoryFilterOptions() {
    const categorySelect = document.getElementById('inventory-category-filter');
    if (!categorySelect) return;
    const selected = categorySelect.value;
    const categories = [...new Set(inventoryRows.map(item => item.category).filter(Boolean))].sort();
    categorySelect.innerHTML = '<option value="all">All Categories</option>' + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
    if (categories.includes(selected)) categorySelect.value = selected;
  }

  function renderInventoryTable() {
    const table = document.getElementById('inventory-table');
    if (!table) return;
    const head = `
      <div class="card-title" style="margin:0;">Live Stock Table</div>
      <table>
        <thead>
          <tr>
            <th>Medicine</th>
            <th>Brand</th>
            <th>Batch</th>
            <th>Expiration</th>
            <th style="text-align:right;">Price</th>
            <th style="text-align:right;">Stock (Avail / Total)</th>
            <th style="text-align:right;">Min Stock</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="inventory-table-body"></tbody>
      </table>
      <div class="inventory-pagination" id="inventory-pagination" aria-label="Inventory table pagination"></div>
    `;
    table.innerHTML = head;
    const filteredRows = getFilteredRows();
    const tableBody = document.getElementById('inventory-table-body');
    if (!tableBody) return;
    const pageCount = Math.max(1, Math.ceil(filteredRows.length / inventoryPageSize));
    inventoryPage = Math.min(inventoryPage, pageCount);
    const pageRows = filteredRows.slice((inventoryPage - 1) * inventoryPageSize, inventoryPage * inventoryPageSize);
    const firstRecord = filteredRows.length ? (inventoryPage - 1) * inventoryPageSize + 1 : 0;
    const lastRecord = Math.min(inventoryPage * inventoryPageSize, filteredRows.length);
    const pagination = document.getElementById('inventory-pagination');
    pagination.innerHTML = `
      <span class="inventory-record-count">Showing ${firstRecord}–${lastRecord} of ${filteredRows.length}</span>
      <div class="inventory-page-controls">
        <button type="button" class="inventory-page-button inventory-page-previous" aria-label="Previous page" ${inventoryPage <= 1 ? 'disabled' : ''}>${iconSvg('chevron', 16)}</button>
        <span>Page ${inventoryPage} of ${pageCount}</span>
        <button type="button" class="inventory-page-button inventory-page-next" aria-label="Next page" ${inventoryPage >= pageCount ? 'disabled' : ''}>${iconSvg('chevron', 16)}</button>
      </div>
    `;
    pagination.querySelector('.inventory-page-previous').addEventListener('click', () => {
      if (inventoryPage > 1) { inventoryPage -= 1; renderInventoryTable(); }
    });
    pagination.querySelector('.inventory-page-next').addEventListener('click', () => {
      if (inventoryPage < pageCount) { inventoryPage += 1; renderInventoryTable(); }
    });
    if (!filteredRows.length) {
      tableBody.innerHTML = `<tr><td colspan="9"><div class="empty-state"><h3>No inventory matches</h3><p>Try another search or filter.</p></div></td></tr>`;
      return;
    }
    tableBody.innerHTML = pageRows.map(item => {
      const total = Number(item.stock_quantity || 0);
      const reserved = Number(item.reserved_quantity || 0);
      const available = Math.max(0, total - reserved);
      const lowThreshold = Number(item.low_stock_threshold || 10);
      const batch = item.batch_number || '—';
      const expiry = item.next_expiration_date ? new Date(item.next_expiration_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No Expiry';
      const statusBadges = [];
      if (total === 0) {
        statusBadges.push('<span class="badge badge-danger">Out of Stock</span>');
      } else if (total <= lowThreshold) {
        statusBadges.push('<span class="badge badge-warning">Low Stock</span>');
      } else {
        statusBadges.push('<span class="badge badge-available">Available</span>');
      }
      if (item.next_expiration_date && new Date(item.next_expiration_date).getTime() <= Date.now()) {
        statusBadges.push('<span class="badge badge-danger">Expired</span>');
      } else if (item.next_expiration_date && new Date(item.next_expiration_date).getTime() - Date.now() <= 30 * 86400000) {
        statusBadges.push('<span class="badge badge-warning">Expiring Soon</span>');
      }
      statusBadges.push(item.deployed ? '<span class="badge badge-deployed">Deployed</span>' : '<span class="badge badge-draft">Undeployed</span>');
      return `
        <tr>
          <td>
            <div style="font-weight:700;">${escapeHtml(item.medicine_name)}</div>
            <div class="text-sm muted">${escapeHtml(item.category || 'Uncategorized')}</div>
          </td>
          <td>${escapeHtml(item.brand || '—')}</td>
          <td>${escapeHtml(batch)}</td>
          <td class="inventory-expiration"><span class="${item.next_expiration_date ? '' : 'inventory-no-expiry'}">${escapeHtml(expiry)}</span></td>
          <td style="text-align:right;">${money(Number(item.price || 0))}</td>
          <td style="text-align:right;" title="Available: ${available} · Reserved: ${reserved} · Total: ${total} · Min stock: ${lowThreshold}">${available} / ${total}</td>
          <td style="text-align:right;">${Number(item.low_stock_threshold || 0)}</td>
          <td><div style="display:flex;flex-wrap:wrap;gap:6px;">${statusBadges.join('')}</div></td>
          <td>
            <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;">
              <details class="inventory-menu row-menu">
                <summary aria-label="Medicine actions" title="Medicine actions">${iconSvg('more', 18)}</summary>
                <div class="inventory-menu-popover">
                  <button type="button" data-action="edit" data-id="${item.id}">Edit</button>
                  <button type="button" data-action="stock-in" data-id="${item.id}">Stock in</button>
                  <button type="button" data-action="stock-out" data-id="${item.id}">Stock out</button>
                  <button type="button" data-action="deploy" data-id="${item.id}">Deploy to folder</button>
                  <button type="button" class="danger-action" data-action="delete" data-id="${item.id}">Remove</button>
                </div>
              </details>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    wireOverflowMenus(table);
    document.querySelectorAll('[data-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const menu = button.closest('.inventory-menu');
        if (menu) menu.open = false;
        const itemId = Number(button.dataset.id);
        const item = inventoryRows.find(row => row.id === itemId);
        if (!item) return;
        if (button.dataset.action === 'edit') {
          const values = await appModal({
            title: `Edit ${item.medicine_name}`,
            fields: [
              { name: 'brand', label: 'Brand', value: item.brand || '', type: 'text' },
              { name: 'price', label: 'Price (₱)', value: item.price, type: 'number', min: 0, step: '0.01', required: true },
              { name: 'stock_quantity', label: 'Stock quantity', value: item.stock_quantity, type: 'number', min: 0, step: 1, required: true },
              { name: 'low_stock_threshold', label: 'Low stock threshold', value: item.low_stock_threshold, type: 'number', min: 0, step: 1, required: true },
            ],
            confirmText: 'Save changes',
          });
          if (!values) return;
          try {
            await Api.put(`/api/pharmacy/inventory/${item.id}`, {
              brand: values.brand,
              price: Number(values.price),
              stock_quantity: Number(values.stock_quantity),
              low_stock_threshold: Number(values.low_stock_threshold),
            });
            toast('Inventory updated.');
            load();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        if (button.dataset.action === 'stock-in') {
          const qty = await appModal({ title: 'Stock-In', quantity: { label: 'Quantity received', value: 10, max: 10000, unitPrice: Number(item.price || 0), hint: `${item.medicine_name} · ${money(Number(item.price || 0))} each` }, confirmText: 'Add Stock' });
          if (qty == null) return;
          try {
            await Api.post('/api/pharmacy/inventory/stock-in', { inventory_id: item.id, quantity: qty, selling_price: item.price, batch_number: `LOT-${Date.now().toString().slice(-6)}`, supplier_reference: 'Manual stock-in', remarks: 'Stock-in via inventory dashboard' });
            toast(`Stock-In completed successfully. +${qty} units added.`);
            load();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        if (button.dataset.action === 'stock-out') {
          const qty = await appModal({ title: 'Stock-Out', quantity: { label: 'Quantity to remove', value: 1, max: Number(item.stock_quantity || 0), unitPrice: Number(item.price || 0), hint: `Current stock: ${item.stock_quantity} · Available: ${Math.max(0, Number(item.stock_quantity || 0) - Number(item.reserved_quantity || 0))}` }, confirmText: 'Remove Stock' });
          if (qty == null) return;
          try {
            await Api.post('/api/pharmacy/inventory/stock-out', { inventory_id: item.id, quantity: qty, reason: 'Dispensed/Sold', reference_number: `OUT-${Date.now()}`, remarks: 'Stock-out via inventory dashboard' });
            toast(`Stock-out completed. -${qty} units removed.`);
            load();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        if (button.dataset.action === 'deploy') {
          const destinations = allFolders.filter(folder => folder.status !== 'archived');
          if (!destinations.length) { toast('Create a folder before deploying a medicine.', 'error'); return; }
          const folderId = await appModal({
            title: `Deploy ${item.medicine_name}`,
            message: 'The selected folder will become the active customer-facing inventory folder.',
            select: {
              label: 'Destination folder',
              value: item.folder_id || '',
              options: destinations.map(folder => ({ value: folder.id, label: `${folder.name}${folder.status === 'deployed' ? ' (currently deployed)' : ''}` })),
            },
            confirmText: 'Deploy folder',
          });
          if (!folderId) return;
          try {
            const result = await Api.post(`/api/pharmacy/inventory/${item.id}/deploy`, { folder_id: Number(folderId) });
            toast(`${result.folder_name} is now the active deployed folder.`);
            load();
            loadDeployHistory();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        if (button.dataset.action === 'delete') {
          if (!await appModal({ title: 'Remove medicine?', message: 'This medicine will be removed from your inventory.', confirmText: 'Remove', danger: true })) return;
          try {
            await Api.del(`/api/pharmacy/inventory/${item.id}`);
            toast('Removed from inventory.');
            load();
          } catch (err) { toast(err.message, 'error'); }
        }
      });
    });
  }

  function bindQuickActions() {
    document.getElementById('stock-in-btn')?.addEventListener('click', async () => {
      const item = inventoryRows[0];
      if (!item) { toast('Add a medicine before stock-in.', 'error'); return; }
      const qty = await appModal({ title: 'Stock-In', quantity: { label: 'Quantity received', value: 10, max: 10000, unitPrice: Number(item.price || 0), hint: `${item.medicine_name}` }, confirmText: 'Add Stock' });
      if (qty == null) return;
      try {
        await Api.post('/api/pharmacy/inventory/stock-in', { inventory_id: item.id, quantity: qty, selling_price: item.price, batch_number: `LOT-${Date.now().toString().slice(-6)}`, supplier_reference: 'Manual stock-in', remarks: 'Stock-in via quick action' });
        toast(`Stock-In completed successfully. +${qty} units added.`);
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('stock-out-btn')?.addEventListener('click', async () => {
      const item = inventoryRows[0];
      if (!item) { toast('No inventory available to stock-out.', 'error'); return; }
      const qty = await appModal({ title: 'Stock-Out', quantity: { label: 'Quantity to remove', value: 1, max: Number(item.stock_quantity || 0), unitPrice: Number(item.price || 0), hint: `Current stock: ${item.stock_quantity}` }, confirmText: 'Remove Stock' });
      if (qty == null) return;
      try {
        await Api.post('/api/pharmacy/inventory/stock-out', { inventory_id: item.id, quantity: qty, reason: 'Dispensed/Sold', reference_number: `OUT-${Date.now()}`, remarks: 'Stock-out via quick action' });
        toast(`Stock-out completed. -${qty} units removed.`);
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('adjust-stock-btn')?.addEventListener('click', async () => {
      const item = inventoryRows[0];
      if (!item) { toast('No inventory available to adjust.', 'error'); return; }
      const delta = await appModal({ title: 'Adjust Stock', quantity: { label: 'Adjustment amount', value: -1, max: 1000, hint: `Current stock: ${item.stock_quantity}` }, confirmText: 'Apply Adjustment' });
      if (delta == null) return;
      try {
        await Api.post('/api/pharmacy/inventory/adjust', { inventory_id: item.id, adjustment: Number(delta), reason: 'Physical Inventory Count', remarks: 'Stock adjusted from quick action' });
        toast(`Stock adjusted by ${delta}.`);
        load();
      } catch (err) { toast(err.message, 'error'); }
    });
    const resetInventoryPage = () => { inventoryPage = 1; render(); };
    document.getElementById('inventory-search')?.addEventListener('input', resetInventoryPage);
    document.getElementById('inventory-category-filter')?.addEventListener('change', resetInventoryPage);
    document.getElementById('inventory-status-filter')?.addEventListener('change', resetInventoryPage);
    document.getElementById('inventory-expiry-filter')?.addEventListener('change', resetInventoryPage);
  }

  function render() {
    renderSummaryCards();
    renderInventoryFilterOptions();
    if (document.getElementById('inventory-table')) renderInventoryTable();
    if (!allFolders.length && !inventoryRows.filter(r => !r.folder_id).length) {
      foldersList.innerHTML = `<div class="empty-state"><div class="icon">&#128193;</div><h3>No folders yet</h3><p>Create a folder, add your medicines to it, then deploy the whole folder at once.</p></div>`;
      return;
    }
    const foldersWithProducts = allFolders.map(f => ({ ...f, _products: inventoryRows.filter(r => r.folder_id === f.id) }));
    const unassigned = inventoryRows.filter(r => !r.folder_id);
    let html = foldersWithProducts.map(folderCard).join('');
    if (unassigned.length) {
      html += folderCard({ id: 'unassigned', name: 'Inventory Table', status: 'draft', product_count: unassigned.length, estimated_value: unassigned.reduce((s, p) => s + p.price * p.stock_quantity, 0), _products: unassigned });
    }
    foldersList.innerHTML = html;
    wireOverflowMenus(foldersList);
    wireFolderActions();
    wireProductRows();
  }

  async function loadDeployHistory() {
    const box = document.getElementById('deploy-history');
    const month = document.getElementById('filter-month').value;
    const folder_id = document.getElementById('filter-folder').value;
    const q = document.getElementById('filter-q').value.trim();
    try {
      const params = new URLSearchParams();
      if (month) params.set('month', month);
      if (folder_id) params.set('folder_id', folder_id);
      if (q) params.set('q', q);
      const data = await Api.get('/api/pharmacy/deploy-log?' + params.toString());
      document.getElementById('deployed-value').textContent = money(data.deployedStats.estimatedValue);
      document.getElementById('deployed-count').textContent = `${data.deployedStats.deployedCount} product(s) currently deployed`;
      if (!data.history.length) {
        box.innerHTML = `<div class="empty-state" style="padding:24px;"><p class="text-sm">No deploy activity found.</p></div>`;
        return;
      }
      box.innerHTML = data.history.map(h => `
        <div class="deploy-history-item" style="align-items:flex-start;">
          <div class="flex items-center gap-8">
            <span class="deploy-dot ${h.action === 'deployed' ? 'on' : 'off'}"></span>
            <div>
              <div style="font-weight:600">${escapeHtml(h.folder_name)}</div>
              <div class="text-sm muted">${h.action === 'deployed' ? 'Deployed' : 'Undeployed'} &middot; ${h.product_count} product(s)</div>
              ${h.products && h.products.length ? `<div class="text-sm muted mt-8">${h.products.slice(0, 4).map(p => escapeHtml(p.name)).join(', ')}${h.products.length > 4 ? `, +${h.products.length - 4} more` : ''}</div>` : ''}
            </div>
          </div>
          <div class="text-sm muted" style="white-space:nowrap;">${new Date(h.created_at).toLocaleDateString()}</div>
        </div>
      `).join('');
    } catch (err) {
      box.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  async function load() {
    try {
      const [invData, folderData] = await Promise.all([
        Api.get('/api/pharmacy/inventory'),
        Api.get('/api/pharmacy/folders'),
      ]);
      allMedicines = invData.medicines;
      allFolders = folderData.folders;
      inventoryRows = invData.inventory;
      renderAddForm();
      if (new URLSearchParams(window.location.search).get('add') === '1') {
        addForm.style.display = 'block';
        addForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      const folderFilter = document.getElementById('filter-folder');
      folderFilter.innerHTML = `<option value="">All folders</option>${allFolders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}`;

      bindQuickActions();
      render();
    } catch (err) {
      foldersList.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  document.getElementById('filter-month').addEventListener('change', loadDeployHistory);
  document.getElementById('filter-folder').addEventListener('change', loadDeployHistory);
  let qTimer;
  document.getElementById('filter-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadDeployHistory, 300); });

  load();
  loadDeployHistory();
})();
