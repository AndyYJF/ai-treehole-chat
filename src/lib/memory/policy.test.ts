import { describe, expect, it } from "vitest";
import { selectProactiveMemories, selectRetrievableMemories, selectStableSystemMemories } from "./policy";
import type { MemoryRecord } from "./types";

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    userId: "test-user",
    type: "preference",
    content: "用户偏好直接、简短的回答",
    confidence: 0.8,
    importance: 80,
    sensitivity: "normal",
    sourceMessageIds: ["message-1"],
    userConfirmed: true,
    revision: 1,
    validFrom: null,
    validUntil: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("memory prompt policy", () => {
  it("places non-private stable memories in the system prefix", () => {
    const memories = [
      memory({ id: "candidate" }),
      memory({ id: "private", sensitivity: "private" }),
      memory({ id: "event", type: "episodic" }),
    ];

    expect(selectStableSystemMemories(memories).map((item) => item.id)).toEqual(["candidate"]);
  });

  it("filters low-confidence candidates from retrieval", () => {
    const memories = [
      memory({ id: "low", confidence: 0.2 }),
      memory({ id: "enough", confidence: 0.7 }),
      memory({ id: "previously-confirmed", confidence: 0.1, userConfirmed: true }),
    ];

    expect(selectRetrievableMemories(memories).map((item) => item.id)).toEqual(["enough"]);
  });

  it("requires normal sensitivity and an affect or episodic type for proactive use", () => {
    const memories = [
      memory({ id: "affect", type: "affect" }),
      memory({ id: "private-affect", type: "affect", sensitivity: "private" }),
      memory({ id: "event", type: "episodic", userConfirmed: false }),
    ];

    expect(selectProactiveMemories(memories, 10).map((item) => item.id)).toEqual(["affect", "event"]);
  });
});
