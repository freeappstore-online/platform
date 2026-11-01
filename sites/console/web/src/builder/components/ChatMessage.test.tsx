import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessage } from "./ChatMessage";

describe("ChatMessage", () => {
  it("renders assistant markdown and exposes speak and copy controls", () => {
    const html = renderToStaticMarkup(<ChatMessage role="assistant" content="**Hello**" canSpeak speaking />);
    expect(html).toContain("<strong>Hello</strong>");
    expect(html).toContain('aria-label="Stop speaking"');
    expect(html).toContain('aria-label="Copy this message"');
    expect(html).toContain("text-accent");
  });

  it("preserves literal user content and the contrast of actions on the accent bubble", () => {
    const html = renderToStaticMarkup(<ChatMessage role="user" content="**Hello**" canSpeak />);
    expect(html).toContain("**Hello**");
    expect(html).not.toContain("<strong>");
    expect(html).toContain("whitespace-pre-wrap");
    expect(html).toContain("bg-accent");
    expect(html).toContain("text-white/75");
  });

  it.each(["tool", "system"])("does not offer conversation actions for %s messages", (role) => {
    const html = renderToStaticMarkup(<ChatMessage role={role} content="Status" canSpeak />);
    expect(html).toContain("Status");
    expect(html).not.toContain("<button");
  });
});
