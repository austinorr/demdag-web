import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig({
  plugins: [glsl({ minify: true })],
  base: "/demdag-web/",
  assetsInclude: ["**/*{.tif,.jpg}"],
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
});
