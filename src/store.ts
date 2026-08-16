export interface MirroredMessage {
  mirror: string;
  /** IDs of every webhook message produced for one source message, in order. */
  messageIds: string[];
}

interface Entry {
  targets: MirroredMessage[];
  content: string;
}

/**
 * Source message id -> webhook message ids, so edits and deletes can follow.
 * In-memory and bounded; the oldest entries fall off once the cap is hit, which
 * simply means very old messages stop syncing their edits.
 */
export class MessageStore {
  private map = new Map<string, Entry>();

  constructor(private readonly max = 5000) {}

  add(sourceId: string, mirror: string, messageIds: string[], content: string): void {
    let entry = this.map.get(sourceId);
    if (!entry) {
      entry = { targets: [], content };
      this.map.set(sourceId, entry);
    }
    entry.content = content;
    const existing = entry.targets.find((t) => t.mirror === mirror);
    if (existing) existing.messageIds = messageIds;
    else entry.targets.push({ mirror, messageIds });

    while (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
    }
  }

  get(sourceId: string): Entry | undefined {
    return this.map.get(sourceId);
  }

  setContent(sourceId: string, content: string): void {
    const entry = this.map.get(sourceId);
    if (entry) entry.content = content;
  }

  delete(sourceId: string): Entry | undefined {
    const entry = this.map.get(sourceId);
    this.map.delete(sourceId);
    return entry;
  }

  get size(): number {
    return this.map.size;
  }
}
