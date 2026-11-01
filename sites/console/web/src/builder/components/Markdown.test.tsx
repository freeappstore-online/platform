import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it.each(["- item", "1. item"])("caps indentation for %s at three levels", (item) => {
    const html = renderToStaticMarkup(<Markdown text={[0, 2, 4, 6, 8].map(n => " ".repeat(n) + item).join("\n")} />);
    expect(html).toContain("pl-0");
    expect(html).toContain("pl-[1.1rem]");
    expect(html).toContain("pl-[2.2rem]");
    expect(html.match(/pl-\[3.3rem\]/g)).toHaveLength(2);
    expect(html).not.toContain("style=");
  });
  it("preserves code, quotes and safe links", () => {
    const html = renderToStaticMarkup(<Markdown text={'```\n<a>\n```\n> quoted\n[unsafe](javascript:alert)\n[safe](https://example.com)'} />);
    expect(html).toContain("&lt;a&gt;");
    expect(html).toContain("<blockquote");
    expect(html).toContain('href="#"');
    expect(html).toContain('href="https://example.com"');
    expect(html).not.toContain("style=");
  });
});
