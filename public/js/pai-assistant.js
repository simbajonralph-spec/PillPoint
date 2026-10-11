(function () {
  const ICON_URL = '/img/pai-icon.jpg';
  const ROLE_LABELS = {
    customer: 'Customer assistant',
    pharmacy_staff: 'Pharmacy assistant',
    admin: 'Admin assistant',
  };
  const ROLE_ENDPOINTS = {
    pharmacy_staff: '/api/pai/pharmacy-assistant',
    admin: '/api/pai/admin-assistant',
  };

  function makeIconFallback(image) {
    image.addEventListener('error', () => {
      image.hidden = true;
      const fallback = image.parentElement.querySelector('.pai-icon-fallback');
      if (fallback) fallback.hidden = false;
    }, { once: true });
  }

  function appendTextMessage(log, role, text) {
    const bubble = document.createElement('div');
    bubble.className = `pai-chat-message pai-chat-message-${role}`;
    bubble.textContent = text;
    log.appendChild(bubble);
    log.scrollTop = log.scrollHeight;
    return bubble;
  }

  function appendResponseNotice(log, text) {
    if (!text) return;
    const notice = document.createElement('div');
    notice.className = 'pai-chat-notice';
    notice.setAttribute('role', 'status');
    notice.textContent = text;
    log.appendChild(notice);
    log.scrollTop = log.scrollHeight;
  }

  function appendResponseProvenance(log, result) {
    const notice = result?.notice || (result?.source === 'ai'
      ? 'AI-generated explanation based on current PillPoint data.'
      : result?.source === 'deterministic'
        ? 'Based on current PillPoint data.'
        : '');
    appendResponseNotice(log, notice);
  }

  async function reviewReservation(log, item, quantity, trigger) {
    if (trigger?.disabled) return;
    if (trigger) trigger.disabled = true;
    const available = Number(item.available_quantity ?? item.available_stock ?? 0);
    if (!Number.isInteger(available) || available < 1) {
      appendTextMessage(log, 'assistant', 'That listing no longer shows available stock. Search again to refresh availability.');
      if (trigger) trigger.disabled = false;
      return;
    }
    let placed = false;
    try {
      const confirmedQuantity = await appModal({
        title: 'Review reservation',
        message: `${item.medicine_name} at ${item.pharmacy_name} is listed at ${money(item.price)} each. There are ${available} currently available. No reservation is created until you confirm.`,
        quantity: {
          label: 'Quantity',
          max: available,
          value: Math.min(Math.max(Number(quantity) || 1, 1), available),
          hint: `${available} currently available`,
          unitPrice: Number(item.price),
        },
        confirmText: 'Confirm reservation',
      });
      if (!confirmedQuantity) return;
      await Api.post('/api/customer/reservations', {
        inventory_id: item.inventory_id,
        quantity: confirmedQuantity,
      });
      placed = true;
      if (trigger) {
        trigger.dataset.reserved = 'true';
        trigger.textContent = 'Reservation placed';
      }
      appendTextMessage(log, 'assistant', 'Reservation placed. Check My Reservations for its status.');
    } catch (error) {
      appendTextMessage(log, 'assistant', error.message || 'The reservation could not be placed. Refresh the listing and try again.');
    } finally {
      if (trigger && !placed) trigger.disabled = false;
    }
  }

  function appendListingResults(log, results, quantity = 1) {
    if (!Array.isArray(results) || !results.length) return;
    const list = document.createElement('ul');
    list.className = 'pai-chat-listings';
    results.slice(0, 4).forEach(item => {
      const row = document.createElement('li');
      const medicine = document.createElement('strong');
      medicine.textContent = item.medicine_name || 'Medicine listing';
      const details = document.createElement('span');
      details.textContent = `${item.pharmacy_name || 'Verified pharmacy'} | ${money(item.price)} | ${Number(item.available_quantity ?? item.available_stock ?? 0)} available | ${Number(item.stock_quantity ?? 0)} physical | ${Number(item.reserved_quantity || 0)} reserved`;
      row.append(medicine, details);
      if (Number(item.available_quantity ?? item.available_stock ?? 0) > 0
        && log.closest('#pai-assistant-root')?.dataset.role === 'customer') {
        const reserve = document.createElement('button');
        reserve.type = 'button';
        reserve.className = 'pai-chat-action';
        reserve.textContent = 'Review reservation';
        reserve.addEventListener('click', () => reviewReservation(log, item, quantity, reserve));
        row.appendChild(reserve);
      }
      list.appendChild(row);
    });
    log.appendChild(list);
    log.scrollTop = log.scrollHeight;
  }

  function appendAction(log, label, callback) {
    const wrapper = document.createElement('div');
    wrapper.className = 'pai-chat-actions';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pai-chat-action';
    button.textContent = label;
    button.addEventListener('click', callback);
    wrapper.appendChild(button);
    log.appendChild(wrapper);
    log.scrollTop = log.scrollHeight;
  }

  function renderCustomerResult(log, result) {
    appendTextMessage(log, 'assistant', result?.message || 'P.A.I. did not return a response.');
    appendResponseProvenance(log, result);
    appendListingResults(log, result?.results, result?.quantity || 1);

    if (result?.type === 'reservation_options' && result.results?.length) {
      appendTextMessage(log, 'assistant', 'Choose a listing to review its quantity and confirm. No reservation is created until you confirm.');
    }

    if (result?.type === 'availability_watch_confirmation' && result.medicine_id) {
      appendAction(log, 'Set availability alert', async event => {
        const actionButton = event.currentTarget;
        actionButton.disabled = true;
        try {
          const response = await Api.post('/api/pai/availability-watch', {
            medicine_id: result.medicine_id,
            pharmacy_id: result.pharmacy_id,
          });
          appendTextMessage(log, 'assistant', response.message || 'Availability alert set.');
        } catch (error) {
          appendTextMessage(log, 'assistant', error.message || 'Could not set that availability alert.');
          actionButton.disabled = false;
        }
      });
    }

    (result?.suggestions || []).slice(0, 4).forEach(suggestion => {
      appendAction(log, `Search ${suggestion.name}`, () => sendCustomerMessage(`Find ${suggestion.name}`));
    });
  }

  let sendCustomerMessage = () => {};

  function init({ role }) {
    if (document.getElementById('pai-assistant-root')) return;
    const root = document.createElement('div');
    root.id = 'pai-assistant-root';
    root.className = 'pai-assistant-root';
    root.dataset.role = role;
    root.innerHTML = `
      <button class="pai-assistant-launcher" id="pai-assistant-launcher" type="button"
        aria-label="Open P.A.I. assistant" aria-expanded="false" aria-controls="pai-assistant-panel"
        aria-describedby="pai-assistant-tooltip">
        <span class="pai-launcher-icon pai-icon-frame">
          <img src="${ICON_URL}" alt="" />
          <span class="pai-icon-fallback" hidden aria-hidden="true">P.A.I.</span>
        </span>
        <span class="pai-assistant-tooltip" id="pai-assistant-tooltip" role="tooltip">Ask P.A.I.</span>
      </button>
      <button class="pai-assistant-backdrop" type="button" aria-label="Close P.A.I. assistant" tabindex="-1" hidden></button>
      <section class="pai-assistant-panel" id="pai-assistant-panel" role="dialog"
        aria-modal="false" aria-labelledby="pai-assistant-title" hidden>
        <header class="pai-assistant-header">
          <span class="pai-avatar pai-icon-frame">
            <img src="${ICON_URL}" alt="" />
            <span class="pai-icon-fallback" hidden aria-hidden="true">P.A.I.</span>
          </span>
          <div class="pai-assistant-heading">
            <h2 id="pai-assistant-title">P.A.I. Assistant</h2>
            <span class="pai-assistant-role"></span>
          </div>
          <button class="pai-assistant-close" type="button" aria-label="Close P.A.I. assistant">&times;</button>
        </header>
        <div class="pai-assistant-log" id="pai-assistant-log" role="log" aria-live="polite" aria-relevant="additions text" tabindex="0"></div>
        <form class="pai-assistant-form" id="pai-assistant-form">
          <label class="sr-only" for="pai-assistant-input">Message P.A.I.</label>
          <input id="pai-assistant-input" name="message" maxlength="500" autocomplete="off" placeholder="Ask P.A.I. a question" />
          <button class="pai-assistant-send" type="submit">Send</button>
        </form>
      </section>`;
    document.body.appendChild(root);

    const launcher = root.querySelector('#pai-assistant-launcher');
    const panel = root.querySelector('#pai-assistant-panel');
    const closeButton = root.querySelector('.pai-assistant-close');
    const backdrop = root.querySelector('.pai-assistant-backdrop');
    const log = root.querySelector('#pai-assistant-log');
    const form = root.querySelector('#pai-assistant-form');
    const input = root.querySelector('#pai-assistant-input');
    const sendButton = root.querySelector('.pai-assistant-send');
    const roleLabel = ROLE_LABELS[role] || 'P.A.I. assistant';
    root.querySelector('.pai-assistant-role').textContent = roleLabel;
    root.querySelectorAll('.pai-icon-frame img').forEach(makeIconFallback);

    function isMobilePanel() {
      return window.matchMedia('(max-width: 640px)').matches;
    }

    function closePanel(restoreFocus = true) {
      panel.hidden = true;
      backdrop.hidden = true;
      panel.setAttribute('aria-modal', 'false');
      launcher.setAttribute('aria-expanded', 'false');
      document.body.classList.remove('pai-assistant-open');
      if (restoreFocus) launcher.focus();
    }

    function openPanel() {
      panel.hidden = false;
      launcher.setAttribute('aria-expanded', 'true');
      const mobile = isMobilePanel();
      panel.setAttribute('aria-modal', String(mobile));
      backdrop.hidden = !mobile;
      if (mobile) document.body.classList.add('pai-assistant-open');
      (input.disabled ? closeButton : input).focus();
    }

    const isCustomer = role === 'customer';
    const roleEndpoint = ROLE_ENDPOINTS[role];
    if (isCustomer) {
      appendTextMessage(log, 'assistant', 'Hi, I’m P.A.I. I can help with verified PillPoint listings, reservations, medicine information stored in PillPoint, and availability alerts. I can’t diagnose or recommend treatment.');
      sendCustomerMessage = async message => {
        const text = String(message || '').trim().slice(0, 500);
        if (!text || sendButton.disabled) return;
        appendTextMessage(log, 'user', text);
        input.value = '';
        sendButton.disabled = true;
        input.disabled = true;
        try {
          const response = await Api.post('/api/pai/assistant', { message: text });
          renderCustomerResult(log, response.result);
        } catch (error) {
          appendTextMessage(log, 'assistant', error.message || 'P.A.I. is temporarily unavailable. You can continue using PillPoint standard search.');
        } finally {
          sendButton.disabled = false;
          input.disabled = false;
          input.focus();
        }
      };
    } else {
      appendTextMessage(log, 'assistant', role === 'pharmacy_staff'
        ? 'Hi, I’m P.A.I. Ask about stock risks, restocking priorities, expiry alerts, demand, pricing signals, or pharmacy performance. I explain current analytics and cannot change pharmacy records.'
        : 'Hi, I’m P.A.I. Ask about system-wide medicine demand, availability gaps, pharmacy participation, stale inventory, pricing signals, or system performance. I explain current analytics and cannot change system records.');
    }

    launcher.addEventListener('click', () => panel.hidden ? openPanel() : closePanel(false));
    closeButton.addEventListener('click', () => closePanel());
    backdrop.addEventListener('click', () => closePanel());
    form.addEventListener('submit', event => {
      event.preventDefault();
      if (isCustomer) {
        sendCustomerMessage(input.value);
        return;
      }
      const text = String(input.value || '').trim().slice(0, 500);
      if (!text || sendButton.disabled || !roleEndpoint) return;
      appendTextMessage(log, 'user', text);
      input.value = '';
      sendButton.disabled = true;
      input.disabled = true;
      Api.post(roleEndpoint, { message: text })
        .then(response => {
          appendTextMessage(log, 'assistant', response.result?.message || 'P.A.I. did not return a response.');
          appendResponseProvenance(log, response.result);
        })
        .catch(error => appendTextMessage(log, 'assistant', error.message || 'P.A.I. is temporarily unavailable.'))
        .finally(() => {
          sendButton.disabled = false;
          input.disabled = false;
          input.focus();
        });
    });
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) {
        event.preventDefault();
        closePanel();
      }
      if (event.key === 'Tab' && !panel.hidden && isMobilePanel()) {
        const focusable = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), [tabindex="0"]')];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    });
  }

  window.PaiAssistant = { init };
})();
