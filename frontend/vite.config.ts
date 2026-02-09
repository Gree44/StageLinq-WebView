import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // in dev, proxy websocket + api to backend if you run it separately
    proxy: {
      '/ws': {
        target: 'ws://localhost:8090',
        ws: true,
      },
      '/api': {
        target: 'http://localhost:8090',
      },
    },
  },
});
