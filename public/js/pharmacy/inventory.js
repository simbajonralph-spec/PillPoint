(async function () {
  const user = await guardPage(['pharmacy_staff'], 'My Inventory', 'Manage internal inventory and publish validated products to customers');
  if (!user) return;
  document.body.classList.add('inventory-page');
  const content = document.getElementById('page-content');
  content.innerHTML = `
    <div class="mt-8">
      <div class="flex justify-between items-center" style="flex-wrap:wrap;gap:12px;">
        <div>
          <div class="page-subtitle">One place to manage products, stock movements, batches, expiry, and publishing.</div>
        </div>
        <div class="flex gap-8" style="flex-wrap:wrap;">
          <button class="btn btn-primary" id="add-btn">+ Add Medicine</button>
        </div>
      </div>
      <div id="summary-cards" class="grid mt-16" style="grid-template-columns: repeat(4, minmax(170px, 1fr)); gap:14px;"></div>
      <div id="inventory-error" class="mt-12" role="alert"></div>
      <div id="add-form" class="card mt-16" style="display:none;"></div>
      <nav class="inventory-center-tabs mt-16" role="tablist" aria-label="Inventory sections">
        <button type="button" role="tab" id="inventory-tab-products" aria-controls="inventory-panel-products" aria-selected="true" data-inventory-tab="products">Products</button>
        <button type="button" role="tab" id="inventory-tab-movements" aria-controls="inventory-panel-movements" aria-selected="false" data-inventory-tab="movements">Stock Movement</button>
        <button type="button" role="tab" id="inventory-tab-batches" aria-controls="inventory-panel-batches" aria-selected="false" data-inventory-tab="batches">Batches</button>
        <button type="button" role="tab" id="inventory-tab-expiration" aria-controls="inventory-panel-expiration" aria-selected="false" data-inventory-tab="expiration">Expiration</button>
        <button type="button" role="tab" id="inventory-tab-publishing" aria-controls="inventory-panel-publishing" aria-selected="false" data-inventory-tab="publishing">Publishing</button>
      </nav>
      <section class="inventory-center-panel mt-16" role="tabpanel" id="inventory-panel-products" aria-labelledby="inventory-tab-products" data-inventory-panel="products">
        <div id="inventory-integrity-warning" class="mt-12" role="status"></div>
        <div class="card inventory-products-toolbar">
          <div class="inventory-overview-head">
            <div><div class="card-title" style="margin:0;">Products</div><p class="text-sm muted mt-8">Physical stock is the inventory balance. Available stock is physical stock minus active reservations.</p></div>
            <div class="inventory-toolbar" role="search">
              <label class="inventory-search-control">${iconSvg('search', 18)}<input id="inventory-search" type="search" aria-label="Search inventory" placeholder="Search medicines, batches, brands" /></label>
              <label class="sr-only" for="inventory-category-filter">Category</label>
              <select id="inventory-category-filter" aria-label="Filter by category"><option value="all">All Categories</option></select>
              <label class="sr-only" for="inventory-status-filter">Stock status</label>
              <select id="inventory-status-filter" aria-label="Filter by stock status"><option value="all">All Stock Status</option><option value="available">Available</option><option value="low">Low Stock</option><option value="out">Out of Stock</option></select>
            </div>
          </div>
        </div>
        <div id="inventory-table" class="card mt-12"></div>
      </section>
      <section class="inventory-center-panel mt-16" role="tabpanel" id="inventory-panel-movements" aria-labelledby="inventory-tab-movements" data-inventory-panel="movements" hidden>
        <div class="inventory-movement-actions">
          <button class="btn btn-primary" id="stock-in-btn">Stock IN</button>
          <button class="btn btn-outline" id="stock-out-btn">Stock OUT</button>
          <button class="btn btn-outline" id="adjust-stock-btn">Adjustment</button>
          <button class="btn btn-outline" id="return-stock-btn">Return</button>
          <button class="btn btn-outline" id="damaged-stock-btn">Dispose Expired Batch</button>
        </div>
        <div class="card mt-12"><div class="card-title">Inventory transactions</div><div id="inventory-movements"></div></div>
      </section>
      <section class="inventory-center-panel mt-16" role="tabpanel" id="inventory-panel-batches" aria-labelledby="inventory-tab-batches" data-inventory-panel="batches" hidden>
        <div class="card"><div class="card-title">Stock batches</div><div id="inventory-batches"></div></div>
      </section>
      <section class="inventory-center-panel mt-16" role="tabpanel" id="inventory-panel-expiration" aria-labelledby="inventory-tab-expiration" data-inventory-panel="expiration" hidden>
        <div class="card"><div class="card-title">Batch expiration schedule</div><div id="inventory-expiration"></div></div>
      </section>
      <section class="inventory-center-panel mt-16" role="tabpanel" id="inventory-panel-publishing" aria-labelledby="inventory-tab-publishing" data-inventory-panel="publishing" hidden>
        <div class="inventory-publishing-actions">
          <button class="btn btn-outline" id="add-folder-btn">+ Add Folder</button>
          <p class="text-sm muted">Publish validated, in-stock products for customers. Select products in Products for bulk actions, or use a folder to publish/unpublish its products together. Stock is never changed by publishing.</p>
        </div>
        <div id="add-folder-form" class="card mt-12" style="display:none;"></div>
        <div class="inventory-publishing-layout mt-16">
          <div class="inventory-folder-column"><div class="card-title">Product folders</div><div id="folders-list"></div></div>
          <div>
            <div class="card-title">Recent publishing history</div>
            <div class="card stat-card mb-12">
              <div class="stat-label">Estimated Value of Published Inventory</div>
              <div class="stat-value" id="deployed-value">—</div>
              <div class="text-sm muted" id="deployed-count"></div>
            </div>
            <div class="card mb-12">
              <div class="field"><label>Filter by Month</label><input type="month" id="filter-month" /></div>
              <div class="field"><label>Filter by Folder</label><select id="filter-folder"><option value="">All folders</option></select></div>
              <div class="field"><label>Search Product/Folder</label><input type="text" id="filter-q" placeholder="e.g. Paracetamol" /></div>
            </div>
            <div class="card" style="padding:0;"><div id="deploy-history"></div></div>
          </div>
        </div>
      </section>
    </div>
  `;

  const foldersList = document.getElementById('folders-list');
  const addForm = document.getElementById('add-form');
  const addFolderForm = document.getElementById('add-folder-form');
  let allMedicines = [];
  let allFolders = [];
  let allSuppliers = [];
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
      ready: '<span class="badge badge-ready">Ready to publish</span>',
      deployed: '<span class="badge badge-deployed">Published</span>',
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
        <div class="field"><label>Category</label><input id="medicine_category" type="text" placeholder="e.g. Pain Relief" required /></div>
        <div class="field">
          <label>Folder</label>
          <select id="folder_id">
            <option value="">Inventory Table</option>
            ${allFolders.map(f => `<option value="${f.id}">${escapeHtml(f.name)} (${f.status === 'deployed' ? 'published' : f.status === 'ready' ? 'ready to publish' : f.status})</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>Brand</label><input type="text" id="brand" placeholder="e.g. Biogesic" /></div>
        <div class="field"><label>Price (₱)</label><input type="number" id="price" min="0" step="0.01" /></div>
      </div>
      <div class="grid grid-4">
        <div class="field"><label>Low Stock Alert Below</label><input type="number" id="low_stock_threshold" value="10" min="0" /></div>
      </div>
      <button class="btn btn-primary" id="save-add">Add to Inventory</button>
      <button class="btn btn-outline" id="cancel-add">Cancel</button>
      <p class="text-sm muted mt-16">New products start at zero physical stock. Receive quantities using a recorded Stock IN movement, complete product details, then publish when stock and batch information are valid.</p>
    `;
    document.getElementById('cancel-add').addEventListener('click', () => addForm.style.display = 'none');
    document.getElementById('save-add').addEventListener('click', async () => {
      const medicineName = (document.getElementById('medicine_name')?.value || '').trim();
      const category = (document.getElementById('medicine_category')?.value || '').trim();
      if (!medicineName) {
        toast('Medicine name is required.', 'error');
        return;
      }
      if (!category) {
        toast('Category is required before a product can be published.', 'error');
        return;
      }

      try {
        await Api.post('/api/pharmacy/inventory', {
          medicine_name: medicineName,
          category,
          folder_id: document.getElementById('folder_id').value || null,
          brand: document.getElementById('brand').value.trim(),
          price: parseFloat(document.getElementById('price').value),
          stock_quantity: 0,
          low_stock_threshold: parseInt(document.getElementById('low_stock_threshold').value, 10),
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
    const published = Number(item.deployed) === 1 && Number(item.customer_visible) === 1;
    const publishedStatus = published
      ? '<span class="badge badge-deployed">Customer-visible</span>'
      : Number(item.deployed)
        ? `<span class="badge badge-out" title="${escapeHtml((item.publish_issues || []).join(' '))}">Published · hidden</span>`
        : '<span class="badge badge-draft">Unpublished</span>';
    return `
      <tr>
        <td>
          <div style="font-weight:600">${escapeHtml(item.medicine_name)}</div>
          <div class="text-sm muted">${escapeHtml(item.brand || '—')} · ${escapeHtml(item.category || 'Uncategorized')}</div>
        </td>
        <td>${publishedStatus}</td>
        <td>${stockBadge(item.stock_quantity, item.low_stock_threshold)}</td>
        <td style="white-space:nowrap;">
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
    const visibleCount = products.filter(item => Number(item.customer_visible) === 1).length;
    const unpublishedCount = products.filter(item => !Number(item.deployed)).length;
    const needsAttentionCount = products.filter(item => Number(item.deployed) && !Number(item.customer_visible)).length;
    const canPublish = !isUnassigned && folder.status !== 'archived' && unpublishedCount > 0;
    const canUnpublish = !isUnassigned && products.some(item => Number(item.deployed));
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
              <div class="folder-meta">${folder.product_count} product(s) &middot; ${visibleCount} customer-visible${needsAttentionCount ? ` &middot; ${needsAttentionCount} need attention` : ''} &middot; ${money(folder.estimated_value)} est. value</div>
            </div>
          </div>
          <div class="folder-head-actions">
            ${visibleCount > 0 && unpublishedCount > 0
              ? '<span class="badge badge-ready">Partially published</span>'
              : needsAttentionCount > 0
                ? '<span class="badge badge-out">Needs attention</span>'
              : statusBadge(folder.status)}
            ${!isUnassigned ? `
              <details class="inventory-menu folder-menu">
                <summary aria-label="Folder actions" title="Folder actions">${iconSvg('more', 18)}</summary>
                <div class="inventory-menu-popover">
                  ${canReady ? `<button type="button" data-folder-action="ready" data-id="${folder.id}">Mark ready to publish</button>` : ''}
                  ${canPublish ? `<button type="button" data-folder-action="deploy" data-id="${folder.id}">Publish remaining products</button>` : ''}
                  ${canUnpublish ? `<button type="button" data-folder-action="undeploy" data-id="${folder.id}">Unpublish folder products</button>` : ''}
                  ${canArchive ? `<button type="button" data-folder-action="archive" data-id="${folder.id}">Archive</button>` : ''}
                  <button type="button" data-folder-action="rename" data-id="${folder.id}" data-name="${escapeHtml(folder.name)}">Rename</button>
                  <button type="button" class="danger-action" data-folder-action="delete" data-id="${folder.id}">Delete</button>
                </div>
              </details>` : ''}
          </div>
        </div>
        <div class="folder-body ${isOpen ? 'open' : ''}" id="folder-body-${folder.id}">
          ${products.length ? `
            <div class="inventory-folder-table-wrap">
              <table>
                <thead><tr><th>Product</th><th>Publishing</th><th>Physical status</th><th>Move folder / Remove</th></tr></thead>
                <tbody>${products.map(productRow).join('')}</tbody>
              </table>
            </div>
          ` : `<p class="text-sm muted">No products in this folder yet. Use "+ Add Medicine" above and assign it here.</p>`}
        </div>
      </div>
    `;
  }

  function wireProductRows() {
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
          toast('Folder marked ready to publish.');
        } else if (btn.dataset.folderAction === 'deploy') {
          const res = await Api.post(`/api/pharmacy/folders/${id}/deploy`);
          toast(`${res.product_count} product(s) published. Their physical stock was not changed.`);
          loadDeployHistory();
        } else if (btn.dataset.folderAction === 'undeploy') {
          if (!await appModal({ title: 'Unpublish folder products?', message: 'These products will no longer be visible to customers. Inventory and stock will be retained.', confirmText: 'Unpublish', danger: true })) return;
          await Api.post(`/api/pharmacy/folders/${id}/undeploy`);
          toast('Folder products unpublished. Inventory and stock were retained.');
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
      } catch (err) {
        const blocked = btn.dataset.folderAction === 'deploy'
          ? inventoryRows.filter(item => Number(item.folder_id) === Number(id) && !Number(item.deployed) && item.publish_issues?.length)
          : [];
        const reasons = blocked.slice(0, 3)
          .map(item => `${item.medicine_name}: ${item.publish_issues.join(' ')}`)
          .join(' ');
        toast(reasons || err.message, 'error');
      }
    }));
  }

  let inventoryRows = [];
  let allBatches = [];
  const selectedInventoryIds = new Set();
  let inventoryPage = 1;
  const inventoryPageSize = 10;

  function summarizeInventory(rows) {
    const uniqueMedicineIds = new Set(rows.map(item => item.medicine_id));
    const totalStock = rows.reduce((sum, item) => sum + Number(item.stock_quantity || 0), 0);
    const lowStock = rows.filter(item => Number(item.available_quantity || 0) > 0 && Number(item.available_quantity || 0) <= Number(item.low_stock_threshold || 10)).length;
    const outOfStock = rows.filter(item => Number(item.available_quantity || 0) === 0).length;
    const reserved = rows.reduce((sum, item) => sum + Number(item.reserved_quantity || 0), 0);
    const inventoryValue = rows.reduce((sum, item) => sum + Number(item.price || 0) * Number(item.stock_quantity || 0), 0);
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + 30);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const activeBatches = allBatches.filter(batch => Number(batch.current_quantity) > 0 && batch.expiration_date);
    const expiringSoon = activeBatches.filter(batch => batch.expiration_date >= today && batch.expiration_date <= cutoffDate).length;
    const expired = activeBatches.filter(batch => batch.expiration_date < today || batch.status === 'expired').length;
    return { totalMedicines: uniqueMedicineIds.size, totalStock, lowStock, outOfStock, reserved, inventoryValue, expiringSoon, expired };
  }

  async function publishProducts(ids, shouldPublish) {
    if (!ids.length) return;
    if (!shouldPublish && !await appModal({
      title: 'Unpublish selected products?',
      message: 'Customers will no longer see these products. Inventory, batches, and stock quantities will be retained.',
      confirmText: 'Unpublish',
      danger: true,
    })) return;
    try {
      const action = shouldPublish ? 'publish' : 'unpublish';
      const result = await Api.post(`/api/pharmacy/inventory/${action}`, { inventory_ids: ids });
      ids.forEach(id => selectedInventoryIds.delete(Number(id)));
      const count = shouldPublish ? result.published_count : result.unpublished_count;
      toast(`${count} product(s) ${shouldPublish ? 'published' : 'unpublished'}. Physical stock was not changed.`);
      await load();
      loadDeployHistory();
    } catch (err) {
      const details = ids
        .map(id => {
          const item = inventoryRows.find(row => Number(row.id) === Number(id));
          return item?.publish_issues?.length
            ? `${item.medicine_name}: ${item.publish_issues.join(' ')}`
            : null;
        })
        .filter(Boolean)
        .slice(0, 3)
        .join(' ');
      toast(details || err.message, 'error');
    }
  }

  function renderSummaryCards() {
    const stats = summarizeInventory(inventoryRows);
    const integrityIssues = inventoryRows.filter(item => !item.integrity_ok).length;
    const cards = [
      { label: 'Total Medicines', value: `${stats.totalMedicines} Medicines`, tone: 'teal' },
      { label: 'Total Stock', value: `${stats.totalStock} Units`, tone: 'blue' },
      { label: 'Low Stock', value: `${stats.lowStock} Medicines`, tone: 'amber' },
      { label: 'Out of Stock', value: `${stats.outOfStock} Medicines`, tone: 'rose' },
      { label: 'Expiring Soon', value: `${stats.expiringSoon} Batches`, tone: 'orange' },
      { label: 'Expired', value: `${stats.expired} Batches`, tone: 'red' },
      { label: 'Reserved Stock', value: `${stats.reserved} Units`, tone: 'purple' },
      { label: 'Inventory Value', value: money(stats.inventoryValue), tone: 'green' },
      { label: 'Integrity Warnings', value: `${integrityIssues} Products`, tone: integrityIssues ? 'red' : 'green' },
    ];
    const summaryBox = document.getElementById('summary-cards');
    summaryBox.innerHTML = cards.map(card => `
      <div class="card stat-card" data-tone="${card.tone}" style="padding:14px 16px;">
        <div class="stat-label">${escapeHtml(card.label)}</div>
        <div class="stat-value" style="font-size:1.7rem; margin-top:8px;">${escapeHtml(card.value)}</div>
      </div>
    `).join('');
    const integrityWarning = document.getElementById('inventory-integrity-warning');
    const mismatches = inventoryRows.filter(item => !item.integrity_ok);
    integrityWarning.innerHTML = mismatches.length
      ? `<div class="alert alert-warning"><strong>Inventory integrity warning:</strong> ${mismatches.length} product(s) have physical quantities that do not match their batch totals. Stock availability is limited to valid batch quantities. Review batch records before further movements.
          <ul class="mt-8">${mismatches.map(item => `<li>${escapeHtml(item.medicine_name)}: ${Number(item.stock_quantity)} physical, ${Number(item.batch_quantity)} in batches (${Number(item.integrity_difference) > 0 ? '+' : ''}${Number(item.integrity_difference)} difference)</li>`).join('')}</ul>
        </div>`
      : '';
  }

  function getFilteredRows() {
    const q = document.getElementById('inventory-search')?.value.trim().toLowerCase() || '';
    const category = document.getElementById('inventory-category-filter')?.value || 'all';
    const status = document.getElementById('inventory-status-filter')?.value || 'all';

    return inventoryRows.filter(item => {
      const haystack = [item.medicine_name, item.brand, item.category, item.batch_number, item.folder_name].filter(Boolean).join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (category !== 'all' && item.category !== category) return false;
      const stockQty = Number(item.available_quantity || 0);
      const statusMatch = (() => {
        if (status === 'available') return stockQty > 0 && stockQty > Number(item.low_stock_threshold || 10);
        if (status === 'low') return stockQty > 0 && stockQty <= Number(item.low_stock_threshold || 10) && stockQty > 0;
        if (status === 'out') return stockQty === 0;
        return true;
      })();
      if (!statusMatch) return false;
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

  function renderBatchSections() {
    const batchRows = allBatches || [];
    const batchTable = rows => rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Medicine</th><th>Batch</th><th>Supplier</th><th>Supplier Ref.</th><th>Received</th><th>Current Units</th><th>Purchase / Selling</th><th>Manufactured</th><th>Expiration</th><th>Storage</th><th>Notes</th><th>Status</th></tr></thead>
        <tbody>${rows.map(batch => `
          <tr>
            <td>${escapeHtml(batch.medicine_name)}</td>
            <td>${escapeHtml(batch.batch_number)}</td>
            <td>${escapeHtml(batch.supplier_name || '—')}</td>
            <td>${escapeHtml(batch.supplier_reference || '—')}</td>
            <td>${Number(batch.quantity_received)}</td>
            <td>${Number(batch.current_quantity)}</td>
            <td>${batch.purchase_price == null ? '—' : money(batch.purchase_price)} / ${batch.selling_price == null ? '—' : money(batch.selling_price)}</td>
            <td>${escapeHtml(batch.manufacturing_date || '—')}</td>
            <td>${escapeHtml(batch.expiration_date || 'Not recorded')}</td>
            <td>${escapeHtml(batch.storage_location || '—')}</td>
            <td>${escapeHtml(batch.notes || '—')}</td>
            <td>${escapeHtml(batch.status)}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state"><p>No batch records found.</p></div>`;
    document.getElementById('inventory-batches').innerHTML = batchTable(batchRows);
    const today = new Date().toISOString().slice(0, 10);
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() + 90);
    const cutoffDate = cutoff.toISOString().slice(0, 10);
    const expirationRows = batchRows.filter(batch => Number(batch.current_quantity) > 0
      && (!batch.expiration_date || batch.expiration_date <= cutoffDate || batch.status === 'expired'))
      .sort((a, b) => (a.expiration_date || '9999-12-31').localeCompare(b.expiration_date || '9999-12-31'));
    document.getElementById('inventory-expiration').innerHTML = expirationRows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Medicine</th><th>Batch</th><th>Units</th><th>Expiration</th><th>Review</th></tr></thead>
        <tbody>${expirationRows.map(batch => {
          const expired = batch.expiration_warning === 'expired' || batch.status === 'expired';
          const within30 = batch.expiration_warning === 'within_30_days';
          const within90 = batch.expiration_warning === 'within_90_days';
          const soon = within30 || within90;
          const tone = expired ? 'badge-out' : soon ? 'badge-low' : 'badge-available';
          const label = expired ? 'Expired · record disposal' : within30 ? 'Expires within 30 days' : within90 ? 'Expires within 90 days' : 'No expiration recorded';
          return `<tr><td>${escapeHtml(batch.medicine_name)}</td><td>${escapeHtml(batch.batch_number)}</td><td>${Number(batch.current_quantity)}</td><td>${escapeHtml(batch.expiration_date || 'Not recorded')}</td><td><span class="badge ${tone}">${label}</span></td></tr>`;
        }).join('')}</tbody>
      </table></div>` : `<div class="empty-state"><p>No active batches need an expiration review.</p></div>`;
  }

  function renderMovementHistory(rows) {
    const box = document.getElementById('inventory-movements');
    box.innerHTML = rows.length ? `
      <div class="table-wrap"><table>
        <thead><tr><th>Date</th><th>Medicine</th><th>Movement</th><th>Quantity</th><th>Physical stock</th><th>Batch</th><th>Supplier</th><th>Reason</th><th>Recorded by</th></tr></thead>
        <tbody>${rows.map(row => `
          <tr>
            <td>${new Date(row.created_at).toLocaleString()}</td>
            <td>${escapeHtml(row.medicine_name)}</td>
            <td>${escapeHtml(row.transaction_type.replaceAll('_', ' '))}</td>
            <td>${row.previous_quantity != null && row.new_quantity != null && Number(row.new_quantity) !== Number(row.previous_quantity)
              ? `${Number(row.new_quantity) > Number(row.previous_quantity) ? '+' : '-'}${Number(row.quantity)}`
              : Number(row.quantity)}</td>
            <td>${row.previous_quantity == null ? '—' : `${Number(row.previous_quantity)} → ${Number(row.new_quantity)}`}</td>
            <td>${escapeHtml(row.batch_number || '—')}</td>
            <td>${row.supplier_id ? `<a href="/pharmacy/suppliers.html?id=${row.supplier_id}">${escapeHtml(row.supplier_name || 'View supplier')}</a>` : '—'}</td>
            <td>${escapeHtml(row.remarks || row.reason || '—')}</td>
            <td>${escapeHtml(row.staff_name || 'System / Customer')}</td>
          </tr>`).join('')}
        </tbody>
      </table></div>` : `<div class="empty-state"><p>No inventory transactions have been recorded yet.</p></div>`;
  }

  function renderInventoryTable() {
    const table = document.getElementById('inventory-table');
    if (!table) return;
    const head = `
      <div class="inventory-publish-toolbar">
        <span id="publishing-selection-count" class="text-sm muted">0 products selected</span>
        <button type="button" class="btn btn-primary btn-sm" id="bulk-publish-btn">Publish selected</button>
        <button type="button" class="btn btn-outline btn-sm" id="bulk-unpublish-btn">Unpublish selected</button>
      </div>
      <div class="card-title" style="margin:0;">Products and publishing status</div>
      <table>
        <thead>
          <tr>
            <th><input type="checkbox" id="select-inventory-page" aria-label="Select products on this page" /></th>
            <th>Medicine</th>
            <th>Category</th>
            <th>Physical Stock</th>
            <th>Reserved Stock</th>
            <th>Available Stock</th>
            <th>Published</th>
            <th>Lowest Expiration</th>
            <th>Batch Integrity</th>
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
    const bulkPublish = document.getElementById('bulk-publish-btn');
    const bulkUnpublish = document.getElementById('bulk-unpublish-btn');
    const selectionCount = document.getElementById('publishing-selection-count');
    const pageIds = pageRows.map(item => Number(item.id));
    const updatePublishingControls = () => {
      const selected = inventoryRows.filter(item => selectedInventoryIds.has(Number(item.id)));
      const unpublishedSelected = selected.filter(item => !Number(item.deployed));
      const publishedSelected = selected.filter(item => Number(item.deployed));
      selectionCount.textContent = `${selected.length} product(s) selected`;
      bulkPublish.disabled = unpublishedSelected.length === 0;
      bulkUnpublish.disabled = publishedSelected.length === 0;
      document.getElementById('select-inventory-page').checked = pageIds.length > 0
        && pageIds.every(id => selectedInventoryIds.has(id));
    };
    document.getElementById('select-inventory-page').addEventListener('change', event => {
      pageIds.forEach(id => event.target.checked ? selectedInventoryIds.add(id) : selectedInventoryIds.delete(id));
      tableBody.querySelectorAll('[data-select-inventory]').forEach(box => { box.checked = event.target.checked; });
      updatePublishingControls();
    });
    bulkPublish.addEventListener('click', () => {
      const ids = inventoryRows.filter(item => selectedInventoryIds.has(Number(item.id)) && !Number(item.deployed)).map(item => item.id);
      publishProducts(ids, true);
    });
    bulkUnpublish.addEventListener('click', () => {
      const ids = inventoryRows.filter(item => selectedInventoryIds.has(Number(item.id)) && Number(item.deployed)).map(item => item.id);
      publishProducts(ids, false);
    });
    if (!filteredRows.length) {
      tableBody.innerHTML = `<tr><td colspan="10"><div class="empty-state"><h3>No inventory matches</h3><p>Try another search or filter.</p></div></td></tr>`;
      updatePublishingControls();
      return;
    }
    tableBody.innerHTML = pageRows.map(item => {
      const total = Number(item.stock_quantity || 0);
      const reserved = Number(item.reserved_quantity || 0);
      const available = Number(item.available_quantity ?? Math.max(0, total - reserved));
      const integrityBadge = item.integrity_ok
        ? '<span class="badge badge-available">Reconciled</span>'
        : `<span class="badge badge-out" title="${total} physical units vs ${Number(item.batch_quantity)} in batches">Mismatch ${Number(item.integrity_difference) > 0 ? '+' : ''}${Number(item.integrity_difference)} units</span>`;
      const expiry = item.next_expiration_date ? new Date(item.next_expiration_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : 'No Expiry';
      const publishingIssues = item.publish_issues || [];
      const publishedBadge = Number(item.deployed) && Number(item.customer_visible)
          ? '<span class="badge badge-deployed">Published · customer-visible</span>'
          : Number(item.deployed)
            ? `<span class="badge badge-out" title="${escapeHtml(publishingIssues.join(' '))}">Not visible · needs attention</span>`
            : publishingIssues.length
              ? `<span class="badge badge-draft" title="${escapeHtml(publishingIssues.join(' '))}">Unpublished · needs attention</span>`
              : '<span class="badge badge-draft">Unpublished</span>';
      return `
        <tr>
          <td><input type="checkbox" data-select-inventory="${item.id}" aria-label="Select ${escapeHtml(item.medicine_name)}" ${selectedInventoryIds.has(Number(item.id)) ? 'checked' : ''} /></td>
          <td><strong>${escapeHtml(item.medicine_name)}</strong>${item.brand ? `<div class="text-sm muted">${escapeHtml(item.brand)}</div>` : ''}</td>
          <td>${escapeHtml(item.category || 'Uncategorized')}</td>
          <td>${total}</td>
          <td>${reserved}</td>
          <td><strong>${available}</strong></td>
          <td>${publishedBadge}</td>
          <td class="inventory-expiration"><span class="${item.next_expiration_date ? '' : 'inventory-no-expiry'}">${escapeHtml(expiry)}</span></td>
          <td>${integrityBadge}</td>
          <td>
            <div style="display:flex;gap:6px;justify-content:flex-end;align-items:center;">
              <details class="inventory-menu row-menu">
                <summary aria-label="Medicine actions" title="Medicine actions">${iconSvg('more', 18)}</summary>
                <div class="inventory-menu-popover">
                  <button type="button" data-action="edit" data-id="${item.id}">Edit</button>
                  <a href="/pharmacy/suppliers.html?medicine_id=${item.medicine_id}">View Suppliers</a>
                  <button type="button" data-action="stock-in" data-id="${item.id}">Stock in</button>
                  <button type="button" data-action="stock-out" data-id="${item.id}">Stock out</button>
                  <button type="button" data-action="adjust" data-id="${item.id}">Adjust stock</button>
                  ${!item.integrity_ok ? `<button type="button" data-action="reconcile" data-id="${item.id}">Reconcile batch integrity</button>` : ''}
                  ${Number(item.deployed)
                    ? `<button type="button" data-action="unpublish" data-id="${item.id}">Unpublish</button>`
                    : `<button type="button" data-action="publish" data-id="${item.id}">Publish</button>`}
                  <button type="button" data-action="return" data-id="${item.id}">Record return</button>
                  <button type="button" data-action="damaged" data-id="${item.id}">Expired / damaged</button>
                  <button type="button" class="danger-action" data-action="delete" data-id="${item.id}">Remove</button>
                </div>
              </details>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    tableBody.querySelectorAll('[data-select-inventory]').forEach(box => {
      box.addEventListener('change', () => {
        const id = Number(box.dataset.selectInventory);
        if (box.checked) selectedInventoryIds.add(id);
        else selectedInventoryIds.delete(id);
        updatePublishingControls();
      });
    });
    updatePublishingControls();
    wireOverflowMenus(table);
    document.querySelectorAll('[data-action]').forEach(button => {
      button.addEventListener('click', async () => {
        const menu = button.closest('.inventory-menu');
        if (menu) menu.open = false;
        const itemId = Number(button.dataset.id);
        const item = inventoryRows.find(row => row.id === itemId);
        if (!item) return;
        if (button.dataset.action === 'publish') {
          await publishProducts([item.id], true);
          return;
        }
        if (button.dataset.action === 'unpublish') {
          await publishProducts([item.id], false);
          return;
        }
        if (button.dataset.action === 'edit') {
          const integrityDescription = item.integrity_ok
            ? `Batch integrity: reconciled (${Number(item.batch_quantity)} batch units match ${Number(item.stock_quantity)} physical units).`
            : `Batch integrity: mismatch (${Number(item.stock_quantity)} physical units vs ${Number(item.batch_quantity)} batch units). Use “Reconcile batch integrity” to resolve this with a required reason; the field is calculated, not directly editable.`;
          const values = await appModal({
            title: `Edit ${item.medicine_name}`,
            message: `${integrityDescription} Lowest expiration updates the currently earliest-expiring stocked batch and is recorded in the audit log.`,
            fields: [
              { name: 'category', label: 'Category', value: item.category || '', type: 'text', required: true },
              { name: 'brand', label: 'Brand', value: item.brand || '', type: 'text' },
              { name: 'price', label: 'Price (₱)', value: item.price, type: 'number', min: 0, step: '0.01', required: true },
              { name: 'low_stock_threshold', label: 'Low stock threshold', value: item.low_stock_threshold, type: 'number', min: 0, step: 1, required: true },
              { name: 'expiration_date', label: 'Lowest Expiration', value: item.next_expiration_date || '', type: 'date' },
              { name: 'expiration_change_reason', label: 'Reason for expiration change (required if changed)', value: '', type: 'text' },
            ],
            confirmText: 'Save changes',
          });
          if (!values) return;
          try {
            await Api.put(`/api/pharmacy/inventory/${item.id}`, {
              category: values.category,
              brand: values.brand,
              price: Number(values.price),
              low_stock_threshold: Number(values.low_stock_threshold),
              expiration_date: values.expiration_date,
              expiration_change_reason: values.expiration_change_reason,
            });
            toast('Inventory updated.');
            load();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        if (button.dataset.action === 'reconcile') {
          const reason = await appModal({
            title: `Reconcile ${item.medicine_name}`,
            message: `Physical stock is ${Number(item.stock_quantity)} units; batches total ${Number(item.batch_quantity)}. Reconciliation changes physical stock to match the batch total and records an adjustment and audit entry.`,
            input: { label: 'Reason for reconciliation' },
            confirmText: 'Reconcile',
          });
          if (!reason || !reason.trim()) {
            if (reason !== null) toast('A reason is required to reconcile batch integrity.', 'error');
            return;
          }
          try {
            const result = await Api.post('/api/pharmacy/inventory/reconcile-batches', {
              inventory_id: item.id,
              reason: reason.trim(),
            });
            toast(`Inventory reconciled (${result.previous_quantity} → ${result.batch_quantity} units).`);
            await load();
            loadMovementHistory();
          } catch (err) { toast(err.message, 'error'); }
          return;
        }
        if (button.dataset.action === 'stock-in') {
          await performStockIn(item);
          return;
        }
        if (button.dataset.action === 'stock-out') {
          await performStockOut(item);
          return;
        }
        if (button.dataset.action === 'adjust') {
          await performAdjustment(item);
          return;
        }
        if (button.dataset.action === 'return') {
          await performReturn(item);
          return;
        }
        if (button.dataset.action === 'damaged') {
          await performDisposal(item);
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

  async function chooseProduct(preselectedId = null) {
    if (preselectedId) {
      const preselected = inventoryRows.find(item => Number(item.id) === Number(preselectedId));
      if (preselected) return preselected;
    }
    if (!inventoryRows.length) { toast('Add a product before recording a stock movement.', 'error'); return null; }
    const id = await appModal({
      title: 'Choose product',
      select: {
        label: 'Product',
        options: inventoryRows.map(item => ({
          value: item.id,
          label: `${item.medicine_name} · ${Number(item.available_quantity)} available · ${Number(item.stock_quantity)} physical`,
        })),
      },
    });
    return id == null ? null : inventoryRows.find(item => String(item.id) === String(id));
  }

  async function performStockIn(item) {
    const fields = await appModal({
      title: `Stock IN · ${item.medicine_name}`,
      fields: [
        { name: 'quantity', label: 'Quantity received', type: 'number', min: 1, max: 1000000, step: 1, value: 1, required: true },
        { name: 'batch_number', label: 'Batch number', value: `LOT-${Date.now().toString().slice(-6)}`, required: true },
        {
          name: 'supplier_id',
          label: 'Supplier',
          placeholder: 'No supplier selected',
          value: new URLSearchParams(window.location.search).get('supplier_id') || '',
          options: allSuppliers.filter(supplier => supplier.status === 'active')
            .map(supplier => ({ value: supplier.id, label: supplier.name })),
        },
        { name: 'purchase_price', label: 'Purchase price per unit', type: 'number', min: 0, step: '0.01' },
        { name: 'selling_price', label: 'Selling price per unit', type: 'number', min: 0, step: '0.01', value: item.price },
        { name: 'manufacturing_date', label: 'Manufacturing date', type: 'date' },
        { name: 'expiration_date', label: 'Expiration date', type: 'date' },
        { name: 'supplier_reference', label: 'Supplier reference' },
        { name: 'storage_location', label: 'Storage location' },
        { name: 'remarks', label: 'Notes', type: 'textarea', rows: 3, maxLength: 1000 },
      ],
      confirmText: 'Receive stock',
    });
    if (!fields) return;
    try {
      await Api.post('/api/pharmacy/inventory/stock-in', {
        inventory_id: item.id,
        quantity: fields.quantity,
        supplier_id: fields.supplier_id || null,
        purchase_price: fields.purchase_price === '' ? null : fields.purchase_price,
        selling_price: fields.selling_price === '' ? null : fields.selling_price,
        batch_number: fields.batch_number,
        manufacturing_date: fields.manufacturing_date || null,
        expiration_date: fields.expiration_date || null,
        supplier_reference: fields.supplier_reference,
        storage_location: fields.storage_location,
        reason: 'stock_in',
        remarks: fields.remarks,
      });
      toast(`Stock IN recorded. +${fields.quantity} units.`);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function performStockOut(item, batch = null, initialReason = '') {
    const available = Number(item.available_quantity ?? item.stock_quantity);
    const today = new Date().toISOString().slice(0, 10);
    const stockedBatches = allBatches.filter(row => Number(row.inventory_id) === Number(item.id)
      && Number(row.current_quantity) > 0
      && !['depleted', 'recalled', 'archived'].includes(row.status));
    const expiredBatches = stockedBatches.filter(row => row.status === 'expired'
      || (row.expiration_date && row.expiration_date < today));
    if (initialReason === 'expired' && !batch) {
      if (!expiredBatches.length) { toast('There are no expired batches available for disposal.', 'error'); return; }
      const batchId = await appModal({
        title: `Choose expired batch · ${item.medicine_name}`,
        select: {
          label: 'Batch',
          options: expiredBatches.map(row => ({
            value: row.id,
            label: `${row.batch_number} · ${row.current_quantity} units · ${row.expiration_date || 'no expiry'}`,
          })),
        },
      });
      if (batchId == null) return;
      batch = expiredBatches.find(row => String(row.id) === String(batchId));
    }
    const expiredBatchSelected = batch && (batch.status === 'expired'
      || (batch.expiration_date && batch.expiration_date < today));
    if (initialReason !== 'expired' && available < 1) {
      toast('No unreserved, unexpired batch stock is available for this movement.', 'error');
      return;
    }
    if (initialReason === 'expired' && !expiredBatchSelected) {
      toast('Select an expired batch to record expired stock.', 'error');
      return;
    }
    const max = initialReason === 'expired'
      ? Math.min(Math.max(0, Number(item.stock_quantity) - Number(item.reserved_quantity || 0)), Number(batch.current_quantity))
      : available;
    if (max < 1) { toast('No unreserved stock is available for this movement.', 'error'); return; }
    const fields = await appModal({
      title: `Stock OUT · ${item.medicine_name}`,
      fields: [
        { name: 'quantity', label: `Quantity to remove (max ${max})`, type: 'number', min: 1, max, step: 1, value: 1, required: true },
        {
          name: 'reason',
          label: 'Reason',
          value: initialReason,
          required: true,
          options: expiredBatchSelected
            ? [{ value: 'expired', label: 'Expired' }]
            : [
              { value: 'sold', label: 'Sold' },
              { value: 'damaged', label: 'Damaged' },
              { value: 'returned', label: 'Returned to supplier' },
              { value: 'lost', label: 'Lost' },
              { value: 'other', label: 'Other' },
            ],
        },
        { name: 'reference_number', label: 'Reference number' },
        { name: 'remarks', label: 'Notes', type: 'textarea', rows: 3, maxLength: 1000 },
      ],
      confirmText: 'Record stock out',
      danger: true,
    });
    if (!fields) return;
    try {
      await Api.post('/api/pharmacy/inventory/stock-out', {
        inventory_id: item.id,
        quantity: fields.quantity,
        batch_id: fields.reason === 'expired' ? batch.id : undefined,
        reason: fields.reason,
        reference_number: fields.reference_number,
        remarks: fields.remarks,
      });
      toast(`${fields.reason} stock-out recorded. -${fields.quantity} units.`);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function performAdjustment(item) {
    const values = await appModal({
      title: `Adjust stock · ${item.medicine_name}`,
      fields: [
        { name: 'adjustment', label: 'Adjustment (+ or - whole units)', type: 'number', step: 1, required: true },
        { name: 'reason', label: 'Reason for physical count difference', required: true },
      ],
      confirmText: 'Record adjustment',
    });
    if (!values) return;
    try {
      await Api.post('/api/pharmacy/inventory/adjust', {
        inventory_id: item.id,
        adjustment: Number(values.adjustment),
        reason: values.reason,
        remarks: 'Adjustment recorded in Inventory Center',
      });
      toast(`Stock adjustment recorded (${values.adjustment} units).`);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function performReturn(item) {
    const quantity = await appModal({ title: `Return · ${item.medicine_name}`, quantity: { label: 'Quantity returned to stock', value: 1, max: 10000 }, confirmText: 'Continue' });
    if (quantity == null) return;
    const fields = await appModal({
      title: 'Record returned batch',
      fields: [{ name: 'batch_number', label: 'Batch number', required: true }],
      confirmText: 'Record return',
    });
    if (!fields) return;
    try {
      await Api.post('/api/pharmacy/inventory/stock-in', {
        inventory_id: item.id, quantity, batch_number: fields.batch_number,
        transaction_type: 'return', remarks: 'Returned stock recorded in Inventory Center',
      });
      toast(`Return recorded. +${quantity} units.`);
      await load();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function performDisposal(item) {
    const today = new Date().toISOString().slice(0, 10);
    const batches = allBatches.filter(batch => Number(batch.inventory_id) === Number(item.id)
      && Number(batch.current_quantity) > 0
      && (batch.status === 'expired' || (batch.expiration_date && batch.expiration_date < today)));
    if (!batches.length) { toast('This product has no stocked batch to dispose.', 'error'); return; }
    const batchId = await appModal({
      title: `Expired / damaged · ${item.medicine_name}`,
      select: { label: 'Batch to dispose', options: batches.map(batch => ({ value: batch.id, label: `${batch.batch_number} · ${batch.current_quantity} units · ${batch.expiration_date || 'no expiry'}` })) },
    });
    if (batchId == null) return;
    const batch = batches.find(row => String(row.id) === String(batchId));
    await performStockOut(item, batch, 'expired');
  }

  function bindQuickActions() {
    if (document.body.dataset.inventoryActionsBound === 'true') return;
    document.body.dataset.inventoryActionsBound = 'true';
    const requestedInventoryId = new URLSearchParams(window.location.search).get('inventory_id');
    document.getElementById('stock-in-btn')?.addEventListener('click', async () => {
      const item = await chooseProduct(requestedInventoryId);
      if (item) await performStockIn(item);
    });
    document.getElementById('stock-out-btn')?.addEventListener('click', async () => {
      const item = await chooseProduct(requestedInventoryId);
      if (item) await performStockOut(item);
    });
    document.getElementById('adjust-stock-btn')?.addEventListener('click', async () => {
      const item = await chooseProduct(requestedInventoryId);
      if (item) await performAdjustment(item);
    });
    document.getElementById('return-stock-btn')?.addEventListener('click', async () => {
      const item = await chooseProduct(requestedInventoryId);
      if (item) await performReturn(item);
    });
    document.getElementById('damaged-stock-btn')?.addEventListener('click', async () => {
      const item = await chooseProduct(requestedInventoryId);
      if (item) await performDisposal(item);
    });
    const resetInventoryPage = () => { inventoryPage = 1; render(); };
    document.getElementById('inventory-search')?.addEventListener('input', resetInventoryPage);
    document.getElementById('inventory-category-filter')?.addEventListener('change', resetInventoryPage);
    document.getElementById('inventory-status-filter')?.addEventListener('change', resetInventoryPage);
  }

  function render() {
    renderSummaryCards();
    renderInventoryFilterOptions();
    if (document.getElementById('inventory-table')) renderInventoryTable();
    if (!allFolders.length && !inventoryRows.filter(r => !r.folder_id).length) {
      foldersList.innerHTML = `<div class="empty-state"><div class="icon">&#128193;</div><h3>No folders yet</h3><p>Create a folder to organize products. Publish products individually or publish all valid products in a folder.</p></div>`;
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
      document.getElementById('deployed-count').textContent = `${data.deployedStats.deployedCount} product(s) marked published`;
      if (!data.history.length) {
        box.innerHTML = `<div class="empty-state" style="padding:24px;"><p class="text-sm">No publishing activity found.</p></div>`;
        return;
      }
      box.innerHTML = data.history.map(h => `
        <div class="deploy-history-item" style="align-items:flex-start;">
          <div class="flex items-center gap-8">
            <span class="deploy-dot ${h.action === 'deployed' ? 'on' : 'off'}"></span>
            <div>
              <div style="font-weight:600">${escapeHtml(h.folder_name)}</div>
              <div class="text-sm muted">${h.action === 'deployed' ? 'Published' : 'Unpublished'} &middot; ${h.product_count} product(s)</div>
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
      allSuppliers = invData.suppliers || [];
      inventoryRows = invData.inventory;
      const existingInventoryIds = new Set(inventoryRows.map(item => Number(item.id)));
      selectedInventoryIds.forEach(id => { if (!existingInventoryIds.has(id)) selectedInventoryIds.delete(id); });
      allBatches = invData.batches || [];
      document.getElementById('inventory-error').innerHTML = '';
      renderAddForm();
      if (new URLSearchParams(window.location.search).get('add') === '1') {
        addForm.style.display = 'block';
        addForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      const folderFilter = document.getElementById('filter-folder');
      folderFilter.innerHTML = `<option value="">All folders</option>${allFolders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('')}`;

      const params = new URLSearchParams(window.location.search);
      const productId = params.get('product_id');
      const medicineId = params.get('medicine_id');
      if (productId) {
        const product = inventoryRows.find(item => Number(item.id) === Number(productId));
        if (product) document.getElementById('inventory-search').value = product.medicine_name;
      } else if (medicineId) {
        const product = inventoryRows.find(item => Number(item.medicine_id) === Number(medicineId));
        if (product) document.getElementById('inventory-search').value = product.medicine_name;
      }
      const requestedStatus = params.get('status');
      if (['available', 'low', 'out'].includes(requestedStatus)) {
        document.getElementById('inventory-status-filter').value = requestedStatus;
      }
      const requestedAction = params.get('action');
      bindQuickActions();
      render();
      renderBatchSections();
      loadMovementHistory();
      const requestedTab = params.get('tab');
      activateInventoryTab(requestedAction ? 'movements' : params.has('expiry') ? 'expiration' : requestedTab || 'products');
      if (['stock-in', 'stock-out'].includes(requestedAction)) {
        params.delete('action');
        const query = params.toString();
        window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
        window.setTimeout(() => document.getElementById(`${requestedAction}-btn`)?.click(), 0);
      }
    } catch (err) {
      document.getElementById('inventory-error').innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  async function loadMovementHistory() {
    const box = document.getElementById('inventory-movements');
    try {
      const data = await Api.get('/api/pharmacy/inventory/history');
      renderMovementHistory(data.history || []);
    } catch (err) {
      box.innerHTML = `<div class="alert alert-error">${escapeHtml(err.message)}</div>`;
    }
  }

  function activateInventoryTab(tabName) {
    const validTabs = ['products', 'movements', 'batches', 'expiration', 'publishing'];
    const active = validTabs.includes(tabName) ? tabName : 'products';
    document.querySelectorAll('[data-inventory-tab]').forEach(button => {
      const selected = button.dataset.inventoryTab === active;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll('[data-inventory-panel]').forEach(panel => {
      panel.hidden = panel.dataset.inventoryPanel !== active;
    });
  }

  document.querySelectorAll('[data-inventory-tab]').forEach((button, index, buttons) => {
    button.addEventListener('click', () => activateInventoryTab(button.dataset.inventoryTab));
    button.addEventListener('keydown', event => {
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      const direction = event.key === 'ArrowRight' ? 1 : -1;
      const next = buttons[(index + direction + buttons.length) % buttons.length];
      activateInventoryTab(next.dataset.inventoryTab);
      next.focus();
    });
  });

  document.getElementById('filter-month').addEventListener('change', loadDeployHistory);
  document.getElementById('filter-folder').addEventListener('change', loadDeployHistory);
  let qTimer;
  document.getElementById('filter-q').addEventListener('input', () => { clearTimeout(qTimer); qTimer = setTimeout(loadDeployHistory, 300); });

  load();
  loadDeployHistory();
})();
