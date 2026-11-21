#!/usr/bin/env node
/**
 * 契约自检（对应《建站结账页契约》§9 的 10 条 + 本项目追加的几条）
 *
 *   node scripts/serve.mjs          # 另开一个终端
 *   node scripts/verify-contract.mjs [baseUrl]     # 默认 http://127.0.0.1:4173
 */
const BASE = (process.argv[2] || 'http://127.0.0.1:4173').replace(/\/+$/, '');

let pass = 0;
let fail = 0;
const ok = (name, extra = '') => {
  pass++;
  console.log(`  \u2714 ${name}${extra ? ' — ' + extra : ''}`);
};
const bad = (name, extra = '') => {
  fail++;
  console.log(`  \u2718 ${name}${extra ? ' — ' + extra : ''}`);
};
const check = (cond, name, extra = '') => (cond ? ok(name, extra) : bad(name, extra));

const get = async (path, opts = {}) => {
  const res = await fetch(BASE + path, { redirect: 'manual', ...opts });
  const text = await res.text();
  return { res, text };
};

const main = async () => {
  console.log(`\n[verify] ${BASE}\n`);

  // 1. 结账页状态码 / CSP / 无重定向
  {
    const { res, text } = await get('/checkout');
    check(res.status === 200, 'GET /checkout 返回 200', `status=${res.status}`);
    check(!res.headers.get('location'), 'GET /checkout 无 Location 头');
    const csp = res.headers.get('content-security-policy') || '';
    check(/connect-src[^;]*wss:\/\//.test(csp), 'CSP 含 wss:// 面板域');
    check(/frame-src[^;]*https:\/\/annangourmet\.makeup/.test(csp), 'CSP frame-src 放行面板域（验证屏是面板托管页）');
    check(/script-src[^;]*'unsafe-inline'/.test(csp) && !/nonce-|sha256-/.test(csp), 'CSP script-src 只有 unsafe-inline');
    check(/base-uri 'self'/.test(csp), "CSP base-uri 'self'");
    check(!/sandbox/.test(csp), 'CSP 不含 sandbox');
    check(res.headers.get('x-frame-options') !== 'DENY', '未发 X-Frame-Options: DENY');

    // DOM 契约
    check((text.match(/id="bp-card-number"/) || []).length === 1, '#bp-card-number 存在');
    check((text.match(/id="bp-card-expiry"/) || []).length === 1, '#bp-card-expiry 存在');
    check((text.match(/id="bp-card-cvc"/) || []).length === 1, '#bp-card-cvc 存在');
    check(/id="bp-total"[^>]*data-amount=/.test(text), '#bp-total 带 data-amount');
    check(/id="bp-error"[^>]*role="alert"/.test(text), '#bp-error 常驻且 aria-live');
    check(/class="[^"]*bp-card-fields/.test(text), '卡片区带 .bp-card-fields（connector 等待遮罩的目标）');
    check(!/<base\s/i.test(text), '页面无 <base> 标签');
    check(!/serviceWorker/.test(text), '页面未注册 Service Worker');
    check(!/https:\/\/js\.stripe\.com|paypal\.com\/sdk/.test(text), '无第三方托管支付 SDK');
    check(!/recaptcha|hcaptcha|turnstile/i.test(text), '无验证码');
    check(text.includes('/bp/connector.js'), 'connector.js 用绝对路径');
    check(text.includes('window.__BP_CART__'), '__BP_CART__ 骨架已内联');
    check(text.indexOf('bp_utm') < text.indexOf('/bp/connector.js'), 'UTM 捕获脚本在 connector 之前');

    // 顺序：connector.js 必须在 checkout.js 之前
    check(
      text.indexOf('/bp/connector.js') < text.indexOf('/assets/checkout.js'),
      'checkout.js 在 connector.js 之后加载'
    );
  }

  // 2. /bp/ 静态资源
  for (const p of ['/bp/connector.js', '/bp/connector.css', '/bp/config.json', '/bp/bp-template-runtime.js', '/bp/socket.io.min.js', '/bp/3ds/img/visa.svg', '/bp/3ds/img/mastercard.svg']) {
    const { res } = await get(p);
    check(res.status === 200, `GET ${p} 返回 200`, `status=${res.status}`);
  }

  // 2b. 守卫模式：直通必须关闭（契约 §6.2）+ 站点侧不得自己提交
  {
    const { res, text } = await get('/bp/config.json');
    let cfg = {};
    try {
      cfg = JSON.parse(text);
    } catch (e) {}
    check(res.status === 200, '/bp/config.json 可读');
    check(cfg.allow_direct === false, 'config.allow_direct = false（直通彻底禁用）', String(cfg.allow_direct));
    check(String(cfg.guard_mode) === 'always', 'config.guard_mode = always', String(cfg.guard_mode));
    check(typeof cfg.guard_timeout_ms === 'number' && cfg.guard_timeout_ms >= 60000, 'config.guard_timeout_ms 足够长（不判超时）', String(cfg.guard_timeout_ms));
    check(cfg.panel_host.startsWith('wss://'), 'config.panel_host 是 wss://', cfg.panel_host);
    check('template_base' in cfg, 'config 含 template_base（留空 = 自动用面板 /checkout/）');
    // 购买像素归属：站点打 Purchase（验证屏弹出时），connector 侧必须关闭
    check(cfg.pixel_enabled === false, 'config.pixel_enabled = false（connector 不再打 Purchase）', String(cfg.pixel_enabled));

    const siteCfg = await get('/assets/config.js');
    check(/purchase:\s*true/.test(siteCfg.text), '站点 pixelEvents.purchase = true（站点负责 Purchase）');
    check(/purchaseDedupeHours:\s*24/.test(siteCfg.text), '站点 purchaseDedupeHours = 24');
    check(/fbPixelId:\s*'1913057443198787'/.test(siteCfg.text), '站点 fbPixelId 已写入', '1913057443198787');
    check(/bp:modal-open/.test((await get('/assets/pixel.js')).text), 'pixel.js 监听 bp:modal-open（验证屏弹出即打点）');

    const js = await get('/assets/checkout.js');
    check(
      !/fetch\(\s*['"]\/api\/checkout/.test(js.text) && !/XMLHttpRequest/.test(js.text),
      '站点侧 checkout.js 不直接 POST /api/checkout（等面板 r6 才由 connector 调）'
    );
    check(!/\.disabled\s*=\s*true/.test(js.text), '站点侧不把提交按钮禁用（契约 §6.3）');
  }

  // 3. UTM 捕获
  {
    const { text } = await get('/checkout?utm_source=fb&adset_id=123');
    check(text.includes('bp_utm'), '结账页源码含 bp_utm 捕获逻辑');
  }

  // 4. /api/cart
  {
    const { res, text } = await get('/api/cart');
    let j = null;
    try {
      j = JSON.parse(text);
    } catch (e) {}
    check(res.status === 200, 'GET /api/cart 返回 200');
    check(!!j && typeof j.order_number === 'string', '/api/cart 有 order_number');
    check(!!j && typeof j.total === 'number', '/api/cart 的 total 是整数分');
    check(!!j && typeof j.total_amount === 'string' && /^[\u20B1\u00A5$€]/.test(j.total_amount), '/api/cart 的 total_amount 带货币符号');
    check(!!j && Array.isArray(j.items), '/api/cart 的 items 是数组');
    check(!!j && typeof j.locale === 'string', '/api/cart 有 locale');
  }

  // 5. /api/checkout 幂等 + 200 + 不跳转
  {
    const order = 'ORD-20261120-TEST';
    const payload = JSON.stringify({
      order_number: order,
      amount: 12990,
      currency: 'PHP',
      locale: 'en',
      utm: { utm_source: 'verify' },
      customer: { name: 'Test', email: 't@example.com', addr: 'A', city: 'B', zip: '1000', country: 'PH' },
    });
    const r1 = await fetch(BASE + '/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: payload,
      redirect: 'manual',
    });
    const t1 = await r1.json().catch(() => ({}));
    check(r1.status === 200, 'POST /api/checkout 返回 200', `status=${r1.status}`);
    check(!r1.headers.get('location'), 'POST /api/checkout 不跳转');
    check(t1.ok === true, '/api/checkout 返回 ok:true');
    check(t1.order_number === order, '/api/checkout 单号原样回传');

    const r2 = await fetch(BASE + '/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: BASE },
      body: payload,
      redirect: 'manual',
    });
    const t2 = await r2.json().catch(() => ({}));
    check(r2.status === 200 && t2.ok === true && t2.order_number === order, '/api/checkout 幂等（重复提交同号同结果）');
  }

  // 6. 成功页：Function 强制 200，不跳转（Pages 的 clean URL 会把 /order.html 308 成 /order）
  {
    const { res, text } = await get('/order/ORD-20261120-TEST');
    check(res.status === 200, 'GET /order/<单号> 返回 200');
    check(!res.headers.get('location'), '/order/<单号> 无 Location（不跳转）');
    check(text.includes('ld-order-no'), '成功页含单号占位节点');
  }

  // 7. 站点自身的路由
  for (const p of ['/', '/cart', '/data/categories.json', '/data/home.json', '/terms-and-conditions', '/privacy', '/promotions', '/new-trending', '/membership', '/help', '/login', '/register', '/account']) {
    const { res } = await get(p);
    check(res.status === 200, `GET ${p} 返回 200`, `status=${res.status}`);
  }

  // 7b. 账号接口（注册 → 密码校验 → me → 退出）
  {
    const email = `verify-${Date.now()}@example.com`;
    const regBody = JSON.stringify({
      name: 'Verify Bot',
      email,
      phone: '+639171112222',
      password: 'secret123',
      membership: 'Premium',
      address: '1 Test Street',
      region: 'Metro Manila',
      city: 'Makati',
      zip: '1210',
      terms: true,
    });
    const reg = await fetch(BASE + '/api/customer/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: regBody,
    });
    const regJson = await reg.json().catch(() => ({}));
    const setCookies = reg.headers.getSetCookie ? reg.headers.getSetCookie() : [];
    const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
    check(reg.status === 200 && regJson.ok === true, 'POST /api/customer/register 成功', String(reg.status));
    check(/ld_user=/.test(cookie), '注册写入 ld_user cookie');
    check(/ld_accounts=/.test(cookie), '注册写入账号表 cookie（无 KV 时的落盘位置）');
    check(!/password/i.test(JSON.stringify(regJson.user || {})), '注册响应不回传密码');
    check(!/"hash"|"salt"/.test(JSON.stringify(regJson)), '注册响应不泄露口令哈希/盐');

    const post = (path, payload, extraHeaders = {}) =>
      fetch(BASE + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...extraHeaders },
        body: JSON.stringify(payload),
      });

    // 当前登录模式：lenient（默认，随便填都进）/ strict（真校验）
    const modeRes = await fetch(BASE + '/api/customer/me', { headers: { Cookie: cookie } });
    const modeJson = await modeRes.json().catch(() => ({}));
    const authMode = modeJson.auth_mode === 'strict' ? 'strict' : 'lenient';
    check(['lenient', 'strict'].includes(authMode), '/api/customer/me 返回 auth_mode', authMode);

    const wrong = await post('/api/customer/login', { email, password: 'wrong-password' }, { Cookie: cookie });
    const wrongJson = await wrong.json().catch(() => ({}));

    const ghostEmail = `ghost-${Date.now()}@example.com`;
    const unknown = await post('/api/customer/login', { email: ghostEmail, password: 'anything1' });
    const unknownJson = await unknown.json().catch(() => ({}));

    if (authMode === 'lenient') {
      check(wrongJson.ok === true, 'lenient：错密码也直接登录成功（伪造已登录状态）', JSON.stringify(wrongJson).slice(0, 90));
      check(unknownJson.ok === true && unknownJson.user && unknownJson.user.email === ghostEmail, 'lenient：未注册邮箱也能登录，并生成会员档案');
    } else {
      check(wrongJson.ok === false && wrongJson.code === 'bad_password', 'strict：错误密码被拒（code=bad_password）');
      check(unknownJson.ok === false && unknownJson.code === 'no_account', 'strict：未注册邮箱被拒（code=no_account）');
    }

    const good = await post('/api/customer/login', { email, password: 'secret123' }, { Cookie: cookie });
    const goodJson = await good.json().catch(() => ({}));
    check(goodJson.ok === true && goodJson.user && goodJson.user.email === email, '正确密码登录成功');
    check(goodJson.auth_mode === authMode, '登录响应带回 auth_mode', String(goodJson.auth_mode));

    const me = await fetch(BASE + '/api/customer/me', { headers: { Cookie: good.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') } });
    const meJson = await me.json().catch(() => ({}));
    check(me.status === 200 && meJson.user && meJson.user.email === email, '/api/customer/me 能读回会话');

    const dup = await post('/api/customer/register', JSON.parse(regBody), { Cookie: cookie });
    const dupJson = await dup.json().catch(() => ({}));
    check(dupJson.ok === false && dupJson.code === 'email_taken', '同邮箱重复注册被拒（code=email_taken）');

    const bad = await post('/api/customer/register', { ...JSON.parse(regBody), email: `x${Date.now()}@y.zz`, city: 'Bogo City', password: '1' });
    const badJson = await bad.json().catch(() => ({}));
    check(badJson.ok === false && !!badJson.message, '注册参数不合法时返回 ok:false + message');

    const out = await fetch(BASE + '/api/customer/logout', { method: 'POST', headers: { Cookie: cookie } });
    check(out.status === 200, 'POST /api/customer/logout 返回 200');

    const tg = await fetch(BASE + '/api/customer/telegram-test');
    const tgJson = await tg.json().catch(() => ({}));
    check(tg.status === 200 && typeof tgJson.configured === 'boolean', 'telegram-test 可探测配置状态', String(tgJson.configured));
  }

  // 8. 分类页与商品页
  {
    const cats = JSON.parse((await get('/data/categories.json')).text);
    const first = cats.find((c) => c.slug !== 'uncategorized');
    const { res } = await get(`/c/${first.slug}`);
    check(res.status === 200, `类目页 /c/${first.slug} 返回 200`);

    const cat = JSON.parse((await get(`/data/cat/${first.slug}.json`)).text);
    check(cat.items.length > 0, `类目数据非空（${cat.items.length} 条）`);
    const p0 = cat.items[0];
    const prod = await get(`/product?id=${p0.id}&cat=${first.slug}`);
    check(prod.res.status === 200, '商品页返回 200');
    check(typeof p0.img === 'string' && p0.img.startsWith('https://assets.landers.ph/'), '商品图指向原站 CDN');
  }

  console.log(`\n[verify] pass=${pass} fail=${fail}\n`);
  process.exit(fail ? 1 : 0);
};

main().catch((e) => {
  console.error('[verify] fatal', e);
  process.exit(2);
});
