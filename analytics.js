(() => {
  const publicPaths = new Set(['/', '/about', '/blog', '/contact', '/cookie', '/fancy-cafe-pov-ideas', '/fancy-cafe-pov-meme-meaning', '/fancy-cafe-pov-trend-tiktok', '/first-time-in-a-fancy-cafe-ai-free', '/first-time-in-a-fancy-cafe-viral-video', '/how-to-make-first-time-in-a-fancy-cafe-ai-video', '/pricing', '/privacy', '/refund', '/terms']);
  const path = location.pathname.replace(/\/index\.html$/, '').replace(/\/$/, '') || '/';
  if (!publicPaths.has(path) || location.hostname !== 'fancycafeaivideo.pro') return;

  const script = (src) => { const node = document.createElement('script'); node.async = true; node.src = src; document.head.appendChild(node); };
  let referrer = '';
  try { if (document.referrer) referrer = new URL(document.referrer).origin; } catch { /* Invalid referrer is omitted. */ }
  window.dataLayer = window.dataLayer || [];
  function gtag() { window.dataLayer.push(arguments); }
  gtag('js', new Date());
  gtag('config', 'G-PPRXQ1L5XC', { send_page_view: false, page_location: location.origin + path, page_referrer: referrer, allow_google_signals: false, allow_ad_personalization_signals: false });
  gtag('event', 'page_view', { page_location: location.origin + path, page_referrer: referrer, page_title: document.title });
  script('https://www.googletagmanager.com/gtag/js?id=G-PPRXQ1L5XC');

  // Do not send URLs containing order identifiers or other query/fragment data to Clarity.
  if (location.search || location.hash) return;
  document.body.setAttribute('data-clarity-mask', 'true');
  window.clarity = window.clarity || function () { (window.clarity.q = window.clarity.q || []).push(arguments); };
  script('https://www.clarity.ms/tag/z96tgl8jkt');
})();
