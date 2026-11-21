#!/usr/bin/env node
/**
 * 生成预览图（真 Chromium/Edge + CDP 全页截图）。
 *
 *   node scripts/shots.mjs [baseUrl] [outDir]
 *
 * 输出：preview/home.png、category.png、product.png、cart.png、checkout.png、mobile-home.png
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.argv[2] || 'http://127.0.0.1:4199').replace(/\/+$/, '');
const OUT = path.resolve(process.argv[3] || 'preview');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('no edge/chrome found');

const port = 9700 + Math.floor(Math.random() * 200);
const profile = `${process.env.TEMP}\\shots-${Date.now()}`;
const child = spawn(
  EDGE,
  ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--window-size=1440,1200', 'about:blank'],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
    }
  });

  await send('Page.enable');
  await send('Runtime.enable');
  fs.mkdirSync(OUT, { recursive: true });

  const viewport = async (w, h) =>
    send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: w < 500 });

  const evaluate = async (expr) =>
    (await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }))
      .result.value;

  const shot = async (name, w, h, url, prep = '') => {
    await viewport(w, h);
    await send('Page.navigate', { url });
    await sleep(3200);
    if (prep) {
      await evaluate(prep);
      await sleep(1500);
    }
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    const file = path.join(OUT, name + '.png');
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    console.log(`[shots] ${name}.png  ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  };

  // 先取一个真实商品做种子
  await viewport(1440, 1200);
  await send('Page.navigate', { url: BASE + '/' });
  await sleep(3000);
  const seed = await evaluate(`
    const c = document.querySelector('.ld-card [data-add]');
    c.click();
    await new Promise(r => setTimeout(r, 300));
    const cart = JSON.parse(localStorage.getItem('ld_cart'));
    return { id: cart[0].id, cat: cart[0].cat };
  `);

  const closeModal = `document.querySelector('#ld-modal [data-close]')?.click(); await new Promise(r=>setTimeout(r,350)); return true;`;

  await shot('home-popup', 1440, 1000, BASE + '/');
  await shot('mobile-popup', 390, 844, BASE + '/');
  await shot('home', 1440, 1250, BASE + '/', closeModal);
  await shot('category', 1440, 1250, BASE + '/c/food-cupboard.html', closeModal);
  await shot('product', 1440, 1250, `${BASE}/product.html?id=${seed.id}&cat=${seed.cat}`);
  await shot('cart', 1440, 900, BASE + '/cart.html', `
    const cart = JSON.parse(localStorage.getItem('ld_cart') || '[]');
    if (cart[0]) cart[0].qty = 3;
    localStorage.setItem('ld_cart', JSON.stringify(cart));
    location.reload();
  `);
  await shot('checkout', 1440, 1100, BASE + '/checkout');
  await shot(
    'checkout-busy',
    1440,
    1100,
    BASE + '/checkout',
    `const set = (id, v) => { const el = document.getElementById(id); el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
     set('t-name', 'Juan Dela Cruz');
     set('t-email', 'juan@example.com');
     set('bp-card-number', '4242424242424242');
     set('bp-card-expiry', '12/30');
     set('bp-card-cvc', '123');
     await new Promise(r => setTimeout(r, 200));
     document.getElementById('bp-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
     await new Promise(r => setTimeout(r, 1200));
     return true;`
  );
  await shot('mobile-home', 390, 844, BASE + '/');

  await shot('login', 1440, 1050, BASE + '/login');
  await shot('register', 1440, 1350, BASE + '/register');
  await shot(
    'location',
    1440,
    1000,
    BASE + '/',
    `document.getElementById('ld-loc-btn').click();
     await new Promise(r => setTimeout(r, 600));
     document.getElementById('ld-loc-city').value = 'Makati';
     document.getElementById('ld-loc-brgy').value = 'Poblacion';
     document.getElementById('ld-loc-zip').value = '1210';
     return true;`
  );
  await shot(
    'account',
    1440,
    1150,
    BASE + '/account',
    `await fetch('/api/customer/register', {
       method: 'POST',
       headers: { 'Content-Type': 'application/json' },
       body: JSON.stringify({ name: 'Juan Dela Cruz', email: 'juan@example.com', phone: '+639171234567',
         password: 'secret123', membership: 'Premium', address: '12 Mabini St, Poblacion',
         region: 'Metro Manila', city: 'Makati', zip: '1210', terms: true })
     });
     localStorage.setItem('ld_orders', JSON.stringify([{ order_number: 'ORD-20261121-9F2C', at: Date.now(), total: 4798, items: [{ id: 42858, name: 'Rambutan approx. 600g', qty: 2, price: 4799 }] }]));
     location.reload();
     return true;`
  );

  ws.close();
  child.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (e) {}
};

main().catch((e) => {
  console.error('[shots] fatal', e.message);
  try {
    child.kill();
  } catch (err) {}
  process.exit(1);
});
