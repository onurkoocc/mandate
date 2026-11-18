//! The stages of a program of language 0.7 (spec/attention.md "`stage`",
//! "Titles"), which only the Rust compiler reads: where a `stage` may stand
//! (E1901) and the list of stages of each body (E1902).
//!
//! A stage is a marker with no body: it names the statements after it, up to
//! the next stage or the end of the body. It stands only at the top level of
//! the body of a workflow or of a pattern; anywhere else (a block, a branch,
//! a loop, a map's body, a function, an agent's skill, a handler, a test, a
//! constant) it is E1901, at the stage. The stages of one body have names of
//! their own; a body that has stages starts with one; each stage is followed
//! by at least one statement, and the one directly after it is not `on
//! error`; and its title follows the title rules ([`title_problem`]).
//! Otherwise E1902, with the fact `problem` saying which rule.
//!
//! [`stage_checks`] runs in [`crate::check()`] after the shapes of an
//! envelope, on the program as written (its own workflows and patterns, and
//! every place a stage may not stand), and again on what an expansion wrote
//! (a workflow that applies a pattern has the pattern's stages), each
//! diagnostic of the expansion reported at the application. Nothing else of
//! the compiler reads a stage as more than a statement that does nothing:
//! it adds no cost, node, value, scope, role or authority.

use mandate_ir::{
    DefKind, Diagnostic, JsObject, Language, Location, Program, Spans, Stmt, StmtOp, Value,
    nearest_span, ptr_token,
};

/// The most characters (Unicode scalar values) a title holds; the schema of
/// 0.7 holds it too (`maxLength`, which counts code points).
pub(crate) const TITLE_MAX: usize = 80;

/// How a title breaks the title rules (spec/attention.md "Titles").
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum TitleProblem {
    /// No character, or more than [`TITLE_MAX`]: the number it has.
    Length(usize),
    /// A C0 or C1 control (or DEL, Unicode's category Cc).
    Control(char),
    /// A format character (category Cf), every bidirectional control among
    /// them.
    Format(char),
    /// U+2028 LINE SEPARATOR or U+2029 PARAGRAPH SEPARATOR (categories Zl
    /// and Zp), which break a line in some renderers: a title is one line.
    Separator(char),
}

impl TitleProblem {
    /// The fact `rule`.
    pub(crate) fn rule(self) -> &'static str {
        match self {
            TitleProblem::Length(_) => "length",
            TitleProblem::Control(_) => "control",
            TitleProblem::Format(_) => "format",
            TitleProblem::Separator(_) => "separator",
        }
    }

    /// What the message says of the title.
    pub(crate) fn said(self) -> String {
        match self {
            TitleProblem::Length(0) => "is empty".to_owned(),
            TitleProblem::Length(n) => format!("has {n} characters, more than {TITLE_MAX}"),
            TitleProblem::Control(c) => format!("holds the control character {}", code_point(c)),
            TitleProblem::Format(c) => format!(
                "holds the format or bidirectional character {}",
                code_point(c)
            ),
            TitleProblem::Separator(c) => {
                format!("holds the line or paragraph separator {}", code_point(c))
            }
        }
    }

    /// The character the problem names, when it names one: the fact `char`.
    pub(crate) fn char(self) -> Option<char> {
        match self {
            TitleProblem::Length(_) => None,
            TitleProblem::Control(c) | TitleProblem::Format(c) | TitleProblem::Separator(c) => {
                Some(c)
            }
        }
    }

    /// The facts of a title problem beside the others of its diagnostic:
    /// `rule`, and `char` when it names one.
    pub(crate) fn facts(self, facts: JsObject) -> JsObject {
        facts
            .with("rule", self.rule())
            .with_some("char", self.char().map(code_point))
    }
}

/// What every message about a title says of the rules, after what is wrong.
pub(crate) const TITLE_RULES: &str = "a title is constant text of 1 to 80 characters with no control, format, bidirectional, line separator or paragraph separator character, since a person reads it on one line of an approval card";

/// `U+0007`: a character as the facts and the messages name it.
pub(crate) fn code_point(c: char) -> String {
    format!("U+{:04X}", u32::from(c))
}

/// The characters of Unicode's general category Cf (format), as ranges of
/// scalar values (Unicode 16.0, `DerivedGeneralCategory.txt`). The
/// bidirectional controls (U+061C, U+200E, U+200F, U+202A to U+202E, U+2066
/// to U+2069) are among them.
const FORMAT: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

/// Whether `c` is a format character (category Cf).
fn is_format(c: char) -> bool {
    let c = u32::from(c);
    FORMAT.iter().any(|(lo, hi)| (*lo..=*hi).contains(&c))
}

/// Whether `c` breaks a line as a separator: U+2028 LINE SEPARATOR (Zl) or
/// U+2029 PARAGRAPH SEPARATOR (Zp), the only characters of those categories.
fn is_separator(c: char) -> bool {
    matches!(c, '\u{2028}' | '\u{2029}')
}

/// How `title` breaks the title rules, if it does: 1 to [`TITLE_MAX`]
/// characters, counted as Unicode scalar values, and no control, no format
/// character and no line or paragraph separator, the first such character
/// named. A title is constant text: the parser refuses interpolation in it,
/// and in IR it is a string. Stage titles (E1902) and report titles (E1903)
/// are held to the same rules.
pub(crate) fn title_problem(title: &str) -> Option<TitleProblem> {
    let n = title.chars().count();
    if n == 0 || n > TITLE_MAX {
        return Some(TitleProblem::Length(n));
    }
    title.chars().find_map(|c| {
        if c.is_control() {
            Some(TitleProblem::Control(c))
        } else if is_format(c) {
            Some(TitleProblem::Format(c))
        } else if is_separator(c) {
            Some(TitleProblem::Separator(c))
        } else {
            None
        }
    })
}

/// Where the diagnostics go, and with which spans.
struct Out<'s> {
    spans: Option<&'s Spans>,
    found: Vec<Diagnostic>,
}

impl Out<'_> {
    fn report(&mut self, code: &str, message: String, path: &str, facts: JsObject) {
        let span = nearest_span(self.spans, path);
        self.found.push(Diagnostic::new(
            code,
            message,
            Location::path_span(path, span),
            Some(facts),
        ));
    }
}

/// What holds a body whose top level may have stages: a workflow (written
/// out, not one that applies a pattern) or a pattern.
fn holder(kind: Option<DefKind>, def: &Value) -> Option<&'static str> {
    match kind {
        Some(DefKind::Workflow) if def.get("apply").is_none() => Some("workflow"),
        Some(DefKind::Pattern) => Some("pattern"),
        _ => None,
    }
}

/// E1901 and E1902 for `program`, in the order of its definitions and then
/// of its tests: of each definition, the list of its body when it may have
/// stages, then each stage that stands where none may. A program older than
/// 0.7 has no stage (its schema refuses one, and its text reads none), and
/// is given nothing.
#[must_use]
pub fn stage_checks(program: Program<'_>, spans: Option<&Spans>) -> Vec<Diagnostic> {
    if !program
        .language()
        .is_some_and(|l| l.at_least(Language::V0_7))
    {
        return Vec::new();
    }
    let mut out = Out {
        spans,
        found: Vec::new(),
    };
    for (name, d) in program.definitions() {
        let base = format!("/defs/{}", ptr_token(name));
        let value = d.value();
        let kind = d.kind();
        let Some(m) = value.as_object() else { continue };
        match holder(kind, value) {
            Some(what) => {
                let body = value
                    .get("body")
                    .and_then(Value::as_array)
                    .unwrap_or_default();
                list_rules(body, &format!("{base}/body"), what, name, &mut out);
                for (k, x) in m.iter() {
                    let at = format!("{base}/{}", ptr_token(k));
                    if k == "body" {
                        // The top level is the list's; what its statements
                        // hold is nested.
                        for (i, s) in body.iter().enumerate() {
                            let at = format!("{at}/{i}");
                            if !is_stage(s) {
                                misplaced(s, &at, &Place::Nested(what, name), &mut out);
                            }
                        }
                    } else {
                        misplaced(x, &at, &Place::Nested(what, name), &mut out);
                    }
                }
            }
            None => {
                let what = kind.map_or("definition", DefKind::as_str);
                for (k, x) in m.iter() {
                    let at = format!("{base}/{}", ptr_token(k));
                    misplaced(x, &at, &Place::In(what, name), &mut out);
                }
            }
        }
    }
    for (k, x) in program.members().iter() {
        if k == "defs" {
            continue;
        }
        let at = format!("/{}", ptr_token(k));
        if k == "tests" {
            for (t, test) in x.as_object().into_iter().flat_map(mandate_ir::Map::iter) {
                misplaced(
                    test,
                    &format!("{at}/{}", ptr_token(t)),
                    &Place::In("test", t),
                    &mut out,
                );
            }
        } else {
            misplaced(x, &at, &Place::In(k, ""), &mut out);
        }
    }
    out.found
}

fn is_stage(v: &Value) -> bool {
    Stmt::of(v).is_some_and(|s| s.op() == Some(StmtOp::Stage))
}

/// Where a misplaced stage stands: nested in the body of a workflow or a
/// pattern (or in another of its members), or in something that has no
/// stages at all (a definition of another kind, by its kind and name, or a
/// test).
enum Place<'n> {
    Nested(&'static str, &'n str),
    In(&'n str, &'n str),
}

impl Place<'_> {
    /// The fact `place`.
    fn fact(&self) -> &str {
        match self {
            Place::Nested(..) => "nested",
            Place::In(what, _) => what,
        }
    }

    /// Where the message says the stage stands.
    fn said(&self) -> String {
        match self {
            Place::Nested(what, name) => {
                format!(
                    "inside a statement or a member of {what} {name}, not at the top level of its body"
                )
            }
            Place::In("test", name) => format!("in test \"{name}\""),
            Place::In(what, "") => format!("in the program's {what}"),
            Place::In(what, name) => format!("in {what} {name}"),
        }
    }
}

/// E1901 for every stage in `v` (at `path`), which stands at `place`. A
/// stage holds no statement, so the walk does not go into one.
fn misplaced(v: &Value, path: &str, place: &Place<'_>, out: &mut Out<'_>) {
    match v {
        Value::Array(items) => {
            for (i, x) in items.iter().enumerate() {
                misplaced(x, &format!("{path}/{i}"), place, out);
            }
        }
        Value::Object(m) => {
            if is_stage(v) {
                let name = Stmt::of(v).and_then(Stmt::name).unwrap_or_default();
                out.report(
                    "E1901",
                    format!(
                        "Stage '{name}' stands {}; a stage marks only the top level of a workflow's or a pattern's body.",
                        place.said()
                    ),
                    path,
                    JsObject::new()
                        .with("stage", name)
                        .with("place", place.fact()),
                );
                return;
            }
            for (k, x) in m.iter() {
                misplaced(x, &format!("{path}/{}", ptr_token(k)), place, out);
            }
        }
        _ => {}
    }
}

/// E1902 for the list of stages of one body, at `base` (`/defs/W/body`), of
/// the `what` (`workflow` or `pattern`) named `name`: the statement before
/// the first stage, then for each stage in order a name it shares with an
/// earlier one, no statement after it or an `on error` directly after it,
/// and its title.
fn list_rules(body: &[Value], base: &str, what: &str, name: &str, out: &mut Out<'_>) {
    let stmts: Vec<Option<Stmt<'_>>> = body.iter().map(Stmt::of).collect();
    let op_at = |i: usize| stmts.get(i).copied().flatten().and_then(Stmt::op);
    let stages: Vec<(usize, Stmt<'_>)> = stmts
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.filter(|s| s.op() == Some(StmtOp::Stage)).map(|s| (i, s)))
        .collect();
    let Some((first, first_stage)) = stages.first().copied() else {
        return;
    };
    let facts = |problem: &str, stage: &str| {
        JsObject::new()
            .with(what, name)
            .with("stage", stage)
            .with("problem", problem)
    };
    if first > 0 {
        let stage = first_stage.name().unwrap_or_default();
        out.report(
            "E1902",
            format!(
                "The body of {what} {name} has stages and does not start with one: the statements before stage '{stage}' are in no stage. A body with stages starts with one."
            ),
            &format!("{base}/0"),
            facts("before_first", stage),
        );
    }
    let mut seen: Vec<&str> = Vec::new();
    for (i, s) in &stages {
        let stage = s.name().unwrap_or_default();
        let at = format!("{base}/{i}");
        if seen.contains(&stage) {
            out.report(
                "E1902",
                format!(
                    "Stage '{stage}' is named twice in the body of {what} {name}; the stages of one body have names of their own."
                ),
                &format!("{at}/name"),
                facts("duplicate", stage),
            );
        } else {
            seen.push(stage);
        }
        let next = i.saturating_add(1);
        match op_at(next) {
            None if next >= body.len() => out.report(
                "E1902",
                format!(
                    "Stage '{stage}' ends the body of {what} {name} and marks no statement; each stage is followed by at least one."
                ),
                &at,
                facts("empty", stage),
            ),
            Some(StmtOp::Stage) => out.report(
                "E1902",
                format!(
                    "Stage '{stage}' of {what} {name} is directly followed by another stage and marks no statement; each stage is followed by at least one."
                ),
                &at,
                facts("empty", stage),
            ),
            Some(StmtOp::OnError) => out.report(
                "E1902",
                format!(
                    "Stage '{stage}' of {what} {name} is directly followed by an on error, which handles the statement before the stage; a stage stands before the statement whose handler follows it."
                ),
                &at,
                facts("on_error", stage),
            ),
            Some(
                StmtOp::Let
                | StmtOp::Par
                | StmtOp::If
                | StmtOp::Loop
                | StmtOp::Return
                | StmtOp::Run
                | StmtOp::Expr
                | StmtOp::Report,
            )
            | None => {}
        }
        if let Some(p) = title_problem(s.title().unwrap_or_default()) {
            out.report(
                "E1902",
                format!(
                    "The title of stage '{stage}' of {what} {name} {}; {TITLE_RULES}.",
                    p.said()
                ),
                &format!("{at}/title"),
                p.facts(facts("title", stage)),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{TitleProblem, is_format, is_separator, title_problem};

    #[test]
    fn the_title_rules() {
        assert_eq!(title_problem("Collect the items"), None);
        assert_eq!(title_problem(&"x".repeat(80)), None);
        // Counted as scalar values, not bytes or UTF-16 units.
        assert_eq!(title_problem(&"\u{1F600}".repeat(80)), None);
        assert_eq!(title_problem(""), Some(TitleProblem::Length(0)));
        assert_eq!(
            title_problem(&"é".repeat(81)),
            Some(TitleProblem::Length(81))
        );
        for c in [
            '\u{0}', '\u{7}', '\n', '\t', '\u{1F}', '\u{7F}', '\u{85}', '\u{9F}',
        ] {
            assert_eq!(
                title_problem(&format!("a{c}b")),
                Some(TitleProblem::Control(c)),
                "{c:?}"
            );
        }
        for c in [
            '\u{AD}',
            '\u{61C}',
            '\u{200B}',
            '\u{200D}',
            '\u{200E}',
            '\u{200F}',
            '\u{202A}',
            '\u{202E}',
            '\u{2066}',
            '\u{2069}',
            '\u{FEFF}',
            '\u{E0001}',
            '\u{E007F}',
        ] {
            assert!(is_format(c), "{c:?}");
            assert_eq!(
                title_problem(&format!("a{c}b")),
                Some(TitleProblem::Format(c)),
                "{c:?}"
            );
        }
        // The line and the paragraph separator break a line in some
        // renderers: a title is one line.
        for c in ['\u{2028}', '\u{2029}'] {
            assert!(!is_format(c) && !c.is_control(), "{c:?}");
            assert_eq!(
                title_problem(&format!("a{c}b")),
                Some(TitleProblem::Separator(c)),
                "{c:?}"
            );
            assert_eq!(TitleProblem::Separator(c).rule(), "separator");
        }
        // None of them: spaces of other kinds (Zs), letters, marks and
        // symbols.
        for c in [
            '\u{A0}',
            '\u{2007}',
            '\u{202F}',
            '\u{3000}',
            'ß',
            '\u{301}',
            '€',
            '\u{1F600}',
        ] {
            assert!(
                !is_format(c) && !c.is_control() && !is_separator(c),
                "{c:?}"
            );
            assert_eq!(title_problem(&format!("a{c}b")), None, "{c:?}");
        }
        // The first character that breaks a rule is named.
        assert_eq!(
            title_problem("a\u{200B}\u{7}"),
            Some(TitleProblem::Format('\u{200B}'))
        );
    }
}
