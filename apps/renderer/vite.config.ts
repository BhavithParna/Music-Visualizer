import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    // The daemon owns the socket and the art cache; proxy them so the dev
    // server and the kiosk build behave identically.
    proxy: {
      '/ws': { target: 'ws://localhost:8321', ws: true },
      '/art': 'http://localhost:8321',
      '/api': 'http://localhost:8321',
    },
  },
  build: { target: 'es2022', assetsInlineLimit: 4096 },
});
