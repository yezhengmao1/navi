import { createHash, randomUUID } from "node:crypto";
import type { SyncRecord } from "./confab-sync-state.js";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

/** Reserve the entire intended prefix BEFORE network I/O, including uncertain uploads. */
export function planSync(scope: string, lines: string[], records: SyncRecord[]) {
  const hashes = lines.map(hash);
  const compatible = records.filter(record => record.hashes.length <= hashes.length &&
    record.hashes.every((h, i) => h === hashes[i])).sort((a, b) => b.hashes.length - a.hashes.length)[0];
  const record: SyncRecord = compatible ? { ...compatible, hashes } : {
    // Never regenerate an old ID from a prefix: that remote may already contain its former descendants.
    externalId: "pi-live-" + hash(JSON.stringify(["v1", scope, randomUUID()])), hashes,
  };
  if (!compatible && records.length >= 100) throw new Error("Sync branch registry is full.");
  return { record, previousCount: compatible?.hashes.length ?? 0,
    created: !compatible, records: compatible
      ? records.map(r => r.externalId === compatible.externalId ? record : r)
      : [...records, record] };
}
