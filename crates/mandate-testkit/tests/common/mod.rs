//! What the gates that run `mandate_check::check` share: reading a source
//! as Node's `readFileSync(file, "utf8")` reads it, loading modules as
//! `--module` loads them, and checking with them and a lock.

#![allow(dead_code, clippy::expect_used, clippy::panic, missing_docs)]

use mandate_check::library::LibrarySource;
use mandate_check::{
    AmendmentInput, CapVal, CheckOptions, CheckResult, DataClass, ModuleSource, Modules, PatchOp,
    Room, SubprogramInput, apply_ops, cap_ctor, check, check_amendment, check_subprogram,
    language_of, load_modules, skeleton,
};
use mandate_ir::{Diagnostic, JsObject, JsValue, Spans, Value, hash_program, stringify_pretty};
use mandate_syntax::{SourceKind, kind_of};
use mandate_testkit::{library_files, read_bytes, read_json};

/// The text of the repository file `rel`, decoded as
/// `readFileSync(file, "utf8")` decodes it: each ill-formed sequence is
/// U+FFFD.
pub fn read_source(rel: &str) -> Result<String, String> {
    Ok(String::from_utf8_lossy(&read_bytes(rel)?).into_owned())
}

/// `mdt` or `json`.
pub fn kind_named(kind: &str) -> SourceKind {
    if kind == "json" {
        SourceKind::Json
    } else {
        SourceKind::Mdt
    }
}

/// The modules in the repository files `files`, loaded together with
/// `load_modules` (each against the others), named by `names` in messages.
/// They must load, as the TypeScript's test helpers require.
pub fn modules_of(files: &[String], names: &[String]) -> Result<Modules, String> {
    let mut texts = Vec::new();
    for f in files {
        texts.push(read_source(f)?);
    }
    let sources: Vec<ModuleSource<'_>> = files
        .iter()
        .zip(&texts)
        .zip(names)
        .map(|((f, text), name)| ModuleSource {
            text,
            kind: kind_of(f),
            file: name,
        })
        .collect();
    let loaded = load_modules(&sources);
    if let Some(p) = loaded.problems.first() {
        let codes: Vec<String> = p
            .diagnostics
            .iter()
            .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
            .collect();
        return Err(format!(
            "module {} does not load: {}",
            p.file,
            codes.join(", ")
        ));
    }
    Ok(loaded.modules)
}

/// `check(text, kind, { modules, lock })`, with the modules and the lock
/// read from these repository files.
pub fn check_with(
    text: &str,
    kind: SourceKind,
    modules: Option<&Modules>,
    lock: Option<&str>,
) -> Result<CheckResult, String> {
    check_with_libraries(text, kind, modules, lock, &[], None)
}

/// The one place of the Rust gates that says what a program of 0.6
/// relabelled `mandate @ 0.7` is given besides what it was given as 0.6
/// (slice RL6, spec/attention.md "Which version"): without a pin, a
/// program of 0.7 reads `std.patterns` 2.0.0, with its stages and reports,
/// where the same program of 0.6 read 1.0.0; the faithful translation of
/// a program of 0.6 that imports `std.patterns` pins 1.0.0. Its check (and
/// a sub-program's or an amendment's check of it as a parent) is given the
/// module of 1.0.0 as `std.patterns`, which stands for a pin of 1.0.0 when
/// its lock has none and is the module its lock pins when it has one (a lock
/// of 0.6 that the program checks with pins 1.0.0, or the check is E1605 as
/// it was). So is one whose check reads the built-in for a library it is
/// handed (in the repository directories `libraries`) that requires it.
/// `None` for a text that does not load and for one whose check reads no
/// version of it: it is given nothing more.
///
/// What it does not touch: the views, which are given the modules they were
/// given (a view adds the built-in itself, and is compared as it is: a gate
/// finds a view that shows the two versions apart), and nothing else of
/// the program or its lock.
pub fn relabelled_modules(text: &str, kind: SourceKind, libraries: &[String]) -> Option<Modules> {
    let program = mandate_syntax::load(text, kind).program?;
    let imports = program
        .get("uses")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .any(|u| u.get("module").and_then(Value::as_str) == Some("std.patterns"));
    let required = libraries_of(libraries)
        .unwrap_or_default()
        .iter()
        .filter_map(|l| mandate_check::library::load_library(l, false, "a library").ok())
        .any(|l| l.manifest.requires().contains_key("std.patterns"));
    if !imports && !required {
        return None;
    }
    let one = mandate_check::library::STD_PATTERNS_EMBEDDED
        .first()
        .and_then(mandate_check::library::Embedded::load)?;
    Some(one.modules)
}

/// `modules` with `more` added, each by its name.
pub fn with_more(modules: Option<&Modules>, more: Option<&Modules>) -> Option<Modules> {
    let more = more?;
    let mut all = modules.cloned().unwrap_or_default();
    for (m, ir) in more.iter() {
        all.insert(m, ir.clone());
    }
    Some(all)
}

/// The libraries in the repository directories `dirs`, as a caller hands
/// them to the compiler.
pub fn libraries_of(dirs: &[String]) -> Result<Vec<LibrarySource>, String> {
    dirs.iter()
        .map(|d| library_files(d).map(|(manifest, files)| LibrarySource { manifest, files }))
        .collect()
}

/// [`check_with`], with the libraries in the repository directories
/// `libraries` (language 0.6) and the digests a configuration revokes.
pub fn check_with_libraries(
    text: &str,
    kind: SourceKind,
    modules: Option<&Modules>,
    lock: Option<&str>,
    libraries: &[String],
    revoked: Option<&std::collections::BTreeSet<mandate_check::library::Digest>>,
) -> Result<CheckResult, String> {
    let lock: Option<Value> = lock.map(read_json).transpose()?;
    let libraries = libraries_of(libraries)?;
    Ok(check(
        text,
        kind,
        &CheckOptions {
            lock: lock.as_ref(),
            modules,
            claim: None,
            libraries: (!libraries.is_empty()).then_some(libraries.as_slice()),
            revoked,
            ..CheckOptions::default()
        },
    ))
}

/// The text the golden test hashes for a check: `JSON.stringify({ ok,
/// hashes?, diagnostics }, null, 2) + "\n"`.
pub fn check_text(r: &CheckResult) -> String {
    let mut text = stringify_pretty(&r.to_js()).unwrap_or_default();
    text.push('\n');
    text
}

/// A stored value as that text: `JSON.stringify(value, null, 2) + "\n"`.
pub fn value_text(v: &Value) -> String {
    let mut text = stringify_pretty(&JsValue::from(v)).unwrap_or_default();
    text.push('\n');
    text
}

/// The reference tokens of a JSON Pointer, unescaped: `tokens` in
/// `compiler/test/cases-runner.ts`.
fn pointer_tokens(pointer: &str) -> Result<Vec<String>, String> {
    if pointer.is_empty() {
        return Ok(Vec::new());
    }
    let Some(rest) = pointer.strip_prefix('/') else {
        return Err(format!("\"{pointer}\" is not a JSON Pointer"));
    };
    Ok(rest
        .split('/')
        .map(|t| t.replace("~1", "/").replace("~0", "~"))
        .collect())
}

/// An array index of the runner: `index(token, length, allowEnd)`. `-` is
/// the end when `allow_end`; otherwise `/^(0|[1-9][0-9]*)$/`, within the
/// array (or at its end when `allow_end`).
fn pointer_index(token: &str, length: usize, allow_end: bool) -> Result<usize, String> {
    if allow_end && token == "-" {
        return Ok(length);
    }
    let digits = !token.is_empty()
        && token.bytes().all(|b| b.is_ascii_digit())
        && (token == "0" || !token.starts_with('0'));
    if !digits {
        return Err(format!("\"{token}\" is not an array index"));
    }
    // `Number(token)`: a run of digits too long for usize is past any end.
    let i = token.parse::<usize>().unwrap_or(usize::MAX);
    if i > length || (i == length && !allow_end) {
        return Err(format!("index {token} is out of range"));
    }
    Ok(i)
}

/// `child(parent, token)` of the runner.
fn pointer_child<'v>(parent: &'v mut Value, token: &str) -> Result<&'v mut Value, String> {
    match parent {
        Value::Array(items) => {
            let i = pointer_index(token, items.len(), false)?;
            items
                .get_mut(i)
                .ok_or_else(|| format!("index {token} is out of range"))
        }
        Value::Object(map) => map
            .get_mut(token)
            .ok_or_else(|| format!("there is no member \"{token}\"")),
        _ => Err(format!("there is no member \"{token}\"")),
    }
}

/// One operation of [`apply_json_patch`].
fn apply_op(root: &mut Value, kind: &str, path: &str, value: Option<&Value>) -> Result<(), String> {
    let value = || value.cloned().unwrap_or(Value::Null);
    let tokens = pointer_tokens(path)?;
    let Some((last, init)) = tokens.split_last() else {
        if kind == "remove" {
            return Err("the document root cannot be removed".to_owned());
        }
        *root = value();
        return Ok(());
    };
    let mut parent = root;
    for t in init {
        parent = pointer_child(parent, t)?;
    }
    match parent {
        Value::Array(items) => {
            let i = pointer_index(last, items.len(), kind == "add")?;
            match kind {
                "add" => items.insert(i, value()),
                "replace" => {
                    if let Some(slot) = items.get_mut(i) {
                        *slot = value();
                    }
                }
                _ => {
                    items.remove(i);
                }
            }
        }
        Value::Object(map) => {
            if kind != "add" && !map.contains_key(last) {
                return Err(format!("there is no member \"{last}\""));
            }
            if kind == "remove" {
                map.remove(last);
            } else {
                map.insert(last.clone(), value());
            }
        }
        _ => return Err("the parent is not an object or an array".to_owned()),
    }
    Ok(())
}

/// `applyJsonPatch(doc, ops)` of `compiler/test/cases-runner.ts`: RFC 6902
/// `add`, `replace` and `remove`, applied in order to a copy of `doc`; any
/// other op is refused, and so is an operation whose path does not exist.
/// An object member set by `add` or `replace` is assigned, so a member that
/// is there keeps its place and a new one comes last (in ECMAScript order).
/// (The runner's objects come from `JSON.parse`, plain objects, where an
/// assignment to `__proto__` would set the prototype; no case writes one.)
pub fn apply_json_patch(doc: &Value, ops: &[Value]) -> Result<Value, String> {
    let mut root = doc.clone();
    for (n, op) in ops.iter().enumerate() {
        let kind = op.get("op").and_then(Value::as_str).unwrap_or("undefined");
        let path = op.get("path").and_then(Value::as_str).unwrap_or("");
        let at = format!("patch operation {n} ({kind} {path})");
        if !matches!(kind, "add" | "replace" | "remove") {
            return Err(format!(
                "{at}: op \"{kind}\" is not supported; use add, replace or remove"
            ));
        }
        apply_op(&mut root, kind, path, op.get("value")).map_err(|e| format!("{at}: {e}"))?;
    }
    Ok(root)
}

/// The text a `check_patched` case is checked as (`runCompileCase`): its
/// input loaded, which must load without errors, the case's patch applied
/// to the IR, and the patched IR written as `JSON.stringify(program)`
/// writes it, compact.
pub fn patched_source(text: &str, kind: SourceKind, patch: &[Value]) -> Result<String, String> {
    let before = mandate_syntax::load(text, kind);
    let program = match before.program {
        Some(p) if !mandate_ir::has_errors(&before.diagnostics) => p,
        _ => {
            let codes: Vec<String> = before
                .diagnostics
                .iter()
                .map(|d| format!("{} at {}", d.code, d.at.path.as_deref().unwrap_or("")))
                .collect();
            return Err(format!(
                "the input of a patch case must load before the patch: {}",
                codes.join(", ")
            ));
        }
    };
    let patched = apply_json_patch(&program, patch)?;
    mandate_ir::stringify(&JsValue::from(&patched)).ok_or_else(|| "no JSON text".to_owned())
}

/// What the door `apply_ops` of a conformance case gives before the patched
/// program is checked (`runCompileCase`): the text to check, or the result
/// that is the case's when `applyOps` refuses the patch.
pub enum Applied {
    /// The patched IR as `JSON.stringify(applied.program)` writes it, to be
    /// checked as JSON.
    Source(String),
    /// `{ ok: false, diagnostics }`: the stale base (E0130) or the operation
    /// that failed (E0131), or what the patched program is refused for.
    Refused(Box<CheckResult>),
}

/// The door `apply_ops` of `runCompileCase`: the input loaded, which must
/// load without errors, and `applyOps(program, base, patch)` called.
pub fn applied_source(
    text: &str,
    kind: SourceKind,
    base: &str,
    patch: &[Value],
) -> Result<Applied, String> {
    let before = mandate_syntax::load(text, kind);
    let program = match before.program {
        Some(p) if !mandate_ir::has_errors(&before.diagnostics) => p,
        _ => {
            return Err("the input of a patch case must load before the patch".to_owned());
        }
    };
    let ops: Vec<PatchOp> = patch.iter().map(PatchOp::from_value).collect();
    let applied = apply_ops(&program, base, &ops);
    match applied.program {
        Some(p) => mandate_ir::stringify(&JsValue::from(&p))
            .map(Applied::Source)
            .ok_or_else(|| "no JSON text".to_owned()),
        None => Ok(Applied::Refused(Box::new(CheckResult {
            program: None,
            spans: Spans::new(),
            diagnostics: applied.diagnostics,
            ok: false,
            hashes: None,
            expanded: None,
            linked: None,
        }))),
    }
}

/// The envelope `amendmentInput(a, parent, modules).envelope` of
/// `compiler/test/cases-runner.ts` gives: the envelope of the workflow
/// `workflow` of `parent`, with the RFC 6902 `patch` applied by
/// [`apply_json_patch`]. The workflow must be a workflow with an envelope.
pub fn amendment_envelope(
    workflow: &str,
    patch: &[Value],
    parent: &Value,
) -> Result<Value, String> {
    let envelope = parent
        .get("defs")
        .and_then(|defs| defs.get(workflow))
        .filter(|wf| wf.get("kind").and_then(Value::as_str) == Some("workflow"))
        .and_then(|wf| wf.get("envelope"))
        .filter(|e| !matches!(e, Value::Null | Value::Bool(false)));
    let Some(envelope) = envelope else {
        return Err(format!(
            "amendment.workflow: {workflow} is not a workflow with an envelope"
        ));
    };
    apply_json_patch(envelope, patch)
}

/// The program the diff vectors compare an amendment with: `{ ...parent,
/// defs: { ...parent.defs, [workflow]: { ...parent.defs[workflow], envelope } } }`,
/// each member that is there keeping its place.
pub fn amended_program(parent: &Value, workflow: &str, envelope: Value) -> Result<Value, String> {
    let mut program = parent
        .as_object()
        .ok_or("the parent is not an object")?
        .clone();
    let mut defs = parent
        .get("defs")
        .and_then(Value::as_object)
        .ok_or("the parent has no defs")?
        .clone();
    let mut wf = defs
        .get(workflow)
        .and_then(Value::as_object)
        .ok_or("the workflow is not defined")?
        .clone();
    wf.insert("envelope", envelope);
    defs.insert(workflow, Value::Object(wf));
    program.insert("defs", Value::Object(defs));
    Ok(Value::Object(program))
}

/// What a case observes of a door: `ok`, the diagnostics, and the `hashes`
/// it compares (`Observed` in `compiler/test/cases-runner.ts`).
pub struct Observed {
    pub ok: bool,
    pub diagnostics: Vec<Diagnostic>,
    pub hashes: Option<JsValue>,
    /// A library case of `add` or `upgrade`: whether it gives back a lock.
    pub written: Option<bool>,
}

impl From<&CheckResult> for Observed {
    fn from(r: &CheckResult) -> Observed {
        Observed {
            ok: r.ok,
            diagnostics: r.diagnostics.clone(),
            hashes: r.hashes.as_ref().map(|h| JsValue::Object(h.to_js())),
            written: None,
        }
    }
}

/// What a case of a door that is not `check` gives: the observation, and
/// the text of the result the door gives, `JSON.stringify(result, null, 2)`
/// and a line end, which the stored result of the diagnostics gate is.
pub struct DoorResult {
    pub observed: Observed,
    pub text: String,
}

/// What `checkSubprogram` receives for a case's `subprogram`
/// (`subprogramInput` of `compiler/test/cases-runner.ts`), owned.
pub struct SubprogramCase {
    pub workflow: String,
    pub number: f64,
    pub base: String,
    pub ops: Vec<PatchOp>,
    pub lead: DataClass,
    pub room: Room,
}

/// `subprogramInput(dir, s, parent, modules)`: the operations are one `add`
/// for each definition of `defs`, in order, then `patch` as written; the
/// room's writes are capabilities of their constructor's effect.
pub fn subprogram_case(dir: &str, s: &Value, parent: &Value) -> Result<SubprogramCase, String> {
    let number = s.get("number").and_then(Value::as_i64).unwrap_or(1) as f64;
    let mut ops: Vec<PatchOp> = Vec::new();
    if let Some(defs) = s.get("defs") {
        let kind = kind_named(defs.get("kind").and_then(Value::as_str).unwrap_or("mdt"));
        let text = match defs.get("text").and_then(Value::as_str) {
            Some(t) => t.to_owned(),
            None => read_source(&mandate_testkit::repo_path(
                dir,
                defs.get("file")
                    .and_then(Value::as_str)
                    .ok_or("no defs file")?,
            ))?,
        };
        let r = mandate_syntax::load(&text, kind);
        let program = match r.program {
            Some(p) if !mandate_ir::has_errors(&r.diagnostics) => p,
            _ => return Err("the defs of a subprogram case must load".to_owned()),
        };
        // Only the definitions are read; the module's header is not.
        for (name, def) in program
            .get("defs")
            .and_then(Value::as_object)
            .ok_or("no defs")?
            .iter()
        {
            ops.push(PatchOp {
                op: "add".to_owned(),
                path: format!("/defs/{name}"),
                value: Some(def.clone()),
            });
        }
    }
    for op in s.get("patch").and_then(Value::as_array).unwrap_or_default() {
        ops.push(PatchOp::from_value(op));
    }
    let lead = s.get("lead").and_then(Value::as_str).unwrap_or("public");
    let lead =
        DataClass::from_name(lead).ok_or_else(|| format!("lead {lead} is not a data class"))?;
    let room = s.get("room").ok_or("no room")?;
    let mut writes: Vec<CapVal> = Vec::new();
    for w in room
        .get("writes")
        .and_then(Value::as_array)
        .unwrap_or_default()
    {
        let ctor = w.get("ctor").and_then(Value::as_str).unwrap_or("undefined");
        let spec = cap_ctor(ctor)
            .filter(|c| c.write)
            .ok_or_else(|| format!("room.writes: {ctor} is not a write capability constructor"))?;
        let mut cap = CapVal::new(ctor, spec.effect, spec.write);
        cap.set_scope(Some(
            w.get("scope")
                .and_then(Value::as_array)
                .unwrap_or_default()
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        ));
        writes.push(cap);
    }
    let room = Room {
        left: room
            .get("left")
            .and_then(Value::as_object)
            .ok_or("no room.left")?
            .iter()
            .filter_map(|(k, v)| v.as_i64().map(|n| (k.to_owned(), n as f64)))
            .collect(),
        time_left_ms: room
            .get("time_left_ms")
            .and_then(Value::as_i64)
            .map(|n| n as f64),
        writes,
    };
    Ok(SubprogramCase {
        workflow: s
            .get("workflow")
            .and_then(Value::as_str)
            .ok_or("no workflow")?
            .to_owned(),
        number,
        base: hash_program(&skeleton(
            parent
                .get("module")
                .and_then(Value::as_str)
                .unwrap_or("undefined"),
            number,
            language_of(parent),
        ))
        .program,
        ops,
        lead,
        room,
    })
}

/// `checkSubprogram(subprogramInput(…))`.
pub fn run_subprogram(
    case: &SubprogramCase,
    parent: &Value,
    modules: &Modules,
) -> Result<DoorResult, String> {
    let r = check_subprogram(&SubprogramInput {
        parent,
        modules: Some(modules),
        workflow: &case.workflow,
        number: case.number,
        base: &case.base,
        ops: &case.ops,
        lead: case.lead,
        room: &case.room,
        std_patterns: None,
    })?;
    Ok(DoorResult {
        observed: Observed {
            ok: r.ok,
            diagnostics: r.diagnostics.clone(),
            hashes: None,
            written: None,
        },
        text: result_text(&r.to_js()),
    })
}

/// `checkAmendment(amendmentInput(a, parent, modules))`, observed with
/// `hashes: { program: hash }` where the amendment has a hash.
pub fn run_amendment(a: &Value, parent: &Value, modules: &Modules) -> Result<DoorResult, String> {
    let workflow = a
        .get("workflow")
        .and_then(Value::as_str)
        .ok_or("no workflow")?;
    let patch = a
        .get("patch")
        .and_then(Value::as_array)
        .ok_or("no amendment patch")?;
    let envelope = amendment_envelope(workflow, patch, parent)?;
    let r = check_amendment(&AmendmentInput {
        parent,
        modules: Some(modules),
        workflow,
        envelope: Some(&envelope),
        std_patterns: None,
    })?;
    Ok(DoorResult {
        observed: Observed {
            ok: r.ok,
            diagnostics: r.diagnostics.clone(),
            hashes: r
                .hash
                .as_deref()
                .map(|h| JsObject::new().with("program", h).into()),
            written: None,
        },
        text: result_text(&r.to_js()),
    })
}

/// `JSON.stringify(result, null, 2)` and a line end.
fn result_text(v: &JsValue) -> String {
    let mut text = stringify_pretty(v).unwrap_or_default();
    text.push('\n');
    text
}

/// The library directories of a case (`libraries`, 0.6), as repository
/// paths.
pub fn case_libraries(dir: &str, case: &Value) -> Vec<String> {
    case.get("libraries")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .map(|l| mandate_testkit::repo_path(dir, l))
        .collect()
}

/// `modules` with the modules of the libraries in the repository
/// directories `dirs` (0.6): what a door that is given modules rather than
/// libraries (a sub-program's check, an amendment's) is handed of a package
/// whose lock pins them.
pub fn with_library_modules(modules: &Modules, dirs: &[String]) -> Result<Modules, String> {
    let mut all = modules.clone();
    for source in libraries_of(dirs)? {
        let l = mandate_check::library::load_library(&source, false, "a library")
            .map_err(|d| format!("a library does not load: {d:?}"))?;
        for (m, ir) in l.modules.iter() {
            all.insert(m, ir.clone());
        }
    }
    Ok(all)
}

/// The configuration of a case (`config`, 0.6): the `libraries` member of
/// the runtime's configuration, read.
pub fn case_config(
    dir: &str,
    case: &Value,
) -> Result<Option<mandate_check::library::LibrariesConfig>, String> {
    let Some(path) = case.get("config").and_then(Value::as_str) else {
        return Ok(None);
    };
    let v = read_json(&mandate_testkit::repo_path(dir, path))?;
    mandate_check::library::read_libraries_config(&v)
        .map(Some)
        .map_err(|p| format!("{path}: {} problems", p.len()))
}

/// A version directory of a library, as a caller reads it.
fn published(dir: &str, version: &str) -> Result<mandate_check::library::ops::Published, String> {
    let at = format!("{dir}/{version}");
    let (manifest, files) = library_files(&at)?;
    Ok(mandate_check::library::ops::Published {
        version: version.to_owned(),
        source: LibrarySource { manifest, files },
        index: mandate_testkit::read_text(&format!("{at}/index.json")).ok(),
    })
}

/// Runs a library case (`library`, 0.6): `add`, `upgrade` or `publish` of
/// `crate::library::ops`, observed with `written` for `add` and `upgrade`.
pub fn run_library_case(dir: &str, case: &Value) -> Result<DoorResult, String> {
    use mandate_check::library::ops::{Request, add, publish, upgrade};
    let l = case.get("library").ok_or("no library")?;
    let s = |k: &str| l.get(k).and_then(Value::as_str);
    let op = s("op").ok_or("no op")?;
    let now = mandate_check::library::Timestamp::parse(s("now").ok_or("no now")?)
        .map_err(|f| format!("now: {}", f.id()))?;
    let versions_dir = s("versions").map(|v| mandate_testkit::repo_path(dir, v));
    let only: Option<Vec<String>> = l.get("only").and_then(Value::as_array).map(|xs| {
        xs.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    let mut versions = Vec::new();
    if let Some(vd) = &versions_dir {
        for v in mandate_testkit::subdirectories(vd)? {
            if only.as_ref().is_none_or(|o| o.contains(&v)) {
                versions.push(published(vd, &v)?);
            }
        }
    }
    let config = case_config(dir, case)?;
    let deps = libraries_of(&case_libraries(dir, case))?;
    let (observed, out) = match op {
        "publish" => {
            let source = s("source").ok_or("no source")?;
            let (manifest, files) = library_files(&mandate_testkit::repo_path(dir, source))?;
            let r = publish(&LibrarySource { manifest, files }, &versions, &deps, now);
            (
                Observed {
                    ok: r.ok,
                    diagnostics: r.diagnostics.clone(),
                    hashes: None,
                    written: None,
                },
                r.to_js(),
            )
        }
        "add" | "upgrade" => {
            let lock = match case.get("lock").and_then(Value::as_str) {
                Some(p) => read_json(&mandate_testkit::repo_path(dir, p))?,
                None => return Err("a library case of add or upgrade needs a lock".to_owned()),
            };
            let request = Request {
                library: s("name").ok_or("no name")?,
                range: s("range"),
                lock: &lock,
                versions: &versions,
                libraries: &deps,
                config: config.as_ref(),
                now,
                // 0.7: the case's language is the program's the lock is for.
                language: case
                    .get("language")
                    .and_then(mandate_ir::Language::from_value),
            };
            let r = if op == "add" {
                add(&request)
            } else {
                let pinned = s("pinned").ok_or("no pinned")?;
                let (manifest, files) = library_files(&mandate_testkit::repo_path(dir, pinned))?;
                upgrade(
                    &request,
                    &LibrarySource { manifest, files },
                    l.get("accept_governance") == Some(&Value::Bool(true)),
                )
            };
            (
                Observed {
                    ok: r.ok,
                    diagnostics: r.diagnostics.clone(),
                    hashes: None,
                    written: Some(r.lock.is_some()),
                },
                r.to_js(),
            )
        }
        other => return Err(format!("no library operation {other}")),
    };
    Ok(DoorResult {
        observed,
        text: result_text(&out),
    })
}
