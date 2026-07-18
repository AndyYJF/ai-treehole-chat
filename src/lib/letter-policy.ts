import { selectProactiveMemories } from "./memory/policy";
import type { MemoryRecord } from "./memory/types";

export const letterWindowDays = 14;
export const letterIntervalDays = 7;
export const minimumLetterMemoryCount = 3;

export function isLetterDue(lastLetterAt: string | null, now = Date.now()) {
  if (!lastLetterAt) return true;

  const lastTime = new Date(lastLetterAt).getTime();
  if (Number.isNaN(lastTime)) return true;

  return now - lastTime >= letterIntervalDays * 24 * 60 * 60 * 1000;
}

export function selectLetterMemories(memories: MemoryRecord[], now = Date.now()) {
  const since = now - letterWindowDays * 24 * 60 * 60 * 1000;

  return selectProactiveMemories(memories, 36)
    .filter((memory) => {
      const timestamp = new Date(memory.lastSeenAt || memory.createdAt).getTime();
      return !Number.isNaN(timestamp) && timestamp >= since;
    })
    .sort((left, right) => {
      if (right.importance !== left.importance) return right.importance - left.importance;
      return new Date(right.lastSeenAt).getTime() - new Date(left.lastSeenAt).getTime();
    })
    .slice(0, 18);
}
