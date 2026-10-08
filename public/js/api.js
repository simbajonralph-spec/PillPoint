// api.js — thin fetch wrapper for the PillPoint REST API
const Api = {
  async request(method, url, body) {
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      cache: 'no-store',
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = {};
    try { data = await res.json(); } catch (e) { /* empty body */ }
    if (!res.ok) {
      const err = new Error(data.error || 'Request failed');
      err.status = res.status;
      throw err;
    }
    return data;
  },
  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
  del(url) { return this.request('DELETE', url); },
};

function toast(message, type = 'ok') {
  let box = document.getElementById('toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  const item = document.createElement('div');
  item.className = `toast-item ${type}`;
  item.textContent = message;
  box.appendChild(item);
  setTimeout(() => item.remove(), 3500);
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, s => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[s]));
}

function money(n) {
  return '₱' + Number(n).toFixed(2);
}

function statusBadge(status) {
  return `<span class="badge badge-${status}">${escapeHtml(status)}</span>`;
}

function stockBadge(qty, threshold) {
  if (qty === 0) return '<span class="badge badge-out">Out of Stock</span>';
  if (qty <= (threshold ?? 10)) return '<span class="badge badge-low">Low Stock</span>';
  return '<span class="badge badge-available">Available</span>';
}

const PIE_COLORS = ['#14B8A6', '#0B1220', '#F59E0B', '#3B82F6', '#EF4444', '#8B5CF6'];

// Builds an inline SVG pie/donut chart + legend markup from [{label, value}].
// Pure vanilla SVG (no chart library) so it works with the no-build-step frontend.
function pieChartSvg(items, opts = {}) {
  const size = opts.size || 180;
  const r = size / 2;
  const inner = opts.donut ? r * 0.55 : 0;
  const total = items.reduce((s, i) => s + i.value, 0);

  if (!total) {
    return `<div class="empty-state" style="padding:24px;"><p class="text-sm">No data yet</p></div>`;
  }

  let angle = -90; // start at 12 o'clock
  const slices = items.map((item, idx) => {
    const color = item.color || PIE_COLORS[idx % PIE_COLORS.length];
    const fraction = item.value / total;
    const startAngle = angle;
    const endAngle = angle + fraction * 360;
    angle = endAngle;

    const toXY = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return [r + r * Math.cos(rad), r + r * Math.sin(rad)];
    };
    const [x1, y1] = toXY(startAngle);
    const [x2, y2] = toXY(endAngle);
    const largeArc = fraction > 0.5 ? 1 : 0;

    // Full circle edge case (single slice = 100%)
    if (fraction >= 0.999) {
      return `<circle cx="${r}" cy="${r}" r="${r}" fill="${color}" />`;
    }

    return `<path d="M ${r} ${r} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z" fill="${color}" stroke="#fff" stroke-width="1.5" />`;
  }).join('');

  const donutHole = inner ? `<circle cx="${r}" cy="${r}" r="${inner}" fill="#fff" />` : '';

  const legend = items.map((item, idx) => {
    const color = item.color || PIE_COLORS[idx % PIE_COLORS.length];
    const pct = Math.round((item.value / total) * 100);
    return `
      <div class="flex items-center gap-8" style="margin-bottom:8px;">
        <span style="width:11px;height:11px;border-radius:3px;background:${color};flex-shrink:0;display:inline-block;"></span>
        <span class="text-sm" style="flex:1;">${escapeHtml(item.label)}</span>
        <span class="text-sm muted" style="font-weight:700;">${item.value} &middot; ${pct}%</span>
      </div>`;
  }).join('');

  return `
    <div class="flex items-center gap-12" style="flex-wrap:wrap;">
      <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" style="flex-shrink:0;">
        ${slices}
        ${donutHole}
      </svg>
      <div style="flex:1;min-width:160px;">${legend}</div>
    </div>
  `;
}

// Builds a pseudo-3D "tilted" pie/donut chart from [{label, value}] — same flat
// SVG pie as pieChartSvg, but rendered on a tilted plane with a grounding
// shadow and drop-shadow so it reads as a 3D disc rather than a flat circle.
// Pure CSS 3D transform (no chart library), so it still works with the
// no-build-step frontend.
// Renders a Monday→Sunday reservation-activity bar chart from parallel
// labels/counts arrays (as returned by /dashboard and /analytics).
function weekdayBarChart(labels, counts) {
  const max = Math.max(1, ...counts);
  return `
    <div class="weekday-chart">
      ${labels.map((label, i) => {
        const count = counts[i] || 0;
        const pct = Math.max(4, Math.round((count / max) * 100));
        return `
          <div class="weekday-col">
            <div class="weekday-count">${count}</div>
            <div class="weekday-bar" style="height:${pct}%;"></div>
            <div class="weekday-label">${label}</div>
          </div>`;
      }).join('')}
    </div>
  `;
}

function pieChart3D(items, opts = {}) {
  const size = opts.size || 200;
  const r = size / 2;
  const inner = opts.donut === false ? 0 : r * 0.5;
  const total = items.reduce((s, i) => s + i.value, 0);

  if (!total) {
    return `<div class="empty-state" style="padding:24px;"><p class="text-sm">No data yet</p></div>`;
  }

  let angle = -90;
  const slices = items.map((item, idx) => {
    const color = item.color || PIE_COLORS[idx % PIE_COLORS.length];
    const fraction = item.value / total;
    const startAngle = angle;
    const endAngle = angle + fraction * 360;
    angle = endAngle;
    const toXY = (deg) => {
      const rad = (deg * Math.PI) / 180;
      return [r + r * Math.cos(rad), r + r * Math.sin(rad)];
    };
    const [x1, y1] = toXY(startAngle);
    const [x2, y2] = toXY(endAngle);
    const largeArc = fraction > 0.5 ? 1 : 0;
    if (fraction >= 0.999) {
      return `<circle cx="${r}" cy="${r}" r="${r}" fill="${color}" />`;
    }
    return `<path d="M ${r} ${r} L ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)} Z" fill="${color}" stroke="rgba(255,255,255,0.55)" stroke-width="1.5" />`;
  }).join('');

  const donutHole = inner ? `<circle cx="${r}" cy="${r}" r="${inner}" fill="#fff" />` : '';

  const legend = items.map((item, idx) => {
    const color = item.color || PIE_COLORS[idx % PIE_COLORS.length];
    const pct = Math.round((item.value / total) * 100);
    return `
      <div class="flex items-center gap-8" style="margin-bottom:8px;">
        <span style="width:11px;height:11px;border-radius:3px;background:${color};flex-shrink:0;display:inline-block;"></span>
        <span class="text-sm" style="flex:1;">${escapeHtml(item.label)}</span>
        <span class="text-sm muted" style="font-weight:700;">${item.value} &middot; ${pct}%</span>
      </div>`;
  }).join('');

  return `
    <div class="pie3d-wrap">
      <div style="width:${size}px;flex-shrink:0;">
        <div class="pie3d-stage" style="width:${size}px;height:${size}px;perspective:700px;">
          <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"
               style="display:block;transform:rotateX(48deg) rotateZ(0deg);transform-style:preserve-3d;">
            ${slices}
            ${donutHole}
          </svg>
        </div>
        ${opts.shadow === false ? '' : '<div class="pie3d-shadow"></div>'}
      </div>
      <div style="flex:1;min-width:160px;">${legend}</div>
    </div>
  `;
}

const ICON_PATHS = {
  activity: '<path d="M3 12h4l3-9 4 18 3-9h4"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 7h1m4 0h1m-6 4h1m4 0h1m-6 4h1m4 0h1M10 21v-3h4v3"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18"/>',
  camera: '<path d="M14 4h-4L8 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-4z"/><circle cx="12" cy="13" r="3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9m-5 8V5m-5 12v-4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4.5V3h6v1.5M9 10h6m-6 4h6m-6 4h3"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  close: '<path d="m18 6-12 12M6 6l12 12"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="m3 3 18 18M10.6 10.6a2 2 0 0 0 2.8 2.8"/><path d="M9.9 5.2A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a16 16 0 0 1-3.1 3.8M6.2 6.2C3.5 8 2 12 2 12s3.6 7 10 7c1 0 1.9-.2 2.8-.5"/>',
  folder: '<path d="M3 6a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  home: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1z"/>',
  map: '<path d="m3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3z"/><path d="M9 3v15m6-12v15"/>',
  package: '<path d="m12 3 9 5-9 5-9-5z"/><path d="M3 8v9l9 5 9-5V8m-9 5v9"/>',
  pill: '<path d="m10.5 20.5 10-10a6.4 6.4 0 0 0-9-9l-10 10a6.4 6.4 0 0 0 9 9Z"/><path d="m8.5 8.5 7 7"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
  triangle: '<path d="m10.3 3.9-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.1l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4m0 4h.01"/>',
  user: '<path d="M20 21a8 8 0 0 0-16 0"/><circle cx="12" cy="8" r="4"/>',
  wallet: '<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18m-5 5h2"/>',
  xcircle: '<circle cx="12" cy="12" r="10"/><path d="m15 9-6 6m0-6 6 6"/>',
  pin: '<path d="M20 10c0 5-8 12-8 12S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  ban: '<circle cx="12" cy="12" r="10"/><path d="m5 5 14 14"/>',
  logout: '<path d="M10 17l5-5-5-5m5 5H3"/><path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14m-7-7h14"/>',
};

const EMOJI_ICON_NAMES = {
  0x229e: 'home', 0x1f50d: 'search', 0x1f4cb: 'clipboard', 0x1f514: 'bell',
  0x1f464: 'user', 0x1f489: 'pill', 0x1f3e6: 'building', 0x2705: 'check',
  0x23f3: 'clock', 0x1f6ab: 'ban', 0x26a0: 'triangle', 0x1f4b0: 'wallet',
  0x1f4cd: 'pin', 0x1f4e6: 'package', 0x1f4ca: 'chart', 0x274c: 'xcircle',
  0x1f4c1: 'folder', 0x25b8: 'chevron', 0x1f441: 'eye', 0x1f440: 'eye-off',
  0x1f4f7: 'camera', 0x1f4c5: 'calendar', 0x8630: 'logout',
};

function iconSvg(name, size = 20) {
  const paths = ICON_PATHS[name] || ICON_PATHS.activity;
  return `<svg data-ui-icon="${escapeHtml(name)}" xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`;
}

function enhanceAppDom(root = document) {
  const iconSelector = '.icon, .stat-icon, .folder-icon, .folder-chevron, .store-photo-placeholder, .password-toggle, .topbar-icon, .topbar-profile';
  const iconElements = [];
  if (root instanceof Element && root.matches(iconSelector)) iconElements.push(root);
  if (root.querySelectorAll) iconElements.push(...root.querySelectorAll(iconSelector));
  iconElements.forEach(element => {
    if (element.querySelector('svg[data-ui-icon]')) return;
    const glyph = element.textContent.trim();
    const name = glyph ? EMOJI_ICON_NAMES[glyph.codePointAt(0)] : null;
    if (name) {
      const size = element.closest('.photo-upload-box') ? 26
        : element.closest('.empty-state') ? 40
          : element.closest('.account-type-card') ? 22
            : element.classList.contains('stat-icon') || element.classList.contains('folder-icon') ? 20
              : 18;
      element.innerHTML = iconSvg(name, size);
    }
  });

  const fields = [];
  if (root instanceof Element && root.matches('.field')) fields.push(root);
  if (root.querySelectorAll) fields.push(...root.querySelectorAll('.field'));
  fields.forEach(field => {
    const label = field.querySelector('label:not([for])');
    const control = field.querySelector('input, select, textarea');
    if (!label || !control) return;
    if (!control.id) control.id = `field-control-${Math.random().toString(36).slice(2, 10)}`;
    label.htmlFor = control.id;
  });

  const tables = [];
  if (root instanceof Element && root.matches('table')) tables.push(root);
  if (root.querySelectorAll) tables.push(...root.querySelectorAll('table'));
  tables.forEach(table => {
    const headers = [...table.querySelectorAll('thead th')].map(header => header.textContent.trim());
    table.querySelectorAll('tbody tr').forEach(row => {
      [...row.cells].forEach((cell, index) => {
        if (!cell.hasAttribute('data-label') && !cell.hasAttribute('colspan') && headers[index]) cell.dataset.label = headers[index];
      });
    });
  });

  const controls = [];
  if (root instanceof Element && root.matches('input, select, textarea')) controls.push(root);
  if (root.querySelectorAll) controls.push(...root.querySelectorAll('input, select, textarea'));
  controls.forEach(control => {
    if (control.labels && control.labels.length || control.hasAttribute('aria-label')) return;
    const fieldLabel = control.closest('.field')?.querySelector('label');
    const labelText = fieldLabel?.textContent.trim() || control.closest('td')?.dataset.label || control.placeholder || control.name || 'Form control';
    if (!control.id) control.id = `field-control-${Math.random().toString(36).slice(2, 10)}`;
    const label = document.createElement('label');
    label.className = 'sr-only';
    label.htmlFor = control.id;
    label.textContent = labelText;
    control.parentElement.insertBefore(label, control);
  });
}

if (typeof document !== 'undefined' && document.body) {
  enhanceAppDom(document);
  new MutationObserver(records => {
    records.forEach(record => record.addedNodes.forEach(node => {
      if (node.nodeType === Node.ELEMENT_NODE) enhanceAppDom(node);
    }));
  }).observe(document.body, { childList: true, subtree: true });
}

function skeletonLoader(type = 'table', count = 4) {
  const items = Array.from({ length: count }, () => type === 'cards'
    ? `<div class="skeleton-card" aria-hidden="true"><span class="skeleton-line wide"></span><span class="skeleton-line"></span><span class="skeleton-line"></span></div>`
    : `<div class="skeleton-row" aria-hidden="true">${Array.from({ length: 4 }, (_, index) => `<span class="skeleton-line ${index === 0 ? 'wide' : ''}"></span>`).join('')}</div>`
  ).join('');
  return `<div class="skeleton-loader ${type === 'cards' ? 'skeleton-cards' : 'skeleton-table'}" role="status" aria-label="Loading">${items}<span class="sr-only">Loading</span></div>`;
}

function appModal(options = {}) {
  const dialog = getAppDialog();
  const quantity = options.quantity;
  const textInput = options.input;
  const selectInput = options.select;
  const formFields = options.fields;
  const content = options.message ? `<p class="app-modal-message">${escapeHtml(options.message)}</p>` : '';
  let control = '';
  if (quantity) {
    control = `
      <div class="field app-modal-field">
        <label for="app-modal-quantity">${escapeHtml(quantity.label || 'Quantity')}</label>
        <div class="quantity-stepper">
          <button class="stepper-btn" type="button" data-step="-1" aria-label="Decrease quantity">${iconSvg('minus', 16)}</button>
          <input id="app-modal-quantity" type="number" min="1" max="${Number(quantity.max)}" step="1" value="${Number(quantity.value || 1)}" required />
          <button class="stepper-btn" type="button" data-step="1" aria-label="Increase quantity">${iconSvg('plus', 16)}</button>
        </div>
        <div class="text-sm muted" id="app-modal-hint">${escapeHtml(quantity.hint || `${quantity.max} available`)}</div>
        ${quantity.unitPrice != null ? `<div class="reservation-total"><span>Estimated total</span><strong id="app-modal-total">${money(Number(quantity.value || 1) * Number(quantity.unitPrice))}</strong></div>` : ''}
      </div>`;
  } else if (textInput) {
    control = `
      <div class="field app-modal-field">
        <label for="app-modal-input">${escapeHtml(textInput.label || 'Name')}</label>
        <input id="app-modal-input" type="text" value="${escapeHtml(textInput.value || '')}" maxlength="120" required />
      </div>`;
  } else if (selectInput) {
    control = `
      <div class="field app-modal-field">
        <label for="app-modal-select">${escapeHtml(selectInput.label || 'Choose an option')}</label>
        <select id="app-modal-select" required>
          <option value="">Select a destination</option>
          ${(selectInput.options || []).map(option => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(selectInput.value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
        </select>
      </div>`;
  } else if (formFields) {
    control = formFields.map(field => {
      const id = `app-modal-field-${escapeHtml(field.name)}`;
      const required = field.required ? ' required' : '';
      const input = field.options
        ? `<select id="${id}" name="${escapeHtml(field.name)}"${required}>
            ${!field.required ? `<option value="">${escapeHtml(field.placeholder || 'None')}</option>` : `<option value="">${escapeHtml(field.placeholder || 'Select an option')}</option>`}
            ${field.options.map(option => `<option value="${escapeHtml(option.value)}" ${String(option.value) === String(field.value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>`).join('')}
          </select>`
        : field.type === 'textarea'
          ? `<textarea id="${id}" name="${escapeHtml(field.name)}" rows="${Number(field.rows || 3)}" maxlength="${Number(field.maxLength || 1000)}"${required}>${escapeHtml(field.value ?? '')}</textarea>`
          : `<input id="${id}" name="${escapeHtml(field.name)}" type="${escapeHtml(field.type || 'text')}" value="${escapeHtml(field.value ?? '')}"${field.min != null ? ` min="${Number(field.min)}"` : ''}${field.max != null ? ` max="${Number(field.max)}"` : ''}${field.step != null ? ` step="${escapeHtml(field.step)}"` : ''}${required} />`;
      return `<div class="field app-modal-field"><label for="${id}">${escapeHtml(field.label || field.name)}</label>${input}</div>`;
    }).join('');
  }

  dialog.innerHTML = `
    <form class="app-modal-form" novalidate>
      <div class="app-modal-head">
        <h2 id="app-modal-title">${escapeHtml(options.title || 'Please confirm')}</h2>
        <button class="dialog-close" type="button" data-modal-close aria-label="Close">${iconSvg('close', 20)}</button>
      </div>
      ${content}
      ${control}
      <div class="app-modal-actions">
        <button class="btn btn-outline" type="button" data-modal-cancel>${escapeHtml(options.cancelText || 'Cancel')}</button>
        <button class="btn ${options.danger ? 'btn-danger' : 'btn-primary'}" type="submit">${escapeHtml(options.confirmText || 'Confirm')}</button>
      </div>
    </form>`;

  return new Promise(resolve => {
    let settled = false;
    let confirmed = false;
    let result = null;
    const settle = value => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const closeOnBackdrop = event => {
      if (event.target === dialog) dialog.close();
    };
    dialog.addEventListener('close', () => {
      dialog.removeEventListener('click', closeOnBackdrop);
      document.removeEventListener('keydown', closeOnEscape, true);
      dialog.removeEventListener('cancel', closeOnCancel);
      settle(confirmed ? result : null);
    }, { once: true });
    const closeOnEscape = event => {
      if (event.key === 'Escape' && dialog.open) {
        event.preventDefault();
        dialog.close();
      }
    };
    const closeOnCancel = event => {
      event.preventDefault();
      dialog.close();
    };
    document.addEventListener('keydown', closeOnEscape, true);
    dialog.addEventListener('cancel', closeOnCancel);
    dialog.querySelector('[data-modal-close]').addEventListener('click', () => dialog.close());
    dialog.querySelector('[data-modal-cancel]').addEventListener('click', () => dialog.close());
    dialog.addEventListener('click', closeOnBackdrop);
    const quantityInput = dialog.querySelector('#app-modal-quantity');
    if (quantityInput) quantityInput.addEventListener('input', () => {
      quantityInput.setCustomValidity('');
      const total = dialog.querySelector('#app-modal-total');
      if (total) total.textContent = money(Number(quantityInput.value || 0) * Number(quantity.unitPrice));
    });
    dialog.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
      const input = dialog.querySelector('#app-modal-quantity');
      input.value = Math.min(Number(input.max), Math.max(1, Number(input.value || 1) + Number(button.dataset.step)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }));
    dialog.querySelector('form').addEventListener('submit', event => {
      event.preventDefault();
      let value = true;
      if (quantity) {
        const input = dialog.querySelector('#app-modal-quantity');
        const number = Number(input.value);
        if (!Number.isInteger(number) || number < 1 || number > Number(input.max)) {
          input.setCustomValidity(`Enter a quantity from 1 to ${input.max}.`);
          input.reportValidity();
          return;
        }
        value = number;
      } else if (textInput) {
        value = dialog.querySelector('#app-modal-input').value.trim();
        if (!value) {
          dialog.querySelector('#app-modal-input').reportValidity();
          return;
        }
      } else if (selectInput) {
        value = dialog.querySelector('#app-modal-select').value;
        if (!value) {
          dialog.querySelector('#app-modal-select').reportValidity();
          return;
        }
      } else if (formFields) {
        value = {};
        for (const field of formFields) {
          const input = dialog.querySelector(`#app-modal-field-${CSS.escape(field.name)}`);
          if (!input.checkValidity()) {
            input.reportValidity();
            return;
          }
          value[field.name] = field.type === 'number' && input.value !== '' ? Number(input.value) : input.value;
        }
      }
      confirmed = true;
      result = value;
      dialog.close();
    });
    dialog.showModal();
    const autofocus = dialog.querySelector(quantity ? '#app-modal-quantity' : textInput ? '#app-modal-input' : selectInput ? '#app-modal-select' : formFields ? `#app-modal-field-${CSS.escape(formFields[0].name)}` : '[type="submit"]');
    autofocus.focus();
  });
}

function getAppDialog() {
  let dialog = document.getElementById('app-modal');
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.id = 'app-modal';
    dialog.className = 'app-modal';
    dialog.setAttribute('aria-labelledby', 'app-modal-title');
    document.body.appendChild(dialog);
  }
  return dialog;
}
