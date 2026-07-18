import { describe, expect, it } from "vitest";
import { isLetterDue, normalizeLetterContent, selectLetterMemories } from "./letter-policy";
import type { MemoryRecord } from "./memory/types";

const now = new Date("2026-07-18T04:00:00.000Z").getTime();

function memory(overrides: Partial<MemoryRecord> = {}): MemoryRecord {
  return {
    id: "memory-1",
    userId: "test-user",
    type: "episodic",
    content: "用户最近完成了一件重要的事",
    confidence: 0.8,
    importance: 80,
    sensitivity: "normal",
    sourceMessageIds: ["message-1"],
    userConfirmed: true,
    revision: 1,
    validFrom: null,
    validUntil: null,
    createdAt: "2026-07-17T00:00:00.000Z",
    lastSeenAt: "2026-07-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("timebox letter policy", () => {
  it("becomes due exactly seven days after the previous letter", () => {
    expect(isLetterDue("2026-07-11T04:00:00.001Z", now)).toBe(false);
    expect(isLetterDue("2026-07-11T04:00:00.000Z", now)).toBe(true);
  });

  it("uses recent normal affect and episodic memories without a confirmation gate", () => {
    const selected = selectLetterMemories(
      [
        memory({ id: "automatic-event", userConfirmed: false }),
        memory({ id: "affect", type: "affect" }),
        memory({ id: "private", sensitivity: "private" }),
        memory({ id: "old", lastSeenAt: "2026-06-01T00:00:00.000Z" }),
        memory({ id: "semantic", type: "semantic" }),
      ],
      now,
    );

    expect(selected.map((item) => item.id)).toEqual(["automatic-event", "affect"]);
  });

  it("keeps generated letters within 500 characters", () => {
    const normalized = normalizeLetterContent(`  ${"字".repeat(600)}  `);

    expect(normalized).toHaveLength(500);
    expect(normalized.endsWith("...")).toBe(true);
    expect(normalizeLetterContent("   ").length).toBeGreaterThan(0);
  });
});
