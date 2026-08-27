import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => {
  return {
    build: { sourcemap: true },
    plugins: [
      react(),
      ...(command === 'build' ? [cloudflare({ inspectorPort: 9229 })] : []),
    ],
    server: { port: 5180, strictPort: true },
  }
})
