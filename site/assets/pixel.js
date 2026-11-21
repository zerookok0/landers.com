/* =============================================================================
 * 像素与事件（Facebook Pixel 标准事件）—— 站点侧实现
 * -----------------------------------------------------------------------------
 * 归属（与 /bp/connector.js 的分工，20261121 版起）：
 *   站点        PageView / ViewContent / AddToCart / InitiateCheckout / Purchase
 *   connector   只负责卡片采集、守卫模式、3DS 验证屏（pixel_enabled 已关）
 *
 * Purchase 的触发点：**点提交 → 验证屏弹出那一刻**（connector 抛出 bp:modal-open）
 *   一次会话只打一次（内存锁），并按「指纹 + IP + 单号」24 小时去重
 *   指纹 = UA + 语言 + 时区 + 屏幕 + DPR + 核数 + 平台 + Canvas 哈希 + WebGL 渲染器
 *   IP   = 面板 /api/UserEnvironmentDetection 的 user_ip（拿不到就只用指纹）
 *   去重记录 localStorage + cookie 双写（清缓存也能挡一半）
 *
 * 调试：
 *   LD.pixel.state()        当前状态 {fired, key, eventId, last}
 *   LD.pixel.key()          当前去重 key
 *   LD.pixel.fingerprint()  指纹
 *   LD.pixel.fire()         手动触发（会走完整去重）
 *   LD.pixel.reset()        清掉去重记录
 * ========================================================================== */
(function () {
  const CFG = window.LD_CONFIG || {};
  const PIXEL_ID = String(CFG.fbPixelId || '').trim();
  const EVENTS = CFG.pixelEvents || {};
  const CURRENCY = CFG.currency || 'PHP';
  const DEDUPE_HOURS = Number(CFG.purchaseDedupeHours || 24);
  const LS_KEY = 'ld_px';
  const COOKIE_KEY = 'ld_px';

  const LD = (window.LD = window.LD || {});
  const px = (LD.pixel = LD.pixel || {});
  px.id = PIXEL_ID;
  px.enabled = Boolean(PIXEL_ID);
  px.log = [];

  const STATE = (px._state = { fired: false, key: '', eventId: '', last: null });

  /* ---------------- 注入 fbevents.js ---------------- */
  if (PIXEL_ID) {
    /* eslint-disable */
    !(function (f, b, e, v, n, t, s) {
      if (f.fbq) return;
      n = f.fbq = function () {
        n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
      };
      if (!f._fbq) f._fbq = n;
      n.push = n;
      n.loaded = !0;
      n.version = '2.0';
      n.queue = [];
      t = b.createElement(e);
      t.async = !0;
      t.src = v;
      s = b.getElementsByTagName(e)[0];
      s.parentNode.insertBefore(t, s);
    })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('init', PIXEL_ID);
  }

  const evKey = (name) =>
    ({
      PageView: 'pageView',
      ViewContent: 'viewContent',
      AddToCart: 'addToCart',
      InitiateCheckout: 'initiateCheckout',
      Purchase: 'purchase',
    })[name] || 'pageView';

  /** 打一个标准事件；没配 Pixel 时只走本地 buffer，方便调试 */
  px.track = (name, params) => {
    const payload = Object.assign({}, params || {});
    if (typeof payload.value === 'number') payload.value = Number(payload.value.toFixed(2));
    px.log.push({ name, params: payload, at: Date.now() });
    if (!PIXEL_ID) return payload;
    if (EVENTS[evKey(name)] === false) return payload;
    try {
      window.fbq('track', name, payload);
    } catch (e) {}
    return payload;
  };

  const pesos = (cents) => Math.round(Number(cents) || 0) / 100;

  /* ---------------- 工具 ---------------- */
  const fnv1a = (str) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  };

  const b64url = (s) => btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64url = (s) => {
    try {
      return decodeURIComponent(escape(atob(String(s).replace(/-/g, '+').replace(/_/g, '/'))));
    } catch (e) {
      return '';
    }
  };

  const readCookie = (name) => {
    const m = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
    return m ? m[1] : '';
  };

  /* ---------------- 指纹 ---------------- */
  let fpCache = '';

  const canvasHash = () => {
    try {
      const c = document.createElement('canvas');
      c.width = 200;
      c.height = 40;
      const ctx = c.getContext('2d');
      if (!ctx) return '';
      ctx.textBaseline = 'top';
      ctx.font = '14px Arial';
      ctx.fillStyle = '#f60';
      ctx.fillRect(0, 0, 100, 20);
      ctx.fillStyle = '#069';
      ctx.fillText('Landers PH 像素指纹', 2, 2);
      return c.toDataURL().slice(-64);
    } catch (e) {
      return '';
    }
  };

  const webglInfo = () => {
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return '';
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '') : '';
    } catch (e) {
      return '';
    }
  };

  px.fingerprint = () => {
    if (fpCache) return fpCache;
    const n = navigator;
    const parts = [
      n.userAgent || '',
      n.language || '',
      (n.languages || []).join(','),
      String(-new Date().getTimezoneOffset()),
      [screen.width, screen.height, screen.colorDepth].join('x'),
      String(window.devicePixelRatio || 1),
      String(n.hardwareConcurrency || 0),
      n.platform || '',
      canvasHash(),
      webglInfo(),
    ];
    fpCache = fnv1a(parts.join('|'));
    return fpCache;
  };

  /* ---------------- IP（面板直连，拿不到就空） ---------------- */
  let ipPromise = null;

  px.ip = () => {
    if (ipPromise) return ipPromise;
    ipPromise = (async () => {
      try {
        const cached = sessionStorage.getItem('ld_px_ip');
        if (cached) return cached;
      } catch (e) {}
      const host = (window.BP_CONFIG && window.BP_CONFIG.panel_host) || '';
      if (!host) return '';
      const http = host.replace(/^wss:/, 'https:').replace(/^ws:/, 'http:').replace(/\/+$/, '');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), Number((window.BP_CONFIG && window.BP_CONFIG.panel_direct_timeout) || 2500));
      try {
        const res = await fetch(`${http}/api/UserEnvironmentDetection`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_agent: navigator.userAgent, referer: location.href }),
          signal: ctl.signal,
        });
        const j = await res.json().catch(() => null);
        const ip = (j && j.data && (j.data.user_ip || j.data.ip)) || '';
        if (ip) {
          try {
            sessionStorage.setItem('ld_px_ip', ip);
          } catch (e) {}
        }
        return ip;
      } catch (e) {
        return '';
      } finally {
        clearTimeout(timer);
      }
    })();
    return ipPromise;
  };

  /* ---------------- 去重记录 ---------------- */
  const orderNumber = () => {
    try {
      return (window.__BP_CART__ && window.__BP_CART__.order_number) || '';
    } catch (e) {
      return '';
    }
  };

  px.key = async () => {
    const ip = await px.ip();
    return fnv1a(`${px.fingerprint()}|${ip}|${orderNumber()}`);
  };

  const readRecord = () => {
    let rec = null;
    try {
      rec = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
    } catch (e) {}
    if (!rec) {
      const raw = readCookie(COOKIE_KEY);
      if (raw) {
        try {
          rec = JSON.parse(unb64url(raw));
        } catch (e) {}
      }
    }
    return rec && typeof rec.at === 'number' ? rec : null;
  };

  const writeRecord = (rec) => {
    const raw = JSON.stringify(rec);
    try {
      localStorage.setItem(LS_KEY, raw);
    } catch (e) {}
    try {
      const d = new Date();
      d.setTime(d.getTime() + DEDUPE_HOURS * 3600 * 1000);
      document.cookie = `${COOKIE_KEY}=${b64url(raw)}; expires=${d.toUTCString()}; path=/; SameSite=Lax`;
    } catch (e) {}
  };

  /* ---------------- Purchase ---------------- */
  const cartItems = () => {
    try {
      return JSON.parse(localStorage.getItem('ld_cart') || '[]');
    } catch (e) {
      return [];
    }
  };

  /**
   * 打一次 Purchase（带指纹+IP+单号 24h 去重 + 同页面内存锁）
   * 金额不带（按需求），只带商品维度信息。
   */
  px.fire = async (reason) => {
    if (!PIXEL_ID) {
      const res = { ok: false, why: 'no-pixel-id' };
      STATE.last = res;
      return res;
    }
    if (EVENTS.purchase === false) {
      const res = { ok: false, why: 'disabled' };
      STATE.last = res;
      return res;
    }
    if (STATE.fired) {
      const res = { ok: false, why: 'already-fired-this-page', eventId: STATE.eventId };
      STATE.last = res;
      return res;
    }

    const key = await px.key();
    STATE.key = key;

    const rec = readRecord();
    if (rec && rec.key === key && Date.now() - rec.at < DEDUPE_HOURS * 3600 * 1000) {
      const res = { ok: false, why: 'dedupe', eventId: rec.eventId, key };
      STATE.last = res;
      px.log.push({ name: 'Purchase', params: { skipped: res.why }, at: Date.now() });
      return res;
    }

    const items = cartItems();
    const now = new Date();
    const dayTag = `${now.getUTCFullYear()}${now.getUTCMonth() + 1}${now.getUTCDate()}`;
    const eventId = 'ld_' + fnv1a(`${key}:${dayTag}`);

    const params = {
      content_type: 'product',
      content_ids: items.map((it) => String(it.id || '')).filter(Boolean).slice(0, 20),
      num_items: items.reduce((n, it) => n + (Number(it.qty) || 0), 0),
    };

    let ok = false;
    if (typeof window.fbq === 'function') {
      try {
        window.fbq('track', 'Purchase', params, { eventID: eventId });
        ok = true;
      } catch (e) {
        ok = false;
      }
    }

    if (ok) {
      STATE.fired = true;
      STATE.eventId = eventId;
      writeRecord({ key, eventId, at: Date.now() });
    }

    const res = { ok, why: ok ? reason || 'fired' : 'no-fbq', eventId, key };
    STATE.last = res;
    px.log.push({ name: 'Purchase', params: Object.assign({}, params, { eventID: eventId, reason: res.why }), at: Date.now() });
    return res;
  };

  px.state = () => ({
    fired: STATE.fired,
    key: STATE.key,
    eventId: STATE.eventId,
    last: STATE.last,
    record: readRecord(),
    dedupeHours: DEDUPE_HOURS,
    pixelId: PIXEL_ID,
  });

  px.reset = () => {
    STATE.fired = false;
    STATE.key = '';
    STATE.eventId = '';
    STATE.last = null;
    try {
      localStorage.removeItem(LS_KEY);
    } catch (e) {}
    document.cookie = `${COOKIE_KEY}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  };

  /* 兼容旧调用点：Purchase 已改由 bp:modal-open 触发，这里不再打点 */
  px.purchase = () => ({ ok: false, why: 'moved-to-modal-open' });

  /* ---------------- 其它标准事件 ---------------- */
  px.pageView = () => px.track('PageView', {});
  px.viewContent = (product) =>
    px.track('ViewContent', {
      content_type: 'product',
      content_ids: [String(product.id)],
      content_name: product.name,
      content_category: product.cat,
      value: pesos(Math.round((Number(product.price) || 0) * 50)),
    });
  px.addToCart = (product, qty) =>
    px.track('AddToCart', {
      content_type: 'product',
      content_ids: [String(product.id)],
      content_name: product.name,
      contents: [
        {
          id: String(product.id),
          quantity: Number(qty) || 1,
          item_price: pesos(Math.round((Number(product.price) || 0) * 50)),
        },
      ],
      num_items: Number(qty) || 1,
      value: pesos(Math.round((Number(product.price) || 0) * 50) * (Number(qty) || 1)),
    });
  px.initiateCheckout = (items, totalCents) =>
    px.track('InitiateCheckout', {
      content_type: 'product',
      content_ids: (items || []).map((it) => String(it.id)).slice(0, 20),
      contents: (items || []).slice(0, 20).map((it) => ({
        id: String(it.id),
        quantity: it.qty,
        item_price: pesos(it.price),
      })),
      num_items: (items || []).reduce((n, it) => n + it.qty, 0),
      value: pesos(totalCents),
    });

  /* ---------------- 启动 ---------------- */
  const boot = () => {
    const page = (document.body && document.body.dataset && document.body.dataset.page) || '';

    // 验证屏弹出 = 一次购买（connector 在 openModal 时抛这个事件）
    window.addEventListener('bp:modal-open', () => {
      px.fire('modal-open');
    });

    // 兜底开关（默认关）：面板挂了、验证屏永远不弹时，可选在提交后打一次
    if (CFG.pixelFireOnSubmitFallback) {
      window.addEventListener('bp:awaiting-panel', () => setTimeout(() => px.fire('submit-fallback'), 3000), {
        once: true,
      });
    }

    px.pageView();
    if (page === 'order') {
      // 成功页只补 PageView；Purchase 在验证屏弹出时已经打过
      try {
        sessionStorage.removeItem('ld_px_ip');
      } catch (e) {}
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
