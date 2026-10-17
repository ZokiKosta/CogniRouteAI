// URL -> HTML entry point mapping, shared by the Vite dev server and Express.
export const PAGES = {
  '/': 'web/index.html',
  '/index.html': 'web/index.html',
  '/dashboard': 'web/dashboard.html',
  '/dashboard.html': 'web/dashboard.html',
  '/app/': 'mobile/index.html',
  '/app/index.html': 'mobile/index.html',
};

export function pageFor(pathname) {
  return PAGES[pathname] ?? null;
}

/**
 * The mobile app runs YOLOv8 on several CPU threads, which needs a
 * cross-origin isolated page. The website pages stay non-isolated so the map
 * tiles from OpenStreetMap load normally.
 */
export function isolationHeadersFor(pathname) {
  const page = pageFor(pathname);
  if (page && page.startsWith('web/')) return {};
  return {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
}
