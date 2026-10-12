/** File transfer UI constraints and optimistic/canonical reconciliation. */
export const MAX_ATTACHMENT_BYTES = 15_000_000; // 15 decimal MB

export function formatAttachmentSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1000) return Math.floor(bytes) + " B";
  if (bytes < 1_000_000) return (bytes / 1000).toFixed(1) + " KB";
  return (bytes / 1_000_000).toFixed(2) + " MB";
}

export function mergeFileTimeline(messages = [], pendingFiles = [], selected) {
  const rows = (messages || []).filter(row =>
    row.public_key === selected && ["message", "file"].includes(row.type));
  const canonical = rows.filter(row => row.type === "file");
  const used = new Set();
  const unresolved = [];
  for (const pending of pendingFiles || []) {
    if (pending.public_key !== selected || pending.type !== "file") continue;
    // A single file is optimistically shown before the server replies.
    // Native transfer callbacks may persist the canonical file first. Match
    // by transfer ID if known, otherwise only an outgoing same-file offer
    // generated during this upload. Never deduplicate real saved file rows.
    const match = canonical.find(file => {
      if (used.has(file.id) || file.direction !== "outgoing" ||
          pending.direction !== "outgoing" ||
          file.public_key !== pending.public_key) return false;
      if (pending.file_id) return file.file_id === pending.file_id;
      return !file.file_id ? false :
        file.file_name === pending.file_name &&
        file.file_size === pending.file_size &&
        Number.isFinite(file.at) && Number.isFinite(pending.at) &&
        file.at >= pending.at - 2000 &&
        file.at - pending.at < 15 * 60 * 1000;
    });
    if (match) {
      used.add(match.id);
      // Preserve instant local thumbnail until native file cache is ready.
      if (pending.previewBlob && !match.previewBlob) {
        const index = rows.indexOf(match);
        if (index !== -1) rows[index] = {...match, previewBlob: pending.previewBlob};
      }
    } else {
      unresolved.push(pending);
    }
  }
  return [...rows, ...unresolved].sort((a,b)=>(a.at||0)-(b.at||0));
}
