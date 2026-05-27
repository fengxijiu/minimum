import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/tui/index.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  sourcemap: true,
  clean: true,
  dts: true,
  splitting: false,
  treeshake: true,
});
