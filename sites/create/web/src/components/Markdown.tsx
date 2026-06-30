/** Lightweight markdown renderer for chat messages.
 *  Supports: **bold**, *italic*, `code`, ```blocks```, [links](url),
 *  - lists, # headings, --- dividers. No npm dependency. */

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
        <pre key={elements.length} style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "0.5rem", padding: "0.6rem 0.8rem", fontSize: "0.78rem", fontFamily: "monospace", overflowX: "auto", margin: "0.3rem 0" }}>
          <code>{codeLines.join("\n")}</code>
        </pre>
      );
      continue;
    }

    // Heading
    if (line.startsWith("### ")) {
      elements.push(<div key={elements.length} style={{ fontWeight: 700, fontSize: "0.95rem", margin: "0.5rem 0 0.2rem" }}>{inline(line.slice(4))}</div>);
      i++; continue;
    }
    if (line.startsWith("## ")) {
      elements.push(<div key={elements.length} style={{ fontWeight: 700, fontSize: "1.05rem", margin: "0.6rem 0 0.2rem" }}>{inline(line.slice(3))}</div>);
      i++; continue;
    }
    if (line.startsWith("# ")) {
      elements.push(<div key={elements.length} style={{ fontWeight: 800, fontSize: "1.15rem", margin: "0.6rem 0 0.2rem" }}>{inline(line.slice(2))}</div>);
      i++; continue;
    }

    // Divider
    if (/^---+$/.test(line.trim())) {
      elements.push(<hr key={elements.length} style={{ border: "none", borderTop: "1px solid var(--line)", margin: "0.5rem 0" }} />);
      i++; continue;
    }

    // List item
    if (/^[-*] /.test(line)) {
      elements.push(
        <div key={elements.length} style={{ display: "flex", gap: "0.4rem", margin: "0.15rem 0" }}>
          <span style={{ color: "var(--muted)", flexShrink: 0 }}>•</span>
          <span>{inline(line.slice(2))}</span>
        </div>
      );
      i++; continue;
    }

    // Empty line
    if (!line.trim()) {
      elements.push(<div key={elements.length} style={{ height: "0.3rem" }} />);
      i++; continue;
    }

    // Regular paragraph
    elements.push(<div key={elements.length} style={{ margin: "0.1rem 0" }}>{inline(line)}</div>);
    i++;
  }

  return <>{elements}</>;
}

/** Parse inline markdown: **bold**, *italic*, `code`, [link](url) */
function inline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold **text**
    let match = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/s);
    if (match) {
      if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
      parts.push(<strong key={key++}>{match[2]}</strong>);
      remaining = match[3];
      continue;
    }

    // Italic *text*
    match = remaining.match(/^(.*?)\*(.+?)\*(.*)/s);
    if (match) {
      if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
      parts.push(<em key={key++}>{match[2]}</em>);
      remaining = match[3];
      continue;
    }

    // Inline code `text`
    match = remaining.match(/^(.*?)`(.+?)`(.*)/s);
    if (match) {
      if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
      parts.push(<code key={key++} style={{ background: "var(--panel)", border: "1px solid var(--line)", borderRadius: "0.25rem", padding: "0.1rem 0.3rem", fontSize: "0.82em", fontFamily: "monospace" }}>{match[2]}</code>);
      remaining = match[3];
      continue;
    }

    // Link [text](url)
    match = remaining.match(/^(.*?)\[(.+?)\]\((.+?)\)(.*)/s);
    if (match) {
      if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
      const linkHref = /^https?:\/\//i.test(match[3]) ? match[3] : "#";
      parts.push(<a key={key++} href={linkHref} target="_blank" rel="noopener" style={{ color: "var(--accent)", textDecoration: "underline" }}>{match[2]}</a>);
      remaining = match[4];
      continue;
    }

    // Plain URL
    match = remaining.match(/^(.*?)(https?:\/\/[^\s<>]+)(.*)/s);
    if (match) {
      if (match[1]) parts.push(<span key={key++}>{match[1]}</span>);
      parts.push(<a key={key++} href={match[2]} target="_blank" rel="noopener" style={{ color: "var(--accent)", textDecoration: "underline" }}>{match[2]}</a>);
      remaining = match[3];
      continue;
    }

    // No more patterns — emit the rest
    parts.push(<span key={key++}>{remaining}</span>);
    break;
  }

  return parts;
}
