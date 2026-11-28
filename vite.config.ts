import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./", // works under https://<user>.github.io/<repo>/
  plugins: [preact()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  server: {
    watch: {
      // Keep the Python environment and pipeline working files out of Vite's watcher.
      ignored: [
        fileURLToPath(new URL("./.venv", import.meta.url)),
        fileURLToPath(new URL("./work", import.meta.url)),
      ],
    },
  },
});
