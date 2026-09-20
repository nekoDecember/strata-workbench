import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
const apiTarget = process.env.STRATA_API_PROXY || "http://127.0.0.1:8000";
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
        configure(proxy) {
          proxy.on("proxyReq", (request) => {
            request.setHeader("origin", apiTarget);
          });
        },
      },
    },
  },
  build: { chunkSizeWarningLimit: 6000 },
});
