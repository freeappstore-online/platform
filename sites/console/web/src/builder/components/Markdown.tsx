/** Lightweight markdown renderer for chat messages.
 *  Supports: **bold**, *italic*, `code`, ```blocks```, [links](url),
 *  - lists, 1. lists, > quotes, # headings, --- dividers. No npm dependency. */

const INDENT_CLASSES = ["pl-0", "pl-[1.1rem]", "pl-[2.2rem]", "pl-[3.3rem]"];

export function Markdown({ text }: { text: string }) {
  const blocks = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;

  while (i < blocks.length) {
    const line = blocks[i];

    // Code block (opening fence's language tag is ignored — no highlighting)
    if (line.startsWith("```")) {
      const codeLines: string[] = [];
      i++;
      while (i < blocks.length && !blocks[i].startsWith("```")) {
        codeLines.push(blocks[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <pre
          key={elements.length}
          className="bg-panel border border-line rounded-lg py-[0.6rem] px-[0.8rem] text-[0.78rem] font-[monospace] overflow-x-auto my-[0.3rem]"
        >
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Heading
    if (line.startsWith("### ")) {
      elements.push(
        <div key={elements.length} className="font-bold text-[0.95rem] mt-2 mb-[0.2rem]">
          {inline(line.slice(4))}
        </div>,
      );
      i++;
      continue;
    }
    if (line.startsWith("## ")) {
      elements.push(
        <div key={elements.length} className="font-bold text-[1.05rem] mt-[0.6rem] mb-[0.2rem]">
          {inline(line.slice(3))}
        </div>,
      );
      i++;
      continue;
    }
    if (line.startsWith("# ")) {
      elements.push(
        <div key={elements.length} className="font-extrabold text-[1.15rem] mt-[0.6rem] mb-[0.2rem]">
          {inline(line.slice(2))}
        </div>,
      );
      i++;
      continue;
    }

    // Divider
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={elements.length} className="border-0 border-t border-line my-2" />);
      i++;
      continue;
    }

    // List item, including simple nested bullets from two-space indentation.
    const bullet = line.match(/^(\s*)[-*]\s+(.+)$/);
    if (bullet) {
      const depth = Math.min(Math.floor((bullet[1]?.length ?? 0) / 2), 3);
      elements.push(
        <div
          key={elements.length}
          className={`flex gap-[0.4rem] my-[0.15rem] ${INDENT_CLASSES[depth]}`}
        >
          <span className="text-muted shrink-0">•</span>
          <span>{inline(bullet[2] ?? "")}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Numbered list item.
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.+)$/);
    if (numbered) {
      const depth = Math.min(Math.floor((numbered[1]?.length ?? 0) / 2), 3);
      elements.push(
        <div key={elements.length} className={`flex gap-[0.45rem] my-[0.15rem] ${INDENT_CLASSES[depth]}`}>
          <span className="text-muted shrink-0 min-w-[1.35rem] text-right">{numbered[2]}.</span>
          <span>{inline(numbered[3] ?? "")}</span>
        </div>,
      );
      i++;
      continue;
    }

    // Blockquote.
    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < blocks.length && /^>\s?/.test(blocks[i])) {
        quoteLines.push(blocks[i].replace(/^>\s?/, ""));
        i++;
      }
      elements.push(
        <blockquote
          key={elements.length}
          className="border-l-[3px] border-l-(--line-strong) my-[0.45rem] py-[0.1rem] pl-3 text-muted"
        >
          {quoteLines.map((q, qi) => (
            <div key={qi}>{inline(q)}</div>
          ))}
        </blockquote>,
      );
      continue;
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={elements.length} className="h-[0.3rem]" />);
      i++;
      continue;
    }

    // Regular paragraph
    elements.push(
      <div key={elements.length} className="my-[0.1rem]">
        {inline(line)}
      </div>,
    );
    i++;
  }

  return <>{elements}</>;
}

// Whichever construct starts first wins, so a link or URL ahead of some bold
// text is still a link (#596). Code comes first in the alternation so a `*`
// inside a code span is not read as emphasis.
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|\*(.+?)\*|\[(.+?)\]\((.+?)\)|(https?:\/\/[^\s<>]+)/gs;

/** Parse inline markdown: **bold**, *italic*, `code`, [link](url), bare URLs */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let key = 0;
  let last = 0;

  for (const match of text.matchAll(INLINE)) {
    if (match.index > last) parts.push(<span key={key++}>{text.slice(last, match.index)}</span>);
    last = match.index + match[0].length;
    const [, code, bold, italic, linkText, linkUrl, url] = match;
    if (code !== undefined) {
      parts.push(
        <code
          key={key++}
          className="bg-panel border border-line rounded py-[0.1rem] px-[0.3rem] text-[0.82em] font-[monospace]"
        >
          {code}
        </code>,
      );
    } else if (bold !== undefined) {
      parts.push(<strong key={key++}>{bold}</strong>);
    } else if (italic !== undefined) {
      parts.push(<em key={key++}>{italic}</em>);
    } else {
      const href = url ?? (/^https?:\/\//i.test(linkUrl) ? linkUrl : "#");
      parts.push(
        <a key={key++} href={href} target="_blank" rel="noopener" className="text-accent underline">
          {url ?? linkText}
        </a>,
      );
    }
  }
  if (last < text.length) parts.push(<span key={key++}>{text.slice(last)}</span>);

  return parts;
}
