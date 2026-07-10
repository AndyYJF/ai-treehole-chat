import { describe, expect, it } from "vitest";
import {
  effectiveMemoryImportance,
  isMemoryActive,
  maintainMemoryRecords,
  memorySimilarity,
} from "./merge";
import type { MemoryRecord } from "./types";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    userId: "test-user",
    type: "affect",
    content: "用户最近因为工作感到焦虑",
    confidence: 0.8,
    importance: 80,
    sensitivity: "sensitive",
    sourceMessageIds: ["message-1"],
    userConfirmed: false,
    revision: 1,
    validFrom: "2026-06-30T00:00:00.000Z",
    validUntil: null,
    createdAt: "2026-06-30T00:00:00.000Z",
    lastSeenAt: "2026-06-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory lifecycle", () => {
  it("keeps stored importance unchanged during maintenance", () => {
    const original = memory();
    const [maintained] = maintainMemoryRecords([original]);

    expect(maintained.importance).toBe(80);
    expect(original.importance).toBe(80);
  });

  it("applies non-destructive type-aware retrieval decay", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");

    expect(effectiveMemoryImportance(memory(), now)).toBeLessThan(80);
    expect(effectiveMemoryImportance(memory({ userConfirmed: true }), now)).toBe(80);
    expect(effectiveMemoryImportance(memory({ type: "semantic" }), now)).toBe(80);
  });

  it("honors both valid-from and valid-until boundaries", () => {
    const now = new Date("2026-07-10T00:00:00.000Z");

    expect(isMemoryActive(memory(), now)).toBe(true);
    expect(isMemoryActive(memory({ validFrom: "2026-07-11T00:00:00.000Z" }), now)).toBe(false);
    expect(isMemoryActive(memory({ validUntil: "2026-07-09T23:59:59.000Z" }), now)).toBe(false);
    expect(isMemoryActive(memory({ validUntil: "2026-07-11T00:00:00.000Z" }), now)).toBe(true);
  });

  it("does not merge opposite preferences", () => {
    const score = memorySimilarity("用户喜欢在回复结尾提问", "用户不喜欢在回复结尾提问", "preference");
    expect(score).toBeLessThan(0.86);
  });

  it("does not silently discard or background-merge confirmed memories", () => {
    const first = memory({
      id: "memory-confirmed-1",
      type: "preference",
      content: "用户不希望在回答末尾追问",
      userConfirmed: true,
    });
    const second = memory({
      id: "memory-confirmed-2",
      type: "preference",
      content: "用户不希望在回答末尾追问。",
      userConfirmed: true,
    });

    expect(maintainMemoryRecords([first, second]).map((item) => item.id)).toEqual([
      "memory-confirmed-1",
      "memory-confirmed-2",
    ]);
  });
});
