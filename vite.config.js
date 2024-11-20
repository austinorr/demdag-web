import { defineConfig } from "vite";

export default defineConfig({
  base: "/demdag-web/",
  assetsInclude: ["**/*.tif"],
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
});
