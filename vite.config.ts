import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  base: "./", // works under https://<user>.github.io/<repo>/
  plugins: [preact()],
  worker: { format: "es" },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
});
