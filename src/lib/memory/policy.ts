import type { MemoryRecord } from "./types";

const stableSystemTypes = new Set<MemoryRecord["type"]>([
  "boundary",
  "preference",
  "procedural",
  "semantic",
]);

export function selectStableSystemMemories(memories: MemoryRecord[], limit = 8) {
  return memories
    .filter((memory) => stableSystemTypes.has(memory.type))
    .filter((memory) => memory.sensitivity !== "private")
    .slice(0, limit);
}

export function selectRetrievableMemories(memories: MemoryRecord[]) {
  return memories.filter((memory) => memory.confidence >= minimumRetrievalConfidence(memory.type));
}

export function selectProactiveMemories(memories: MemoryRecord[], limit: number) {
  return memories
    .filter((memory) => memory.sensitivity === "normal")
    .filter((memory) => memory.type === "affect" || memory.type === "episodic")
    .sort((left, right) => {
      if (right.importance !== left.importance) return right.importance - left.importance;
      return right.lastSeenAt.localeCompare(left.lastSeenAt);
    })
    .slice(0, limit);
}

function minimumRetrievalConfidence(type: MemoryRecord["type"]) {
  if (type === "safety") return 0.78;
  if (type === "affect") return 0.68;
  return 0.62;
}
