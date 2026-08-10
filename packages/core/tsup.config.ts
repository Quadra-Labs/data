import { defineConfig } from 'tsup';

// `index` is the pure core and is what the evaluation engine's TEE image compiles in, so it
// must stay free of network I/O and native dependencies. The other entries are split out so that
// promise stays literally true: `ground-truth` DOES perform network I/O, `verify` carries the
// replay checks, `deployments` reads the address file, and `fcc` is the abi layout of the
// Confidential Compute result payloads (pure coding, but only settlement code needs it).
export default defineConfig({
    entry: {
        index: 'src/index.ts',
        groundTruth: 'src/groundTruth.ts',
        verify: 'src/verify/index.ts',
        deployments: 'src/deployments.ts',
        fcc: 'src/fcc/codec.ts',
        votingEpoch: 'src/votingEpoch.ts',
    },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    treeshake: true,
});
