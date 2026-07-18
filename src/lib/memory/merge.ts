import type { MemoryRecord } from "./types";

const similarityThreshold = 0.72;
const strictSimilarityThreshold = 0.86;
const negationPenalty = 0.2;
const decayRatePerDay: Partial<Record<MemoryRecord["type"], number>> = {
  affect: 0.92,
  episodic: 0.985,
};
const strictMergeTypes = new Set<MemoryRecord["type"]>(["preference", "boundary"]);
const negationPatterns = [
  "不喜欢",
  "不想",
  "不愿",
  "不要",
  "不能",
  "不会",
  "不是",
  "并不",
  "没有",
  "没",
  "别",
  "讨厌",
  "拒绝",
  "避免",
  "不",
] as const;

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

    const score = memorySimilarity(memory.content, incomingContent, incoming.type);
    if (score >= mergeThresholdForType(incoming.type) && (!best || score > best.score)) {
      best = { memory, score };
    }
  }

  return best?.memory ?? null;
}

export function mergeMemoryRecord(
  base: MemoryRecord,
  incoming: MemoryRecord,
  options: { applyDecay?: boolean } = {},
): MemoryRecord {
  // Decay is a retrieval-time score, not a destructive mutation. Keeping this
  // opt-in preserves compatibility for callers that explicitly need a scored
  // snapshot without repeatedly shrinking the stored importance.
  const shouldApplyDecay = options.applyDecay ?? false;
  const decayedBase = shouldApplyDecay ? applyMemoryDecay(base) : base;
  const decayedIncoming = shouldApplyDecay ? applyMemoryDecay(incoming) : incoming;

  return {
    ...decayedBase,
    content: chooseContent(decayedBase, decayedIncoming),
    confidence: Math.max(decayedBase.confidence, decayedIncoming.confidence),
    importance: Math.max(decayedBase.importance, decayedIncoming.importance),
    sensitivity: stricterSensitivity(decayedBase.sensitivity, decayedIncoming.sensitivity),
    sourceMessageIds: Array.from(new Set([...decayedBase.sourceMessageIds, ...decayedIncoming.sourceMessageIds])),
    userConfirmed: decayedBase.userConfirmed || decayedIncoming.userConfirmed,
    validFrom: earlierTime(decayedBase.validFrom, decayedIncoming.validFrom),
    validUntil: decayedIncoming.validUntil ?? decayedBase.validUntil,
    createdAt: earlierTime(decayedBase.createdAt, decayedIncoming.createdAt) ?? decayedBase.createdAt,
    lastSeenAt: laterTime(decayedBase.lastSeenAt, decayedIncoming.lastSeenAt) ?? decayedIncoming.lastSeenAt,
  };
}

export function maintainMemoryRecords(memories: MemoryRecord[]): MemoryRecord[] {
  const maintained: MemoryRecord[] = [];

  for (const memory of memories) {
    const target = findMergeTarget(maintained, memory);

    if (target) {
      const index = maintained.findIndex((item) => item.id === target.id);
      maintained[index] = mergeMemoryRecord(target, memory, { applyDecay: false });
      continue;
    }

    maintained.push({
      ...memory,
      content: memory.content.trim(),
    });
  }

  // Maintenance is non-destructive. Retrieval applies its own bounded ranking;
  // silently dropping low-ranked records here made old data irrecoverable.
  return maintained.sort(sortMemoryForMaintenance);
}

export function memorySimilarity(a: string, b: string, type?: MemoryRecord["type"]): number {
  const left = normalizeMemoryText(a);
  const right = normalizeMemoryText(b);
  if (!left || !right) return 0;
  if (left === right) return 1;
  const leftNegations = negationSignature(a);
  const rightNegations = negationSignature(b);

  if (left.length >= 10 && right.length >= 10 && (left.includes(right) || right.includes(left))) {
    return applySimilarityGuards(
      Math.min(left.length, right.length) / Math.max(left.length, right.length),
      leftNegations,
      rightNegations,
      type,
    );
  }

  const leftTokens = tokenizeMemory(left);
  const rightTokens = tokenizeMemory(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }

  const union = new Set([...leftTokens, ...rightTokens]).size;
  return applySimilarityGuards(intersection / union, leftNegations, rightNegations, type);
}

export function applyMemoryDecay(memory: MemoryRecord, now = new Date()): MemoryRecord {
  return {
    ...memory,
    importance: effectiveMemoryImportance(memory, now),
  };
}

export function effectiveMemoryImportance(memory: MemoryRecord, now = new Date()): number {
  const rate = decayRatePerDay[memory.type];
  if (rate == null) return memory.importance;

  const ageInDays = memoryAgeInDays(memory, now);
  if (ageInDays <= 0) return memory.importance;

  return clampImportance(Math.round(memory.importance * rate ** ageInDays));
}

export function isMemoryActive(
  memory: Pick<MemoryRecord, "validFrom" | "validUntil">,
  now = new Date(),
): boolean {
  const nowTime = now.getTime();
  const validFrom = parseMemoryTimestamp(memory.validFrom);
  const validUntil = parseMemoryTimestamp(memory.validUntil);

  if (validFrom != null && validFrom > nowTime) return false;
  if (validUntil != null && validUntil <= nowTime) return false;
  return true;
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

function applySimilarityGuards(
  score: number,
  leftNegations: Set<string>,
  rightNegations: Set<string>,
  type?: MemoryRecord["type"],
): number {
  let guardedScore = score;

  if (!sameNegationSignature(leftNegations, rightNegations)) {
    guardedScore *= negationPenalty;
  }

  if (type && strictMergeTypes.has(type)) {
    guardedScore = Math.min(guardedScore, guardedScore ** 1.15);
  }

  return guardedScore;
}

function mergeThresholdForType(type: MemoryRecord["type"]) {
  return strictMergeTypes.has(type) ? strictSimilarityThreshold : similarityThreshold;
}

function negationSignature(text: string): Set<string> {
  const normalized = normalizeMemoryText(text);
  const signature = new Set<string>();

  for (const pattern of negationPatterns) {
    if (normalized.includes(pattern)) signature.add(pattern);
  }

  return signature;
}

function sameNegationSignature(left: Set<string>, right: Set<string>) {
  if (left.size !== right.size) return false;

  for (const negation of left) {
    if (!right.has(negation)) return false;
  }

  return true;
}

function memoryAgeInDays(memory: Pick<MemoryRecord, "validFrom" | "createdAt">, now: Date) {
  const timestamp = parseMemoryTimestamp(memory.validFrom) ?? parseMemoryTimestamp(memory.createdAt);
  if (timestamp == null) return 0;

  return Math.max(0, (now.getTime() - timestamp) / (24 * 60 * 60 * 1000));
}

function parseMemoryTimestamp(value: string | null) {
  if (!value) return null;

  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function clampImportance(value: number) {
  return Math.max(0, Math.min(100, value));
}

function chooseContent(base: MemoryRecord, incoming: MemoryRecord): string {
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
  const importanceDelta = effectiveMemoryImportance(b) - effectiveMemoryImportance(a);
  if (importanceDelta !== 0) return importanceDelta;
  if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt.localeCompare(a.lastSeenAt);
  return a.id.localeCompare(b.id);
}
