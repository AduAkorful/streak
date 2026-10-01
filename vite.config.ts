import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@chain/casino-sdk/guest': resolve(rootDir, 'casino-sdk/src/guest.ts'),
      '@chain/casino-sdk': resolve(rootDir, 'casino-sdk/src/index.ts'),
    },
  },
  server: { port: 3100, cors: true },
  preview: { port: 3100, cors: true },
});
