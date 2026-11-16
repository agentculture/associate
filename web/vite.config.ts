/// <reference types="vitest/config" />
// Cited from qodo-cli web/vite.config.ts @ ee73d5682a02952a76567887995b4f2e3aca5ea2
// (which cited culture-rules web/vite.config.ts @ b7f861f690b57c4355f81371cc02ad1dd2ae9cac;
// cite-don't-import: this repo owns its copy).
// Adapted: the dev proxy targets the associate runs API (ASSOCIATE_API_URL, default the loopback
// listener 127.0.0.1:8794); there is no dev-identity header (the browser carries the Access
// cookie, or a Bearer token is added by whatever fronts it); no Playwright; coverage as there.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The browser always talks to the same-origin prefix `/api` (src/api/client.ts); in dev that
// prefix is proxied to the API with the prefix stripped, so the browser never needs CORS. In
// production `associate serve` strips the same prefix itself (associate/bridge/static.py).
const API_TARGET = process.env.ASSOCIATE_API_URL ?? "http://127.0.0.1:8794";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: API_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4174,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    css: false,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["lcov", "text-summary"],
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/test/**", "src/main.tsx"],
    },
  },
});
