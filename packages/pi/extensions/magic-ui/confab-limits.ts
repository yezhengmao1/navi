/** Upstream CLI uses 14 MiB chunks; upstream sync HTTP body limit is 16 MiB.
 * Count JSON-encoded line bytes (including escaping), leaving room for the request envelope.
 * A deployment's reverse proxy may impose a lower limit; never describe this as its verified limit.
 */
export const CONFAB_CHUNK_BYTES = 14 * 1024 * 1024;
export const encodedLineBytes = (line: string) => Buffer.byteLength(JSON.stringify(line), "utf8") + 1;
