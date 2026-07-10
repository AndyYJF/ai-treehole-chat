type RateLimitOptions = {
  limit: number;
  windowMs: number;
};

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
};

const attemptsByKey = new Map<string, number[]>();
let lastCleanupAt = 0;

/** A small in-process sliding window limiter for the single-node deployment. */
export function takeRateLimit(key: string, options: RateLimitOptions, now = Date.now()): RateLimitResult {
  const windowStart = now - options.windowMs;
  const attempts = (attemptsByKey.get(key) ?? []).filter((timestamp) => timestamp > windowStart);

  if (attempts.length >= options.limit) {
    const retryAfterMs = Math.max(0, attempts[0] + options.windowMs - now);
    attemptsByKey.set(key, attempts);
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }

  attempts.push(now);
  attemptsByKey.set(key, attempts);
  cleanupExpiredEntries(now);
  return {
    allowed: true,
    remaining: Math.max(0, options.limit - attempts.length),
    retryAfterSeconds: 0,
  };
}

export function requestRateLimitKey(request: Request, scope: string, userId?: string) {
  if (userId) return `${scope}:user:${userId}`;
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const client = forwarded || request.headers.get("x-real-ip") || "unknown";
  return `${scope}:ip:${client}`;
}

function cleanupExpiredEntries(now: number) {
  if (now - lastCleanupAt < 60_000) return;
  lastCleanupAt = now;
  const oldestRelevant = now - 60 * 60 * 1000;

  for (const [key, timestamps] of attemptsByKey) {
    if (timestamps.every((timestamp) => timestamp <= oldestRelevant)) attemptsByKey.delete(key);
  }
}

export function resetRateLimitsForTests() {
  attemptsByKey.clear();
  lastCleanupAt = 0;
}
