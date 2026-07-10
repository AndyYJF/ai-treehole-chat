import { describe, expect, it } from "vitest";
import { compareSyncCursors, parseCursor } from "./sync";

describe("sync cursor helpers", () => {
  it("normalizes invalid and zero-padded cursors without numeric precision loss", () => {
    expect(parseCursor(undefined)).toBe("0");
    expect(parseCursor("invalid")).toBe("0");
    expect(parseCursor("00042")).toBe("42");
    expect(parseCursor("900719925474099312345")).toBe("900719925474099312345");
  });

  it("orders decimal cursors lexically by normalized length", () => {
    expect(compareSyncCursors("9", "10")).toBeLessThan(0);
    expect(compareSyncCursors("00010", "10")).toBe(0);
    expect(compareSyncCursors("900719925474099312345", "900719925474099312344")).toBeGreaterThan(0);
  });
});
