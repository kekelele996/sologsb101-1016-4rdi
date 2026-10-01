import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath, URL } from 'node:url';

// 纯前端 SPA：产物交给 nginx:alpine 托管，开发端口与宿主映射端口保持一致（22816）
export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 22816,
    strictPort: false,
  },
  preview: {
    host: true,
    port: 22816,
  },
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    chunkSizeWarningLimit: 1600,
  },
});
