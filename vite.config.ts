import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: `dist/${process.env.VITE_ANILOG_PLATFORM === 'android' ? (process.env.VITE_ANILOG_EDITION === 'original' ? 'android-original' : 'android') : process.env.VITE_ANILOG_EDITION === 'original' ? 'original' : 'standard'}`,
  },
  server: {
    port: 5173,
    strictPort: false,
  },
});
