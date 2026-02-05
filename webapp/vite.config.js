import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const host = process.env.VITE_DEV_HOST || "127.0.0.1";
const port = Number(process.env.VITE_DEV_PORT || 5173);
const apiTarget = process.env.VITE_API_TARGET || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    host,
    strictPort: true,
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port,
    host,
    strictPort: true,
  },
});
