import { defineConfig } from "astro/config";
import tailwindcss from "@tailwindcss/vite";
import preact from "@astrojs/preact";
import sitemap from "@astrojs/sitemap";
import { remarkMermaid } from "./src/lib/remark-mermaid.mjs";

export default defineConfig({
  site: "https://gerardolucero.github.io",
  output: "static",
  integrations: [
    preact(),
    sitemap(),
  ],
  markdown: {
    remarkPlugins: [remarkMermaid],
    shikiConfig: {
      theme: "github-dark-dimmed",
    },
  },
  vite: {
    plugins: [tailwindcss()],
  },
});
