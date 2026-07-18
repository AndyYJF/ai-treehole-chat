"use client";

import { useEffect } from "react";

const letterCheckIntervalMs = 60 * 60 * 1000;

export function LetterSyncScheduler() {
  useEffect(() => {
    let inFlight = false;

    const check = async () => {
      if (inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        await fetch("/api/letters/sync", { method: "POST" });
      } catch {
        // The next interval or foreground event retries without affecting chat.
      } finally {
        inFlight = false;
      }
    };

    const intervalId = window.setInterval(() => void check(), letterCheckIntervalMs);
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void check();
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return null;
}
