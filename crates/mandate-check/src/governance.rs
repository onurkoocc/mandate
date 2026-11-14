//! Governance-class files (K70, item 46): a port of
//! `compiler/src/std/governance.ts`.
//!
//! In a target repository, some files change what the next run, or the next
//! person, is allowed to do: CI workflows decide which checks gate a change,
//! lockfiles decide which code is fetched, agent settings decide what an
//! agent may run, the Mandate lock pins models and modules, and CODEOWNERS
//! decides who approves. An agent that changes one of them can weaken the
//! gate it is being judged by (the target repository's G06). So an action
//! that lands or proposes such a file needs the code owner's approval,
//! whatever else authorizes it.
//!
//! The defaults below are the language's: every implementation uses them and
//! a program cannot remove one. A component of the system model may add its
//! own patterns (`governance "deploy/**"`); a change to them is a system
//! model change, itself a governance change.
//!
//! `globRegExp` builds a JavaScript regular expression; there is no regular
//! expression engine here, so [`GlobRegExp`] matches exactly the language
//! the expressions it can build have, by UTF-16 code unit as a `RegExp`
//! without the `u` flag does.

use mandate_ir::{JsObject, compare_utf16};

/// The kinds of governance-class file: `GovernanceKind`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum GovernanceKind {
    /// `ci`: CI workflows.
    Ci,
    /// `lockfile`: package lockfiles.
    Lockfile,
    /// `agent_settings`: what an agent may run.
    AgentSettings,
    /// `mandate`: the Mandate lock and runtime settings.
    Mandate,
    /// `code_owners`: CODEOWNERS.
    CodeOwners,
    /// `component`: a component's own patterns.
    Component,
}

impl GovernanceKind {
    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            GovernanceKind::Ci => "ci",
            GovernanceKind::Lockfile => "lockfile",
            GovernanceKind::AgentSettings => "agent_settings",
            GovernanceKind::Mandate => "mandate",
            GovernanceKind::CodeOwners => "code_owners",
            GovernanceKind::Component => "component",
        }
    }
}

impl std::fmt::Display for GovernanceKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// The kinds of governance-class file, in the order views list them:
/// `GOVERNANCE_KINDS`.
pub const GOVERNANCE_KINDS: [GovernanceKind; 6] = [
    GovernanceKind::Ci,
    GovernanceKind::Lockfile,
    GovernanceKind::AgentSettings,
    GovernanceKind::Mandate,
    GovernanceKind::CodeOwners,
    GovernanceKind::Component,
];

/// The default patterns, by kind, in order (every kind but `component`):
/// `GOVERNANCE_FILES`. `**` is any number of segments, `*` part of one.
pub const GOVERNANCE_FILES: [(GovernanceKind, &[&str]); 5] = [
    (
        GovernanceKind::Ci,
        &[
            ".github/workflows/**",
            ".github/actions/**",
            ".gitlab-ci.yml",
            ".gitlab/**",
            ".circleci/**",
            "**/Jenkinsfile",
            "azure-pipelines.yml",
            ".azure-pipelines/**",
            ".buildkite/**",
            ".travis.yml",
            "bitbucket-pipelines.yml",
            ".drone.yml",
        ],
    ),
    (
        GovernanceKind::Lockfile,
        &[
            "**/package-lock.json",
            "**/npm-shrinkwrap.json",
            "**/yarn.lock",
            "**/pnpm-lock.yaml",
            "**/bun.lock",
            "**/bun.lockb",
            "**/poetry.lock",
            "**/uv.lock",
            "**/Pipfile.lock",
            "**/pdm.lock",
            "**/Cargo.lock",
            "**/go.sum",
            "**/Gemfile.lock",
            "**/composer.lock",
            "**/gradle.lockfile",
            "**/packages.lock.json",
            "**/flake.lock",
        ],
    ),
    (
        GovernanceKind::AgentSettings,
        &[
            ".claude/**",
            "**/CLAUDE.md",
            "**/CLAUDE.local.md",
            "**/AGENTS.md",
            ".mcp.json",
            ".cursor/**",
            ".cursorrules",
            ".codex/**",
            ".gemini/**",
            "**/GEMINI.md",
            ".github/copilot-instructions.md",
            ".github/instructions/**",
            ".windsurfrules",
        ],
    ),
    (
        GovernanceKind::Mandate,
        &["**/mandate.lock.json", "**/mandate.runtime.json"],
    ),
    (
        GovernanceKind::CodeOwners,
        &["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"],
    ),
];

/// Why `glob` is not a pattern relative to a repository's root, or `None`
/// when it is one: `patternProblem`.
///
/// ```js
/// if (glob === "") return "it is empty";
/// if (/[\\:\0]/.test(glob)) return "it contains `\\`, `:` or NUL";
/// if (glob.startsWith("/")) return "it is absolute";
/// if (glob.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return "it has an empty, `.` or `..` segment";
/// return undefined;
/// ```
#[must_use]
pub fn pattern_problem(glob: &str) -> Option<&'static str> {
    if glob.is_empty() {
        return Some("it is empty");
    }
    if glob.contains(['\\', ':', '\0']) {
        return Some("it contains `\\`, `:` or NUL");
    }
    if glob.starts_with('/') {
        return Some("it is absolute");
    }
    if glob
        .split('/')
        .any(|seg| seg.is_empty() || seg == "." || seg == "..")
    {
        return Some("it has an empty, `.` or `..` segment");
    }
    None
}

/// One element of an expression [`glob_reg_exp`] builds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum Token {
    /// A UTF-16 code unit that stands for itself, escaped (`\.`) when it is
    /// one of `.+^${}()|[]\`.
    Unit(u16),
    /// `[^/]`, from `?`: one code unit that is not `/`.
    NotSlash,
    /// `[^/]*`, from `*`: any code units that are not `/`.
    NotSlashes,
    /// `.*`, from `**` not followed by `/`: any code units that are not a
    /// line terminator (`\n`, `\r`, U+2028, U+2029), `/` included.
    Any,
    /// `(?:[^/]+/)*`, from `**/`: any number of non-empty segments, each
    /// with its `/`.
    Segments,
}

const SLASH: u16 = 0x2f;

/// Whether `.` without the `s` flag matches `c`: it is no line terminator.
fn dot_matches(c: u16) -> bool {
    !matches!(c, 0x0a | 0x0d | 0x2028 | 0x2029)
}

/// The regular expression `globRegExp(glob)` builds, as a matcher. A glob
/// over `/`-separated paths: `**` any number of segments, `*` within a
/// segment, `?` one character (one UTF-16 code unit).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct GlobRegExp {
    tokens: Vec<Token>,
}

/// `globRegExp(glob)`:
///
/// ```js
/// let re = "";
/// for (let i = 0; i < glob.length; i++) {
///   const c = glob[i]!;
///   if (c === "*" && glob[i + 1] === "*") {
///     const slash = glob[i + 2] === "/";
///     re += slash ? "(?:[^/]+/)*" : ".*";
///     i += slash ? 2 : 1;
///   } else if (c === "*") re += "[^/]*";
///   else if (c === "?") re += "[^/]";
///   else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
/// }
/// return new RegExp(`^${re}$`);
/// ```
///
/// Every character it does not translate is escaped or stands for itself,
/// so the expression is always valid, and it has only the five elements of
/// [`Token`]; `^` and `$` (without the `m` flag) anchor it at both ends of
/// the text.
#[must_use]
pub fn glob_reg_exp(glob: &str) -> GlobRegExp {
    const STAR: u16 = 0x2a;
    const QUESTION: u16 = 0x3f;
    let units: Vec<u16> = glob.encode_utf16().collect();
    let mut tokens = Vec::new();
    let mut i: usize = 0;
    while let Some(&c) = units.get(i) {
        let next = |k: usize| i.checked_add(k).and_then(|j| units.get(j)).copied();
        if c == STAR && next(1) == Some(STAR) {
            if next(2) == Some(SLASH) {
                tokens.push(Token::Segments);
                i = i.saturating_add(3);
            } else {
                tokens.push(Token::Any);
                i = i.saturating_add(2);
            }
            continue;
        }
        tokens.push(match c {
            STAR => Token::NotSlashes,
            QUESTION => Token::NotSlash,
            _ => Token::Unit(c),
        });
        i = i.saturating_add(1);
    }
    GlobRegExp { tokens }
}

impl GlobRegExp {
    /// `re.test(text)`: whether the whole of `text` matches.
    ///
    /// It follows every way of matching at once: `reach[j]` is whether the
    /// elements so far can match the first `j` code units, so it takes time
    /// proportional to the length of the text times the number of elements,
    /// never more (a backtracking engine can take exponential time on a glob
    /// such as `*a*a*a*b`).
    #[must_use]
    pub fn test(&self, text: &str) -> bool {
        let units: Vec<u16> = text.encode_utf16().collect();
        let mut reach = vec![false; units.len().saturating_add(1)];
        if let Some(first) = reach.first_mut() {
            *first = true;
        }
        for token in &self.tokens {
            reach = step(*token, &units, &reach);
            if !reach.contains(&true) {
                return false;
            }
        }
        reach.last().copied().unwrap_or(false)
    }

    /// The expression's `source`, as Node gives it for the `RegExp` the
    /// TypeScript builds: the pattern with a `/` outside a character class
    /// written `\/` and a line terminator written as its escape (`\n`, `\r`,
    /// ` `, ` `), as V8's `EscapeRegExpSource` does. A lone
    /// surrogate cannot be in a Rust string, so none is in the source.
    #[must_use]
    pub fn source(&self) -> String {
        let mut units: Vec<u16> = Vec::new();
        units.push(u16::from(b'^'));
        for token in &self.tokens {
            let text: &str = match token {
                Token::Unit(c) => {
                    let c = *c;
                    if ".+^${}()|[]\\".encode_utf16().any(|s| s == c) {
                        units.push(u16::from(b'\\'));
                        units.push(c);
                    } else {
                        match c {
                            SLASH => units.extend("\\/".encode_utf16()),
                            0x0a => units.extend("\\n".encode_utf16()),
                            0x0d => units.extend("\\r".encode_utf16()),
                            0x2028 => units.extend("\\u2028".encode_utf16()),
                            0x2029 => units.extend("\\u2029".encode_utf16()),
                            c => units.push(c),
                        }
                    }
                    continue;
                }
                Token::NotSlash => "[^/]",
                Token::NotSlashes => "[^/]*",
                Token::Any => ".*",
                Token::Segments => "(?:[^/]+\\/)*",
            };
            units.extend(text.encode_utf16());
        }
        units.push(u16::from(b'$'));
        String::from_utf16_lossy(&units)
    }
}

/// The positions the text can be matched to after `token`, from those it
/// could be matched to before (`before[j]`: the first `j` code units).
fn step(token: Token, units: &[u16], before: &[bool]) -> Vec<bool> {
    let mut after = vec![false; before.len()];
    match token {
        Token::Unit(_) | Token::NotSlash => {
            for (j, (&c, &from)) in units.iter().zip(before).enumerate() {
                let ok = match token {
                    Token::Unit(u) => c == u,
                    _ => c != SLASH,
                };
                if from
                    && ok
                    && let Some(a) = after.get_mut(j.saturating_add(1))
                {
                    *a = true;
                }
            }
        }
        Token::NotSlashes | Token::Any => {
            // Any number of matching units: reachable before, or one unit
            // past a reachable position.
            let mut prev = false;
            for (j, a) in after.iter_mut().enumerate() {
                let here = before.get(j).copied().unwrap_or(false);
                let carried = prev
                    && j.checked_sub(1)
                        .and_then(|k| units.get(k))
                        .is_some_and(|&c| match token {
                            Token::Any => dot_matches(c),
                            _ => c != SLASH,
                        });
                *a = here || carried;
                prev = *a;
            }
        }
        Token::Segments => {
            // Zero or more `[^/]+/`: from a reachable position, one or more
            // units that are not `/`, then a `/`.
            after = before.to_vec();
            let mut inside = false;
            for (j, &c) in units.iter().enumerate() {
                let here = after.get(j).copied().unwrap_or(false);
                if c == SLASH {
                    if inside && let Some(a) = after.get_mut(j.saturating_add(1)) {
                        *a = true;
                    }
                    inside = false;
                } else {
                    inside = inside || here;
                }
            }
        }
    }
    after
}

/// The defaults, by kind, as matchers: `DEFAULTS`.
fn defaults() -> impl Iterator<Item = (GovernanceKind, GlobRegExp)> {
    GOVERNANCE_FILES
        .iter()
        .flat_map(|(kind, globs)| globs.iter().map(|g| (*kind, glob_reg_exp(g))))
}

/// The kind of governance-class file `file` is (a path relative to its
/// repository), or `None`: `governanceKind`. `extra`: a component's own
/// patterns, which give `component`; a default pattern comes first.
#[must_use]
pub fn governance_kind<S: AsRef<str>>(file: &str, extra: &[S]) -> Option<GovernanceKind> {
    for (kind, re) in defaults() {
        if re.test(file) {
            return Some(kind);
        }
    }
    extra
        .iter()
        .any(|g| glob_reg_exp(g.as_ref()).test(file))
        .then_some(GovernanceKind::Component)
}

/// One governance-class file and its kind: an element of what
/// `governanceFiles` gives.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct GovernanceFile {
    /// The file, as given.
    pub file: String,
    /// Its kind.
    pub kind: GovernanceKind,
}

impl GovernanceFile {
    /// The object the TypeScript gives: `{ file, kind }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with("file", self.file.as_str())
            .with("kind", self.kind.as_str())
    }
}

/// The governance-class files among `files`, sorted (`[...files].sort()`,
/// by UTF-16 code units; a file given twice is listed twice), each with its
/// kind: `governanceFiles`.
#[must_use]
pub fn governance_files<F: AsRef<str>, S: AsRef<str>>(
    files: impl IntoIterator<Item = F>,
    extra: &[S],
) -> Vec<GovernanceFile> {
    let mut sorted: Vec<F> = files.into_iter().collect();
    sorted.sort_by(|a, b| compare_utf16(a.as_ref(), b.as_ref()));
    sorted
        .iter()
        .filter_map(|file| {
            governance_kind(file.as_ref(), extra).map(|kind| GovernanceFile {
                file: file.as_ref().to_owned(),
                kind,
            })
        })
        .collect()
}
