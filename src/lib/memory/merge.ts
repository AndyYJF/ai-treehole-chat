import type { MemoryRecord } from "./types";

const similarityThreshold = 0.72;

export function findMergeTarget<T extends Pick<MemoryRecord, "id" | "type" | "content">>(
  memories: T[],
  incoming: Pick<MemoryRecord, "type" | "content">,
  excludeId?: string,
): T | null {
  const incomingContent = incoming.content.trim();
  if (!incomingContent) return null;

  let best: { memory: T; score: number } | null = null;

  for (const memory of memories) {
    if (memory.id === excludeId || memory.type !== incoming.type) continue;

    const score = memorySimilarity(memory.content, incomingContent);
    if (score >= similarityThreshold && (!best || score > best.score)) {
      best = { memory, score };
    }
  }

  return best?.memory ?? null;
}

export function mergeMemoryRecord(base: MemoryRecord, incoming: MemoryRecord): MemoryRecord {
  return {
    ...base,
    content: chooseContent(base, incoming),
    confidence: Math.max(base.confidence, incoming.confidence),
    importance: Math.max(base.importance, incoming.importance),
    sensitivity: stricterSensitivity(base.sensitivity, incoming.sensitivity),
    sourceMessageIds: Array.from(new Set([...base.sourceMessageIds, ...incoming.sourceMessageIds])),
    userConfirmed: base.userConfirmed || incoming.userConfirmed,
    validFrom: earlierTime(base.validFrom, incoming.validFrom),
    validUntil: incoming.validUntil ?? base.validUntil,
    createdAt: earlierTime(base.createdAt, incoming.createdAt) ?? base.createdAt,
    lastSeenAt: laterTime(base.lastSeenAt, incoming.lastSeenAt) ?? incoming.lastSeenAt,
  };
}

export function maintainMemoryRecords(memories: MemoryRecord[], limit = 80): MemoryRecord[] {
  const maintained: MemoryRecord[] = [];

  for (const memory of memories) {
    const target = findMergeTarget(maintained, memory);

    if (target) {
      const index = maintained.findIndex((item) => item.id === target.id);
      maintained[index] = mergeMemoryRecord(target, memory);
      continue;
    }

    maintained.push({
      ...memory,
      content: memory.content.trim(),
    });
  }

  return maintained.sort(sortMemoryForMaintenance).slice(0, limit);
}

export function memorySimilarity(a: string, b: string): number {
  const left = normalizeMemoryText(a);
  const right = normalizeMemoryText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length >= 10 && right.length >= 10 && (left.includes(right) || right.includes(left))) {
    return Math.min(left.length, right.length) / Math.max(left.length, right.length);
  }

  const leftTokens = tokenizeMemory(left);
  const rightTokens = tokenizeMemory(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return intersection / union;
}

function normalizeMemoryText(text: string): string {
  return text
    .toLowerCase()
    .replace(/用户|本人|自己|我/g, "")
    .replace(/[，。！？、；：“”‘’"'`~!@#$%^&*()[\]{}_\-+=|\\/:;,.?<> \t\r\n]/g, "")
    .trim();
}

function tokenizeMemory(text: string): Set<string> {
  const normalized = normalizeMemoryText(text);
  const tokens = new Set<string>();

  for (const match of normalized.matchAll(/[a-z0-9]{2,}/g)) {
    tokens.add(match[0]);
  }

  for (let index = 0; index < normalized.length - 1; index += 1) {
    tokens.add(normalized.slice(index, index + 2));
  }

  return tokens;
}

function chooseContent(base: MemoryRecord, incoming: MemoryRecord): string {
  if (incoming.userConfirmed && !base.userConfirmed) return incoming.content.trim();
  if (incoming.importance > base.importance + 10) return incoming.content.trim();
  if (incoming.content.trim().length > base.content.trim().length + 8) return incoming.content.trim();
  return base.content.trim();
}

function stricterSensitivity(
  a: MemoryRecord["sensitivity"],
  b: MemoryRecord["sensitivity"],
): MemoryRecord["sensitivity"] {
  const order: MemoryRecord["sensitivity"][] = ["normal", "sensitive", "private"];
  return order[Math.max(order.indexOf(a), order.indexOf(b))];
}

function earlierTime(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;

  return new Date(a).getTime() <= new Date(b).getTime() ? a : b;
}

function laterTime(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;

  return new Date(a).getTime() >= new Date(b).getTime() ? a : b;
}

function sortMemoryForMaintenance(a: MemoryRecord, b: MemoryRecord): number {
  const typeOrder = ["safety", "boundary", "procedural", "preference", "semantic", "affect", "episodic"];
  const typeDelta = typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type);

  if (typeDelta !== 0) return typeDelta;
  if (b.importance !== a.importance) return b.importance - a.importance;
  if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt.localeCompare(a.lastSeenAt);
  return a.id.localeCompare(b.id);
}
