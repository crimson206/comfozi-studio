import { defineConfig } from 'tsup';

export default defineConfig({
  // index = library entry; cli = the comfozi-parse-fleet bin (shebang from source).
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm', 'cjs'],
  dts: { entry: 'src/index.ts' },
  clean: true,
  sourcemap: true,
  target: 'es2022',
});
