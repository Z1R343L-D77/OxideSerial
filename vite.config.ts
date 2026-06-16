import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'esnext',
  },
  server: {
    host: '127.0.0.1',
    port: 1420,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
})
