import { defineConfig } from "vite";

export default defineConfig({
  base: "/demdag-web/",
  assetsInclude: ["**/*{.tif,.jpg}"],
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
});
