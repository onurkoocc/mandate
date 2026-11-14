//! A small document model for human projections (Doc 4 §15), rendered as
//! Markdown or as one self-contained HTML page: a port of
//! `compiler/src/views/doc.ts`.
//!
//! Every string a view shows is escaped where it is rendered. Text that came
//! from outside the program (a model's output, an answer, a review) is marked
//! untrusted and is shown as plain, quoted content: never as markup, a link or
//! a control. A model can write `<button>Approve</button>`; a view shows those
//! characters and nothing more (G09). The HTML page loads nothing and runs
//! nothing: its content security policy forbids scripts, frames, forms and
//! remote resources.
//!
//! The text is the TypeScript's to the byte. Regular expressions are matched
//! by hand: `\r?\n` is a line feed, with the carriage return before it if
//! there is one (a carriage return alone stays); a run of backticks is a
//! maximal run of U+0060.

/// A table cell: plain text, or text marked as coming from outside the
/// program (`untrusted`) or to be shown as code (`mono`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Cell {
    /// Plain text, escaped where it is rendered.
    Plain(String),
    /// Text with marks.
    Marked {
        /// The text.
        text: String,
        /// Content from outside the program, shown as plain text.
        untrusted: bool,
        /// Shown in a monospace face.
        mono: bool,
    },
}

impl Cell {
    /// A plain cell.
    #[must_use]
    pub fn plain(text: impl Into<String>) -> Cell {
        Cell::Plain(text.into())
    }

    /// A cell shown as code: `{ text, mono: true }`.
    #[must_use]
    pub fn mono(text: impl Into<String>) -> Cell {
        Cell::Marked {
            text: text.into(),
            untrusted: false,
            mono: true,
        }
    }

    /// A cell of text from outside the program: `{ text, untrusted: true }`.
    #[must_use]
    pub fn untrusted(text: impl Into<String>) -> Cell {
        Cell::Marked {
            text: text.into(),
            untrusted: true,
            mono: false,
        }
    }
}

/// One block of a document: `Block`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Block {
    /// A heading: `{ h }`.
    H(String),
    /// A paragraph: `{ p }`.
    P(String),
    /// A note: `{ note }`.
    Note(String),
    /// A list: `{ list }`.
    List(Vec<Cell>),
    /// A table: `{ table: { head, rows } }`.
    Table {
        /// The heads of the columns.
        head: Vec<String>,
        /// The rows.
        rows: Vec<Vec<Cell>>,
    },
    /// Code: `{ code, lang?, untrusted? }`.
    Code {
        /// The code.
        code: String,
        /// The language of a fence, when it has one.
        lang: Option<String>,
        /// Content from outside the program: its fence says `text`.
        untrusted: bool,
    },
}

/// A document: title, what it shows, and its blocks: `Doc`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Doc {
    /// The title.
    pub title: String,
    /// What the document shows, e.g. the program hash (INV-10, G10).
    pub meta: Vec<(String, String)>,
    /// The blocks, in order.
    pub blocks: Vec<Block>,
}

/// `cellText(c)`: the text of a cell.
#[must_use]
pub fn cell_text(c: &Cell) -> &str {
    match c {
        Cell::Plain(text) | Cell::Marked { text, .. } => text,
    }
}

// ── Markdown ─────────────────────────────────────────────────────────────

/// `s.replace(/\r?\n/g, " ")`.
fn flatten_lines(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' if chars.peek() == Some(&'\n') => {
                chars.next();
                out.push(' ');
            }
            '\n' => out.push(' '),
            c => out.push(c),
        }
    }
    out
}

/// Markdown inline text with its markup characters escaped: each of
/// `` \ ` * _ [ ] < > | ~ `` gets a backslash, and a line break becomes a
/// space. Enough that nothing becomes emphasis, a link, an image, raw HTML or
/// a table cell break. `mdEscape(s)`.
#[must_use]
pub fn md_escape(s: &str) -> String {
    let mut escaped = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '~'
        ) {
            escaped.push('\\');
        }
        escaped.push(c);
    }
    flatten_lines(&escaped)
}

/// The length of the longest run of backticks in `s`; 0 for none.
fn longest_backtick_run(s: &str) -> usize {
    let mut longest = 0_usize;
    let mut run = 0_usize;
    for c in s.chars() {
        if c == '`' {
            run = run.saturating_add(1);
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    longest
}

/// `` "`".repeat(n) ``.
fn backticks(n: usize) -> String {
    "`".repeat(n)
}

/// Text from outside the program, in Markdown: an inline code span long
/// enough that nothing inside closes it. `mdQuoted(s)`.
fn md_quoted(s: &str) -> String {
    let flat = flatten_lines(s);
    let fence = backticks(longest_backtick_run(&flat).saturating_add(1));
    format!("{fence} {} {fence}", flat.replace('|', "¦"))
}

/// `mdCell(c)`.
fn md_cell(c: &Cell) -> String {
    match c {
        Cell::Plain(text) => md_escape(text),
        Cell::Marked {
            text,
            untrusted,
            mono,
        } => {
            if *untrusted || *mono {
                md_quoted(text)
            } else {
                md_escape(text)
            }
        }
    }
}

/// The document as Markdown: `toMarkdown(doc)`. It ends with a line feed.
#[must_use]
pub fn to_markdown(doc: &Doc) -> String {
    let mut out: Vec<String> = vec![format!("# {}", md_escape(&doc.title)), String::new()];
    for (k, v) in &doc.meta {
        out.push(format!("- **{}:** {}", md_escape(k), md_quoted(v)));
    }
    out.push(String::new());
    for b in &doc.blocks {
        match b {
            Block::H(h) => {
                out.push(format!("## {}", md_escape(h)));
                out.push(String::new());
            }
            Block::P(p) => {
                out.push(md_escape(p));
                out.push(String::new());
            }
            Block::Note(note) => {
                out.push(format!("> {}", md_escape(note)));
                out.push(String::new());
            }
            Block::List(list) => {
                out.extend(list.iter().map(|c| format!("- {}", md_cell(c))));
                out.push(String::new());
            }
            Block::Table { head, rows } => {
                let heads: Vec<String> = head.iter().map(|h| md_escape(h)).collect();
                out.push(format!("| {} |", heads.join(" | ")));
                let rule: Vec<&str> = head.iter().map(|_| "---").collect();
                out.push(format!("|{}|", rule.join("|")));
                for r in rows {
                    let cells: Vec<String> = r.iter().map(md_cell).collect();
                    out.push(format!("| {} |", cells.join(" | ")));
                }
                out.push(String::new());
            }
            Block::Code {
                code,
                lang,
                untrusted,
            } => {
                // A fence longer than any run of backticks inside, so the content cannot end it.
                let longest = longest_backtick_run(code).max(2);
                let fence = backticks(longest.saturating_add(1));
                let info = if *untrusted {
                    "text"
                } else {
                    lang.as_deref().unwrap_or_default()
                };
                out.push(format!("{fence}{info}"));
                out.push(code.clone());
                out.push(fence);
                out.push(String::new());
            }
        }
    }
    out.join("\n")
}

// ── HTML ─────────────────────────────────────────────────────────────────

/// `& < > " '` as the entities that stand for them: `htmlEscape(s)`.
#[must_use]
pub fn html_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            c => out.push(c),
        }
    }
    out
}

/// `htmlCell(c)`: a plain cell is escaped text; a marked one is a span.
fn html_cell(c: &Cell) -> String {
    match c {
        Cell::Plain(text) => html_escape(text),
        Cell::Marked {
            text,
            untrusted,
            mono,
        } => {
            let mut classes: Vec<&str> = Vec::new();
            if *untrusted {
                classes.push("untrusted");
            }
            if *mono {
                classes.push("mono");
            }
            let title = if *untrusted {
                " title=\"Content from outside the program, shown as plain text\""
            } else {
                ""
            };
            format!(
                "<span class=\"{}\"{title}>{}</span>",
                classes.join(" "),
                html_escape(text)
            )
        }
    }
}

/// The page's style, as `STYLE` in `doc.ts` is: it begins and ends with a line
/// feed.
const STYLE: &str = r#"
body { font: 14px/1.45 system-ui, sans-serif; margin: 2rem auto; max-width: 72rem; padding: 0 1rem; color: #1b1b1b; background: #fff; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #ddd; }
table { border-collapse: collapse; margin: .5rem 0 1rem; } th, td { border: 1px solid #ccc; padding: .3rem .5rem; text-align: left; vertical-align: top; }
th { background: #f3f3f3; } .meta td:first-child { font-weight: 600; }
pre { background: #f6f6f6; padding: .6rem; overflow-x: auto; white-space: pre-wrap; }
.mono, code { font-family: ui-monospace, monospace; font-size: 12px; }
.untrusted { font-family: ui-monospace, monospace; font-size: 12px; background: #fff7e0; border: 1px dashed #c9a227; padding: 0 .2rem; white-space: pre-wrap; }
pre.untrusted { display: block; padding: .6rem; }
.note { color: #555; border-left: 3px solid #bbb; padding-left: .6rem; }
"#;

/// The document as one self-contained HTML page: `toHtml(doc)`. It ends with
/// a line feed.
#[must_use]
pub fn to_html(doc: &Doc) -> String {
    let mut body: Vec<String> = vec![
        format!("<h1>{}</h1>", html_escape(&doc.title)),
        "<table class=\"meta\">".to_owned(),
    ];
    for (k, v) in &doc.meta {
        body.push(format!(
            "<tr><td>{}</td><td class=\"mono\">{}</td></tr>",
            html_escape(k),
            html_escape(v)
        ));
    }
    body.push("</table>".to_owned());
    for b in &doc.blocks {
        match b {
            Block::H(h) => body.push(format!("<h2>{}</h2>", html_escape(h))),
            Block::P(p) => body.push(format!("<p>{}</p>", html_escape(p))),
            Block::Note(note) => body.push(format!("<p class=\"note\">{}</p>", html_escape(note))),
            Block::List(list) => {
                let items: String = list
                    .iter()
                    .map(|c| format!("<li>{}</li>", html_cell(c)))
                    .collect();
                body.push(format!("<ul>{items}</ul>"));
            }
            Block::Table { head, rows } => {
                let heads: String = head
                    .iter()
                    .map(|h| format!("<th>{}</th>", html_escape(h)))
                    .collect();
                body.push(format!("<table><thead><tr>{heads}</tr></thead><tbody>"));
                for r in rows {
                    let cells: String = r
                        .iter()
                        .map(|c| format!("<td>{}</td>", html_cell(c)))
                        .collect();
                    body.push(format!("<tr>{cells}</tr>"));
                }
                body.push("</tbody></table>".to_owned());
            }
            Block::Code {
                code, untrusted, ..
            } => body.push(format!(
                "<pre class=\"{}\">{}</pre>",
                if *untrusted { "untrusted" } else { "mono" },
                html_escape(code)
            )),
        }
    }
    let mut lines: Vec<String> = vec![
        "<!doctype html>".to_owned(),
        "<html lang=\"en\"><head><meta charset=\"utf-8\">".to_owned(),
        "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'\">".to_owned(),
        "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">".to_owned(),
        format!(
            "<title>{}</title><style>{STYLE}</style></head><body>",
            html_escape(&doc.title)
        ),
    ];
    lines.extend(body);
    lines.push("</body></html>".to_owned());
    lines.push(String::new());
    lines.join("\n")
}
