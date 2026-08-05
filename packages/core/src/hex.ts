/**
 * Hex helpers used by the encryption modules.
 *
 * Small, but shared on purpose: `strip` existed in two copies in the Flare reference, and a hex
 * decoder that disagrees with itself about the `0x` prefix produces a key that is one byte short
 * and an error message that says nothing useful.
 */

import type { Hex } from 'viem';

/** Drop a leading `0x` if present. */
export function strip(value: string): string {
    return value.startsWith('0x') ? value.slice(2) : value;
}

/** Hex string (with or without `0x`) to bytes. */
export function toBytes(value: Hex | string): Buffer {
    return Buffer.from(strip(value), 'hex');
}
