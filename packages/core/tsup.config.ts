import { defineConfig } from 'tsup';

// `index` is the pure core and is what the evaluation engine's TEE image compiles in, so it
// must stay free of network I/O and native dependencies. Two more entries join it later —
// `ground-truth` (which does perform network I/O, and is split out so the promise above stays
// literally true) and `verify` (the replay checks).
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        groundTruth: 'src/groundTruth.ts',
        verify: 'src/verify/index.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    treeshake: true,
});
