import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "/admin/",
  server: {
    port: 5173,
    proxy: { "/healthz": "http://127.0.0.1:8787", "/api": "http://127.0.0.1:8787" },
  },
});
