import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: "react-vendor",
              test: /[\\/]node_modules[\\/](react|react-dom|react-router-dom|scheduler)[\\/]/,
            },
            {
              name: "chart-vendor",
              test: /[\\/]node_modules[\\/]lightweight-charts[\\/]/,
            },
            {
              name: "icons-vendor",
              test: /[\\/]node_modules[\\/]lucide-react[\\/]/,
            },
            {
              name: "web3-vendor",
              test: /[\\/]node_modules[\\/](ethers|@adraffy|@noble|aes-js|tslib)[\\/]/,
            },
            {
              name: "vendor",
              test: /[\\/]node_modules[\\/]/,
            },
          ],
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/ws": {
        target: "ws://127.0.0.1:8787",
        ws: true,
      },
    },
  },
});
