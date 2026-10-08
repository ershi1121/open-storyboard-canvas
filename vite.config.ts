import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Strip development-only console output from production builds. We keep
  // `console.error` / `console.warn` because they surface real problems
  // worth seeing in the WebView devtools (or a future Sentry-like sink),
  // and drop the chatty `log` / `info` / `debug` / `trace` calls that
  // are useful during development but pure noise in shipped binaries.
  esbuild: {
    pure: ['console.log', 'console.info', 'console.debug', 'console.trace'],
  },

  build: {
    // Split heavy third-party libs into their own chunks so the main
    // bundle stays small on cold start. Each chunk is fetched lazily
    // when the feature that needs it actually mounts (see BlueprintNode,
    // PanoramaPanel, AnnotateToolEditor — all wrapped in React.lazy).
    //
    // Sizes are approximate (gzipped):
    //   three           — ~140 KB (BlueprintScene + GLTF playback)
    //   konva           — ~70 KB  (AnnotateToolEditor only)
    //   pano            — ~50 KB  (PanoramaPanel only)
    //   markdown        — ~40 KB  (settings dialog only)
    //   react-vendor    — ~50 KB  (always loaded)
    rollupOptions: {
      output: {
        manualChunks: {
          three: ['three'],
          konva: ['konva', 'react-konva'],
          pano: ['@photo-sphere-viewer/core'],
          markdown: ['react-markdown', 'remark-gfm', 'remark-breaks'],
          'react-vendor': ['react', 'react-dom'],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
