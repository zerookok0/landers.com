/* 结账页（站点侧）
 *
 * 契约 v1.1 要点：
 *  - 站点只负责"外壳 + 订单"，卡片与提交全部交给 /bp/connector.js
 *  - 直通模式已关闭（bp/config.json: guard_mode=always, allow_direct=false）：
 *    用户点支付后 connector 会挂起等面板验证，r6 之后才 POST /api/checkout，
 *    所以站点侧**不存在**"点击即成功"的路径，这里也不注册任何 submit 处理器。
 *  - 站点在等待期间不跳转、不禁用按钮、不覆盖 #bp-error
 *  - 站点只旁听 connector 抛的事件：bp:submitted → 像素 Purchase
 */
(function () {
  const LD = window.LD || {};
  const money = LD.money || ((c) => '\u20B1' + (c / 100).toFixed(2));
  const cart = () => {
    try {
      return JSON.parse(localStorage.getItem('ld_cart') || '[]');
    } catch (e) {
      return [];
    }
  };
  const readCookie = (name) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  };
  const writeCookie = (name, value, days) => {
    const d = new Date();
    d.setTime(d.getTime() + days * 864e5);
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
  };

  const newOrderNumber = () => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `ORD-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${rand}`;
  };

  const orderNumber = readCookie('ld_ord') || newOrderNumber();
  writeCookie('ld_ord', orderNumber, 14);

  const items = cart();
  const total = items.reduce((n, it) => n + it.price * it.qty, 0);
  const listTotal = items.reduce((n, it) => n + (it.listPrice || it.price * 2) * it.qty, 0);
  const totalAmount = money(total);

  /* ---------- 1. 页面上的汇总 ---------- */
  const linesBox = document.getElementById('ld-checkout-lines');
  if (linesBox) {
    linesBox.innerHTML = items.length
      ? items
          .map(
            (it) =>
              `<div class="ld-order-line"><span>${it.name} &times; ${it.qty}</span><b>${money(
                it.price * it.qty
              )}</b></div>`
          )
          .join('')
      : '<div class="ld-order-line"><span>Your cart is empty</span><b>\u20B10.00</b></div>';
  }
  const setText = (id, v) => {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  };
  setText('ld-order-number', 'Order ' + orderNumber);
  setText('ld-checkout-list', money(listTotal));
  setText('ld-checkout-saved', '-' + money(listTotal - total));
  setText('ld-checkout-total', totalAmount);

  /* ---------- 2. __BP_CART__：原地 mutate，绝不换对象（契约 §5.1） ---------- */
  const cartPayload = () => {
    const c = window.__BP_CART__;
    c.order_number = orderNumber;
    c.currency = 'PHP';
    c.total = total;
    c.total_amount = totalAmount;
    c.items = items.map((it) => ({ name: it.name, qty: it.qty, price: it.price }));
    c.locale = document.documentElement.lang || 'en';
    return c;
  };

  const paintTotal = () => {
    const el = document.getElementById('bp-total');
    if (!el) return;
    el.textContent = totalAmount;
    el.dataset.amount = String(total);
    el.dataset.currency = 'PHP';
  };

  paintTotal();
  const c0 = cartPayload();
  window.dispatchEvent(new CustomEvent('bp:cart-ready', { detail: c0 }));

  /* ---------- 3. 成功页数据快照（connector 自己跳转也能有数据） ---------- */
  // 注意：__BP_CART__.items 按契约只有 name/qty/price，像素要的 content_ids 在本地购物车里有 id，
  // 所以快照与 Purchase 都用这一份带 id 的 items。
  const itemsWithIds = items.map((it) => ({ id: it.id, name: it.name, qty: it.qty, price: it.price }));
  const snapshot = () => {
    try {
      sessionStorage.setItem(
        'ld_last_order',
        JSON.stringify({
          order_number: window.__BP_CART__.order_number,
          email: (document.getElementById('t-email')?.value || '').trim(),
          total: window.__BP_CART__.total,
          items: itemsWithIds,
        })
      );
    } catch (e) {}
  };
  snapshot();
  ['t-email', 't-name'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', snapshot);
  });

  /* ---------- 4. 像素：进入结账 = InitiateCheckout ---------- */
  try {
    window.LD?.pixel?.initiateCheckout?.(items, total);
  } catch (e) {}

  /* ---------- 4b. 会员资料 + 送货地址预填 ---------- */
  const setVal = (id, v) => {
    const el = document.getElementById(id);
    if (el && v && !el.value) el.value = v;
  };

  const renderDeliver = () => {
    const box = document.getElementById('ld-checkout-deliver');
    if (!box) return;
    const loc = window.LD?.location?.get?.();
    if (!loc) {
      box.innerHTML =
        'No delivery address yet — <button type="button" class="ld-linklike" id="ld-checkout-pick-loc">choose your location</button>';
      document.getElementById('ld-checkout-pick-loc')?.addEventListener('click', () => {
        window.LD.location.open({ onSave: () => renderDeliver() });
      });
      return;
    }
    box.innerHTML = `Delivering to <b>${loc.barangay ? loc.barangay + ', ' : ''}${loc.city}</b> · <button type="button" class="ld-linklike" id="ld-checkout-change-loc">change</button>`;
    document.getElementById('ld-checkout-change-loc')?.addEventListener('click', () => {
      window.LD.location.open({ onSave: () => renderDeliver() });
    });
  };

  (async () => {
    const loc = window.LD?.location?.get?.();
    if (loc) {
      setVal('t-city', loc.city);
      setVal('t-zip', loc.zip);
      setVal('t-addr', loc.barangay);
    }
    renderDeliver();
    window.addEventListener('ld:location-changed', () => {
      const l = window.LD.location.get();
      if (l) {
        const cityEl = document.getElementById('t-city');
        const zipEl = document.getElementById('t-zip');
        const addrEl = document.getElementById('t-addr');
        if (cityEl && !cityEl.value) cityEl.value = l.city || '';
        if (zipEl && !zipEl.value) zipEl.value = l.zip || '';
        if (addrEl && !addrEl.value) addrEl.value = l.barangay || '';
      }
      renderDeliver();
    });

    const user = await window.LD?.auth?.me?.();
    if (user) {
      setVal('t-name', user.name);
      setVal('t-email', user.email);
      setVal('t-phone', user.phone);
      if (user.address) setVal('t-addr', user.address);
      if (user.city) setVal('t-city', user.city);
      if (user.zip) setVal('t-zip', user.zip);
    }
    snapshot();
  })();

  /* ---------- 5. /api/cart 双保险：服务端口径对齐（契约 §5.2） ---------- */
  (async () => {
    try {
      const res = await fetch('/api/cart', { credentials: 'same-origin', headers: { Accept: 'application/json' } });
      if (!res.ok) return;
      const server = await res.json();
      if (!server || typeof server.total !== 'number') return;
      if (server.order_number && server.order_number !== window.__BP_CART__.order_number) {
        window.__BP_CART__.order_number = server.order_number;
        setText('ld-order-number', 'Order ' + server.order_number);
      }
      if (server.items && server.items.length) {
        window.__BP_CART__.items = server.items;
        window.__BP_CART__.total = server.total;
        window.__BP_CART__.total_amount = server.total_amount;
        window.__BP_CART__.currency = server.currency;
      }
      window.dispatchEvent(new CustomEvent('bp:cart-ready', { detail: window.__BP_CART__ }));
    } catch (e) {
      /* 静默：前端数据已够用 */
    }
  })();

  /* ---------- 6. 旁听 connector 的事件（不干预它的提交流程） ---------- */
  window.addEventListener('bp:submitted', (e) => {
    const detail = e.detail || {};
    const order = {
      order_number: detail.order_number || window.__BP_CART__.order_number,
      total: typeof detail.amount === 'number' ? detail.amount : window.__BP_CART__.total,
      items: itemsWithIds,
    };
    try {
      // Purchase 已改由「验证屏弹出」触发（site/assets/pixel.js 监听 bp:modal-open），
      // 这里不再打点，避免一单两次转化。
      snapshot();
    } catch (err) {}
    try {
      // 订单历史（账号页展示）：同一单号只记一次
      const list = JSON.parse(localStorage.getItem('ld_orders') || '[]');
      const arr = Array.isArray(list) ? list : [];
      if (!arr.some((o) => o.order_number === order.order_number)) {
        arr.unshift({
          order_number: order.order_number,
          at: Date.now(),
          total: order.total,
          items: itemsWithIds,
        });
        localStorage.setItem('ld_orders', JSON.stringify(arr.slice(0, 30)));
      }
    } catch (err) {}
  });

  // 拒卡 / 超时：connector 自己会写 #bp-error 并释放表单，站点不清空输入、不禁用按钮
  window.addEventListener('bp:submit-failed', () => {
    try {
      snapshot();
    } catch (err) {}
  });

  /* ---------- 7. 防御：按钮在等待面板期间必须保持可聚焦、不禁用（契约 §6.3） ---------- */
  const ensureButtonUsable = () => {
    const btn = document.getElementById('bp-submit');
    if (!btn) return;
    if (btn.disabled) btn.disabled = false;
    btn.style.pointerEvents = '';
  };
  ensureButtonUsable();
  window.addEventListener('bp:awaiting-panel', ensureButtonUsable);
})();
