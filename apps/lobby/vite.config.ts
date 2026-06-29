import path from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  base: "/lobby/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": dirname,
    },
  },
});
