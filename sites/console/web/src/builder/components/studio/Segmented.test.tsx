import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Segmented } from "./Segmented";

describe("Segmented", () => {
  it.each(["chat", "preview"])("marks %s as selected with its active appearance", (value) => {
    const html = renderToStaticMarkup(<Segmented value={value} onChange={() => {}} options={[
      { value: "chat", label: "Chat" },
      { value: "preview", label: "Preview" },
    ]} />);
    const buttons = [...html.matchAll(new RegExp("<button([^>]*)>([^<]*)</button>", "g"))];
    expect(buttons).toHaveLength(2);
    for (const [, attributes, label] of buttons) {
      const active = label.toLowerCase() === value;
      expect(attributes).toContain('aria-pressed="' + active + '"');
      expect(attributes).toContain(active ? "bg-panel text-ink-strong shadow-control" : "bg-transparent text-muted shadow-none");
    }
  });
});
