import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import * as path from 'node:path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Capacitor 用 file/localhost 加载，必须相对路径
  base: './',
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, '../src/shared')
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
})
