import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? "/peel-gallery/" : "/",
  server: {
    port: 5202,
    strictPort: true,
  },
});
