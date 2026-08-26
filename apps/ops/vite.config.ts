import { cloudflare } from '@cloudflare/vite-plugin'
import { sentryViteBuild } from '@code2create/client-observability/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ command, mode }) => {
  const sentry = sentryViteBuild({ ...loadEnv(mode, process.cwd(), ''), ...process.env })
  return {
    build: { sourcemap: sentry.sourcemap },
    plugins: [
      tailwindcss(),
      react(),
      ...(command === 'build' ? [cloudflare({ inspectorPort: 9230 })] : []),
      ...sentry.plugins,
    ],
    server: { port: 5181, strictPort: true },
  }
})
