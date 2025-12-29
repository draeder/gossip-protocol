import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import inject from '@rollup/plugin-inject'

export default defineConfig({
  plugins: [
    vue(),
    inject({
      Buffer: ['buffer', 'Buffer'],
      process: 'process'
    })
  ],
  define: {
    global: 'globalThis',
    'process.env': {}
  },
  resolve: {
    alias: {
      events: 'events',
      util: 'util',
      stream: 'stream-browserify',
      buffer: 'buffer',
      process: 'process/browser'
    }
  },
  optimizeDeps: {
    include: ['simple-peer', 'events', 'util', 'stream-browserify', 'buffer', 'process']
  }
})
