import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";

export default defineConfig({
  site: "https://gerardolucero.github.io",
  output: "static",
  integrations: [
    preact(),
    sitemap(),
  ],
  markdown: {
    shikiConfig: {
      theme: "github-dark-dimmed",
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
