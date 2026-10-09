// A small document model for human projections (Doc 4 §15), rendered as
// Markdown or as one self-contained HTML page.
//
// Every string a view shows is escaped where it is rendered. Text that came
// from outside the program (a model's output, an answer, a review) is marked
// untrusted and is shown as plain, quoted content: never as markup, a link
// or a control. A model can write "<button>Approve</button>"; a view shows
// those characters and nothing more (G09). The HTML page loads nothing and
// runs nothing: its content security policy forbids scripts, frames, forms
// and remote resources.

/** A table cell: plain text, or text marked as coming from outside the program. */
export type Cell = string | { text: string; untrusted?: boolean; mono?: boolean };

export type Block =
  | { h: string }
  | { p: string }
  | { note: string }
  | { list: Cell[] }
  | { table: { head: string[]; rows: Cell[][] } }
  | { code: string; lang?: string; untrusted?: boolean };

export interface Doc {
  title: string;
  /** What the document shows, e.g. the program hash, the run, its revision and last event (INV-10, G10). */
  meta: Array<[string, string]>;
  blocks: Block[];
}

const cellText = (c: Cell): string => (typeof c === "string" ? c : c.text);

// ── Markdown ──────────────────────────────────────────────────────────────

/** Markdown inline text with its markup characters escaped. */
export function mdEscape(s: string): string {
  // Enough that nothing becomes emphasis, a link, an image, raw HTML or a table cell break.
  return s.replace(/[\\`*_[\]<>|~]/g, (m) => `\\${m}`).replace(/\r?\n/g, " ");
}

/** Text from outside the program, in Markdown: an inline code span long enough that nothing inside closes it. */
function mdQuoted(s: string): string {
  const flat = s.replace(/\r?\n/g, " ");
  const longest = Math.max(0, ...(flat.match(/`+/g) ?? []).map((m) => m.length));
  const fence = "`".repeat(longest + 1);
  return `${fence} ${flat.replace(/\|/g, "¦")} ${fence}`;
}

function mdCell(c: Cell): string {
  if (typeof c === "string") return mdEscape(c);
  if (c.untrusted || c.mono) return mdQuoted(c.text);
  return mdEscape(c.text);
}

export function toMarkdown(doc: Doc): string {
  const out: string[] = [`# ${mdEscape(doc.title)}`, ""];
  for (const [k, v] of doc.meta) out.push(`- **${mdEscape(k)}:** ${mdQuoted(v)}`);
  out.push("");
  for (const b of doc.blocks) {
    if ("h" in b) out.push(`## ${mdEscape(b.h)}`, "");
    else if ("p" in b) out.push(mdEscape(b.p), "");
    else if ("note" in b) out.push(`> ${mdEscape(b.note)}`, "");
    else if ("list" in b) out.push(...b.list.map((c) => `- ${mdCell(c)}`), "");
    else if ("table" in b) {
      out.push(`| ${b.table.head.map(mdEscape).join(" | ")} |`, `|${b.table.head.map(() => "---").join("|")}|`);
      for (const r of b.table.rows) out.push(`| ${r.map(mdCell).join(" | ")} |`);
      out.push("");
    } else {
      // A fence longer than any run of backticks inside, so the content cannot end it.
      const longest = Math.max(2, ...(b.code.match(/`+/g) ?? []).map((m) => m.length));
      const fence = "`".repeat(longest + 1);
      out.push(`${fence}${b.untrusted ? "text" : (b.lang ?? "")}`, b.code, fence, "");
    }
  }
  return out.join("\n");
}

// ── HTML ──────────────────────────────────────────────────────────────────

export function htmlEscape(s: string): string {
  return s.replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]!);
}

function htmlCell(c: Cell): string {
  if (typeof c === "string") return htmlEscape(c);
  const cls = [c.untrusted ? "untrusted" : "", c.mono ? "mono" : ""].filter(Boolean).join(" ");
  return `<span class="${cls}"${c.untrusted ? ' title="Content from outside the program, shown as plain text"' : ""}>${htmlEscape(c.text)}</span>`;
}

const STYLE = `
body { font: 14px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1b1b1b; background: #fff; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; }
table { border-collapse: collapse; margin: .5rem 0 1rem; } th, td { border: 1px solid #ccc; padding: .3rem .5rem; text-align: left; vertical-align: top; }
th { background: #f3f3f3; } .meta td:first-child { font-weight: 600; }
pre { background: #f6f6f6; padding: .6rem; overflow-x: auto; white-space: pre-wrap; }
.mono, code { font-family: ui-monospace, monospace; font-size: 12px; }
.untrusted { font-family: ui-monospace, monospace; font-size: 12px; background: #fff7e0; border: 1px dashed #c9a227; padding: 0 .2rem; white-space: pre-wrap; }
pre.untrusted { display: block; padding: .6rem; }
.note { color: #555; border-left: 3px solid #bbb; padding-left: .6rem; }
`;

export function toHtml(doc: Doc): string {
  const body: string[] = [`<h1>${htmlEscape(doc.title)}</h1>`, '<table class="meta">'];
  for (const [k, v] of doc.meta) body.push(`<tr><td>${htmlEscape(k)}</td><td class="mono">${htmlEscape(v)}</td></tr>`);
  body.push("</table>");
  for (const b of doc.blocks) {
    if ("h" in b) body.push(`<h2>${htmlEscape(b.h)}</h2>`);
    else if ("p" in b) body.push(`<p>${htmlEscape(b.p)}</p>`);
    else if ("note" in b) body.push(`<p class="note">${htmlEscape(b.note)}</p>`);
    else if ("list" in b) body.push(`<ul>${b.list.map((c) => `<li>${htmlCell(c)}</li>`).join("")}</ul>`);
    else if ("table" in b) {
      body.push(`<table><thead><tr>${b.table.head.map((h) => `<th>${htmlEscape(h)}</th>`).join("")}</tr></thead><tbody>`);
      for (const r of b.table.rows) body.push(`<tr>${r.map((c) => `<td>${htmlCell(c)}</td>`).join("")}</tr>`);
      body.push("</tbody></table>");
    } else body.push(`<pre class="${b.untrusted ? "untrusted" : "mono"}">${htmlEscape(b.code)}</pre>`);
  }
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${htmlEscape(doc.title)}</title><style>${STYLE}</style></head><body>`,
    ...body,
    "</body></html>",
    "",
  ].join("\n");
}

export { cellText };
