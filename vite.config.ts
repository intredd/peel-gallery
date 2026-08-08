import { defineConfig } from "vite";

export default defineConfig({
  // Pages project site in CI; root base for local dev/preview.
  base: process.env.GITHUB_ACTIONS ? "/peel-gallery/" : "/",
  server: {
    port: 5202,
    strictPort: true,
  },
});
