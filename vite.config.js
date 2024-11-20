import { defineConfig } from "vite";

export default defineConfig({
  assetsInclude: ["**/*.tif"],
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
});
