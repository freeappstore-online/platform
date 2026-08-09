import { useCallback, useEffect, useState } from "react";

// Shared across all stores so the preference follows the user.
const KEY = "stores-text-size";
export type TextSize = "default" | "lg" | "sm";

function getTextSize(): TextSize {
  const stored = localStorage.getItem(KEY);
  if (stored === "lg" || stored === "sm") return stored;
  return "default";
}

function applyTextSize(size: TextSize): void {
  if (size === "default") {
    delete document.documentElement.dataset.text;
  } else {
    document.documentElement.dataset.text = size;
  }
}

export function useTextSize() {
  const [size, setSize] = useState<TextSize>(getTextSize);

  useEffect(() => { applyTextSize(size); }, [size]);

  const set = useCallback((next: TextSize) => {
    setSize(next);
    localStorage.setItem(KEY, next);
  }, []);

  return { size, setSize: set };
}
