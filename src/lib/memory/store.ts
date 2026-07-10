import type { MemoryCandidate, MemoryRecord, MemoryUpdate } from "./types";
import { effectiveMemoryImportance, isMemoryActive, maintainMemoryRecords } from "./merge";

const memoryStore = new Map<string, MemoryRecord[]>();
const memorySettingsStore = new Map<string, { enabled: boolean; revision: number }>();

const seedMemories: MemoryRecord[] = [
  {
    id: "seed-preference-1",
    userId: "local-user",
    type: "procedural",
    content: "用户偏好安静、少说教、先回应感受，再给选择。",
    confidence: 0.82,
    importance: 86,
    sensitivity: "normal",
    sourceMessageIds: [],
    userConfirmed: false,
    revision: 1,
    validFrom: null,
    validUntil: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    lastSeenAt: "2026-07-04T00:00:00.000Z",
  },
  {
    id: "seed-boundary-1",
    userId: "local-user",
    type: "boundary",
    content: "不要把普通倾诉立刻上升成诊断或命令式建议。",
    confidence: 0.8,
    importance: 78,
    sensitivity: "normal",
    sourceMessageIds: [],
    userConfirmed: false,
    revision: 1,
    validFrom: null,
    validUntil: null,
    createdAt: "2026-07-04T00:00:00.000Z",
    lastSeenAt: "2026-07-04T00:00:00.000Z",
  },
];

export function listMemories(userId: string): MemoryRecord[] {
  if (!memoryStore.has(userId)) {
    memoryStore.set(
      userId,
      seedMemories.map((memory) => ({ ...memory, userId })),
    );
  }

  return [...(memoryStore.get(userId) ?? [])].filter((memory) => isMemoryActive(memory)).sort(sortMemoryForPrompt);
}

export function listAllMemories(userId: string): MemoryRecord[] {
  if (!memoryStore.has(userId)) listMemories(userId);
  return [...(memoryStore.get(userId) ?? [])].sort(sortMemoryForPrompt);
}

export function getMemorySettings(userId: string) {
  const current = memorySettingsStore.get(userId) ?? { enabled: true, revision: 1 };
  memorySettingsStore.set(userId, current);
  return current;
}

export function setMemoryEnabled(userId: string, enabled: boolean) {
  const current = getMemorySettings(userId);
  const next = { enabled, revision: current.revision + 1 };
  memorySettingsStore.set(userId, next);
  return next;
}

export function addMemoryCandidates(userId: string, candidates: MemoryCandidate[]): MemoryRecord[] {
  const existing = listMemories(userId);
  const now = new Date().toISOString();
  const created = candidates.map((candidate, index): MemoryRecord => {
    return {
      ...candidate,
      id: `mem-${Date.now()}-${index}`,
      userId,
      userConfirmed: false,
      revision: 1,
      createdAt: now,
      lastSeenAt: now,
    };
  });

  const merged = mergeMemoryRecords([...existing, ...created]);
  memoryStore.set(userId, merged);
  return merged;
}

export function confirmMemory(userId: string, memoryId: string): MemoryRecord[] {
  const now = new Date().toISOString();
  const updated = listMemories(userId).map((memory) => {
    if (memory.id !== memoryId) return memory;

    return {
      ...memory,
      userConfirmed: true,
      confidence: Math.max(memory.confidence, 0.9),
      revision: memory.revision + 1,
      lastSeenAt: now,
    };
  });

  memoryStore.set(userId, updated);
  return updated;
}

export function updateMemory(userId: string, memoryId: string, update: MemoryUpdate): MemoryRecord[] {
  const now = new Date().toISOString();
  const updated = listMemories(userId).map((memory) => {
    if (memory.id !== memoryId) return memory;

    return {
      ...memory,
      type: update.type,
      content: update.content.trim(),
      importance: update.importance,
      sensitivity: update.sensitivity,
      userConfirmed: true,
      confidence: Math.max(memory.confidence, 0.9),
      revision: memory.revision + 1,
      lastSeenAt: now,
    };
  });

  memoryStore.set(userId, mergeMemoryRecords(updated));
  return listMemories(userId);
}

export function maintainMemories(userId: string): MemoryRecord[] {
  const allMemories = memoryStore.get(userId) ?? listMemories(userId);
  const active = allMemories.filter((memory) => isMemoryActive(memory));
  const inactive = allMemories.filter((memory) => !isMemoryActive(memory));
  const maintained = maintainMemoryRecords(active);
  memoryStore.set(userId, [...inactive, ...maintained]);
  return listMemories(userId);
}

export function deleteMemory(userId: string, memoryId: string): MemoryRecord[] {
  const updated = listMemories(userId).filter((memory) => memory.id !== memoryId);
  memoryStore.set(userId, updated);
  return updated;
}

export function clearMemories(userId: string): MemoryRecord[] {
  memoryStore.set(userId, []);
  return [];
}

export function mergeMemoryRecords(records: MemoryRecord[]): MemoryRecord[] {
  return maintainMemoryRecords(records);
}

export function sortMemoryForPrompt(a: MemoryRecord, b: MemoryRecord): number {
  const typeOrder = ["safety", "boundary", "procedural", "preference", "semantic", "affect", "episodic"];
  const typeDelta = typeOrder.indexOf(a.type) - typeOrder.indexOf(b.type);

  if (typeDelta !== 0) return typeDelta;
  const importanceDelta = effectiveMemoryImportance(b) - effectiveMemoryImportance(a);
  if (importanceDelta !== 0) return importanceDelta;
  if (b.lastSeenAt !== a.lastSeenAt) return b.lastSeenAt.localeCompare(a.lastSeenAt);
  return a.id.localeCompare(b.id);
}
