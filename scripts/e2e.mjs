#!/usr/bin/env node
/**
 * End-to-end smoke test with a real Chromium/Edge over CDP (no third-party deps).
 *
 *   home -> ADD TO CART -> /cart.html (+qty) -> /checkout (fill card) -> /order/<no>
 *
 *   node scripts/e2e.mjs [baseUrl]      # default http://127.0.0.1:4199
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = (process.argv[2] || 'http://127.0.0.1:4199').replace(/\/+$/, '');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('no edge/chrome found');

const port = 9400 + Math.floor(Math.random() * 300);
const profile = `${process.env.TEMP}\\e2e-${Date.now()}`;
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,1000',
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0;
let fail = 0;
const check = (cond, name, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`);
  } else {
    fail++;
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`);
  }
};

const main = async () => {
  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch (e) {}
    if (!wsUrl) await sleep(250);
  }
  if (!wsUrl) throw new Error('cdp not ready');

  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const events = [];
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id;
      pending.set(mid, { resolve, reject });
      ws.send(JSON.stringify({ id: mid, method, params }));
    });
  await new Promise((r) => ws.addEventListener('open', r));
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  });

  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 300));
    return res.result.value;
  };
  const goto = async (url) => {
    await send('Page.navigate', { url });
    await sleep(2600);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  console.log(`\n[e2e] ${BASE}\n`);

  // 1. home
  await goto(BASE + '/');
  const home = await evaluate(`
    const cards = document.querySelectorAll('.ld-card').length;
    const firstHref = document.querySelector('.ld-card-media')?.getAttribute('href') || '';
    const navCount = document.querySelectorAll('.ld-side a').length;
    return { cards, firstHref, navCount, title: document.title };
  `);
  check(home.cards > 10, 'home renders product cards', `${home.cards} cards`);
  check(home.navCount > 5, 'sidebar categories injected', `${home.navCount} links`);
  check(/\/product\?id=\d+/.test(home.firstHref), 'product link shape', home.firstHref);

  // 2. add to cart
  const added = await evaluate(`
    document.querySelector('.ld-card [data-add]').click();
    await new Promise(r => setTimeout(r, 400));
    const cart = JSON.parse(localStorage.getItem('ld_cart') || '[]');
    return { count: cart.length, qty: cart[0]?.qty || 0, price: cart[0]?.price || 0, listPrice: cart[0]?.listPrice || 0, badge: document.getElementById('ld-cart-count')?.textContent };
  `);
  check(added.count === 1, 'add-to-cart creates one line');
  check(added.qty === 1, 'qty is 1');
  check(
    added.price > 0 && added.price === Math.round(added.listPrice / 2),
    'sale price is exactly half of list (centavos, rounded)',
    `${added.price} / ${added.listPrice}`
  );
  check(added.badge === '1', 'header badge synced to 1');

  // 2b. 进场弹窗 + 像素事件
  const pop = await evaluate(`
    await new Promise(r => setTimeout(r, 1500));
    const m = document.getElementById('ld-modal');
    const events = (window.LD && window.LD.pixel && window.LD.pixel.log || []).map(e => e.name);
    const timer = document.getElementById('ld-promo-timer');
    const before = timer ? timer.textContent : '';
    await new Promise(r => setTimeout(r, 1300));
    return {
      exists: !!m,
      visible: !!(m && m.classList.contains('is-on')),
      title: m?.querySelector('#ld-modal-title')?.textContent || '',
      cta: m?.querySelector('.ld-promo-cta')?.getAttribute('href') || '',
      ctaText: (m?.querySelector('.ld-promo-cta')?.textContent || '').trim(),
      badges: m ? m.querySelectorAll('.ld-promo-badge-item').length : 0,
      timerBefore: before,
      timerAfter: timer ? timer.textContent : '',
      events,
    };
  `);
  check(pop.exists && pop.visible, 'promo modal pops on first visit', pop.title);
  check(/50% OFF/i.test(pop.title), 'hero shows the 50% offer', pop.title);
  check(pop.cta.includes('/'), 'promo modal has CTA link', pop.cta);
  check(/shop now/i.test(pop.ctaText), 'CTA label is "Shop now →"', pop.ctaText);
  check(pop.badges === 3, 'three trust badges rendered', String(pop.badges));
  check(/^\d{2}:\d{2}:\d{2}$/.test(pop.timerBefore), 'countdown renders HH:MM:SS', pop.timerBefore);
  check(pop.timerAfter !== pop.timerBefore, 'countdown is ticking', `${pop.timerBefore} → ${pop.timerAfter}`);
  check(pop.events.includes('PageView'), 'pixel fired PageView', pop.events.join(','));
  check(pop.events.includes('AddToCart'), 'pixel fired AddToCart', pop.events.join(','));

  // 3. product page
  await evaluate(`
    const cart = JSON.parse(localStorage.getItem('ld_cart'));
    location.href = '/product?id=' + cart[0].id + '&cat=' + cart[0].cat;
    return true;
  `);
  await sleep(2600);
  const pd = await evaluate(`
    return {
      h1: document.querySelector('#ld-product h1')?.textContent || '',
      now: document.querySelector('.ld-pv-price .now')?.textContent || '',
      was: document.querySelector('.ld-pv-price .was')?.textContent || '',
      addBtn: !!document.getElementById('ld-add-main'),
      stacked: !!document.querySelector('#ld-product .ld-pv-media') && !!document.querySelector('#ld-product .ld-pv-body'),
      related: document.querySelectorAll('#ld-related .ld-card').length,
      pageView: (window.LD && window.LD.pixel && window.LD.pixel.log || []).map(e => e.name),
    };
  `);
  check(pd.h1.length > 3, 'product page title', pd.h1.slice(0, 40));
  check(/[\u20B1]/.test(pd.now) && /[\u20B1]/.test(pd.was), 'product page shows sale + list price', `${pd.now} / ${pd.was}`);
  check(pd.addBtn, 'product page has ADD TO CART');
  check(pd.stacked, 'product page is stacked (media above body)');
  check(pd.pageView.includes('ViewContent'), 'pixel fired ViewContent', pd.pageView.join(','));
  check(pd.related > 0, 'related products rendered', `${pd.related} cards`);

  // 4. cart page qty
  await goto(BASE + '/cart');
  const cartPage = await evaluate(`
    const row = document.querySelector('.ld-cart-row');
    row.querySelector('[data-step="1"]').click();
    await new Promise(r => setTimeout(r, 400));
    const cart = JSON.parse(localStorage.getItem('ld_cart'));
    return { rows: document.querySelectorAll('.ld-cart-row').length, qty: cart[0].qty, sum: document.getElementById('ld-cart-summary')?.textContent.includes('Total') };
  `);
  check(cartPage.rows === 1, 'cart page has one row');
  check(cartPage.qty === 2, 'qty + works', `qty=${cartPage.qty}`);
  check(cartPage.sum, 'cart summary shows total');

  // 5. checkout page contract state
  await goto(BASE + '/checkout?utm_source=facebook&adset_id=123');
  const co = await evaluate(`
    const c = window.__BP_CART__;
    const t = document.getElementById('bp-total');
    return {
      cardFields: document.querySelectorAll('#bp-card-number,#bp-card-expiry,#bp-card-cvc').length,
      orderNumber: c.order_number,
      total: c.total,
      totalAmount: c.total_amount,
      domAmount: t?.dataset.amount,
      textMatch: t?.textContent === c.total_amount,
      utm: JSON.parse(sessionStorage.getItem('bp_utm') || '{}'),
      connectorLoaded: !!document.querySelector('script[src="/bp/connector.js"]'),
      apiCart: await (await fetch('/api/cart')).json(),
    };
  `);
  check(co.cardFields === 3, 'checkout has 3 card inputs');
  check(/^ORD-/.test(co.orderNumber), 'order number generated', co.orderNumber);
  check(co.total > 0, 'total is integer centavos', String(co.total));
  check(String(co.domAmount) === String(co.total), 'data-amount matches __BP_CART__.total');
  check(co.textMatch, 'total text matches total_amount', co.totalAmount);
  check(co.utm.utm_source === 'facebook' && co.utm.adset_id === '123', 'utm captured', JSON.stringify(co.utm));
  check(co.connectorLoaded, 'connector.js loaded');
  check(co.apiCart.total === co.total, '/api/cart total matches frontend', String(co.apiCart.total));

  // 6. 点支付 -> 守卫模式（直通已关闭：不跳转、等面板指令）
  await evaluate(`
    document.getElementById('t-name').value = 'Juan Dela Cruz';
    document.getElementById('t-email').value = 'juan@example.com';
    document.getElementById('t-phone').value = '+639171234567';
    document.getElementById('t-addr').value = '12 Mabini St, Barangay Poblacion';
    document.getElementById('t-city').value = 'Makati';
    document.getElementById('t-zip').value = '1210';
    const set = (id, v) => {
      const el = document.getElementById(id);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set('bp-card-number', '4242424242424242');
    set('bp-card-expiry', '12/30');
    set('bp-card-cvc', '123');
    await new Promise(r => setTimeout(r, 300));
    document.getElementById('bp-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  `);
  await sleep(2500);
  const guard = await evaluate(`
    const m = window.BPConnector && window.BPConnector.mode ? window.BPConnector.mode() : null;
    const log = (window.LD && window.LD.pixel && window.LD.pixel.log || []).map(e => e.name);
    const btn = document.getElementById('bp-submit');
    const veil = document.querySelector('.bp-card-fields');
    const cpx = window.BPConnector && window.BPConnector.pixel ? window.BPConnector.pixel.state() : null;
    return {
      url: location.pathname,
      mode: m,
      btnDisabled: !!btn?.disabled,
      busyClass: !!btn?.classList.contains('bp-busy'),
      veilClass: !!veil?.classList.contains('bp-veil'),
      sitePurchase: log.filter(n => n === 'Purchase').length,
      connectorFired: !!(cpx && cpx.fired),
    };
  `);
  check(guard.url === '/checkout', 'submit does not self-redirect (waits for panel)', guard.url);
  check(!!guard.mode && guard.mode.need_guard === true, 'connector entered guard mode', JSON.stringify(guard.mode));
  check(!!guard.mode && guard.mode.awaiting === true, 'connector is awaiting the panel');
  check(guard.btnDisabled === false, '#bp-submit stays enabled while waiting');
  check(guard.busyClass === true, 'button shows the spinner state (.bp-busy)');
  check(guard.veilClass === true, 'card fields are veiled (.bp-veil), not the whole form');
  check(guard.connectorFired === false, 'connector-side pixel is off (site owns Purchase)');
  check(guard.sitePurchase === 0, 'no Purchase before the verification screen opens');

  // 7b. 验证屏弹出 -> 站点侧打一次 Purchase
  const pxFire = await evaluate(`
    window.dispatchEvent(new CustomEvent('bp:modal-open', { detail: { reason: 'test' } }));
    await new Promise(r => setTimeout(r, 600));
    const st = window.LD.pixel.state();
    const log = (window.LD.pixel.log || []).filter(e => e.name === 'Purchase');
    return {
      fired: st.fired,
      ok: st.last && st.last.ok,
      eventId: st.eventId,
      key: String(st.key || ''),
      fp: String(window.LD.pixel.fingerprint() || ''),
      count: log.length,
      params: log[0] ? JSON.stringify(log[0].params) : '',
      hasValue: log[0] ? Object.prototype.hasOwnProperty.call(log[0].params, 'value') : null,
    };
  `);
  check(pxFire.fired === true, 'verification screen fires Purchase', pxFire.eventId);
  check(pxFire.ok === true, 'Purchase reached fbq');
  check(/^ld_/.test(pxFire.eventId), 'eventID generated for CAPI dedupe', pxFire.eventId);
  check(pxFire.count === 1, 'exactly one Purchase event', String(pxFire.count));
  check(pxFire.hasValue === false, 'Purchase carries no value (as requested)');
  check(pxFire.fp.length > 4 && pxFire.key.length > 0, 'dedupe key = hash(fingerprint|ip|order)', `fp=${pxFire.fp} key=${pxFire.key}`);

  // 7c. 再弹一次 -> 去重
  const dedupe = await evaluate(`
    window.dispatchEvent(new CustomEvent('bp:modal-open', { detail: { reason: 'again' } }));
    await new Promise(r => setTimeout(r, 500));
    const st = window.LD.pixel.state();
    return { fired: st.fired, last: st.last, count: (window.LD.pixel.log || []).filter(e => e.name === 'Purchase').length };
  `);
  check(dedupe.count === 1, 'second verification screen does not double count', String(dedupe.count));

  // 7. 模拟面板 r6(to_finish) 放行 -> 成功页
  const released = await evaluate(`
    const no = window.__BP_CART__.order_number;
    window.dispatchEvent(new CustomEvent('bp:submitted', { detail: { ok: true, order_number: no, amount: window.__BP_CART__.total } }));
    await new Promise(r => setTimeout(r, 400));
    const log = (window.LD && window.LD.pixel && window.LD.pixel.log || []).filter(e => e.name === 'Purchase');
    return { no, sitePurchase: log.length };
  `);
  check(released.sitePurchase === 1, 'release does not add another Purchase');

  await goto(BASE + '/order/' + released.no);
  const after = await evaluate(`
    await new Promise(r => setTimeout(r, 1200));
    const log = (window.LD && window.LD.pixel && window.LD.pixel.log || []);
    const purchase = log.filter(e => e.name === 'Purchase');
    return {
      url: location.pathname,
      no: document.getElementById('ld-order-no')?.textContent || '',
      total: document.getElementById('ld-order-total')?.textContent || '',
      purchaseCount: purchase.length,
    };
  `);
  check(/^\/order\/ORD-/.test(after.url), 'order page reachable at /order/<no>', after.url);
  check(/^ORD-/.test(after.no), 'success page shows order number', after.no);
  check(/[\u20B1]/.test(after.total), 'success page shows amount', after.total);
  check(after.purchaseCount === 0, 'Purchase not double-counted on the success page (deduped)');

  // 8. 送货地址弹窗
  await goto(BASE + '/');
  const locPick = await evaluate(`
    document.getElementById('ld-loc-btn').click();
    await new Promise(r => setTimeout(r, 400));
    const modal = document.getElementById('ld-loc-modal');
    const opened = !!modal && modal.classList.contains('is-on') && !!document.getElementById('ld-loc-city');
    const city = document.getElementById('ld-loc-city');
    city.value = 'Makati';
    document.getElementById('ld-loc-brgy').value = 'Poblacion';
    document.getElementById('ld-loc-save').click();
    await new Promise(r => setTimeout(r, 350));
    return {
      modalShown: opened,
      label: document.querySelector('.ld-loc-text')?.textContent || '',
      saved: JSON.parse(localStorage.getItem('ld_loc') || 'null'),
      clickable: !!document.getElementById('ld-loc-btn'),
    };
  `);
  check(locPick.clickable && locPick.modalShown, 'delivery location modal opens from header');
  check(locPick.saved && locPick.saved.city === 'Makati', 'location saved', JSON.stringify(locPick.saved));
  check(/Makati/.test(locPick.label), 'header shows the chosen location', locPick.label);

  // 9. 注册（会员申请）
  await goto(BASE + '/register');
  await evaluate(`
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('ld-name', 'Juan Dela Cruz');
    set('ld-email', 'juan@example.com');
    set('ld-phone', '+63 917 123 4567');
    set('ld-password', 'secret123');
    set('ld-password2', 'secret123');
    set('ld-address', '12 Mabini St, Poblacion');
    set('ld-zip', '1210');
    document.getElementById('ld-city').value = 'Makati';
    document.getElementById('ld-terms').checked = true;
    document.getElementById('ld-register-submit').click();
    return true;
  `);
  await sleep(3000);
  const reg = await evaluate(`
    return {
      url: location.pathname,
      name: (document.getElementById('ld-profile')?.textContent || '').includes('Juan Dela Cruz'),
      chip: document.getElementById('ld-account-chip')?.textContent || '',
      header: document.getElementById('ld-account')?.textContent || '',
    };
  `);
  check(reg.url === '/account', 'registration lands on /account', reg.url);
  check(reg.name === true, 'profile shows the registered name');
  check(/member/i.test(reg.chip), 'membership tier shown', reg.chip);
  check(/Hi, Juan/.test(reg.header), 'header shows the signed-in member', reg.header.trim().slice(0, 40));

  // 9b. 结账页预填（姓名/邮箱来自账号）
  await goto(BASE + '/checkout');
  const prefill = await evaluate(`
    return {
      name: document.getElementById('t-name')?.value || '',
      email: document.getElementById('t-email')?.value || '',
      city: document.getElementById('t-city')?.value || '',
      deliver: document.getElementById('ld-checkout-deliver')?.textContent || '',
    };
  `);
  check(prefill.name === 'Juan Dela Cruz' && prefill.email === 'juan@example.com', 'checkout prefilled from account', prefill.name);
  check(/Makati/.test(prefill.deliver), 'checkout shows delivery location', prefill.deliver.trim());

  // 10. 退出 + 重新登录
  await goto(BASE + '/account');
  await evaluate(`document.getElementById('ld-logout').click(); return true;`);
  await sleep(2200);
  const out = await evaluate(`
    return { url: location.pathname, header: document.getElementById('ld-account')?.textContent || '' };
  `);
  check(out.url === '/' || out.url === '/login', 'logout leaves the account page', out.url);
  check(/Login/.test(out.header), 'header back to Sign Up / Login', out.header.trim());

  await goto(BASE + '/login');
  await evaluate(`
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('ld-email', 'juan@example.com');
    set('ld-password', 'secret123');
    document.getElementById('ld-login-submit').click();
    return true;
  `);
  await sleep(2600);
  const login = await evaluate(`
    return {
      url: location.pathname,
      name: (document.getElementById('ld-profile')?.textContent || '').includes('Juan'),
    };
  `);
  check(login.url === '/account', 'login returns to /account', login.url);
  check(login.name === true, 'login restores the registered profile');

  // 10b. 登录模式决定错误密码的行为：lenient（默认）= 直接进，strict = 报错留在登录页
  const authMode = await evaluate(`
    const r = await fetch('/api/customer/me', { credentials: 'same-origin' });
    const j = await r.json().catch(() => ({}));
    return j.auth_mode === 'strict' ? 'strict' : 'lenient';
  `);
  await evaluate(`document.getElementById('ld-logout')?.click(); return true;`);
  await sleep(2000);
  await goto(BASE + '/login');
  await evaluate(`
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('ld-email', 'juan@example.com');
    set('ld-password', 'totally-wrong');
    document.getElementById('ld-login-submit').click();
    return true;
  `);
  await sleep(2200);
  const wrong = await evaluate(`
    return { url: location.pathname, err: document.getElementById('ld-login-error')?.textContent || '' };
  `);
  if (authMode === 'lenient') {
    check(wrong.url === '/account', 'lenient: wrong password still signs in (fake logged-in state)', wrong.url);
  } else {
    check(wrong.url === '/login', 'strict: wrong password stays on /login', wrong.url);
    check(/incorrect password/i.test(wrong.err), 'strict: wrong password shows an error', wrong.err.trim());
  }

  // 10c. 随机邮箱：lenient 也必须是"登录成功"
  await goto(BASE + '/account');
  await evaluate(`document.getElementById('ld-logout')?.click(); return true;`);
  await sleep(2000);
  await goto(BASE + '/login');
  await evaluate(`
    const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('ld-email', 'guest-' + Date.now() + '@example.com');
    set('ld-password', 'whatever');
    document.getElementById('ld-login-submit').click();
    return true;
  `);
  await sleep(2400);
  const guest = await evaluate(`
    return {
      url: location.pathname,
      header: document.getElementById('ld-account')?.textContent || '',
      profile: document.getElementById('ld-profile')?.textContent || '',
    };
  `);
  if (authMode === 'lenient') {
    check(guest.url === '/account', 'lenient: unknown email signs in', guest.url);
    check(/Hi,/.test(guest.header), 'lenient: header shows a member', guest.header.trim().slice(0, 30));
  } else {
    check(guest.url === '/login', 'strict: unknown email stays on /login', guest.url);
  }

  // 11. console errors
  const errors = events
    .filter((e) => e.method === 'Runtime.exceptionThrown' || (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error'))
    .map((e) => JSON.stringify(e.params).slice(0, 160));
  const realErrors = errors.filter((t) => !/annangourmet|socket\.io|WebSocket|connect_error|ERR_NAME|net::/i.test(t));
  check(realErrors.length === 0, 'no unhandled page errors', realErrors.slice(0, 2).join(' | '));

  console.log(`\n[e2e] pass=${pass} fail=${fail}\n`);
  ws.close();
  child.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (e) {}
  process.exit(fail ? 1 : 0);
};

main().catch((e) => {
  console.error('[e2e] fatal', e.message);
  try {
    child.kill();
  } catch (err) {}
  process.exit(2);
});
