import { defineConfig } from "vite";

export default defineConfig({
  // Relative base — works on GitHub Pages project sites and local preview.
  base: "./",
  server: {
    port: 5202,
    strictPort: true,
  },
});
