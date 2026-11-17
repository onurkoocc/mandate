//! A stage changes nothing but where the statements after it stand
//! (spec/attention.md "`stage`", "Nothing else"): every program the golden
//! file of 0.6 pins (`fixtures/library/`), relabelled `mandate @ 0.7` as
//! `language_0_7.rs` relabels it, and then with stage markers put into the
//! top level of each body of a workflow written out and of a pattern, gives
//! what the relabelled program gives.
//!
//! **Where the markers go.** In each such body, before its first statement
//! and before some of the others, chosen by a generator seeded by the
//! program's path and the definition's name (so every run marks the same
//! places): each other statement is chosen with a chance of one in three,
//! and one is chosen when none was, so that a body of two statements or
//! more has two stages. A marker never goes directly before an `on error`
//! (E1902), nor before a statement that does not start its line; a body
//! whose first statement does not is left unmarked, and listed. A marker is
//! a line of its own, `stage sN "Part N of D"`, indented as the statement it
//! stands before; each stage has a statement after it.
//!
//! **What is compared.** Every output `outputs::outputs_of` gives (the
//! outputs the golden files pin), each of both programs, and three things
//! besides, each by name:
//!
//! - The JSON outputs (`check`, `check --module`, `check --lock`, `load`,
//!   `view --format json`, `view --against itself`, `sandbox`, `view --card
//!   --format json`) as values, member by member in their order, every
//!   value of the unmarked program mapped to the marked one: a path
//!   `/defs/D/body/i` of a marked body (and of a workflow that applies a
//!   marked pattern of the program, whose expansion has its stages) at the
//!   index the statement has with the markers before it, and a span's lines
//!   moved down by the marker lines above them. Each value is held to be
//!   the very text the output is (`JSON.stringify(v, null, 2)`).
//! - `ir --canonical`: the marked IR with its stage statements taken out is
//!   the unmarked IR, and it has one stage per marker.
//! - `fmt`: the marked text printed, with its marker lines and the blank
//!   line the printer puts before each taken out, is the unmarked one's.
//! - `hash`, the documents (`view --format md`, `html`, the card's) and the
//!   sub-programs' checks as text, paths mapped as above.
//! - The static nodes of each workflow (`workflow_nodes`, of the expansion
//!   when there is one), the places the program names a role
//!   (`role_sites_of`, paths mapped) and the roles it names.
//!
//! **What may differ.** Only the hashes, each as a renaming (a hash of the
//! unmarked program is one hash of the marked one wherever it stands, and
//! no two are one), and the program hash must differ: what a person will
//! see is part of the program. Nothing else is exempt: every count of what
//! was compared is printed and held above zero.
//!
//! **Reports** (spec/attention.md "`report`", slice RL3). The same test is
//! run again with reports: `report to R "Part N of D" { part: N, count:
//! len([N]) }`, a report of pure fields, before every statement a stage
//! marker may stand before, where `R` is, in a workflow written out, the
//! first role the program already names (`roles_named_in`, so that its lock
//! binds it), else the first it defines that its lock binds; and in a
//! pattern its first role slot. A body with no such role is left unmarked,
//! and listed. Every output, the nodes and the costs are compared as for
//! stages; the role
//! sites of the marked program are those of the unmarked one, paths mapped,
//! and exactly one more for each report its workflows' bodies hold (the
//! expansions of a marked pattern's applications among them), at the
//! report's role; the roles named are the same, but for a role a report
//! names that nothing named before.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;
mod outputs;

use std::collections::BTreeMap;

use mandate_check::{
    CheckResult, RoleSite, requirements_to_js, role_sites_of, roles_named_in, sandbox_requirements,
    semantic_diff_with, static_cost, workflow_nodes,
};
use mandate_ir::{
    Diagnostic, JsObject, JsValue, Language, Program, Spans, Value, canonicalize, parse, ptr_token,
    stringify_pretty,
};
use mandate_syntax::{SourceKind, kind_of, load};
use mandate_testkit::read_json;
use mandate_testkit::rust_vectors::programs_0_6;
use mandate_views::{architecture_with_lock, authority_with, card, cost_with, envelope_workflows};

/// `text` with its one header `mandate @ 0.6` written as 0.7.
fn as_0_7(text: &str) -> Result<String, String> {
    match text.matches("mandate @ 0.6").count() {
        1 => Ok(text.replacen("mandate @ 0.6", "mandate @ 0.7", 1)),
        n => Err(format!("{n} headers of 0.6")),
    }
}

/// The generator of the places: xorshift64*, seeded by FNV-1a of a text.
struct Places(u64);

impl Places {
    fn seeded(seed: &str) -> Places {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in seed.bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        Places(h | 1)
    }

    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_f491_4f6c_dd1d) >> 32
    }
}

/// Where the markers of a program stand, and what that moves.
#[derive(Default)]
struct Marks {
    /// By definition: the indices of the unmarked body a marker stands
    /// before, ascending. A workflow that applies a marked pattern of the
    /// program has the pattern's.
    before: BTreeMap<String, Vec<usize>>,
    /// The lines (from 1) of the unmarked text a marker line stands before,
    /// ascending.
    lines: Vec<usize>,
    /// The markers, in all.
    markers: usize,
    /// The bodies marked, as `D (n of m)`.
    bodies: Vec<String>,
    /// The bodies left unmarked, with why.
    skipped: Vec<String>,
    /// The roles the reports of workflows written out are addressed to.
    roles: Vec<String>,
}

impl Marks {
    /// The index in the marked body of statement `i` of the unmarked body
    /// of `def`.
    fn index(&self, def: &str, i: usize) -> usize {
        i + self
            .before
            .get(def)
            .map_or(0, |b| b.iter().filter(|k| **k <= i).count())
    }

    /// The line in the marked text of line `l` of the unmarked one.
    fn line(&self, l: f64) -> f64 {
        l + self.lines.iter().filter(|x| (**x as f64) <= l).count() as f64
    }

    /// `s` with each `/defs/D/body/i` of a marked `D` at its index in the
    /// marked program.
    fn paths(&self, s: &str) -> String {
        let mut out = String::with_capacity(s.len());
        let mut rest = s;
        while let Some(at) = rest.find("/defs/") {
            let (head, tail) = rest.split_at(at + "/defs/".len());
            out.push_str(head);
            let name_end = tail.find('/').unwrap_or(tail.len());
            let (name, after) = tail.split_at(name_end);
            out.push_str(name);
            rest = after;
            let Some(digits) = after.strip_prefix("/body/") else {
                continue;
            };
            let n = digits.bytes().take_while(u8::is_ascii_digit).count();
            let Some(def) = self.before.keys().find(|d| ptr_token(d) == name) else {
                continue;
            };
            if n == 0 {
                continue;
            }
            let i: usize = digits[..n].parse().unwrap();
            out.push_str("/body/");
            out.push_str(&self.index(def, i).to_string());
            rest = &digits[n..];
        }
        out.push_str(rest);
        out
    }
}

/// The definitions whose body may have stages: a workflow written out and
/// a pattern, each with a body.
fn marked_kind(d: &Value) -> bool {
    match d.get("kind").and_then(Value::as_str) {
        Some("workflow") => d.get("apply").is_none(),
        Some("pattern") => true,
        _ => false,
    }
}

/// What is put in: stage markers, or reports.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Marker {
    Stage,
    Report,
}

impl Marker {
    /// The `op` of what is put in.
    fn op(self) -> &'static str {
        match self {
            Marker::Stage => "stage",
            Marker::Report => "report",
        }
    }
}

/// The first role slot of a pattern.
fn role_slot(d: &Value) -> Option<String> {
    d.get("slots")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .find(|s| s.get("kind").and_then(Value::as_str) == Some("role"))
        .and_then(|s| s.get("name").and_then(Value::as_str))
        .map(str::to_owned)
}

/// The text of `program` (relabelled 0.7) with `marker`'s statements put
/// in, and where.
fn mark_with(program: &str, text: &str, marker: Marker) -> Result<(String, Marks), String> {
    let loaded = load(text, SourceKind::Mdt);
    let ir = loaded
        .program
        .ok_or("the relabelled program does not read")?;
    let spans: &Spans = &loaded.spans;
    let mut lines: Vec<String> = text.split('\n').map(str::to_owned).collect();
    let mut marks = Marks::default();
    // (line from 1, marker text), to insert.
    let mut inserts: Vec<(usize, String)> = Vec::new();
    let defs = ir.get("defs").and_then(Value::as_object).ok_or("no defs")?;
    // A report's role: the first the program names already, else the first
    // role it defines that its lock binds (any, with no lock).
    let bound: Option<Vec<String>> = outputs::lock_file_of(program)
        .map(|f| read_json(&f))
        .transpose()?
        .map(|lock| {
            lock.get("roles")
                .and_then(Value::as_object)
                .map(|r| r.keys().map(str::to_owned).collect())
                .unwrap_or_default()
        });
    let defined = defs
        .iter()
        .filter(|(n, d)| {
            d.get("kind").and_then(Value::as_str) == Some("role")
                && bound.as_ref().is_none_or(|b| b.iter().any(|x| x == n))
        })
        .map(|(n, _)| n.to_owned());
    let named: Vec<String> = roles_named_in(defs, Language::V0_7)
        .into_iter()
        .chain(defined)
        .collect();
    for (name, d) in defs.iter() {
        if !marked_kind(d) {
            continue;
        }
        let body = d.get("body").and_then(Value::as_array).unwrap_or_default();
        if body.is_empty() {
            continue;
        }
        let role = match (marker, d.get("kind").and_then(Value::as_str)) {
            (Marker::Stage, _) => None,
            (Marker::Report, Some("pattern")) => match role_slot(d) {
                Some(r) => Some(r),
                None => {
                    marks.skipped.push(format!("{name}: no role slot"));
                    continue;
                }
            },
            (Marker::Report, _) => match named.first() {
                Some(r) => {
                    if !marks.roles.contains(r) {
                        marks.roles.push(r.clone());
                    }
                    Some(r.clone())
                }
                None => {
                    marks
                        .skipped
                        .push(format!("{name}: the program has no role to report to"));
                    continue;
                }
            },
        };
        // Where a marker line may go: before a statement that starts its
        // line, that is not an `on error`; and its indentation.
        let mut at: Vec<Option<(usize, String)>> = Vec::new();
        for (k, s) in body.iter().enumerate() {
            let path = format!("/defs/{}/body/{k}", ptr_token(name));
            let span = spans
                .get(&path)
                .ok_or_else(|| format!("no span at {path}"))?;
            let line = &lines[span.start_line - 1];
            let indent: String = line.chars().take(span.start_col - 1).collect();
            let starts =
                indent.len() == span.start_col - 1 && indent.chars().all(|c| c == ' ' || c == '\t');
            let on_error = s.get("op").and_then(Value::as_str) == Some("on_error");
            at.push((starts && !on_error).then_some((span.start_line, indent)));
        }
        if at[0].is_none() {
            marks.skipped.push(format!(
                "{name}: its first statement does not start its line"
            ));
            continue;
        }
        let mut places = Places::seeded(&format!("{program}\u{0}{name}"));
        let mut chosen = vec![0];
        for (k, a) in at.iter().enumerate().skip(1) {
            if a.is_some() && places.next().is_multiple_of(3) {
                chosen.push(k);
            }
        }
        let others: Vec<usize> = (1..at.len()).filter(|k| at[*k].is_some()).collect();
        if chosen.len() == 1 && !others.is_empty() {
            chosen.push(others[(places.next() as usize) % others.len()]);
        }
        // A report goes before every statement a marker may stand before:
        // the bodies that may have one are few.
        if marker == Marker::Report {
            chosen = std::iter::once(0).chain(others).collect();
        }
        for (j, k) in chosen.iter().enumerate() {
            let (line, indent) = at[*k].clone().unwrap();
            let n = j + 1;
            let text = match &role {
                None => format!("{indent}stage s{n} \"Part {n} of {name}\""),
                Some(r) => format!(
                    "{indent}report to {r} \"Part {n} of {name}\" {{ part: {n}, count: len([{n}]) }}"
                ),
            };
            inserts.push((line, text));
        }
        marks.markers += chosen.len();
        marks
            .bodies
            .push(format!("{name} ({} of {})", chosen.len(), body.len()));
        marks.before.insert(name.to_owned(), chosen);
    }
    // A workflow that applies a marked pattern of the program: its
    // expansion is the pattern's body, statement for statement.
    for (name, d) in defs.iter() {
        let applied = d
            .get("apply")
            .and_then(|a| a.get("pattern"))
            .and_then(Value::as_str);
        if let Some(p) = applied
            && defs
                .get(p)
                .and_then(|x| x.get("kind"))
                .and_then(Value::as_str)
                == Some("pattern")
            && let Some(b) = marks.before.get(p).cloned()
        {
            marks.before.insert(name.to_owned(), b);
        }
    }
    inserts.sort_by_key(|(line, _)| std::cmp::Reverse(*line));
    for (line, marker) in &inserts {
        lines.insert(line - 1, marker.clone());
    }
    marks.lines = inserts.iter().map(|(l, _)| *l).collect();
    marks.lines.sort_unstable();
    Ok((lines.join("\n"), marks))
}

/// The hashes renamed, both ways (as in `language_0_7.rs`).
#[derive(Default)]
struct Renamed {
    forth: BTreeMap<String, String>,
    back: BTreeMap<String, String>,
}

impl Renamed {
    fn take(&mut self, a: &str, b: &str) -> Result<(), String> {
        let forth = self.forth.get(a).map(String::as_str);
        let back = self.back.get(b).map(String::as_str);
        match (forth, back) {
            (None, None) if a == b => Ok(()),
            (None, None) => {
                self.forth.insert(a.to_owned(), b.to_owned());
                self.back.insert(b.to_owned(), a.to_owned());
                Ok(())
            }
            (Some(x), Some(y)) if x == b && y == a => Ok(()),
            _ => Err(format!("{a} is {b} here and not elsewhere: no renaming")),
        }
    }
}

/// The text with each hash (`sha256:` and its hexadecimal digits) as
/// `sha256:#`, and the hashes, in order.
fn split_hashes(text: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(text.len());
    let mut hashes = Vec::new();
    let mut rest = text;
    while let Some(at) = rest.find("sha256:") {
        let (head, tail) = rest.split_at(at);
        out.push_str(head);
        out.push_str("sha256:#");
        let hex = tail[7..].bytes().take_while(u8::is_ascii_hexdigit).count();
        hashes.push(tail[..7 + hex].to_owned());
        rest = &tail[7 + hex..];
    }
    out.push_str(rest);
    (out, hashes)
}

/// `a` (of the unmarked program, its paths already mapped) and `b` are the
/// same text but for hashes renamed.
fn same_text(a: &str, b: &str, renamed: &mut Renamed) -> Result<(), String> {
    let (ta, ha) = split_hashes(a);
    let (tb, hb) = split_hashes(b);
    if ta != tb {
        mandate_testkit::compare_text(&ta, &tb)?;
        return Err("the texts differ".to_owned());
    }
    for (x, y) in ha.iter().zip(&hb) {
        renamed.take(x, y)?;
    }
    Ok(())
}

/// What was compared, in all.
#[derive(Default, Debug)]
struct Tally {
    values: usize,
    paths: usize,
    spans: usize,
    outputs: usize,
    nodes: usize,
    costs: usize,
    role_sites: usize,
    subprogram_stages: usize,
    report_sites: usize,
}

/// `a`, a value of the unmarked program, mapped by `m`, is `b`, a value of
/// the marked one: member by member in order; a span's lines moved; each
/// string's paths mapped, its hashes renamed.
fn same(
    a: &JsValue,
    b: &JsValue,
    m: &Marks,
    key: &str,
    at: &str,
    t: &mut Tally,
    renamed: &mut Renamed,
) -> Result<(), String> {
    match (a, b) {
        (JsValue::Object(x), JsValue::Object(y)) => {
            let kx: Vec<&str> = x.keys().collect();
            let ky: Vec<&str> = y.keys().collect();
            if kx != ky {
                return Err(format!("{at}: members {kx:?} and {ky:?}"));
            }
            for (k, v) in x.iter() {
                same(v, y.get(k).unwrap(), m, k, &format!("{at}/{k}"), t, renamed)?;
            }
            Ok(())
        }
        (JsValue::Array(x), JsValue::Array(y)) => {
            if x.len() != y.len() {
                return Err(format!("{at}: {} items and {}", x.len(), y.len()));
            }
            if key == "span"
                && x.len() == 4
                && let [JsValue::Number(l1), c1, JsValue::Number(l2), c2] = x.as_slice()
            {
                let moved = vec![
                    JsValue::Number(m.line(*l1)),
                    c1.clone(),
                    JsValue::Number(m.line(*l2)),
                    c2.clone(),
                ];
                if moved != *x {
                    t.spans += 1;
                }
                t.values += 4;
                return if moved == *y {
                    Ok(())
                } else {
                    Err(format!("{at}: span {x:?} moved is {moved:?}, not {y:?}"))
                };
            }
            for (i, (v, w)) in x.iter().zip(y).enumerate() {
                same(v, w, m, "", &format!("{at}/{i}"), t, renamed)?;
            }
            Ok(())
        }
        (JsValue::String(x), JsValue::String(y)) => {
            let mapped = m.paths(x);
            if mapped != *x {
                t.paths += 1;
            }
            t.values += 1;
            same_text(&mapped, y, renamed).map_err(|e| format!("{at}: {x:?} / {y:?}: {e}"))
        }
        (JsValue::Json(x), JsValue::Json(y)) => {
            t.values += 1;
            same_text(&m.paths(x.as_str()), y.as_str(), renamed).map_err(|e| format!("{at}: {e}"))
        }
        _ => {
            t.values += 1;
            if a == b {
                Ok(())
            } else {
                Err(format!("{at}: {a:?} and {b:?}"))
            }
        }
    }
}

/// The JSON outputs of a program, as values, by name; and the check its
/// views stand on.
struct JsonOutputs {
    values: Vec<(String, JsValue)>,
    check: CheckResult,
}

/// The JSON outputs of `program` read as `text`, by the names
/// `outputs::outputs_of` gives them, made as it makes them.
fn json_outputs(program: &str, text: &str) -> Result<JsonOutputs, String> {
    let mut out: Vec<(String, JsValue)> = Vec::new();
    let lock_path = outputs::lock_file_of(program);
    // As `language_0_7.rs` relabels it: std.patterns 1.0.0 pinned.
    let more = common::relabelled_modules(text, kind_of(program));
    let plain = outputs::checked_text_more(program, text, false, false, more.as_ref())?;
    out.push(("check".to_owned(), plain.to_js()));
    let linked = outputs::checked_text_more(program, text, true, false, more.as_ref())?;
    out.push(("check --module".to_owned(), linked.to_js()));
    let with_lock = match lock_path {
        Some(_) => Some(outputs::checked_text_more(
            program,
            text,
            true,
            true,
            more.as_ref(),
        )?),
        None => None,
    };
    if let Some(r) = &with_lock {
        out.push(("check --lock".to_owned(), r.to_js()));
    }
    let loaded = load(text, kind_of(program));
    out.push((
        "load".to_owned(),
        JsValue::Array(loaded.diagnostics.iter().map(Diagnostic::to_js).collect()),
    ));
    let checked = with_lock.unwrap_or(linked);
    if let (true, Some(p)) = (checked.ok, &checked.program) {
        let files = outputs::module_files_of(program);
        let mut modules = common::modules_of(&files, &files)?;
        for (m, ir) in outputs::library_modules_of(program)?.iter() {
            modules.insert(m, ir.clone());
        }
        let lock = lock_path.as_deref().map(read_json).transpose()?;
        let views = JsObject::new()
            .with(
                "architecture",
                architecture_with_lock(p, lock.as_ref(), Some(&modules)).to_js(),
            )
            .with("authority", authority_with(p, Some(&modules)).to_js())
            .with("cost", cost_with(p, lock.as_ref(), Some(&modules)).to_js());
        out.push(("view --format json".to_owned(), JsValue::Object(views)));
        out.push((
            "view --against itself".to_owned(),
            semantic_diff_with(p, p, None, Some(&modules)).to_js(),
        ));
        let hashes = checked.hashes.as_ref().ok_or("no hashes")?;
        let requirements = sandbox_requirements(p, Some(&modules), lock.as_ref());
        let sandbox = JsObject::new()
            .with("program", hashes.program.as_str())
            .with("requirements", requirements_to_js(&requirements));
        out.push(("sandbox".to_owned(), JsValue::Object(sandbox)));
        if let [name] = envelope_workflows(p).as_slice() {
            let view = card(p, name, lock.as_ref(), Some(&modules)).ok_or("no card")?;
            out.push(("view --card --format json".to_owned(), view.to_js()));
        }
    }
    Ok(JsonOutputs {
        values: out,
        check: checked,
    })
}

fn pretty(v: &JsValue) -> String {
    let mut text = stringify_pretty(v).unwrap_or_default();
    text.push('\n');
    text
}

/// A value with every statement whose `op` is `op` taken out of its lists,
/// and how many.
fn without_op(v: &Value, op: &str, n: &mut usize) -> Value {
    match v {
        Value::Array(items) => {
            let mut kept = Vec::with_capacity(items.len());
            for x in items {
                if x.get("op").and_then(Value::as_str) == Some(op) {
                    *n += 1;
                } else {
                    kept.push(without_op(x, op, n));
                }
            }
            Value::Array(kept)
        }
        Value::Object(m) => {
            let mut out = mandate_ir::Map::new();
            for (k, x) in m.iter() {
                out.insert(k, without_op(x, op, n));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// How many statements whose `op` is `op` the bodies of the workflows of
/// `defs` hold, at any depth.
fn ops_in_workflows(defs: &mandate_ir::Map, op: &str) -> usize {
    defs.iter()
        .filter(|(_, d)| d.get("kind").and_then(Value::as_str) == Some("workflow"))
        .map(|(_, d)| {
            let mut n = 0;
            without_op(d, op, &mut n);
            n
        })
        .sum()
}

/// The printed text with the marker lines taken out: each stage's with the
/// blank line the printer puts before a stage that does not start its
/// block, and each report's (one line, as the printer writes a short one).
fn without_marker_lines(text: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in text.split('\n') {
        let t = line.trim_start();
        let stage = t.starts_with("stage s")
            && t.contains(" \"Part ")
            && t.ends_with('"')
            && t.split(' ').nth(1).is_some_and(|n| {
                n.strip_prefix('s')
                    .is_some_and(|d| !d.is_empty() && d.bytes().all(|b| b.is_ascii_digit()))
            });
        if stage {
            if out.last() == Some(&"") {
                out.pop();
            }
            continue;
        }
        let report = t.starts_with("report to ")
            && t.contains(" \"Part ")
            && t.contains("\" { part: ")
            && t.ends_with("]) }");
        if report {
            continue;
        }
        out.push(line);
    }
    out.join("\n")
}

/// The program a check's views and counts read: its expansion when it has
/// one, else the program.
fn target(r: &CheckResult) -> Option<&Value> {
    r.expanded.as_ref().or(r.program.as_ref())
}

fn role_site_text(s: &RoleSite, m: &Marks) -> String {
    format!(
        "{} {:?} {} {} {} {}",
        s.def,
        s.role,
        m.paths(&s.path),
        s.r#where,
        s.distinct,
        mandate_ir::stringify(&s.value.value(s.role.as_deref().unwrap_or(""))).unwrap_or_default()
    )
}

/// One program: marked, and every output of both compared.
fn compare(program: &str, t: &mut Tally) -> Result<Marks, String> {
    compare_with(program, t, Marker::Stage)
}

/// [`compare`], with `marker`'s statements put in.
fn compare_with(program: &str, t: &mut Tally, marker: Marker) -> Result<Marks, String> {
    let text = common::read_source(program)?;
    if kind_of(program) != SourceKind::Mdt {
        return Err("not Mandate text".to_owned());
    }
    let unmarked = as_0_7(&text)?;
    let (marked, marks) = mark_with(program, &unmarked, marker)?;
    let op = marker.op();
    let outs_a = outputs::outputs_of_relabelled(program, &unmarked)?;
    let outs_b = outputs::outputs_of_relabelled(program, &marked)?;
    let names = |o: &[(String, String)]| o.iter().map(|(n, _)| n.clone()).collect::<Vec<_>>();
    if names(&outs_a) != names(&outs_b) {
        return Err(format!(
            "outputs {:?} and {:?}",
            names(&outs_a),
            names(&outs_b)
        ));
    }
    let JsonOutputs {
        values: json_a,
        check: check_a,
    } = json_outputs(program, &unmarked)?;
    let JsonOutputs {
        values: json_b,
        check: check_b,
    } = json_outputs(program, &marked)?;
    let mut renamed = Renamed::default();
    for ((name, a), (_, b)) in outs_a.iter().zip(&outs_b) {
        let at = |e: String| format!("{name}: {e}");
        match name.as_str() {
            "ir --canonical" => {
                let mut n = 0;
                let ir_b = parse(b).map_err(|e| at(format!("{e:?}")))?.value;
                let bare = canonicalize(&without_op(&ir_b, op, &mut n));
                if bare != *a {
                    return Err(at(format!("the marked IR without its {op}s is not the IR")));
                }
                if n != marks.markers {
                    return Err(at(format!("{n} {op}s for {} markers", marks.markers)));
                }
            }
            "fmt" => {
                if without_marker_lines(b) != *a {
                    mandate_testkit::compare_text(a, &without_marker_lines(b)).map_err(at)?;
                    return Err(at("the printed texts differ".to_owned()));
                }
            }
            "hash" => same_text(a, b, &mut renamed).map_err(at)?,
            _ => {
                let json = |o: &[(String, JsValue)]| {
                    o.iter().find(|(n, _)| n == name).map(|(_, v)| v.clone())
                };
                match (json(&json_a), json(&json_b)) {
                    (Some(va), Some(vb)) => {
                        // The values are the outputs.
                        if pretty(&va) != *a || pretty(&vb) != *b {
                            return Err(at("the value is not the output".to_owned()));
                        }
                        same(&va, &vb, &marks, "", "", t, &mut renamed).map_err(at)?;
                    }
                    (None, None) if name.starts_with("check_subprogram ") => {
                        // A sub-program's result holds what it runs, with
                        // the parent's definitions: the marked parent's
                        // with its stages, taken out here. Its paths are
                        // the sub-program's.
                        let read =
                            |s: &str| parse(s).map(|p| p.value).map_err(|e| at(format!("{e:?}")));
                        let mut n = 0;
                        let bare = canonicalize(&without_op(&read(b)?, op, &mut n));
                        same_text(&canonicalize(&read(a)?), &bare, &mut renamed).map_err(at)?;
                        t.subprogram_stages += n;
                    }
                    (None, None) if name.starts_with("view --") => {
                        same_text(&marks.paths(a), b, &mut renamed).map_err(at)?;
                    }
                    _ => return Err(at("an output this test does not know".to_owned())),
                }
            }
        }
        t.outputs += 1;
    }
    // A program with markers is another program; one without is the same.
    let hashed = outs_a.iter().any(|(n, _)| n == "hash");
    if hashed && (marks.markers > 0) == renamed.forth.is_empty() {
        return Err(format!(
            "{} markers, {} hashes renamed",
            marks.markers,
            renamed.forth.len()
        ));
    }
    // The static nodes and the roles, of what the views read.
    let (Some(ta), Some(tb)) = (target(&check_a), target(&check_b)) else {
        return Err("no program".to_owned());
    };
    let (pa, pb) = (Program::of(ta).unwrap(), Program::of(tb).unwrap());
    let (na, nb) = (workflow_nodes(pa, None), workflow_nodes(pb, None));
    if na != nb {
        return Err(format!("nodes {na:?} and {nb:?}"));
    }
    t.nodes += na.len();
    // The static cost of each workflow, its parts at their paths.
    for (name, _) in &na {
        let cost = |p: Program<'_>| static_cost(p, name, None).map(|c| c.to_js());
        match (cost(pa), cost(pb)) {
            (Some(ca), Some(cb)) => {
                same(
                    &ca,
                    &cb,
                    &marks,
                    "",
                    &format!("cost of {name}"),
                    t,
                    &mut renamed,
                )?;
                t.costs += 1;
            }
            (None, None) => {}
            _ => return Err(format!("{name} has a cost in one program only")),
        }
    }
    let defs = |v: &Value| {
        v.get("defs")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default()
    };
    let (da, db) = (defs(ta), defs(tb));
    let sites_a: Vec<String> = role_sites_of(&da, Some(Language::V0_7))
        .iter()
        .map(|s| role_site_text(s, &marks))
        .collect();
    // A report is a role site of its own: those of the marked program but
    // its reports' are the unmarked one's, and it has one for each report
    // its workflows hold.
    let all_b = role_sites_of(&db, Some(Language::V0_7));
    let sites_b: Vec<String> = all_b
        .iter()
        .filter(|s| marker == Marker::Stage || s.r#where != "a report")
        .map(|s| role_site_text(s, &Marks::default()))
        .collect();
    if sites_a != sites_b {
        return Err(format!("role sites {sites_a:?} and {sites_b:?}"));
    }
    if marker == Marker::Report {
        let added = all_b.iter().filter(|s| s.r#where == "a report").count();
        let held = ops_in_workflows(&db, "report");
        let before = role_sites_of(&da, Some(Language::V0_7))
            .iter()
            .filter(|s| s.r#where == "a report")
            .count();
        if added != held || before > 0 {
            return Err(format!("{added} report sites for {held} reports"));
        }
        if all_b
            .iter()
            .any(|s| s.r#where == "a report" && s.role.is_none())
        {
            return Err("a report's site names no role".to_owned());
        }
        t.report_sites += added;
    }
    t.role_sites += sites_a.len();
    t.paths += role_sites_of(&da, Some(Language::V0_7))
        .iter()
        .filter(|s| marks.paths(&s.path) != s.path)
        .count();
    // The roles named: the same, but for the roles of the reports, which a
    // report names (a report of a pattern names the role its application
    // binds, which the program names already).
    let mut expected = roles_named_in(&da, Language::V0_7);
    for r in &marks.roles {
        if !expected.contains(r) {
            expected.push(r.clone());
        }
    }
    mandate_ir::sort_utf16(&mut expected);
    if expected != roles_named_in(&db, Language::V0_7) {
        return Err(format!(
            "the roles named are {:?}, not {expected:?}",
            roles_named_in(&db, Language::V0_7)
        ));
    }
    Ok(marks)
}

#[test]
fn a_program_with_stage_markers_gives_what_it_gives_without_them() {
    let programs = programs_0_6().expect("the 0.6 programs");
    let mut t = Tally::default();
    let mut problems: Vec<String> = Vec::new();
    let (mut markers, mut bodies, mut marked_programs) = (0, 0, 0);
    for p in &programs {
        match compare(p, &mut t) {
            Ok(marks) => {
                markers += marks.markers;
                bodies += marks.bodies.len();
                marked_programs += usize::from(!marks.bodies.is_empty());
                println!(
                    "{p}: {} markers in {}; moved: {:?}{}",
                    marks.markers,
                    marks.bodies.join(", "),
                    marks.lines,
                    if marks.skipped.is_empty() {
                        String::new()
                    } else {
                        format!("; left unmarked: {}", marks.skipped.join(", "))
                    }
                );
            }
            Err(e) => problems.push(format!("{p}: {e}")),
        }
    }
    println!(
        "stages: {} programs, {marked_programs} with markers, {bodies} bodies, {markers} markers; compared {} outputs, {} values ({} paths and {} spans moved), {} workflows' nodes and {} costs, {} role sites; {} stages of a marked parent in the sub-programs' results",
        programs.len(),
        t.outputs,
        t.values,
        t.paths,
        t.spans,
        t.nodes,
        t.costs,
        t.role_sites,
        t.subprogram_stages
    );
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    // What the fixtures of 0.6 have to mark: every workflow written out and
    // every pattern of their own, most of the rest applying patterns.
    assert!(programs.len() >= 10, "only {} programs", programs.len());
    assert!(marked_programs >= 7 && bodies >= 7 && markers >= 12);
    assert!(t.paths > 0 && t.spans > 0 && t.nodes > 0 && t.costs > 0 && t.role_sites > 0);
    assert!(t.subprogram_stages > 0);
}

/// The same as [`a_program_with_stage_markers_gives_what_it_gives_without_them`],
/// with reports of pure fields in the markers' places (RL3): they change no
/// cost, node count, authority or view, and add exactly their role sites.
#[test]
fn a_program_with_reports_gives_what_it_gives_without_them_but_its_role_sites() {
    let programs = programs_0_6().expect("the 0.6 programs");
    let mut t = Tally::default();
    let mut problems: Vec<String> = Vec::new();
    let (mut reports, mut bodies, mut marked_programs) = (0, 0, 0);
    for p in &programs {
        match compare_with(p, &mut t, Marker::Report) {
            Ok(marks) => {
                reports += marks.markers;
                bodies += marks.bodies.len();
                marked_programs += usize::from(!marks.bodies.is_empty());
                println!(
                    "{p}: {} reports in {}{}",
                    marks.markers,
                    marks.bodies.join(", "),
                    if marks.skipped.is_empty() {
                        String::new()
                    } else {
                        format!("; left unmarked: {}", marks.skipped.join(", "))
                    }
                );
            }
            Err(e) => problems.push(format!("{p}: {e}")),
        }
    }
    println!(
        "reports: {} programs, {marked_programs} with reports, {bodies} bodies, {reports} reports; compared {} outputs, {} values ({} paths and {} spans moved), {} workflows' nodes and {} costs, {} role sites, and {} role sites the reports add; {} reports of a marked parent in the sub-programs' results",
        programs.len(),
        t.outputs,
        t.values,
        t.paths,
        t.spans,
        t.nodes,
        t.costs,
        t.role_sites,
        t.report_sites,
        t.subprogram_stages
    );
    assert!(problems.is_empty(), "{}", problems.join("\n"));
    // The bodies of 0.6 a report may go in: a workflow written out of a
    // program with a role, and a pattern with a role slot.
    assert!(marked_programs >= 3 && bodies >= 3 && reports >= 10);
    assert!(t.paths > 0 && t.nodes > 0 && t.costs > 0 && t.role_sites > 0);
    // A pattern of a module applied nowhere in it adds no site there.
    assert!(t.report_sites > 0 && t.report_sites <= reports);
}

#[test]
fn the_paths_and_lines_move_by_the_markers_before_them() {
    let mut m = Marks::default();
    m.before.insert("W".to_owned(), vec![0, 2]);
    m.lines = vec![10, 14];
    assert_eq!(m.index("W", 0), 1);
    assert_eq!(m.index("W", 1), 2);
    assert_eq!(m.index("W", 2), 4);
    assert_eq!(m.index("V", 2), 2);
    assert_eq!(
        m.paths("at /defs/W/body/2/value and /defs/W/bodyx/2, /defs/V/body/1, /defs/W/body/0"),
        "at /defs/W/body/4/value and /defs/W/bodyx/2, /defs/V/body/1, /defs/W/body/1"
    );
    assert_eq!(m.line(9.0), 9.0);
    assert_eq!(m.line(10.0), 11.0);
    assert_eq!(m.line(14.0), 16.0);
    assert_eq!(
        without_marker_lines(
            "{\n  stage s1 \"Part 1 of W\"\n  a\n\n  stage s2 \"Part 2 of W\"\n  b\n}"
        ),
        "{\n  a\n  b\n}"
    );
    assert_eq!(
        without_marker_lines(
            "{\n  report to r \"Part 1 of W\" { part: 1, count: len([1]) }\n  a\n\n  stage s\n  b\n}"
        ),
        "{\n  a\n\n  stage s\n  b\n}"
    );
}
