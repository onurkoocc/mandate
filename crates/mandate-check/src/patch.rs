//! Structural IR patches (Doc 4 §14 `mandate.apply_patch`, §16.1
//! ApplyPatch): a port of `compiler/src/patch/patch.ts`.
//!
//! A patch names the program hash it was written against. If the program has
//! moved on, the patch is refused with `stale_base` (S12) instead of being
//! merged by position. Patches that widen authority are flagged as governance
//! changes (§13.2) so a human sees them; this step reports them, it does not
//! block them. The semantic diff ([`crate::diff`]) classifies them, so a
//! patch and a view agree.
//!
//! The TypeScript is one file that imports the views; here the views'
//! analyses are in this crate beside it, so the two do not make a cycle.
//!
//! Imitated JavaScript: an array index is `Number(token)`, so `"1e0"`,
//! `" 1 "`, `"0x1"`, `"+1"`, `"-0"` and `""` are indices 1, 1, 1, 1, 0 and 0
//! ([`crate::js_number`]); `"-"` is the end of the array; the unescaping of a
//! reference token is `~1` to `/` first and then `~0` to `~`; `structuredClone`
//! of the program is a copy; and an assignment to a member named
//! `__proto__` of a plain object sets its prototype and adds no member.

use mandate_ir::{
    Diagnostic, JsObject, JsValue, Location, Program, Value, has_errors, hash_program, is_integer,
    validate_ir,
};

use crate::diff::{GovernanceChangeKind, governance_changes};
use crate::js_number::js_to_number;
use crate::modules::{Modules, link};
use crate::resolve::resolve_names;
use crate::view_shared::js_text;

/// One operation of a patch: `PatchOp`, `{ op, path, value? }` where `op` is
/// `add`, `remove` or `replace`. It is read as the TypeScript reads what it
/// is given: an `op` or a `path` that is not there is the text `undefined`.
#[derive(Clone, Debug, PartialEq)]
pub struct PatchOp {
    /// `add`, `remove` or `replace`; any other is refused when it is applied.
    pub op: String,
    /// A JSON Pointer.
    pub path: String,
    /// The value an `add` or a `replace` writes; none is `undefined`.
    pub value: Option<Value>,
}

impl PatchOp {
    /// The operation `v` stands for: its `op` and `path` as text, its `value`
    /// when it has one.
    #[must_use]
    pub fn from_value(v: &Value) -> PatchOp {
        PatchOp {
            op: js_text(v.get("op")),
            path: js_text(v.get("path")),
            value: v.get("value").cloned(),
        }
    }
}

/// A governance change as a patch reports it: `GovernanceChange`. `detail` is
/// the change as the semantic diff shows it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GovernanceChange {
    /// What kind of change it is.
    pub kind: GovernanceChangeKind,
    /// Where it is.
    pub path: String,
    /// The change as the diff shows it.
    pub detail: String,
}

impl GovernanceChange {
    /// `{ kind, path, detail }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("kind", self.kind.as_str())
            .with("path", self.path.as_str())
            .with("detail", self.detail.as_str())
            .into()
    }
}

/// What [`apply_patch`] gives: `PatchResult`.
#[derive(Clone, Debug, PartialEq)]
pub struct PatchResult {
    /// No diagnostic is an error.
    pub ok: bool,
    /// The patched program, when `ok`.
    pub program: Option<Value>,
    /// Its program hash, when `ok`.
    pub hash: Option<String>,
    /// Every diagnostic, in the order the stages gave them.
    pub diagnostics: Vec<Diagnostic>,
    /// The governance changes the patch makes; none unless `ok`.
    pub governance: Vec<GovernanceChange>,
}

/// What [`apply_ops`] gives: `{ program?, diagnostics }`.
#[derive(Clone, Debug, PartialEq)]
pub struct OpsResult {
    /// The patched program, when the operations were written against its
    /// hash, all applied, and what they make is valid IR.
    pub program: Option<Value>,
    /// What refused the patch, or the warnings of the program it makes.
    pub diagnostics: Vec<Diagnostic>,
}

/// `program` with `ops` applied, when they were written against its hash,
/// and the program they make passes the checks of the names (`resolveNames`,
/// over `modules`, linked in as `check` links them), with the governance
/// changes of the patch. `applyPatch(program, base, ops, modules)`.
#[must_use]
pub fn apply_patch(
    program: &Value,
    base: &str,
    ops: &[PatchOp],
    modules: Option<&Modules>,
) -> PatchResult {
    let patched = apply_ops(program, base, ops);
    let mut diagnostics = patched.diagnostics;
    if let Some(next) = &patched.program
        && let Some(view) = Program::of(next)
    {
        let linked = link(view, modules);
        diagnostics.extend(linked.diagnostics.iter().cloned());
        diagnostics.extend(resolve_names(view, None, Some(&linked.defs)));
    }
    let Some(next) = patched.program.filter(|_| !has_errors(&diagnostics)) else {
        return PatchResult {
            ok: false,
            program: None,
            hash: None,
            diagnostics,
            governance: Vec::new(),
        };
    };
    let governance = governance_changes(program, &next, modules)
        .into_iter()
        .map(|c| GovernanceChange {
            kind: c.kind,
            path: c.path,
            detail: c.text,
        })
        .collect();
    let hash = hash_program(&next).program;
    PatchResult {
        ok: true,
        program: Some(next),
        hash: Some(hash),
        diagnostics,
        governance,
    }
}

/// `parsePointer(path)`: the reference tokens of a JSON Pointer, unescaped
/// (`~1` to `/`, then `~0` to `~`).
fn parse_pointer(path: &str) -> Result<Vec<String>, String> {
    if path.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = path.strip_prefix('/') else {
        return Err("path must be a JSON Pointer starting with '/'".to_owned());
    };
    Ok(rest
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect())
}

/// `child(node, token)`: the member or element a token names.
fn child<'v>(node: &'v mut Value, token: &str) -> Result<&'v mut Value, String> {
    match node {
        Value::Array(items) => {
            // `node[Number(token)]`: an index only if it is an integer within the array.
            let n = js_to_number(token);
            let found = if is_integer(n) && n >= 0.0 && n < items.len() as f64 {
                items.get_mut(n as usize)
            } else {
                None
            };
            found.ok_or_else(|| format!("index '{token}' out of range"))
        }
        Value::Object(map) => map
            .get_mut(token)
            .ok_or_else(|| format!("no member '{token}'")),
        _ => Err(format!("no member '{token}'")),
    }
}

/// `applyOp(root, op)`: one operation, applied in place. An error is the
/// message of the `Error` the TypeScript throws.
fn apply_op(root: &mut Value, op: &PatchOp) -> Result<(), String> {
    if !matches!(op.op.as_str(), "add" | "remove" | "replace") {
        return Err(format!("unsupported op '{}'", op.op));
    }
    let tokens = parse_pointer(&op.path)?;
    // `op.value`, which may be `undefined`; where it is written into a list or an
    // object it is `null` here (JSON.stringify writes it so in a list).
    let value = || op.value.clone().unwrap_or(Value::Null);
    let Some((last, init)) = tokens.split_last() else {
        if op.op == "remove" {
            return Err("cannot remove the root".to_owned());
        }
        *root = value();
        return Ok(());
    };
    let mut parent: &mut Value = root;
    for t in init {
        parent = child(parent, t)?;
    }
    match parent {
        Value::Array(items) => {
            let length = items.len() as f64;
            let idx = if last == "-" {
                length
            } else {
                js_to_number(last)
            };
            if !is_integer(idx) || idx < 0.0 || idx > length || (op.op != "add" && idx >= length) {
                return Err(format!("index '{last}' out of range"));
            }
            let at = idx as usize;
            match op.op.as_str() {
                "add" => items.insert(at, value()),
                "remove" => {
                    items.remove(at);
                }
                _ => {
                    if let Some(slot) = items.get_mut(at) {
                        *slot = value();
                    }
                }
            }
            Ok(())
        }
        Value::Object(map) => {
            if op.op != "add" && !map.contains_key(last) {
                return Err(format!("no member '{last}'"));
            }
            if op.op == "remove" {
                map.remove(last);
            } else if last != "__proto__" || map.contains_key(last) {
                // `parent[last] = value`: a member that is there keeps its place, a new one comes last.
                map.insert(last.clone(), value());
            }
            // Else `parent["__proto__"] = value` on a plain object sets the prototype and adds no member.
            Ok(())
        }
        _ => Err(format!("'{last}' has no parent object")),
    }
}

/// `program` with `ops` applied, when they were written against its hash and
/// what they make is valid IR. Names are not resolved: the caller says what
/// the patched program sees. A lead's sub-program is made this way from its
/// skeleton (`checkSubprogram`). `applyOps(program, base, ops)`.
///
/// Refused with E0130 when `base` is not the program's hash, and with E0131
/// at the first operation that cannot be applied.
#[must_use]
pub fn apply_ops(program: &Value, base: &str, ops: &[PatchOp]) -> OpsResult {
    let current = hash_program(program).program;
    if current != base {
        return OpsResult {
            program: None,
            diagnostics: vec![Diagnostic::new(
                "E0130",
                "stale_base: the patch was written against an older version of the program.",
                Location::path(""),
                Some(
                    JsObject::new()
                        .with("base", base)
                        .with("current", current.as_str()),
                ),
            )],
        };
    }
    let mut root = program.clone();
    for (i, op) in ops.iter().enumerate() {
        if let Err(why) = apply_op(&mut root, op) {
            return OpsResult {
                program: None,
                diagnostics: vec![Diagnostic::new(
                    "E0131",
                    format!("Patch operation {i} ({} {}) failed: {why}", op.op, op.path),
                    Location::path(op.path.as_str()),
                    Some(JsObject::new().with("index", i)),
                )],
            };
        }
    }
    let diagnostics = validate_ir(&root, None);
    if has_errors(&diagnostics) {
        OpsResult {
            program: None,
            diagnostics,
        }
    } else {
        OpsResult {
            program: Some(root),
            diagnostics,
        }
    }
}
