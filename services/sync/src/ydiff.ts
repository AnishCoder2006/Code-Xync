/**
 * "Does doc A hold anything B lacks?" helpers, shared by the relay (anti-entropy
 * reply skipping) and persistence (skip no-op writes).
 *
 * Why not just check `encodeStateAsUpdate(a, svB).length <= 2`? An empty Yjs update
 * is 2 bytes, but encodeStateAsUpdate always includes A's FULL delete set, so once A
 * has any deletion the diff is larger than 2 bytes even when B already has it all.
 */
import * as Y from "yjs";

/**
 * True if every deleted range in `mine` lies inside a deleted range of `theirs`.
 * Snapshot delete sets are sorted and merged per client, so a covered range must sit
 * inside a single range of theirs: binary-search it.
 */
export const deleteSetCovered = (mine: Y.Snapshot, theirs: Y.Snapshot): boolean => {
  for (const [client, items] of mine.ds.clients) {
    if (items.length === 0) continue;
    const theirItems = theirs.ds.clients.get(client);
    if (!theirItems) return false;
    for (const item of items) {
      let lo = 0;
      let hi = theirItems.length - 1;
      let found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (theirItems[mid].clock <= item.clock) {
          found = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (found < 0) return false;
      const t = theirItems[found];
      if (item.clock + item.len > t.clock + t.len) return false;
    }
  }
  return true;
};

/**
 * Given the diff `encodeStateAsUpdate(doc, theirSv)` and the other side's snapshot,
 * decide whether the diff carries data they do not have.
 */
export const diffHasNewData = (doc: Y.Doc, diff: Uint8Array, theirSnapshot: Y.Snapshot | null): boolean => {
  if (diff.length <= 2) return false;
  if (!theirSnapshot) return true;
  const { structs } = Y.decodeUpdate(diff);
  if (structs.length > 0) return true;
  return !deleteSetCovered(Y.snapshot(doc), theirSnapshot);
};

/** True if `doc` holds structs or deletions not contained in the stored update. */
export const docHasDataBeyond = (doc: Y.Doc, stored: Uint8Array): boolean => {
  const tmp = new Y.Doc();
  try {
    Y.applyUpdate(tmp, stored);
    const diff = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(tmp));
    return diffHasNewData(doc, diff, Y.snapshot(tmp));
  } finally {
    tmp.destroy();
  }
};
