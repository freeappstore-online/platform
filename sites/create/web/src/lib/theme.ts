import { useCallback, useEffect, useState } from "react";

// Shared across all stores so the preference follows the user.
const KEY = "stores-theme";
export type ThemePref = "system" | "light" | "dark";

function resolved(pref: ThemePref): "light" | "dark" {
  if (pref === "system") return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  return pref;
}

function apply(pref: ThemePref) {
  const isDark = resolved(pref) === "dark";
  if (isDark) document.documentElement.dataset.theme = "dark";
  else delete document.documentElement.dataset.theme;
}

export function useTheme() {
  const [pref, setPref] = useState<ThemePref>(() => (localStorage.getItem(KEY) as ThemePref) || "system");

  useEffect(() => { apply(pref); }, [pref]);

  // Track OS changes while on "system".
  useEffect(() => {
    if (pref !== "system") return;
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const cycle = useCallback(() => {
    setPref((prev) => {
      const next: ThemePref = prev === "system" ? "light" : prev === "light" ? "dark" : "system";
      localStorage.setItem(KEY, next);
      return next;
    });
  }, []);

  return { pref, resolved: resolved(pref), cycle };
}
