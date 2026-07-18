import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Epic 9: builds into ../audio-engine/public/, which server.js serves
// directly on the same port as the contract WebSocket (see server.js's
// serveStatic doc comment) — `npm run build:ui` (audio-engine/package.json)
// runs this, then `npm start` just serves whatever's already in public/, no
// build step live. ui/ lives as a sibling of audio-engine/ (not nested
// inside it) — only audio-engine/'s own ws + node-web-audio-api deps live in
// its package.json, this sub-package's deps stay separate.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: '../audio-engine/public',
    emptyOutDir: true,
  },
})
