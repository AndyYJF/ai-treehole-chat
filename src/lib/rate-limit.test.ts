import { afterEach, describe, expect, it } from "vitest";
import { resetRateLimitsForTests, takeRateLimit } from "./rate-limit";

afterEach(resetRateLimitsForTests);

describe("rate limiting", () => {
  it("enforces a sliding window and releases the key after the window expires", () => {
    expect(takeRateLimit("chat:user", { limit: 2, windowMs: 1_000 }, 0).allowed).toBe(true);
    expect(takeRateLimit("chat:user", { limit: 2, windowMs: 1_000 }, 100).allowed).toBe(true);

    const blocked = takeRateLimit("chat:user", { limit: 2, windowMs: 1_000 }, 200);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(takeRateLimit("chat:user", { limit: 2, windowMs: 1_000 }, 1_001).allowed).toBe(true);
  });
});
