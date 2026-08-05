import { defineConfig } from 'tsup';

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    treeshake: true,
    // better-sqlite3 is native and fastify is a server framework; neither may be inlined into a
    // bundle that another repo imports. They stay runtime dependencies resolved by the consumer.
    external: ['better-sqlite3', 'fastify', 'quadra-core'],
});
