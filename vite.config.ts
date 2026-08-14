import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  // GATHERVILLE: was '/ai-town' upstream, which only resolved because
  // vercel.json rewrote /ai-town/* back to /*. Root base is what a
  // root-hosted SPA actually wants, and it removes the dependency on that
  // rewrite existing on whatever host we end up on.
  base: '/',
  plugins: [react()],
  server: {
    allowedHosts: ['ai-town-your-app-name.fly.dev', 'localhost', '127.0.0.1'],
  },
});
