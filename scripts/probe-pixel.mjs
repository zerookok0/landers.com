#!/usr/bin/env node
/**
 * 像素链路探针（真浏览器 + CDP）：
 *   1) 打开 /checkout，塞一件商品到购物车
 *   2) 填卡 → 提交（connector 进入守卫态）
 *   3) 调 BPConnector.openModal() 模拟面板下发验证屏
 *   4) 读 LD.pixel.state() + 网络里有没有打到 facebook
 *
 *   node scripts/probe-pixel.mjs [baseUrl]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const BASE = (process.argv[2] || 'https://landers-com.pages.dev').replace(/\/+$/, '');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
].find((p) => fs.existsSync(p));
if (!EDGE) throw new Error('no edge/chrome found');

const port = 9500 + Math.floor(Math.random() * 200);
const profile = `${process.env.TEMP}\\pxprobe-${Date.now()}`;
const child = spawn(
  EDGE,
  [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--disable-blink-features=AutomationControlled',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--window-size=1440,1000',
    'about:blank',
  ],
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
  const net = [];
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
    } else if (msg.method === 'Network.responseReceived') {
      const u = msg.params.response.url;
      if (/facebook/.test(u)) net.push({ resp: u.slice(0, 120), status: msg.params.response.status, mime: msg.params.response.mimeType });
    } else if (msg.method === 'Network.requestWillBeSent') {
      net.push({ url: msg.params.request.url, type: msg.params.type });
    } else if (msg.method === 'Network.loadingFailed') {
      net.push({ failed: true, url: msg.params.requestId, err: msg.params.errorText, blocked: msg.params.blockedReason });
    } else if (msg.method === 'Runtime.exceptionThrown') {
      net.push({ exception: JSON.stringify(msg.params.exceptionDetails).slice(0, 300) });
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry;
      if (e.level === 'error') net.push({ console: e.text.slice(0, 240) });
    }
  });

  const evaluate = async (expr) => {
    const res = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails).slice(0, 400));
    return res.result.value;
  };
  const goto = async (url, wait = 2800) => {
    await send('Page.navigate', { url });
    await sleep(wait);
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Log.enable').catch(() => {});
  // 让 headless 页面表现得像"聚焦可见"，避免 FB 因为 document.hidden 把事件压住
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
  await send('Page.bringToFront').catch(() => {});

  console.log(`[probe] ${BASE}`);

  // 1) 先落地首页（同源），把购物车塞好
  await goto(BASE + '/');
  await evaluate(`
    const home = await (await fetch('/data/home.json')).json();
    const p = home.rails[0].items[0];
    localStorage.setItem('ld_cart', JSON.stringify([{
      id: p.id, name: p.name, price: Math.round(p.price * 50), listPrice: Math.round(p.price * 100),
      img: p.img, cat: p.cat, qty: 1
    }]));
    return { seed: p.name };
  `);

  // 2) 进结账页
  await goto(BASE + '/checkout', 3200);
  const initial = await evaluate(`
    return {
      total: window.__BP_CART__ && window.__BP_CART__.total,
      orderNumber: window.__BP_CART__ && window.__BP_CART__.order_number,
      pixelId: window.LD && window.LD.pixel && window.LD.pixel.id,
      state: window.LD && window.LD.pixel && window.LD.pixel.state(),
    };
  `);
  console.log('[probe] 初始状态', JSON.stringify(initial, null, 2));

  // 3) 填卡 + 提交
  await evaluate(`
    const set = (id, v) => { const el = document.getElementById(id); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    set('t-name', 'Probe User'); set('t-email', 'probe@example.com'); set('t-phone', '+639170000000');
    set('t-addr', '1 Probe St'); set('t-city', 'Makati'); set('t-zip', '1210');
    set('bp-card-number', '4242424242424242'); set('bp-card-expiry', '12/30'); set('bp-card-cvc', '123');
    await new Promise(r => setTimeout(r, 200));
    document.getElementById('bp-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
    return true;
  `);
  await sleep(1800);

  const afterSubmit = await evaluate(`
    return {
      mode: window.BPConnector && window.BPConnector.mode(),
      state: window.LD.pixel.state(),
      btnBusy: document.getElementById('bp-submit').classList.contains('bp-busy'),
    };
  `);
  console.log('[probe] 提交后（验证屏还没弹）', JSON.stringify(afterSubmit, null, 2));

  // 4) 模拟面板下发验证屏（走 connector 真路径）
  const opened = await evaluate(`
    let err = null;
    try {
      window.BPConnector.openModal('<html><body><div style="font:14px sans-serif;padding:20px">3DS verification (probe)</div></body></html>', { base: '/bp/3ds/' });
    } catch (e) { err = String(e && e.message || e); }
    await new Promise(r => setTimeout(r, 1200));
    return { err, state: window.LD.pixel.state(), log: (window.LD.pixel.log || []).filter(e => e.name === 'Purchase') };
  `);
  console.log('[probe] 验证屏弹出后', JSON.stringify(opened, null, 2));

  // 5) 再弹一次（去重）
  const again = await evaluate(`
    try { window.BPConnector.openModal('<html><body>3DS again</body></html>', { base: '/bp/3ds/' }); } catch (e) {}
    await new Promise(r => setTimeout(r, 900));
    return { state: window.LD.pixel.state(), purchaseCount: (window.LD.pixel.log || []).filter(e => e.name === 'Purchase').length };
  `);
  console.log('[probe] 二次弹出（应被去重）', JSON.stringify(again, null, 2));

  await sleep(4500);
  const urls = net.filter((n) => n.url).map((n) => n.url);
  const fb = urls.filter((u) => /facebook/.test(u));
  const tr = urls.filter((u) => /facebook\.com\/tr/.test(u));
  const problems = net.filter((n) => n.failed || n.exception || n.console);
  console.log('[probe] 打到 facebook 的请求数:', fb.length);
  console.log('[probe] facebook.com/tr 事件请求:', tr.length ? tr : '（无）');
  console.log('[probe] 失败/异常/控制台错误:', problems.length ? problems.slice(0, 8) : '（无）');

  // 直接手搓一次 fbq，看是不是我们代码的问题
  const raw = await evaluate(`
    try { window.fbq('track', 'Purchase', { content_type: 'product' }, { eventID: 'raw_probe_' + Date.now() }); } catch (e) { return String(e); }
    await new Promise(r => setTimeout(r, 3000));
    return 'ok';
  `);
  const tr2 = net.filter((n) => n.url && /facebook\.com\/tr/.test(n.url)).map((n) => n.url);
  console.log('[probe] 手搓 fbq 结果:', raw, ' /tr 请求:', tr2.length ? tr2.slice(0, 3) : '（无）');
  const fbqState = await evaluate(`
    return {
      hasFbq: typeof window.fbq === 'function',
      hasCall: !!(window.fbq && window.fbq.callMethod),
      queueLen: (window.fbq && window.fbq.queue) ? window.fbq.queue.length : -1,
      loaded: !!(window.fbq && window.fbq.loaded),
      version: window.fbq && window.fbq.version,
    };
  `);
  console.log('[probe] fbq 状态:', JSON.stringify(fbqState, null, 2));

  ws.close();
  child.kill();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch (e) {}
};

main().catch((e) => {
  console.error('[probe] fatal', e.message);
  try {
    child.kill();
  } catch (err) {}
  process.exit(2);
});
