(function () {
  /* ---------------- Shop grid (index.html) ---------------- */
  const grid = document.querySelector('[data-product-grid]');
  if (grid) {
    API.getProducts().then((products) => {
      grid.innerHTML = products.map(renderProductCard).join('');
    }).catch(() => {
      grid.innerHTML = '<p class="empty-state">Could not load products right now.</p>';
    });

    grid.addEventListener('click', function (e) {
      const sizeChip = e.target.closest('[data-size]');
      const colorSwatch = e.target.closest('[data-color]');
      const addBtn = e.target.closest('[data-add-to-cart]');

      if (sizeChip) {
        const card = sizeChip.closest('.product-card');
        card.querySelectorAll('[data-size]').forEach((c) => c.classList.remove('selected'));
        sizeChip.classList.add('selected');
      }
      if (colorSwatch) {
        const card = colorSwatch.closest('.product-card');
        card.querySelectorAll('[data-color]').forEach((c) => c.classList.remove('selected'));
        colorSwatch.classList.add('selected');
      }
      if (addBtn) {
        const card = addBtn.closest('.product-card');
        const product = JSON.parse(card.getAttribute('data-product'));
        const size = card.querySelector('[data-size].selected').getAttribute('data-size');
        const color = card.querySelector('[data-color].selected').getAttribute('data-color');
        Cart.add(product, size, color, 1);
        addBtn.textContent = 'Added';
        addBtn.setAttribute('data-added', 'true');
        setTimeout(() => { addBtn.textContent = 'Add to cart'; addBtn.removeAttribute('data-added'); }, 1400);
      }
    });
  }

  function renderProductCard(p) {
    const safe = escapeHtml;
    return (
      '<div class="product-card" data-product-id="' + p.id + '" data-product=\'' + JSON.stringify(p).replace(/'/g, '&#39;') + '\'>' +
        '<div class="product-media">' + (p.imageUrl ? '<img src="' + safe(p.imageUrl) + '" alt="' + safe(p.name) + '">' : iconFor(p.iconKey)) + '</div>' +
        '<div class="product-info">' +
          '<h3>' + safe(p.name) + '</h3>' +
          '<div class="product-fabric">' + safe(p.fabric || '') + '</div>' +
          '<div class="product-price">' + formatPaise(p.price) + '</div>' +
          '<div class="option-row">' + p.sizes.map((s, i) => '<button type="button" class="chip' + (i === 0 ? ' selected' : '') + '" data-size="' + safe(s) + '">' + safe(s) + '</button>').join('') + '</div>' +
          '<div class="option-row">' + p.colors.map((c, i) => '<button type="button" class="swatch' + (i === 0 ? ' selected' : '') + '" data-color="' + safe(c.name) + '" title="' + safe(c.name) + '" style="background:' + safe(c.hex) + '"></button>').join('') + '</div>' +
          '<button type="button" class="btn-add" data-add-to-cart>Add to cart</button>' +
        '</div>' +
      '</div>'
    );
  }

  /* ---------------- Cart page (cart.html) ---------------- */
  const cartList = document.querySelector('[data-cart-list]');
  if (cartList) {
    renderCartPage();
    document.addEventListener('velour:cart-change', renderCartPage);
    cartList.addEventListener('click', function (e) {
      const inc = e.target.closest('[data-qty-inc]');
      const dec = e.target.closest('[data-qty-dec]');
      const remove = e.target.closest('[data-remove-line]');
      if (inc) Cart.updateQty(Number(inc.getAttribute('data-qty-inc')), 1);
      if (dec) Cart.updateQty(Number(dec.getAttribute('data-qty-dec')), -1);
      if (remove) Cart.remove(Number(remove.getAttribute('data-remove-line')));
    });
  }

  async function renderCartPage() {
    const cart = Cart.get();
    const listEl = document.querySelector('[data-cart-list]');
    const summaryEl = document.querySelector('[data-cart-summary]');
    const emptyEl = document.querySelector('[data-cart-empty]');
    if (!cart.length) {
      listEl.innerHTML = '';
      if (emptyEl) emptyEl.hidden = false;
      if (summaryEl) summaryEl.hidden = true;
      return;
    }
    if (emptyEl) emptyEl.hidden = true;
    if (summaryEl) summaryEl.hidden = false;
    listEl.innerHTML = cart.map((line, i) => (
      '<div class="cart-line">' +
        '<div class="thumb">' + (line.imageUrl ? '<img src="' + escapeHtml(line.imageUrl) + '" alt="">' : iconFor(line.iconKey)) + '</div>' +
        '<div>' +
          '<h4>' + escapeHtml(line.name) + '</h4>' +
          '<div class="meta">Size ' + escapeHtml(line.size) + ' &middot; ' + escapeHtml(line.color) + '</div>' +
          '<div class="qty-stepper">' +
            '<button type="button" data-qty-dec="' + i + '">&minus;</button>' +
            '<span>' + line.qty + '</span>' +
            '<button type="button" data-qty-inc="' + i + '">+</button>' +
          '</div>' +
          '<button type="button" class="remove-line" data-remove-line="' + i + '">Remove</button>' +
        '</div>' +
        '<div class="line-price">' + formatPaise(line.qty * line.price) + '</div>' +
      '</div>'
    )).join('');
    const subtotal = Cart.subtotal();
    const config = await getConfig();
    const shipping = calculateShipping(subtotal, config);
    if (summaryEl) {
      summaryEl.querySelector('[data-sum-subtotal]').textContent = formatPaise(subtotal);
      summaryEl.querySelector('[data-sum-shipping]').textContent = shipping === 0 ? 'Free' : formatPaise(shipping);
      summaryEl.querySelector('[data-sum-total]').textContent = formatPaise(subtotal + shipping);
    }
  }

  /* ---------------- Checkout page (checkout.html) ---------------- */
  const checkoutForm = document.querySelector('[data-checkout-form]');
  if (checkoutForm) {
    renderCheckoutSummary();
    // Generated once per page load, not once per click, so retrying the
    // same submission (network hiccup, an impatient second click) reuses
    // the same key and the backend treats it as one order, not two. A full
    // page reload after a completed purchase would need a fresh cart
    // anyway, so a fresh key on reload is correct, not a gap.
    const checkoutIdempotencyKey = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
    checkoutForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      const fields = ['name', 'email', 'phone', 'address', 'city', 'state', 'pincode'];
      let valid = true;
      const values = {};
      fields.forEach((key) => {
        const input = checkoutForm.querySelector('[name="' + key + '"]');
        const wrap = input.closest('.form-field');
        const value = input.value.trim();
        values[key] = value;
        const ok = key === 'phone' ? /^\d{7,15}$/.test(value) : key === 'email' ? /.+@.+\..+/.test(value) : key === 'pincode' ? /^\d{4,8}$/.test(value) : value.length > 0;
        wrap.classList.toggle('has-error', !ok);
        if (!ok) valid = false;
      });
      const cart = Cart.get();
      if (!cart.length) valid = false;
      if (!valid) return;

      const submitBtn = checkoutForm.querySelector('button[type="submit"]');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Placing order...';

      try {
        const offerInput = checkoutForm.querySelector('[name="offerCode"]');
        const order = await API.checkout({
          idempotencyKey: checkoutIdempotencyKey,
          items: cart.map((l) => ({ productId: l.productId, size: l.size, color: l.color, qty: l.qty })),
          customer: values,
          // Only the code travels. The discount is computed server side from
          // the offers table, so nothing here can change what is charged.
          offerCode: offerInput && offerInput.value.trim() ? offerInput.value.trim() : undefined,
        });
        openRazorpay(order, values);
      } catch (err) {
        showCheckoutError(err.details ? err.details.map((d) => d.message).join(', ') : err.message);
        submitBtn.disabled = false;
        submitBtn.textContent = 'Place order';
      }
    });
  }

  function showCheckoutError(message) {
    let el = document.querySelector('[data-checkout-error]');
    if (!el) {
      el = document.createElement('div');
      el.className = 'notice error';
      el.setAttribute('data-checkout-error', '');
      checkoutForm.prepend(el);
    }
    el.textContent = message;
  }

  function openRazorpay(order, customer) {
    const brand = window.VELOUR_BRAND || { name: 'Store' };
    const rzp = new Razorpay({
      key: order.razorpayKeyId,
      amount: order.total,
      currency: 'INR',
      name: brand.name,
      description: 'Order ' + order.displayId,
      order_id: order.razorpayOrderId,
      prefill: { name: customer.name, email: customer.email, contact: customer.phone },
      theme: { color: brand.accent || '#6C5FFF' },
      handler: async function (response) {
        try {
          await API.verifyPayment({
            orderId: order.orderId,
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
          });
          Cart.clear();
          document.querySelector('[data-checkout-form-wrap]').hidden = true;
          const confirm = document.querySelector('[data-checkout-confirm]');
          confirm.hidden = false;
          confirm.querySelector('[data-confirm-order-id]').textContent = order.displayId;
          confirm.querySelector('[data-confirm-email]').textContent = customer.email;
        } catch (err) {
          showCheckoutError('Payment was captured but could not be confirmed automatically. Contact support with order ' + order.displayId + '.');
        }
      },
      modal: {
        ondismiss: function () {
          const submitBtn = checkoutForm.querySelector('button[type="submit"]');
          submitBtn.disabled = false;
          submitBtn.textContent = 'Place order';
        },
      },
    });
    rzp.open();
  }

  async function renderCheckoutSummary() {
    const el = document.querySelector('[data-checkout-summary]');
    if (!el) return;
    const cart = Cart.get();
    if (!cart.length) {
      el.innerHTML = '<p class="empty-state">Your cart is empty. <a href="index.html">Continue shopping</a></p>';
      document.querySelector('[data-checkout-form]').hidden = true;
      return;
    }
    const subtotal = Cart.subtotal();
    const config = await getConfig();
    const shipping = calculateShipping(subtotal, config);
    // Subtotal, shipping, and total are shown as three separate lines, on
    // purpose, matching exactly what the backend actually calculates and
    // exactly what Razorpay is about to charge. Previously this only
    // showed the subtotal labeled "Total", shipping never appeared here
    // even though it was being charged, this is that fix.
    el.innerHTML = cart.map((line) => (
      '<div class="summary-row"><span>' + escapeHtml(line.name) + ' (' + escapeHtml(line.size) + ') &times; ' + line.qty + '</span><span>' + formatPaise(line.qty * line.price) + '</span></div>'
    )).join('') +
      '<div class="summary-row"><span>Subtotal</span><span>' + formatPaise(subtotal) + '</span></div>' +
      '<div class="summary-row"><span>Shipping</span><span>' + (shipping === 0 ? 'Free' : formatPaise(shipping)) + '</span></div>' +
      '<div class="summary-row total"><span>Total</span><span>' + formatPaise(subtotal + shipping) + '</span></div>';
  }

  /* ---------------- Track order page (track-order.html) ---------------- */
  const trackForm = document.querySelector('[data-track-form]');
  let activeOrder = null;

  if (trackForm) {
    trackForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      const email = trackForm.querySelector('[name="email"]').value;
      const displayId = trackForm.querySelector('[name="orderId"]').value;
      const resultEl = document.querySelector('[data-track-result]');
      const notFoundEl = document.querySelector('[data-track-notfound]');
      try {
        const data = await API.trackOrder({ email, displayId });
        activeOrder = data.order;
        notFoundEl.hidden = true;
        resultEl.hidden = false;
        renderOrderResult(activeOrder, resultEl);
      } catch (err) {
        resultEl.hidden = true;
        notFoundEl.hidden = false;
        notFoundEl.textContent = err.message || 'We could not find that order.';
      }
    });
  }

  const STAGES = ['PENDING_PAYMENT', 'PROCESSING', 'SHIPPED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
  const STAGE_LABELS = { PENDING_PAYMENT: 'Payment pending', PROCESSING: 'Processing', SHIPPED: 'Shipped', OUT_FOR_DELIVERY: 'Out for delivery', DELIVERED: 'Delivered' };

  function renderOrderResult(order, container) {
    const stageIndex = STAGES.indexOf(order.status);
    container.querySelector('[data-order-id-out]').textContent = order.displayId;
    container.querySelector('[data-order-items-out]').innerHTML = order.items.map((l) => (
      '<div class="summary-row"><span>' + escapeHtml(l.name) + ' (' + escapeHtml(l.size) + ', ' + escapeHtml(l.color) + ') &times; ' + l.qty + '</span><span>' + formatPaise(l.qty * l.price) + '</span></div>'
    )).join('');
    const track = container.querySelector('[data-status-track]');
    if (order.status === 'CANCELLED') {
      track.innerHTML = '<p class="notice error">This order was cancelled.</p>';
    } else {
      track.innerHTML = STAGES.map((s, i) => {
        const cls = i < stageIndex ? 'done' : i === stageIndex ? 'current' : '';
        return '<div class="status-step ' + cls + '"><div class="dot"></div><div class="label">' + STAGE_LABELS[s] + '</div></div>';
      }).join('');
    }
    renderReturnItemPicker(order);
  }

  function renderReturnItemPicker(order) {
    const picker = document.querySelector('[data-return-item-picker]');
    if (!picker) return;
    picker.innerHTML = order.items.map((item) => (
      '<div class="return-item-row">' +
        '<label><input type="checkbox" data-return-item-check value="' + item.id + '"> ' +
          escapeHtml(item.name) + ' <span class="meta">(' + escapeHtml(item.size) + ', ' + escapeHtml(item.color) + ')</span></label>' +
        '<input type="number" data-return-item-qty="' + item.id + '" min="1" max="' + item.qty + '" value="1" disabled style="width:56px;">' +
        '<span class="meta">of ' + item.qty + '</span>' +
      '</div>'
    )).join('');
    picker.querySelectorAll('[data-return-item-check]').forEach((cb) => {
      cb.addEventListener('change', () => {
        const qtyInput = picker.querySelector('[data-return-item-qty="' + cb.value + '"]');
        qtyInput.disabled = !cb.checked;
      });
    });
  }

  function collectSelectedReturnItems() {
    const picker = document.querySelector('[data-return-item-picker]');
    if (!picker) return [];
    const items = [];
    picker.querySelectorAll('[data-return-item-check]:checked').forEach((cb) => {
      const qtyInput = picker.querySelector('[data-return-item-qty="' + cb.value + '"]');
      items.push({ orderItemId: cb.value, quantity: Math.max(1, Number(qtyInput.value) || 1) });
    });
    return items;
  }

  const returnToggle = document.querySelector('[data-return-toggle]');
  const returnPanel = document.querySelector('[data-return-panel]');
  if (returnToggle && returnPanel) {
    returnToggle.addEventListener('click', () => { returnPanel.hidden = !returnPanel.hidden; });
  }

  const returnForm = document.querySelector('[data-return-form]');
  if (returnForm) {
    const dropzone = returnForm.querySelector('[data-upload-drop]');
    const fileInput = returnForm.querySelector('[data-upload-input]');
    let selectedFile = null;
    if (dropzone && fileInput) {
      dropzone.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const file = fileInput.files[0];
        if (!file) return;
        selectedFile = file;
        const reader = new FileReader();
        reader.onload = () => {
          dropzone.classList.add('has-file');
          dropzone.innerHTML = '<img src="' + reader.result + '" alt="Selected proof photo"><div>Photo selected. Click to replace.</div>';
        };
        reader.readAsDataURL(file);
      });
    }
    returnForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      if (!activeOrder) return;
      const selectedItems = collectSelectedReturnItems();
      const reason = returnForm.querySelector('[name="reason"]').value;
      const description = returnForm.querySelector('[name="description"]').value.trim();
      const submitBtn = returnForm.querySelector('button[type="submit"]');
      if (!selectedItems.length) {
        showReturnFormError('Select at least one item to return.');
        return;
      }
      submitBtn.disabled = true;
      submitBtn.textContent = 'Submitting...';
      try {
        let photoUrl = null;
        if (selectedFile) photoUrl = await API.uploadReturnPhoto(selectedFile);
        const emailUsed = trackForm.querySelector('[name="email"]').value;
        const rec = await API.submitReturn({ displayId: activeOrder.displayId, email: emailUsed, items: selectedItems, reason, description, photoUrl });
        returnForm.hidden = true;
        const confirm = document.querySelector('[data-return-confirm]');
        confirm.hidden = false;
        confirm.querySelector('[data-return-id-out]').textContent = rec.displayId;
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Submit request';
        showReturnFormError(err.message || 'Something went wrong, please try again.');
      }
    });
  }

  function showReturnFormError(message) {
    const returnForm = document.querySelector('[data-return-form]');
    let errEl = returnForm.querySelector('[data-return-error]');
    if (!errEl) {
      errEl = document.createElement('div');
      errEl.className = 'notice error';
      errEl.setAttribute('data-return-error', '');
      returnForm.prepend(errEl);
    }
    errEl.textContent = message;
  }

  window.__velourActiveOrder = () => activeOrder;
})();
