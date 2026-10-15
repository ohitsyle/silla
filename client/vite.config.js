import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
  build: {
    rollupOptions: {
      output: {
        // The libraries (React, the router, Motion, Socket.io, the icons)
        // change far less often than the app does. In their own chunk they
        // stay cached across deploys — /assets/* is served immutable — and
        // neither file crosses Vite's 500 kB warning, which the single
        // bundle had.
        manualChunks: (id) => (id.includes("node_modules") ? "vendor" : undefined),
      },
    },
  },
});
