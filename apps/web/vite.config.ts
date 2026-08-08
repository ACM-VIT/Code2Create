import { cloudflare } from '@cloudflare/vite-plugin'
import { sentryViteBuild } from '@code2create/client-observability/vite'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const sentry = sentryViteBuild({ ...loadEnv(mode, process.cwd(), ''), ...process.env })
  return {
    build: { sourcemap: sentry.sourcemap },
    plugins: [react(), cloudflare({ inspectorPort: 9229 }), ...sentry.plugins],
    server: { port: 5180, strictPort: true },
  }
})
