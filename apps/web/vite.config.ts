import { cloudflare } from "@cloudflare/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command }) => {
  return {
    build: { sourcemap: true },
    optimizeDeps: {
      entries: ["index.html", "src/**/*.{ts,tsx}", "!src/**/*.test.{ts,tsx}"],
      include: ["toqr", "streamdown"],
    },
    plugins: [
      tailwindcss(),
      react(),
      ...(command === "build" ? [cloudflare({ inspectorPort: 9229 })] : []),
    ],
    server: { port: 5180, strictPort: true },
  };
});
