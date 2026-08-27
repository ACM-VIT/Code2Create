import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command }) => {
  return {
    build: { sourcemap: true },
    plugins: [
      tailwindcss(),
      react(),
      ...(command === 'build' ? [cloudflare({ inspectorPort: 9230 })] : []),
    ],
    server: { port: 5181, strictPort: true },
  }
})
