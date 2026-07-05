"use client";

import { useCallback, useEffect, useState } from "react";

export type ThemePreference = "light" | "dark" | "system";

export const themeStorageKey = "treehole-theme";

function resolveTheme(preference: ThemePreference): "light" | "dark" {
  if (preference === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }

  return preference;
}

function applyTheme(preference: ThemePreference) {
  document.documentElement.setAttribute("data-theme", resolveTheme(preference));
}

export function useThemePreference() {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => {
    if (typeof window === "undefined") return "system";

    const stored = window.localStorage.getItem(themeStorageKey);
    return stored === "light" || stored === "dark" ? stored : "system";
  });

  useEffect(() => {
    applyTheme(preference);

    if (preference !== "system") return;

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    window.localStorage.setItem(themeStorageKey, next);
  }, []);

  return { preference, setPreference };
}
