import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), cloudflare({ inspectorPort: 9231 })],
  server: { port: 5182, strictPort: true },
})
