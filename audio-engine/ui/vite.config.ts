import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Epic 9: builds into ../public/, which server.js serves directly on the
// same port as the contract WebSocket (see server.js's serveStatic doc
// comment) — `npm run build:ui` (audio-engine/package.json) runs this, then
// `npm start` just serves whatever's already in public/, no build step live.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: './',
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
})
