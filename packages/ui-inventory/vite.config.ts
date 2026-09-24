import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devPort = process.env.VITE_DEV_PORT ? Number(process.env.VITE_DEV_PORT) : 5174;

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: [".trycloudflare.com"],
    port: devPort,
  },
  build: {
    outDir: "dist",
  },
});
