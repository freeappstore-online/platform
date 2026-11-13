import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProjectPicker } from "./ProjectPicker";
import type { Project } from "../hooks/useProjects";

const projects: Project[] = [
  { id: "one", name: "First", appId: "first", deployed: true, createdAt: "", updatedAt: 0 },
  { id: "two", name: "Second", deployed: false, createdAt: "", updatedAt: 0 },
];
describe("ProjectPicker", () => {
  it.each(["one", "two"])("highlights the current project %s on an opaque surface", (currentId) => {
    const html = renderToStaticMarkup(<ProjectPicker projects={projects} currentId={currentId} onSelect={() => {}} onCreate={() => {}} onOpenApp={() => {}} onClose={() => {}} />);
    expect(html).toContain("bg-paper");
    expect(html).toContain("First");
    expect(html).toContain("Second");
    expect(html.match(/>current</g)).toHaveLength(1);
    expect(html).toContain("bg-success");
    expect(html).toContain("bg-(--line-strong)");
    expect(html).toContain('aria-pressed="false"');
    expect(html).not.toContain("style=");
  });
});
