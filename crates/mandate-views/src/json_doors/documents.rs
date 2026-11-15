//! The doors that take what another door gave: the two renderings of a
//! document (`to_markdown`, `to_html`) and the blocks of a view
//! (`architecture_blocks`, `authority_blocks`); and the JSON of a document,
//! both ways: [`doc_js`] writes it as the TypeScript's object is written,
//! and the readers here read it back (`super` says what they refuse).

use mandate_check::json_doors::DoorError;
use mandate_check::json_doors::input::{args, type_name};
use mandate_check::{ArchEdge, ArchKind, ArchNode, Authority, ProgramRef};
use mandate_ir::{JsObject, JsValue, Map, Value};

use crate::architecture::{ArchitectureView, WorkflowArchitecture, architecture_blocks as arch};
use crate::authority::{AuthorityRow, AuthorityView, authority_blocks as auth};
use crate::doc::{Block, Cell, Doc};

// ── writing ──────────────────────────────────────────────────────────────

/// A cell as the TypeScript writes it: a string, or `{ text, untrusted?,
/// mono? }` with only the marks it has.
fn cell_js(c: &Cell) -> JsValue {
    match c {
        Cell::Plain(text) => JsValue::from(text.as_str()),
        Cell::Marked {
            text,
            untrusted,
            mono,
        } => JsObject::new()
            .with("text", text.as_str())
            .with_some("untrusted", untrusted.then_some(true))
            .with_some("mono", mono.then_some(true))
            .into(),
    }
}

/// A list of cells.
fn cells_js(cells: &[Cell]) -> JsValue {
    JsValue::Array(cells.iter().map(cell_js).collect())
}

/// A block as the TypeScript writes it: `{ h }`, `{ p }`, `{ note }`,
/// `{ list }`, `{ table: { head, rows } }` or `{ code, lang?, untrusted? }`.
fn block_js(b: &Block) -> JsValue {
    match b {
        Block::H(h) => JsObject::new().with("h", h.as_str()).into(),
        Block::P(p) => JsObject::new().with("p", p.as_str()).into(),
        Block::Note(note) => JsObject::new().with("note", note.as_str()).into(),
        Block::List(list) => JsObject::new().with("list", cells_js(list)).into(),
        Block::Table { head, rows } => JsObject::new()
            .with(
                "table",
                JsObject::new()
                    .with(
                        "head",
                        JsValue::Array(head.iter().map(|h| JsValue::from(h.as_str())).collect()),
                    )
                    .with(
                        "rows",
                        JsValue::Array(rows.iter().map(|r| cells_js(r.as_slice())).collect()),
                    ),
            )
            .into(),
        Block::Code {
            code,
            lang,
            untrusted,
        } => JsObject::new()
            .with("code", code.as_str())
            .with_some("lang", lang.as_deref())
            .with_some("untrusted", untrusted.then_some(true))
            .into(),
    }
}

/// Blocks, as an array.
fn blocks_js(blocks: &[Block]) -> JsValue {
    JsValue::Array(blocks.iter().map(block_js).collect())
}

/// A document as the TypeScript's `Doc` is written: `{ title, meta:
/// [[key, value]], blocks }`.
pub(super) fn doc_js(doc: &Doc) -> JsValue {
    let meta = doc
        .meta
        .iter()
        .map(|(k, v)| JsValue::Array(vec![JsValue::from(k.as_str()), JsValue::from(v.as_str())]))
        .collect();
    JsObject::new()
        .with("title", doc.title.as_str())
        .with("meta", JsValue::Array(meta))
        .with("blocks", blocks_js(&doc.blocks))
        .into()
}

// ── reading ──────────────────────────────────────────────────────────────

/// `bad_input`: "`at` is <the JSON type of `v`>, not `want`".
fn wrong(at: &str, v: &Value, want: &str) -> DoorError {
    DoorError::bad_input(format!("`{at}` is {}, not {want}", type_name(v)))
}

/// `v`, an object.
fn object<'a>(v: &'a Value, at: &str) -> Result<&'a Map, DoorError> {
    v.as_object().ok_or_else(|| wrong(at, v, "an object"))
}

/// `v`, an array.
fn array<'a>(v: &'a Value, at: &str) -> Result<&'a [Value], DoorError> {
    v.as_array().ok_or_else(|| wrong(at, v, "an array"))
}

/// `v`, a string.
fn string(v: &Value, at: &str) -> Result<String, DoorError> {
    v.as_str()
        .map(str::to_owned)
        .ok_or_else(|| wrong(at, v, "a string"))
}

/// The member `key` of `m`, which is at `at`; it must be there.
fn member<'a>(m: &'a Map, at: &str, key: &str) -> Result<&'a Value, DoorError> {
    m.get(key)
        .ok_or_else(|| DoorError::bad_input(format!("`{at}.{key}` is missing")))
}

/// The member `key` of `m`, a string.
fn text(m: &Map, at: &str, key: &str) -> Result<String, DoorError> {
    string(member(m, at, key)?, &format!("{at}.{key}"))
}

/// The member `key` of `m`, a string, when it is there and not `null`.
fn opt_text(m: &Map, at: &str, key: &str) -> Result<Option<String>, DoorError> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => string(v, &format!("{at}.{key}")).map(Some),
    }
}

/// The member `key` of `m`, a boolean; left out or `null` is `false`.
fn flag(m: &Map, at: &str, key: &str) -> Result<bool, DoorError> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(Value::Bool(b)) => Ok(*b),
        Some(v) => Err(wrong(&format!("{at}.{key}"), v, "a boolean")),
    }
}

/// The member `key` of `m`, an array of strings.
fn texts(m: &Map, at: &str, key: &str) -> Result<Vec<String>, DoorError> {
    let here = format!("{at}.{key}");
    array(member(m, at, key)?, &here)?
        .iter()
        .enumerate()
        .map(|(i, x)| string(x, &format!("{here}[{i}]")))
        .collect()
}

/// The member `key` of `m`, an array of strings; left out is none.
fn opt_texts(m: &Map, at: &str, key: &str) -> Result<Vec<String>, DoorError> {
    match m.get(key) {
        None | Some(Value::Null) => Ok(Vec::new()),
        Some(_) => texts(m, at, key),
    }
}

/// A cell: a string, or `{ text, untrusted?, mono? }`.
fn cell_of(v: &Value, at: &str) -> Result<Cell, DoorError> {
    match v {
        Value::String(s) => Ok(Cell::Plain(s.clone())),
        Value::Object(m) => Ok(Cell::Marked {
            text: text(m, at, "text")?,
            untrusted: flag(m, at, "untrusted")?,
            mono: flag(m, at, "mono")?,
        }),
        other => Err(wrong(at, other, "a string or an object")),
    }
}

/// An array of cells.
fn cells_of(v: &Value, at: &str) -> Result<Vec<Cell>, DoorError> {
    array(v, at)?
        .iter()
        .enumerate()
        .map(|(i, c)| cell_of(c, &format!("{at}[{i}]")))
        .collect()
}

/// A block, read as `toMarkdown` and `toHtml` read it: the first of `h`,
/// `p`, `note`, `list` and `table` it has decides what it is; one with none
/// of them is code.
fn block_of(v: &Value, at: &str) -> Result<Block, DoorError> {
    let m = object(v, at)?;
    if let Some(h) = m.get("h") {
        return Ok(Block::H(string(h, &format!("{at}.h"))?));
    }
    if let Some(p) = m.get("p") {
        return Ok(Block::P(string(p, &format!("{at}.p"))?));
    }
    if let Some(note) = m.get("note") {
        return Ok(Block::Note(string(note, &format!("{at}.note"))?));
    }
    if let Some(list) = m.get("list") {
        return Ok(Block::List(cells_of(list, &format!("{at}.list"))?));
    }
    if let Some(table) = m.get("table") {
        let here = format!("{at}.table");
        let t = object(table, &here)?;
        let rows_at = format!("{here}.rows");
        let rows = array(member(t, &here, "rows")?, &rows_at)?
            .iter()
            .enumerate()
            .map(|(i, r)| cells_of(r, &format!("{rows_at}[{i}]")))
            .collect::<Result<Vec<_>, _>>()?;
        return Ok(Block::Table {
            head: texts(t, &here, "head")?,
            rows,
        });
    }
    Ok(Block::Code {
        code: text(m, at, "code")?,
        lang: opt_text(m, at, "lang")?,
        untrusted: flag(m, at, "untrusted")?,
    })
}

/// A document, `{ title, meta, blocks }`, at `at` in the input.
fn doc_of(v: &Value, at: &str) -> Result<Doc, DoorError> {
    let m = object(v, at)?;
    let meta_at = format!("{at}.meta");
    let meta = array(member(m, at, "meta")?, &meta_at)?
        .iter()
        .enumerate()
        .map(|(i, entry)| {
            let here = format!("{meta_at}[{i}]");
            match array(entry, &here)? {
                // `for (const [k, v] of doc.meta)`: more items are not read.
                [k, v, ..] => Ok((
                    string(k, &format!("{here}[0]"))?,
                    string(v, &format!("{here}[1]"))?,
                )),
                short => Err(DoorError::bad_input(format!(
                    "`{here}` has {} item(s), not a key and a value",
                    short.len()
                ))),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let blocks_at = format!("{at}.blocks");
    let blocks = array(member(m, at, "blocks")?, &blocks_at)?
        .iter()
        .enumerate()
        .map(|(i, b)| block_of(b, &format!("{blocks_at}[{i}]")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Doc {
        title: text(m, at, "title")?,
        meta,
        blocks,
    })
}

/// A step's kind, by its name in the view.
fn arch_kind(v: &Value, at: &str) -> Result<ArchKind, DoorError> {
    let name = string(v, at)?;
    Ok(match name.as_str() {
        "delegate" => ArchKind::Delegate,
        "verify" => ArchKind::Verify,
        "effect" => ArchKind::Effect,
        "changeset" => ArchKind::Changeset,
        "human" => ArchKind::Human,
        "infer" => ArchKind::Infer,
        "read" => ArchKind::Read,
        "map" => ArchKind::Map,
        _ => {
            return Err(DoorError::bad_input(format!(
                "`{at}` is \"{name}\", not the kind of a step"
            )));
        }
    })
}

/// The items of the member `key` of `m`, an array, each read by `read`.
fn items<T>(
    m: &Map,
    at: &str,
    key: &str,
    read: impl Fn(&Map, &str) -> Result<T, DoorError>,
) -> Result<Vec<T>, DoorError> {
    let here = format!("{at}.{key}");
    array(member(m, at, key)?, &here)?
        .iter()
        .enumerate()
        .map(|(i, x)| {
            let item_at = format!("{here}[{i}]");
            read(object(x, &item_at)?, &item_at)
        })
        .collect()
}

/// A program a view shows that the blocks do not read.
fn unread_program() -> ProgramRef {
    ProgramRef {
        module: String::new(),
        version: String::new(),
        language: String::new(),
        hash: String::new(),
    }
}

/// An architecture view, `v` in the input, read for its workflows.
fn architecture_view_of(v: &Value) -> Result<ArchitectureView, DoorError> {
    let workflows = items(object(v, "v")?, "v", "workflows", |w, at| {
        Ok(WorkflowArchitecture {
            workflow: text(w, at, "workflow")?,
            budget: text(w, at, "budget")?,
            nodes: items(w, at, "nodes", |n, at| {
                Ok(ArchNode {
                    id: text(n, at, "id")?,
                    kind: arch_kind(member(n, at, "kind")?, &format!("{at}.kind"))?,
                    label: text(n, at, "label")?,
                    detail: texts(n, at, "detail")?,
                })
            })?,
            edges: items(w, at, "edges", |e, at| {
                Ok(ArchEdge {
                    from: text(e, at, "from")?,
                    to: text(e, at, "to")?,
                    label: opt_text(e, at, "label")?,
                })
            })?,
            mermaid: text(w, at, "mermaid")?,
        })
    })?;
    Ok(ArchitectureView {
        program: unread_program(),
        workflows,
    })
}

/// An authority view, `v` in the input, read for its rows.
fn authority_view_of(v: &Value) -> Result<AuthorityView, DoorError> {
    let rows = items(object(v, "v")?, "v", "rows", |r, at| {
        let kind_at = format!("{at}.kind");
        let kind = match text(r, at, "kind")?.as_str() {
            "agent" => "agent",
            "workflow" => "workflow",
            "delegation" => "delegation",
            other => {
                return Err(DoorError::bad_input(format!(
                    "`{kind_at}` is \"{other}\", not \"agent\", \"workflow\" or \"delegation\""
                )));
            }
        };
        Ok(AuthorityRow {
            who: text(r, at, "who")?,
            kind,
            effects: texts(r, at, "effects")?,
            authority: Authority {
                read: texts(r, at, "read")?,
                write: texts(r, at, "write")?,
                network: texts(r, at, "network")?,
                model: texts(r, at, "model")?,
                exec: texts(r, at, "exec")?,
                repos: texts(r, at, "repos")?,
                money: texts(r, at, "money")?,
                unbounded: texts(r, at, "unbounded")?,
            },
            tools: opt_texts(r, at, "tools")?,
        })
    })?;
    Ok(AuthorityView {
        program: unread_program(),
        rows,
    })
}

// ── the doors ────────────────────────────────────────────────────────────

/// The parameters of [`to_markdown`].
pub(super) const TO_MARKDOWN: &[&str] = &["doc"];

/// `toMarkdown(doc)`, `compiler/src/views/doc.ts`: a document as Markdown.
///
/// Input: `{ doc }`, a document as a door gives it or as the runtime builds
/// one (`super` says what is refused).
/// Output: the Markdown, a string.
pub(super) fn to_markdown(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, TO_MARKDOWN)?;
    let doc = doc_of(a.value("doc")?, "doc")?;
    Ok(JsValue::String(crate::to_markdown(&doc)))
}

/// The parameters of [`to_html`].
pub(super) const TO_HTML: &[&str] = &["doc"];

/// `toHtml(doc)`, `compiler/src/views/doc.ts`: a document as one
/// self-contained HTML page.
///
/// Input: `{ doc }`, as [`to_markdown`].
/// Output: the page, a string.
pub(super) fn to_html(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, TO_HTML)?;
    let doc = doc_of(a.value("doc")?, "doc")?;
    Ok(JsValue::String(crate::to_html(&doc)))
}

/// The parameters of [`architecture_blocks`].
pub(super) const ARCHITECTURE_BLOCKS: &[&str] = &["v"];

/// `architectureBlocks(v)`, `compiler/src/views/views.ts`: the blocks of an
/// architecture view in a document.
///
/// Input: `{ v }`, the view as the door `architecture` gives it.
/// Output: the blocks, an array.
pub(super) fn architecture_blocks(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ARCHITECTURE_BLOCKS)?;
    let view = architecture_view_of(a.value("v")?)?;
    Ok(blocks_js(&arch(&view)))
}

/// The parameters of [`authority_blocks`].
pub(super) const AUTHORITY_BLOCKS: &[&str] = &["v"];

/// `authorityBlocks(v)`, `compiler/src/views/views.ts`: the blocks of an
/// authority view in a document.
///
/// Input: `{ v }`, the view as the door `authority` gives it.
/// Output: the blocks, an array.
pub(super) fn authority_blocks(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, AUTHORITY_BLOCKS)?;
    let view = authority_view_of(a.value("v")?)?;
    Ok(blocks_js(&auth(&view)))
}
