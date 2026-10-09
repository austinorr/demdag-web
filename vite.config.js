import { defineConfig } from "vite";
import glsl from "vite-plugin-glsl";

export default defineConfig(({ command }) => ({
  plugins: [glsl({ minify: true })],
  base: "/demdag-web/",
  // Dev data (COGs + manifest) lives in the untracked _no_git_public/.
  // Never copy it into the build output.
  publicDir: command === "serve" ? "_no_git_public" : false,
  assetsInclude: ["**/*{.tif,.jpg}"],
  build: {
    outDir: "docs",
    emptyOutDir: true,
  },
}));
