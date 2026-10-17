import { defineConfig, defaultClientConditions } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { isolationHeadersFor, pageFor } from './server/pages.js';

// One Vite project builds both the website (web/) and the mobile app
// (mobile/). URLs: /  -> web/index.html, /dashboard -> web/dashboard.html,
// /app/ -> mobile/index.html. The API server runs separately on port 3000.
function pages() {
  return {
    name: 'cogniroute-pages',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url, 'http://localhost');
        if (url.pathname === '/app') {
          res.statusCode = 301;
          res.setHeader('Location', '/app/');
          return res.end();
        }
        for (const [k, v] of Object.entries(isolationHeadersFor(url.pathname))) res.setHeader(k, v);
        const page = pageFor(url.pathname);
        if (page) req.url = `/${page}${url.search}`;
        next();
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  appType: 'mpa',
  plugins: [pages(), ...(mode === 'phone' ? [basicSsl()] : [])],
  resolve: {
    // onnxruntime-web: load its WebAssembly files from /vendor/ort instead of bundling them.
    conditions: ['onnxruntime-web-use-extern-wasm', ...defaultClientConditions],
  },
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['onnxruntime-web'] },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:3000' },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        home: 'web/index.html',
        dashboard: 'web/dashboard.html',
        app: 'mobile/index.html',
      },
    },
  },
}));
