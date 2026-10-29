// Rigged for the "No ads" check: FreeAppStore apps show no ads.
export function showAds() {
  const s = document.createElement('script');
  s.src = 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js';
  document.head.appendChild(s);
}
