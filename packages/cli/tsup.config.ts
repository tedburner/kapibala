import { defineConfig } from 'tsup';

export default defineConfig({
  noExternal: ['@kiturone/kapibala-host'],
  entry: ['src/index.ts', 'src/bin.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
