import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import AutoImport from 'unplugin-auto-import/vite'
import Components from 'unplugin-vue-components/vite'
import { ElementPlusResolver } from 'unplugin-vue-components/resolvers'

export default defineConfig({
  plugins: [
    vue(),
    // Element Plus 按需自动导入：只有后台真正用到的组件会进包，
    // 用户端页面不会因为装了这个库而变大。
    AutoImport({ resolvers: [ElementPlusResolver()] }),
    Components({ resolvers: [ElementPlusResolver()] }),
  ],
  server: {
    host: true,
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
      '/admin-api': {
        target: 'http://localhost:3001',
        // 保留原始 Host / 透传 X-Forwarded-Host，
        // 否则后台的同源校验会把 vite dev 的请求当成跨站请求直接 403。
        changeOrigin: false,
        xfwd: true,
      },
      '/media': 'http://localhost:3001',
      '/s3-hls': 'http://localhost:3001',
      '/posters': 'http://localhost:3001',
      '/s3-posters': 'http://localhost:3001',
    },
  },
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        manualChunks: {
          hls: ['hls.js'],
        },
      },
    },
  },
})
