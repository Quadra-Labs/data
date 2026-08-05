import { defineConfig } from 'tsup';

// `verify` is a real entry, not just a library barrel: bin/quadra-verify.js imports it, so the
// published binary runs compiled JavaScript rather than needing tsx on a judge's machine.
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        verify: 'src/verify.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    treeshake: true,
    external: ['quadra-core'],
});
