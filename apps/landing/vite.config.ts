import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const lightningTarget = (major: number, minor = 0) => (major << 16) | (minor << 8)

export default defineConfig(({ command }) => ({
  build: {
    cssMinify: 'lightningcss',
    sourcemap: true,
  },
  css: {
    lightningcss: {
      targets: {
        chrome: lightningTarget(90),
        edge: lightningTarget(90),
        firefox: lightningTarget(102),
        safari: lightningTarget(14),
        ios_saf: lightningTarget(14),
      },
    },
  },
  plugins: [
    react(),
    ...(command === 'build' ? [cloudflare({ inspectorPort: 9230 })] : []),
  ],
  server: { port: 5182, strictPort: true },
}))
