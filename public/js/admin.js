(function () {
  // Named-property shortcuts like form.email are real-browser behavior that
  // jsdom (and possibly other embedders) do not implement, so every field
  // read goes through this instead, which works everywhere.
  function fv(form, name) { return form.querySelector('[name="' + name + '"]').value; }

  async function adminFetch(path, options) {
    const res = await fetch((window.API_BASE || '') + '/api/admin' + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    let body = null;
    try { body = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) throw Object.assign(new Error((body && body.error) || 'Request failed'), { status: res.status });
    return body;
  }

  const loginCard = document.querySelector('[data-admin-login]');
  const shell = document.querySelector('[data-admin-shell]');
  const logoutBtn = document.querySelector('[data-admin-logout]');

  // The role decides which tabs exist. This is convenience, not security:
  // the operator-only endpoints check the role server side and return 403
  // regardless of what the browser chooses to display.
  let currentRole = 'client';
  let visionEnabled = false;

  async function checkSession() {
    try {
      const me = await adminFetch('/me');
      currentRole = me.role || 'client';
      visionEnabled = Boolean(me.visionEnabled);
      document.querySelectorAll('[data-operator-only]').forEach((el) => { el.hidden = currentRole !== 'operator'; });
      showDashboard();
    } catch (err) {
      showLogin();
    }
  }

  function showDashboard() {
    loginCard.hidden = true;
    shell.hidden = false;
    logoutBtn.hidden = false;
    loadOrders();
    loadReturns();
    loadProducts();
    loadInventory();
    loadKb();
    loadWidgetSettings();
    loadBrandConfig();
    loadOffers();
    loadRequests();
    loadBundles();
    loadConversations();
    if (currentRole === 'operator') {
      loadUsers();
      loadErrors();
    }
  }
  function showLogin() {
    loginCard.hidden = false;
    shell.hidden = true;
    logoutBtn.hidden = true;
  }

  document.querySelector('[data-admin-login-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errEl = document.querySelector('[data-admin-login-error]');
    errEl.hidden = true;
    try {
      await adminFetch('/login', {
        method: 'POST',
        body: JSON.stringify({ email: fv(form, 'email').trim(), password: fv(form, 'password') }),
      });
      showDashboard();
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err.message;
    }
  });

  logoutBtn.addEventListener('click', async () => {
    await adminFetch('/logout', { method: 'POST' });
    showLogin();
  });

  document.querySelectorAll('.admin-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.admin-tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.admin-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector('[data-panel="' + tab.getAttribute('data-tab') + '"]').classList.add('active');
    });
  });

  /* ---------------------------- orders ---------------------------- */
  const ORDER_STATUSES = ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];

  async function loadOrders() {
    const data = await adminFetch('/orders');
    document.querySelector('[data-orders-body]').innerHTML = data.orders.map((o) => (
      '<tr><td>' + escapeHtml(o.displayId) + '</td>' +
      '<td>' + escapeHtml(o.customerName) + '<br><span style="color:var(--muted)">' + escapeHtml(o.customerEmail) + '</span></td>' +
      '<td>' + formatPaise(o.total) + '</td>' +
      '<td>' + new Date(o.createdAt).toLocaleDateString() + '</td>' +
      '<td><select data-order-status="' + o.id + '">' + ORDER_STATUSES.map((s) => '<option value="' + s + '"' + (s === o.status ? ' selected' : '') + '>' + s + '</option>').join('') + '</select></td></tr>'
    )).join('') || '<tr><td colspan="5">No orders yet.</td></tr>';

    document.querySelectorAll('[data-order-status]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        await adminFetch('/orders/' + sel.getAttribute('data-order-status') + '/status', {
          method: 'PATCH',
          body: JSON.stringify({ status: sel.value }),
        });
      });
    });
  }

  /* ---------------------------- returns ---------------------------- */
  // REFUNDED is deliberately not in this list, see the refund button below,
  // it can only be reached by an actual successful Razorpay refund.
  const RETURN_STATUSES = ['SUBMITTED', 'APPROVED', 'REJECTED'];

  async function loadReturns() {
    const data = await adminFetch('/returns');
    document.querySelector('[data-returns-body]').innerHTML = data.returns.map((r) => {
      const isRefunded = r.status === 'REFUNDED';
      const statusCell = isRefunded
        ? '<span class="pill-status">Refunded</span>'
        : '<select data-return-status="' + r.id + '">' + RETURN_STATUSES.map((s) => '<option value="' + s + '"' + (s === r.status ? ' selected' : '') + '>' + s + '</option>').join('') + '</select>';
      const refundCell = isRefunded
        ? 'Refund ' + escapeHtml(r.razorpayRefundId || '') + '<br><span style="color:var(--muted)">' + formatPaise(r.refundAmount || 0) + '</span>'
        : r.status === 'APPROVED'
          ? '<button type="button" class="small-link" data-do-refund="' + r.id + '">Refund via Razorpay</button>' +
            (r.refundError ? '<div style="color:var(--danger); font-size:11px;">' + escapeHtml(r.refundError) + '</div>' : '')
          : r.status === 'REJECTED'
            ? '<span style="color:var(--danger)">Rejected</span>'
            : '<span style="color:var(--muted)">Awaiting approval</span>';
      // A cancellation is a refund for goods that were never sent, so it is
      // marked rather than left to read as an ordinary return.
      const isCancellation = r.kind === 'CANCELLATION';
      const typeCell = isCancellation
        ? '<span class="pill-status" style="background:var(--lavender-soft)">Cancelled order</span>'
        : 'Return';
      return '<tr><td>' + escapeHtml(r.displayId) + '</td>' +
        '<td>' + typeCell + '</td>' +
        '<td>' + escapeHtml(r.orderDisplayId) + '<br><span style="color:var(--muted)">' + escapeHtml(r.customerEmail) + '</span></td>' +
        '<td>' + escapeHtml(r.reason) + '</td>' +
        '<td>' + escapeHtml(r.description || '') + '</td>' +
        '<td>' + (r.photoUrl ? '<a href="' + escapeHtml(r.photoUrl) + '" target="_blank" rel="noopener noreferrer">View</a>' : '&mdash;') + '</td>' +
        '<td>' + statusCell + '</td>' +
        '<td>' + refundCell + '</td></tr>';
    }).join('') || '<tr><td colspan="8">No return or cancellation requests yet.</td></tr>';

    document.querySelectorAll('[data-return-status]').forEach((sel) => {
      sel.addEventListener('change', async () => {
        await adminFetch('/returns/' + sel.getAttribute('data-return-status') + '/status', {
          method: 'PATCH',
          body: JSON.stringify({ status: sel.value }),
        });
        loadReturns();
      });
    });
    document.querySelectorAll('[data-do-refund]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Processing...';
        try {
          await adminFetch('/returns/' + btn.getAttribute('data-do-refund') + '/refund', { method: 'POST' });
        } catch (err) {
          alert(err.message || 'Refund failed');
        }
        loadReturns();
      });
    });
  }

  /* ---------------------------- products ---------------------------- */
  const productForm = document.querySelector('[data-product-form]');
  const productSubmit = document.querySelector('[data-product-submit]');
  const productCancel = document.querySelector('[data-product-cancel]');
  const productById = new Map();

  function setProductFormMode(product) {
    productForm.dataset.editingId = product ? product.id : '';
    productSubmit.textContent = product ? 'Save changes' : 'Add product';
    productCancel.hidden = !product;
    if (!product) {
      productForm.reset();
      return;
    }
    productForm.querySelector('[name="slug"]').value = product.slug;
    productForm.querySelector('[name="name"]').value = product.name;
    productForm.querySelector('[name="price"]').value = product.price;
    productForm.querySelector('[name="fabric"]').value = product.fabric || '';
    productForm.querySelector('[name="iconKey"]').value = product.iconKey || 'tee';
    productForm.querySelector('[name="imageUrl"]').value = product.imageUrl || '';
    productForm.querySelector('[name="sizes"]').value = product.sizes.join(', ');
    productForm.querySelector('[name="colors"]').value = product.colors.map((c) => `${c.name}:${c.hex}`).join(', ');
    window.scrollTo({ top: productForm.getBoundingClientRect().top + window.scrollY - 24, behavior: 'smooth' });
  }

  async function loadProducts() {
    const data = await adminFetch('/products');
    productById.clear();
    data.products.forEach((p) => productById.set(p.id, p));
    document.querySelector('[data-products-body]').innerHTML = data.products.map((p) => (
      '<tr><td>' + escapeHtml(p.name) + '</td><td>' + formatPaise(p.price) + '</td><td>' + p.sizes.map(escapeHtml).join(', ') + '</td>' +
      '<td>' + (p.active ? 'Yes' : 'No') + '</td>' +
      '<td><button type="button" class="small-link" data-edit-product="' + p.id + '">Edit</button> ' +
      '<button type="button" class="small-link danger" data-deactivate="' + p.id + '">Deactivate</button></td></tr>'
    )).join('') || '<tr><td colspan="5">No products yet.</td></tr>';

    document.querySelectorAll('[data-edit-product]').forEach((btn) => {
      btn.addEventListener('click', () => setProductFormMode(productById.get(btn.getAttribute('data-edit-product'))));
    });
    document.querySelectorAll('[data-deactivate]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await adminFetch('/products/' + btn.getAttribute('data-deactivate'), { method: 'DELETE' });
        loadProducts();
      });
    });
  }

  productCancel.addEventListener('click', () => setProductFormMode(null));

  productForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errEl = document.querySelector('[data-product-form-error]');
    errEl.hidden = true;
    try {
      const colors = fv(form, 'colors').split(',').map((pair) => {
        const [name, hex] = pair.split(':').map((s) => s.trim());
        return { name, hex };
      });
      let imageUrl = fv(form, 'imageUrl').trim() || null;
      const imageFile = form.querySelector('[name="imageFile"]').files[0];
      if (imageFile) {
        const uploadForm = new FormData();
        uploadForm.append('image', imageFile);
        const uploadRes = await fetch((window.API_BASE || '') + '/api/uploads/product-image', { method: 'POST', credentials: 'include', body: uploadForm });
        const uploadBody = await uploadRes.json().catch(() => ({}));
        if (!uploadRes.ok) throw new Error(uploadBody.error || 'Image upload failed');
        imageUrl = uploadBody.url;
      }
      const payload = {
        slug: fv(form, 'slug').trim(),
        name: fv(form, 'name').trim(),
        price: Number(fv(form, 'price')),
        fabric: fv(form, 'fabric').trim() || null,
        iconKey: fv(form, 'iconKey'),
        imageUrl,
        sizes: fv(form, 'sizes').split(',').map((s) => s.trim()).filter(Boolean),
        colors,
        active: true,
      };
      const editingId = productForm.dataset.editingId;
      await adminFetch(editingId ? '/products/' + editingId : '/products', {
        method: editingId ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      });
      setProductFormMode(null);
      loadProducts();
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err.message;
    }
  });

  /* ---------------------------- knowledge base ---------------------------- */
  /* ---------------------------- inventory ---------------------------- */
  async function loadInventory() {
    const data = await adminFetch('/inventory');
    document.querySelector('[data-inventory-body]').innerHTML = data.variants.map((v) => (
      '<tr><td>' + escapeHtml(v.productName) + '</td><td>' + escapeHtml(v.sku) + '</td><td>' + escapeHtml(v.size) + '</td><td>' + escapeHtml(v.color) + '</td>' +
      '<td>' +
        '<button type="button" class="small-link" data-stock-adjust="' + v.id + '" data-delta="-1">&minus;</button> ' +
        '<strong data-stock-value="' + v.id + '">' + v.stockQuantity + '</strong> ' +
        '<button type="button" class="small-link" data-stock-adjust="' + v.id + '" data-delta="1">+</button>' +
      '</td>' +
      '<td><input type="checkbox" data-variant-active="' + v.id + '" ' + (v.active ? 'checked' : '') + '></td></tr>'
    )).join('') || '<tr><td colspan="6">No variants yet, add a product first.</td></tr>';

    document.querySelectorAll('[data-stock-adjust]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const variantId = btn.getAttribute('data-stock-adjust');
        const delta = Number(btn.getAttribute('data-delta'));
        try {
          const result = await adminFetch('/inventory/' + variantId + '/adjust', {
            method: 'POST',
            body: JSON.stringify({ delta, reason: 'Admin dashboard adjustment' }),
          });
          document.querySelector('[data-stock-value="' + variantId + '"]').textContent = result.stockQuantity;
        } catch (err) {
          alert(err.message || 'Could not adjust stock');
        }
      });
    });
    document.querySelectorAll('[data-variant-active]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        await adminFetch('/inventory/' + cb.getAttribute('data-variant-active') + '/active', {
          method: 'PATCH',
          body: JSON.stringify({ active: cb.checked }),
        });
      });
    });
  }

  async function loadKb() {
    const data = await adminFetch('/knowledge-base');
    document.querySelector('[data-kb-body]').innerHTML = data.entries.map((k) => (
      '<tr><td>' + escapeHtml(k.topic) + '</td><td>' + escapeHtml(k.content) + '</td>' +
      '<td><button type="button" class="small-link" data-kb-edit="' + k.id + '">Edit</button> ' +
      '<button type="button" class="small-link danger" data-kb-delete="' + k.id + '">Delete</button></td></tr>'
    )).join('') || '<tr><td colspan="3">No entries yet.</td></tr>';

    document.querySelectorAll('[data-kb-edit]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const current = data.entries.find((entry) => entry.id === btn.getAttribute('data-kb-edit'));
        if (!current) return;
        const topic = window.prompt('Topic', current.topic);
        if (topic === null) return;
        const content = window.prompt('Content', current.content);
        if (content === null) return;
        await adminFetch('/knowledge-base/' + current.id, { method: 'PUT', body: JSON.stringify({ topic: topic.trim(), content: content.trim(), active: current.active }) });
        loadKb();
      });
    });
    document.querySelectorAll('[data-kb-delete]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        await adminFetch('/knowledge-base/' + btn.getAttribute('data-kb-delete'), { method: 'DELETE' });
        loadKb();
      });
    });
  }

  document.querySelector('[data-kb-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    await adminFetch('/knowledge-base', {
      method: 'POST',
      body: JSON.stringify({ topic: fv(form, 'topic').trim(), content: fv(form, 'content').trim(), active: true }),
    });
    form.reset();
    loadKb();
  });

  async function loadWidgetSettings() {
    const data = await adminFetch('/widget-settings');
    const form = document.querySelector('[data-widget-form]');
    form.querySelector('[name="welcomeMessage"]').value = data.settings.welcomeMessage || '';
    form.querySelector('[name="suggestedQuestions"]').value = (data.settings.suggestedQuestions || []).join('\n');
  }

  document.querySelector('[data-widget-form]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = e.target;
    const errEl = document.querySelector('[data-widget-form-error]');
    const okEl = document.querySelector('[data-widget-form-success]');
    errEl.hidden = true; okEl.hidden = true;
    try {
      const suggestedQuestions = fv(form, 'suggestedQuestions').split('\n').map((q) => q.trim()).filter(Boolean);
      await adminFetch('/widget-settings', {
        method: 'PUT',
        body: JSON.stringify({ welcomeMessage: fv(form, 'welcomeMessage').trim(), suggestedQuestions }),
      });
      okEl.hidden = false;
    } catch (err) {
      errEl.hidden = false;
      errEl.textContent = err.message || 'Could not save widget settings';
    }
  });

  /* ---------------------------- branding ---------------------------- */
  /* Every field is optional. A blank field is sent as null so the API falls
   * back to the deployment's environment default rather than storing an
   * empty string that would render as a missing logo or an invalid colour. */

  const BRAND_COLOR_FIELDS = ['accent', 'secondary', 'background', 'surface', 'textColor', 'mutedColor'];
  const BRAND_TEXT_FIELDS = ['logoUrl', 'logoDarkUrl', 'fontFamily'];
  const BRAND_NUMBER_FIELDS = ['logoHeight', 'borderRadius'];
  const BRAND_CHOICE_FIELDS = ['bubbleIcon', 'widgetPosition'];
  const BRAND_BOOL_FIELDS = ['showCart', 'showTrackOrders'];

  async function loadBrandConfig() {
    const form = document.querySelector('[data-brand-form]');
    if (!form) return;
    const data = await adminFetch('/brand');
    const brand = data.brand || {};
    const config = await fetch((window.API_BASE || '') + '/api/config').then((r) => r.json()).catch(() => ({}));
    const effective = config.brand || {};
    [...BRAND_TEXT_FIELDS, ...BRAND_NUMBER_FIELDS, ...BRAND_CHOICE_FIELDS].forEach((name) => {
      const el = form.querySelector('[name="' + name + '"]');
      if (el) el.value = brand[name] != null ? brand[name] : '';
    });
    // Colour inputs cannot show "unset", so they display the value actually
    // in effect, which is the environment default when the row is empty.
    BRAND_COLOR_FIELDS.forEach((name) => {
      const el = form.querySelector('[name="' + name + '"]');
      if (el) el.value = brand[name] || effective[name] || '#000000';
    });
    BRAND_BOOL_FIELDS.forEach((name) => {
      const el = form.querySelector('[name="' + name + '"]');
      const value = brand[name] != null ? brand[name] : effective[name];
      if (el) el.value = value === false ? 'false' : 'true';
    });
  }

  const brandForm = document.querySelector('[data-brand-form]');
  if (brandForm) {
    const fileInput = brandForm.querySelector('[data-brand-logo-file]');
    const urlInput = brandForm.querySelector('[data-brand-logo-url]');
    const errEl = document.querySelector('[data-brand-form-error]');
    const okEl = document.querySelector('[data-brand-form-success]');

    fileInput.addEventListener('change', async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) return;
      errEl.hidden = true; okEl.hidden = true;
      try {
        const body = new FormData();
        body.append('image', file);
        // Goes through the same upload route and magic-byte check as every
        // other image, so a renamed executable is rejected server side.
        const res = await fetch((window.API_BASE || '') + '/api/uploads/brand', { method: 'POST', credentials: 'include', body });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Upload failed');
        urlInput.value = json.url;
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message || 'Could not upload that logo';
      } finally {
        fileInput.value = '';
      }
    });

    brandForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      errEl.hidden = true; okEl.hidden = true;
      const payload = {};
      BRAND_TEXT_FIELDS.forEach((name) => {
        const value = fv(brandForm, name).trim();
        payload[name] = value || null;
      });
      BRAND_COLOR_FIELDS.forEach((name) => { payload[name] = fv(brandForm, name); });
      BRAND_NUMBER_FIELDS.forEach((name) => {
        const value = fv(brandForm, name).trim();
        if (value !== '') payload[name] = Number(value);
      });
      BRAND_CHOICE_FIELDS.forEach((name) => {
        const value = fv(brandForm, name);
        if (value) payload[name] = value;
      });
      BRAND_BOOL_FIELDS.forEach((name) => { payload[name] = fv(brandForm, name) === 'true'; });
      try {
        await adminFetch('/brand', { method: 'PUT', body: JSON.stringify(payload) });
        okEl.hidden = false;
        await loadBrandConfig();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message || 'Could not save branding';
      }
    });
  }

  /* ----------------------------- offers ----------------------------- */

  const OFFER_KIND_LABELS = { PERCENT: 'Percent off', FLAT: 'Flat off', FREE_SHIPPING: 'Free shipping', BUNDLE: 'Bundle' };

  function offerWindow(offer) {
    if (!offer.startsAt && !offer.endsAt) return 'Always';
    const from = offer.startsAt ? new Date(offer.startsAt).toLocaleDateString() : 'now';
    const to = offer.endsAt ? new Date(offer.endsAt).toLocaleDateString() : 'no end';
    return from + ' to ' + to;
  }

  function offerValue(offer) {
    if (offer.kind === 'PERCENT') return offer.value + '%';
    if (offer.kind === 'FLAT') return formatPaise(offer.value);
    return '-';
  }

  async function loadOffers() {
    const body = document.querySelector('[data-offers-body]');
    if (!body) return;
    const data = await adminFetch('/offers');
    body.innerHTML = (data.offers || []).map((o) => (
      '<tr><td>' + escapeHtml(o.title) + (o.code ? '<br><span style="color:var(--muted)">' + escapeHtml(o.code) + '</span>' : '') + '</td>' +
      '<td>' + escapeHtml(OFFER_KIND_LABELS[o.kind] || o.kind) + '</td>' +
      '<td>' + escapeHtml(offerValue(o)) + '</td>' +
      '<td>' + (o.minSubtotal ? formatPaise(o.minSubtotal) : '-') + '</td>' +
      '<td>' + escapeHtml(offerWindow(o)) + '</td>' +
      '<td><input type="checkbox" data-offer-active="' + o.id + '"' + (o.active ? ' checked' : '') + '></td>' +
      '<td><button class="btn-ghost" data-delete-offer="' + o.id + '">Delete</button></td></tr>'
    )).join('') || '<tr><td colspan="7">No offers yet.</td></tr>';

    body.querySelectorAll('[data-offer-active]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const id = cb.getAttribute('data-offer-active');
        const offer = (data.offers || []).find((o) => o.id === id);
        try {
          await adminFetch('/offers/' + id, { method: 'PUT', body: JSON.stringify({ ...offer, active: cb.checked }) });
        } catch (err) {
          cb.checked = !cb.checked;
          alert(err.message || 'Could not update that offer');
        }
      });
    });
    body.querySelectorAll('[data-delete-offer]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this offer?')) return;
        await adminFetch('/offers/' + btn.getAttribute('data-delete-offer'), { method: 'DELETE' });
        loadOffers();
      });
    });
  }

  const offerForm = document.querySelector('[data-offer-form]');
  if (offerForm) {
    offerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.querySelector('[data-offer-form-error]');
      errEl.hidden = true;
      const kind = fv(offerForm, 'kind');
      const rawValue = Number(fv(offerForm, 'value') || 0);
      const toIso = (name) => {
        const value = fv(offerForm, name);
        return value ? new Date(value).toISOString() : null;
      };
      try {
        await adminFetch('/offers', {
          method: 'POST',
          body: JSON.stringify({
            title: fv(offerForm, 'title').trim(),
            code: fv(offerForm, 'code').trim() || null,
            description: fv(offerForm, 'description').trim(),
            kind,
            // Percent is a plain number, flat amounts are stored in paise
            // like every other money value in this system.
            value: kind === 'FLAT' ? Math.round(rawValue * 100) : Math.round(rawValue),
            minSubtotal: Math.round(Number(fv(offerForm, 'minSubtotal') || 0) * 100),
            startsAt: toIso('startsAt'),
            endsAt: toIso('endsAt'),
            active: true,
          }),
        });
        offerForm.reset();
        loadOffers();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message || 'Could not create that offer';
      }
    });
  }

  /* --------------------------- requests --------------------------- */

  function scoreClass(verdict) {
    if (verdict === 'SUPPORTS') return 'score-pill supports';
    if (verdict === 'CONTRADICTS') return 'score-pill contradicts';
    return 'score-pill';
  }

  function scoreHtml(action) {
    if (action.aiScore == null) {
      return visionEnabled ? '<span class="score-pill">Not scored</span>' : '';
    }
    return '<span class="' + scoreClass(action.aiVerdict) + '">Photo ' + escapeHtml(String(action.aiVerdict || '')) +
      ' &middot; ' + action.aiScore + '/100</span>' +
      (action.aiReasoning ? '<div class="transcript-meta">' + escapeHtml(action.aiReasoning) + '</div>' : '');
  }

  function requestItemsHtml(action) {
    const payload = action.payload || {};
    if (action.kind === 'CANCELLATION') {
      return '<div>Reason: ' + escapeHtml(payload.reason || 'not given') + '</div>';
    }
    const lines = (payload.items || []).map((i) => escapeHtml(i.name) + ' x ' + i.quantity).join('<br>');
    return '<div>' + lines + '</div>' +
      '<div class="transcript-meta">Reason: ' + escapeHtml(payload.reason || '') +
      (payload.description ? ' &middot; ' + escapeHtml(payload.description) : '') + '</div>' +
      (payload.estimatedRefund != null ? '<div>Estimated refund: ' + formatPaise(payload.estimatedRefund) + '</div>' : '');
  }

  async function loadRequests() {
    const body = document.querySelector('[data-requests-body]');
    if (!body) return;
    const status = document.querySelector('[data-requests-status]').value;
    const data = await adminFetch('/pending-actions?status=' + encodeURIComponent(status));
    const actions = data.actions || [];
    body.innerHTML = actions.length ? actions.map((a) => {
      const payload = a.payload || {};
      // Only a photo this server issued is ever rendered, matching the check
      // the agent and the database both apply to the same value.
      const photo = typeof payload.photoUrl === 'string' && /^https?:\/\//i.test(payload.photoUrl) ? payload.photoUrl : '';
      return '<div class="request-card">' +
        '<div class="request-head"><div><strong>' + escapeHtml(a.displayId) + '</strong> &middot; ' + escapeHtml(a.kind) +
        '<div class="transcript-meta">Order ' + escapeHtml(a.orderDisplayId || '') + ' &middot; ' + escapeHtml(a.customerEmail || '') +
        ' &middot; ' + new Date(a.createdAt).toLocaleString() + '</div></div>' + scoreHtml(a) + '</div>' +
        requestItemsHtml(a) +
        (a.agentReasoning ? '<div class="transcript-meta">Assistant note: ' + escapeHtml(a.agentReasoning) + '</div>' : '') +
        (photo ? '<img class="request-photo" src="' + escapeHtml(photo) + '" alt="Return photo">' : '') +
        (a.status === 'PENDING'
          ? '<div class="request-actions"><button class="btn-primary" data-approve-request="' + a.id + '">Approve</button>' +
            '<button class="btn-ghost" data-reject-request="' + a.id + '">Reject</button></div>'
          : '<div class="transcript-meta">' + escapeHtml(a.status) + (a.reviewNote ? ' &middot; ' + escapeHtml(a.reviewNote) : '') +
            (a.resultRef ? ' &middot; ' + escapeHtml(a.resultRef) : '') + '</div>') +
        '</div>';
    }).join('') : '<div class="panel-note">Nothing here.</div>';

    body.querySelectorAll('[data-approve-request]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = prompt('Optional note for the record:') || '';
        btn.disabled = true;
        try {
          await adminFetch('/pending-actions/' + btn.getAttribute('data-approve-request') + '/approve', {
            method: 'POST', body: JSON.stringify({ note }),
          });
          loadRequests();
          loadReturns();
        } catch (err) {
          btn.disabled = false;
          alert(err.message || 'Could not approve that request');
        }
      });
    });
    body.querySelectorAll('[data-reject-request]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const note = prompt('Why is this being rejected?') || '';
        try {
          await adminFetch('/pending-actions/' + btn.getAttribute('data-reject-request') + '/reject', {
            method: 'POST', body: JSON.stringify({ note }),
          });
          loadRequests();
        } catch (err) {
          alert(err.message || 'Could not reject that request');
        }
      });
    });
  }

  const requestsStatus = document.querySelector('[data-requests-status]');
  if (requestsStatus) requestsStatus.addEventListener('change', loadRequests);

  /* --------------------------- bundles ---------------------------- */

  async function loadBundles() {
    const body = document.querySelector('[data-bundles-body]');
    if (!body) return;
    const [data, productData] = await Promise.all([adminFetch('/bundles'), adminFetch('/products')]);
    const nameById = new Map((productData.products || []).map((p) => [p.id, p.name]));

    const picker = document.querySelector('[data-bundle-products]');
    if (picker) {
      picker.innerHTML = (productData.products || [])
        .map((p) => '<option value="' + p.id + '">' + escapeHtml(p.name) + '</option>').join('');
    }

    body.innerHTML = (data.bundles || []).map((b) => (
      '<tr><td>' + escapeHtml(b.title) + (b.description ? '<br><span style="color:var(--muted)">' + escapeHtml(b.description) + '</span>' : '') + '</td>' +
      '<td>' + (b.productIds || []).map((id) => escapeHtml(nameById.get(id) || 'removed product')).join('<br>') + '</td>' +
      '<td><input type="checkbox" data-bundle-active="' + b.id + '"' + (b.active ? ' checked' : '') + '></td>' +
      '<td><button class="btn-ghost" data-delete-bundle="' + b.id + '">Delete</button></td></tr>'
    )).join('') || '<tr><td colspan="4">No bundles yet.</td></tr>';

    body.querySelectorAll('[data-bundle-active]').forEach((cb) => {
      cb.addEventListener('change', async () => {
        const id = cb.getAttribute('data-bundle-active');
        const bundle = (data.bundles || []).find((b) => b.id === id);
        try {
          await adminFetch('/bundles/' + id, { method: 'PUT', body: JSON.stringify({ ...bundle, active: cb.checked }) });
        } catch (err) {
          cb.checked = !cb.checked;
          alert(err.message || 'Could not update that bundle');
        }
      });
    });
    body.querySelectorAll('[data-delete-bundle]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Delete this bundle?')) return;
        await adminFetch('/bundles/' + btn.getAttribute('data-delete-bundle'), { method: 'DELETE' });
        loadBundles();
      });
    });
  }

  const bundleForm = document.querySelector('[data-bundle-form]');
  if (bundleForm) {
    bundleForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.querySelector('[data-bundle-form-error]');
      errEl.hidden = true;
      const picker = bundleForm.querySelector('[data-bundle-products]');
      const productIds = Array.from(picker.selectedOptions).map((o) => o.value);
      try {
        await adminFetch('/bundles', {
          method: 'POST',
          body: JSON.stringify({
            title: fv(bundleForm, 'title').trim(),
            description: fv(bundleForm, 'description').trim(),
            productIds,
            active: true,
          }),
        });
        bundleForm.reset();
        loadBundles();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message || 'Could not create that bundle';
      }
    });
  }

  /* ------------------------ conversations ------------------------- */

  async function loadConversations() {
    const body = document.querySelector('[data-conversations-body]');
    if (!body) return;
    const data = await adminFetch('/conversations');
    body.innerHTML = (data.conversations || []).map((c) => (
      '<tr><td><button class="btn-ghost" data-open-conversation="' + escapeHtml(c.sessionId) + '">' +
      escapeHtml(c.sessionId.slice(0, 12)) + '</button></td>' +
      '<td>' + escapeHtml(c.verifiedEmail || 'not verified') +
      (c.orderDisplayId ? '<br><span style="color:var(--muted)">' + escapeHtml(c.orderDisplayId) + '</span>' : '') + '</td>' +
      '<td>' + c.messageCount + '</td>' +
      '<td>' + new Date(c.lastMessageAt).toLocaleString() + '</td></tr>'
    )).join('') || '<tr><td colspan="4">No conversations yet.</td></tr>';

    body.querySelectorAll('[data-open-conversation]').forEach((btn) => {
      btn.addEventListener('click', () => openConversation(btn.getAttribute('data-open-conversation')));
    });
  }

  async function openConversation(sessionId) {
    const detail = document.querySelector('[data-conversation-detail]');
    detail.innerHTML = '<div class="panel-note">Loading...</div>';
    const data = await adminFetch('/conversations/' + encodeURIComponent(sessionId));
    const header = data.session && data.session.verifiedEmail
      ? 'Verified as ' + escapeHtml(data.session.verifiedEmail) +
        (data.session.orderDisplayId ? ' on ' + escapeHtml(data.session.orderDisplayId) : '')
      : 'Not verified';
    detail.innerHTML = '<div class="transcript-meta">' + header + '</div><div class="transcript">' +
      (data.messages || []).map((m) => {
        // Blocks are summarised rather than re-rendered. This view is for
        // reading what was said, not for reproducing the widget.
        const blocks = Array.isArray(m.blocks) && m.blocks.length
          ? '<div class="transcript-meta">showed: ' + escapeHtml(m.blocks.map((b) => b.type).join(', ')) + '</div>'
          : '';
        return '<div class="transcript-msg ' + (m.role === 'user' ? 'user' : 'assistant') + '">' +
          '<div class="transcript-meta">' + escapeHtml(m.role) + ' &middot; ' + new Date(m.createdAt).toLocaleString() + '</div>' +
          escapeHtml(m.content) + blocks + '</div>';
      }).join('') + '</div>';
  }

  const refreshConversations = document.querySelector('[data-refresh-conversations]');
  if (refreshConversations) refreshConversations.addEventListener('click', loadConversations);

  /* ----------------------------- team ----------------------------- */

  async function loadUsers() {
    const body = document.querySelector('[data-users-body]');
    if (!body) return;
    const data = await adminFetch('/users');
    body.innerHTML = (data.users || []).map((u) => (
      '<tr><td>' + escapeHtml(u.name) + '</td><td>' + escapeHtml(u.email) + '</td><td>' + escapeHtml(u.role) + '</td>' +
      '<td><button class="btn-ghost" data-delete-user="' + u.id + '">Remove</button></td></tr>'
    )).join('');
    body.querySelectorAll('[data-delete-user]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        if (!confirm('Remove this account?')) return;
        try {
          await adminFetch('/users/' + btn.getAttribute('data-delete-user'), { method: 'DELETE' });
          loadUsers();
        } catch (err) {
          alert(err.message || 'Could not remove that account');
        }
      });
    });
  }

  const userForm = document.querySelector('[data-user-form]');
  if (userForm) {
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const errEl = document.querySelector('[data-user-form-error]');
      errEl.hidden = true;
      try {
        await adminFetch('/users', {
          method: 'POST',
          body: JSON.stringify({
            name: fv(userForm, 'name').trim(),
            email: fv(userForm, 'email').trim(),
            password: fv(userForm, 'password'),
            role: fv(userForm, 'role'),
          }),
        });
        userForm.reset();
        loadUsers();
      } catch (err) {
        errEl.hidden = false;
        errEl.textContent = err.message || 'Could not create that account';
      }
    });
  }

  /* ------------------------- diagnostics -------------------------- */

  async function loadErrors() {
    const body = document.querySelector('[data-errors-body]');
    if (!body) return;
    const source = document.querySelector('[data-errors-source]').value;
    const data = await adminFetch('/errors' + (source ? '?source=' + encodeURIComponent(source) : ''));
    body.innerHTML = (data.errors || []).map((e) => (
      '<tr><td>' + new Date(e.createdAt).toLocaleString() + '</td>' +
      '<td>' + escapeHtml(e.source) + '</td>' +
      '<td>' + escapeHtml(e.message) + '</td>' +
      '<td><span style="color:var(--muted)">' + escapeHtml(JSON.stringify(e.context || {})) + '</span></td></tr>'
    )).join('') || '<tr><td colspan="4">Nothing logged.</td></tr>';
  }

  const errorsSource = document.querySelector('[data-errors-source]');
  if (errorsSource) errorsSource.addEventListener('change', loadErrors);
  const refreshErrors = document.querySelector('[data-refresh-errors]');
  if (refreshErrors) refreshErrors.addEventListener('click', loadErrors);

  checkSession();
})();
