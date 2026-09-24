import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const serverTarget = process.env.VITE_FEATURE_FLAG_WORKER_ORIGIN || "http://localhost:8787";
const devPort = process.env.VITE_DEV_PORT ? Number(process.env.VITE_DEV_PORT) : 5175;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: devPort,
    allowedHosts: [".trycloudflare.com", ".loca.lt"],
    proxy: {
      "/api": {
        target: serverTarget,
        changeOrigin: true,
      },
    },
  },
  preview: {
    port: devPort,
    proxy: {
      "/api": {
        target: serverTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
});
