import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 5174, not 5173: the portal and a buyer's app are routinely run side by
// side while checking that a profile produces the system it promised.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
  },
  preview: {
    port: 5174,
  },
});
