//! The commands the Node command line has too, each as `bridge/src/cli.ts`
//! answers it: `check`, `ir`, `fmt`, `hash`, `patch`, `sandbox`,
//! `target acs`, `view` and `explain`. The library commands are
//! `crate::libraries`'s.

use mandate_check::{
    CheckOptions, CheckResult, Locks, ModuleSource, Modules, PatchOp, apply_patch, check,
    denial_diagnostics, load_modules, requirements_to_js, sandbox_requirements, semantic_diff_with,
};
use mandate_ir::{
    Diagnostic, JsObject, JsValue, Language, Map, Program, Value, canonicalize, format_diagnostic,
    has_errors, parse, stringify_pretty,
};
use mandate_syntax::{kind_of, load, print_program};
use mandate_views::{
    acs_target, architecture_pinned, attention_doc, attention_program_doc, attention_view,
    attention_views_js, authority_pinned, card_doc_given, card_given, cost_with, diff_doc_with,
    envelope_workflows, has_attention, program_doc_given, to_html, to_markdown, workflow_names,
};

use crate::args::Args;
use crate::libraries::Given;
use crate::{Io, IoErrorKind};

/// The commands of the Node command line that this executable does not
/// have: `CONTROL` of `bridge/src/cli.ts` (the runtime's).
const NOT_HERE: [&str; 27] = [
    "run",
    "status",
    "approve",
    "decline",
    "answer",
    "cancel",
    "reconcile",
    "shadow-diff",
    "raise-limits",
    "replay",
    "artifact",
    "show",
    "denials",
    "rotate-key",
    "test",
    "onboard",
    "drift",
    "deploy",
    "key",
    "decision",
    "verify-decision",
    "approve-envelope",
    "amend",
    "journal",
    "egress",
    "halt",
    "otel",
];

/// What the command prints when it is not used as it is meant.
const USAGE: &str = "usage: mandate <command> [options]
  check <file> [--json] [--lock <lock.json>] [--denials <report.json>] [--module <file>]… [--libraries <dir>] [--config <file>]
  ir <file> [--canonical]
  fmt <file>
  hash <file>
  patch <program> <patch.json> [--json]   patch.json: { \"base\": \"sha256:…\", \"ops\": [ … ] }
  sandbox <file> [--agent <name>] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]
  target acs <file> [--out <dir>] [--json] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]
  explain <code> [--json]
  view <file> [--against <old file>] [--against-lock <old lock.json>] [--format md|html|json] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]
  view <file> --card [--workflow W] [--format md|html|json] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]
  view <file> --attention [--workflow W] [--format md|html|json] [--lock <lock.json>] [--module <file>]… [--libraries <dir>] [--config <file>]
  add <library>[@<range>] [--lock <lock.json>] [--program <file>] [--libraries <dir>] [--config <file>] [--json]
  upgrade <library>[@<range>] [--lock <lock.json>] [--program <file>] [--libraries <dir>] [--config <file>] [--accept-governance] [--json]
  publish <source dir> [--libraries <dir>] [--config <file>] [--json]
  mcp [--module <file>]…   (an MCP server on stdio)
  (the commands that control a run are the Node command line's, not this executable's)
";

/// A command that ended before its end, with its exit status; what it had
/// to say is already written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Stop(pub i32);

/// A command's exit status, or the stop that ended it.
pub(crate) type Done = Result<i32, Stop>;

/// `JSON.stringify(v, null, 2) + "\n"`.
pub(crate) fn pretty(v: &JsValue) -> String {
    let mut text = stringify_pretty(v).unwrap_or_default();
    text.push('\n');
    text
}

/// The diagnostics as an array.
fn diagnostics_js(diagnostics: &[Diagnostic]) -> JsValue {
    JsValue::Array(diagnostics.iter().map(Diagnostic::to_js).collect())
}

/// Whether `program` is written in a language only the Rust compiler reads
/// (0.6 or later).
fn is_0_6(program: &Value) -> bool {
    Program::of(program)
        .and_then(Program::language)
        .is_some_and(|l| l.at_least(Language::V0_6))
}

/// `viewModules` of `bridge/src/util.ts`: the modules a view or a diff of
/// `programs` is given, which is the caller's modules when one of the
/// programs is of 0.6, and none for programs of 0.1 to 0.5.
fn view_modules<'a>(modules: &'a Modules, programs: &[&Value]) -> Option<&'a Modules> {
    programs.iter().any(|p| is_0_6(p)).then_some(modules)
}

/// A document in the format asked for: Markdown, or HTML.
fn rendered(doc: &mandate_views::Doc, format: &str) -> String {
    if format == "html" {
        to_html(doc)
    } else {
        to_markdown(doc)
    }
}

/// The command line over an [`Io`].
pub(crate) struct Cli<'a> {
    pub(crate) io: &'a mut dyn Io,
}

impl<'a> Cli<'a> {
    pub(crate) fn new(io: &'a mut dyn Io) -> Cli<'a> {
        Cli { io }
    }

    /// Runs the command and gives its exit status.
    pub(crate) fn run(&mut self, args: &[String]) -> i32 {
        match self.command(args) {
            Ok(code) | Err(Stop(code)) => code,
        }
    }

    fn command(&mut self, args: &[String]) -> Done {
        let Some((cmd, after)) = args.split_first() else {
            return Err(self.usage());
        };
        if NOT_HERE.contains(&cmd.as_str()) {
            return Err(self.fail(
                2,
                &format!(
                    "{cmd} is not in this executable: it is a command of the Node command line (`mandate` of @mandate/bridge, with @mandate/runtime)"
                ),
            ));
        }
        let Ok(a) = Args::read(after) else {
            return Err(self.usage());
        };
        let modules = self.read_modules(&a)?;
        match cmd.as_str() {
            "check" => self.check(&a, &modules),
            "ir" | "fmt" | "hash" => self.print(cmd, &a),
            "patch" => self.patch(&a, &modules),
            "sandbox" => self.sandbox(&a, &modules),
            "target" => self.target(&a, &modules),
            "view" => self.view(&a, &modules),
            "explain" => self.explain(&a),
            "add" => self.add(&a, false),
            "upgrade" => self.add(&a, true),
            "publish" => self.publish(&a),
            // The server reads no file: its modules are read here, before it starts.
            "mcp" => Ok(crate::mcp::serve(&mut *self.io, JsObject::from(&modules))),
            _ => Err(self.usage()),
        }
    }

    // ── what every command shares ────────────────────────────────────────

    pub(crate) fn out(&mut self, text: &str) {
        self.io.write_out(text);
    }

    pub(crate) fn err(&mut self, text: &str) {
        self.io.write_err(text);
    }

    /// Says `mandate: <message>` on standard error; the stop with `code`.
    pub(crate) fn fail(&mut self, code: i32, message: &str) -> Stop {
        self.err(&format!("mandate: {message}\n"));
        Stop(code)
    }

    /// Prints the usage; the stop with 2.
    pub(crate) fn usage(&mut self) -> Stop {
        self.err(USAGE);
        Stop(2)
    }

    /// The text of `file`, decoded as Node's `readFileSync(file, "utf8")`
    /// decodes it (an ill-formed sequence is U+FFFD); `-` is standard input.
    pub(crate) fn read(&mut self, file: &str) -> Result<String, Stop> {
        let bytes = if file == "-" {
            self.io.read_input()
        } else {
            self.io.read_file(file)
        };
        match bytes {
            Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
            Err(e) => Err(self.fail(2, &format!("cannot read {file}: {}", e.message))),
        }
    }

    /// The text of `file`, or `None` when it is not there.
    pub(crate) fn read_if_there(&mut self, file: &str) -> Result<Option<String>, Stop> {
        match self.io.read_file(file) {
            Ok(bytes) => Ok(Some(String::from_utf8_lossy(&bytes).into_owned())),
            Err(e) if e.kind == IoErrorKind::NotFound => Ok(None),
            Err(e) => Err(self.fail(2, &format!("cannot read {file}: {}", e.message))),
        }
    }

    /// Writes `text` as `file`.
    pub(crate) fn write(&mut self, file: &str, text: &str) -> Result<(), Stop> {
        match self.io.write_file(file, text.as_bytes()) {
            Ok(()) => Ok(()),
            Err(e) => Err(self.fail(2, &format!("cannot write {file}: {}", e.message))),
        }
    }

    /// Makes the directory `dir`.
    pub(crate) fn make_dir(&mut self, dir: &str) -> Result<(), Stop> {
        match self.io.create_dir_all(dir) {
            Ok(()) => Ok(()),
            Err(e) => Err(self.fail(2, &format!("cannot make {dir}: {}", e.message))),
        }
    }

    /// The path of `name` beside `file`: in its directory, or `name` alone
    /// when `file` is a bare name.
    pub(crate) fn beside(&self, file: &str, name: &str) -> String {
        let dir = self.io.parent(file);
        if dir.is_empty() || dir == "." {
            name.to_owned()
        } else {
            self.io.join(&dir, name)
        }
    }

    /// `report` of cli.ts: the diagnostics as `{ ok, ...extra, diagnostics }`
    /// on standard output, or one a line on standard error.
    pub(crate) fn report(
        &mut self,
        diagnostics: &[Diagnostic],
        file: &str,
        as_json: bool,
        extra: &JsObject,
    ) {
        if as_json {
            let all = JsObject::new()
                .with("ok", !has_errors(diagnostics))
                .spread(extra)
                .with("diagnostics", diagnostics_js(diagnostics));
            self.out(&pretty(&JsValue::Object(all)));
        } else {
            for d in diagnostics {
                self.err(&format!("{}\n", format_diagnostic(d, Some(file))));
            }
        }
    }

    /// `text` read as strict JSON; its diagnostics reported against `file`
    /// and the stop with 1 when it is not.
    pub(crate) fn strict_json(
        &mut self,
        text: &str,
        file: &str,
        as_json: bool,
    ) -> Result<Value, Stop> {
        match parse(text) {
            Ok(parsed) => Ok(parsed.value),
            Err(diagnostics) => {
                self.report(&diagnostics, file, as_json, &JsObject::new());
                Err(Stop(1))
            }
        }
    }

    /// `readLock` of cli.ts: the lock named by `--lock`, or
    /// `mandate.lock.json` beside the program when there is one; strict JSON
    /// either way. A lock that JavaScript reads as false (`null`, `false`,
    /// `0`, `""`) is no lock.
    fn read_lock(
        &mut self,
        file: &str,
        named: Option<&str>,
        as_json: bool,
    ) -> Result<Option<Value>, Stop> {
        let (path, text) = match named {
            Some(path) => (path.to_owned(), self.read(path)?),
            None => {
                let path = self.beside(file, "mandate.lock.json");
                match self.read_if_there(&path)? {
                    Some(text) => (path, text),
                    None => return Ok(None),
                }
            }
        };
        let lock = self.strict_json(&text, &path, as_json)?;
        Ok(Some(lock).filter(Value::is_truthy))
    }

    /// `readModules` of cli.ts: the modules named by `--module`, each
    /// checked against the others; any problem stops the command.
    fn read_modules(&mut self, a: &Args) -> Result<Modules, Stop> {
        let mut texts = Vec::with_capacity(a.modules.len());
        for file in &a.modules {
            texts.push(self.read(file)?);
        }
        let sources: Vec<ModuleSource<'_>> = a
            .modules
            .iter()
            .zip(&texts)
            .map(|(file, text)| ModuleSource {
                text,
                kind: kind_of(file),
                file,
            })
            .collect();
        let loaded = load_modules(&sources);
        for p in &loaded.problems {
            self.report(&p.diagnostics, &p.file, a.json(), &JsObject::new());
        }
        if loaded.problems.is_empty() {
            Ok(loaded.modules)
        } else {
            Err(Stop(1))
        }
    }

    /// `check(text, kind, { modules, lock })` of `file`, with the libraries
    /// its lock pins.
    fn checked(
        &mut self,
        file: &str,
        modules: &Modules,
        lock: Option<&Value>,
        given: &Given,
    ) -> Result<CheckResult, Stop> {
        let text = self.read(file)?;
        let opts = CheckOptions {
            lock,
            modules: Some(modules),
            libraries: (!given.libraries.is_empty()).then_some(given.libraries.as_slice()),
            revoked: given.revoked.as_ref(),
            ..CheckOptions::default()
        };
        Ok(check(&text, kind_of(file), &opts))
    }

    /// The program of `file` when it checks with `lock`; else its
    /// diagnostics reported (as text, or as JSON) and the stop with 1.
    fn checked_program(
        &mut self,
        file: &str,
        modules: &Modules,
        lock: Option<&Value>,
        given: &Given,
        as_json: bool,
    ) -> Result<(Value, CheckResult), Stop> {
        let r = self.checked(file, modules, lock, given)?;
        match (&r.program, r.ok) {
            (Some(program), true) => Ok((program.clone(), r)),
            _ => {
                self.report(&r.diagnostics, file, as_json, &JsObject::new());
                Err(Stop(1))
            }
        }
    }

    // ── the commands ─────────────────────────────────────────────────────

    /// `mandate check <file> [--json] [--lock L] [--denials R] [--module M]…`.
    fn check(&mut self, a: &Args, modules: &Modules) -> Done {
        let Some(file) = a.arg(0) else {
            return Err(self.usage());
        };
        let as_json = a.json();
        let lock = self.read_lock(file, a.lock.as_deref(), as_json)?;
        let given = self.given(a, lock.as_ref())?;
        let mut r = self.checked(file, modules, lock.as_ref(), &given)?;
        // W0311: what sandboxes denied in learning mode (§11.3).
        if let Some(denials) = a.denials.as_deref()
            && r.ok
            && r.program.is_some()
        {
            let text = self.read(denials)?;
            let report = self.strict_json(&text, denials, as_json)?;
            let more = r
                .program
                .as_ref()
                .map(|program| denial_diagnostics(program, &report));
            match more {
                Some(Ok(more)) => r.diagnostics.extend(more),
                Some(Err(message)) => return Err(self.fail(1, &message)),
                None => {}
            }
            r.ok = !has_errors(&r.diagnostics);
        }
        let extra = match &r.hashes {
            Some(h) => JsObject::new().with("hashes", h.to_js()),
            None => JsObject::new(),
        };
        self.report(&r.diagnostics, file, as_json, &extra);
        if let (false, true, Some(h)) = (as_json, r.ok, &r.hashes) {
            self.out(&format!("ok {}\n", h.program));
        }
        Ok(i32::from(!r.ok))
    }

    /// `mandate ir <file> [--canonical]`, `mandate fmt <file>` and
    /// `mandate hash <file>`.
    fn print(&mut self, cmd: &str, a: &Args) -> Done {
        let Some(file) = a.arg(0) else {
            return Err(self.usage());
        };
        let as_json = a.json();
        let text = self.read(file)?;
        let (program, diagnostics, hashes) = if cmd == "hash" {
            let r = check(&text, kind_of(file), &CheckOptions::default());
            (r.program, r.diagnostics, r.hashes)
        } else {
            let r = load(&text, kind_of(file));
            (r.program, r.diagnostics, None)
        };
        let program = match program {
            Some(program) if !has_errors(&diagnostics) => program,
            _ => {
                self.report(&diagnostics, file, as_json, &JsObject::new());
                return Ok(1);
            }
        };
        match cmd {
            "ir" => {
                // Pretty output keeps the JCS member order, read back as
                // JavaScript reads it.
                let jcs = canonicalize(&program);
                if a.flag("--canonical") {
                    self.out(&jcs);
                } else {
                    let read = parse(&jcs).map_or(program, |p| p.value);
                    self.out(&pretty(&JsValue::from(&read)));
                }
            }
            "fmt" => match print_program(&program) {
                Ok(text) => self.out(&text),
                Err(message) => return Err(self.fail(1, &message)),
            },
            _ => match hashes {
                Some(h) => self.out(&pretty(&JsValue::Object(h.to_js()))),
                None => {
                    self.report(&diagnostics, file, as_json, &JsObject::new());
                    return Ok(1);
                }
            },
        }
        Ok(0)
    }

    /// `mandate patch <program> <patch.json> [--json]`.
    fn patch(&mut self, a: &Args, modules: &Modules) -> Done {
        let (Some(file), Some(patch_file)) = (a.arg(0), a.arg(1)) else {
            return Err(self.usage());
        };
        let as_json = a.json();
        let text = self.read(file)?;
        let loaded = load(&text, kind_of(file));
        let program = match loaded.program {
            Some(program) if !has_errors(&loaded.diagnostics) => program,
            _ => {
                self.report(&loaded.diagnostics, file, as_json, &JsObject::new());
                return Ok(1);
            }
        };
        let patch_text = self.read(patch_file)?;
        let patch = self.strict_json(&patch_text, patch_file, as_json)?;
        let (Some(base), Some(ops)) = (
            patch.get("base").and_then(Value::as_str),
            patch.get("ops").and_then(Value::as_array),
        ) else {
            return Err(self.fail(
                2,
                "patch file must be { \"base\": \"sha256:…\", \"ops\": [ … ] }",
            ));
        };
        if ops.iter().any(|op| !matches!(op, Value::Object(_))) {
            return Err(self.fail(
                1,
                "the patch has an operation that is not an object ({ op, path, value? })",
            ));
        }
        let ops: Vec<PatchOp> = ops.iter().map(PatchOp::from_value).collect();
        let r = apply_patch(&program, base, &ops, Some(modules));
        let governance: Vec<JsValue> = r.governance.iter().map(|g| g.to_js()).collect();
        // Without `ok`, what cli.ts reads of the result has no program or hash.
        let (hash, patched) = if r.ok {
            (r.hash.as_deref(), r.program.as_ref())
        } else {
            (None, None)
        };
        if as_json {
            let extra = JsObject::new()
                .with("hash", hash.map_or(JsValue::Null, JsValue::from))
                .with("governance", governance)
                .with("program", patched.map_or(JsValue::Null, JsValue::from));
            self.report(&r.diagnostics, file, true, &extra);
        } else {
            self.report(&r.diagnostics, file, false, &JsObject::new());
            if r.ok {
                for g in &r.governance {
                    self.err(&format!(
                        "governance change: {} at {}: {}\n",
                        g.kind.as_str(),
                        g.path,
                        g.detail
                    ));
                }
                self.out(&pretty(&patched.map_or(JsValue::Null, JsValue::from)));
            }
        }
        Ok(i32::from(!r.ok))
    }

    /// `mandate sandbox <file> [--agent <name>] [--lock L] [--module M]…`.
    fn sandbox(&mut self, a: &Args, modules: &Modules) -> Done {
        let Some(file) = a.arg(0) else {
            return Err(self.usage());
        };
        let as_json = a.json();
        let lock = self.read_lock(file, a.lock.as_deref(), as_json)?;
        let given = self.given(a, lock.as_ref())?;
        let (program, r) = self.checked_program(file, modules, lock.as_ref(), &given, as_json)?;
        let all = given.with_modules(modules);
        let requirements =
            requirements_to_js(&sandbox_requirements(&program, Some(&all), lock.as_ref()));
        let shown = match a.agent.as_deref() {
            Some(agent) => match requirements.get(agent) {
                Some(one) => one.clone(),
                None => {
                    return Err(self.fail(2, &format!("no local agent {agent} in {file}")));
                }
            },
            None => JsObject::new()
                .with(
                    "program",
                    r.hashes.as_ref().map_or("", |h| h.program.as_str()),
                )
                .with("requirements", requirements)
                .into(),
        };
        self.out(&pretty(&shown));
        Ok(0)
    }

    /// `mandate target acs <file> [--out <dir>] [--json] [--lock L] [--module M]…`.
    fn target(&mut self, a: &Args, modules: &Modules) -> Done {
        let (Some("acs"), Some(file)) = (a.arg(0), a.arg(1)) else {
            return Err(self.usage());
        };
        let as_json = a.json();
        let lock = self.read_lock(file, a.lock.as_deref(), as_json)?;
        let given = self.given(a, lock.as_ref())?;
        let (program, _) = self.checked_program(file, modules, lock.as_ref(), &given, as_json)?;
        let all = given.with_modules(modules);
        let t = acs_target(&program, Some(&all), lock.as_ref());
        let dir = a.out.as_deref().unwrap_or("acs");
        self.make_dir(dir)?;
        let mut names: Vec<JsValue> = Vec::new();
        for (name, agent) in &t.agents {
            names.push(JsValue::from(name.as_str()));
            let own = self.io.join(dir, name);
            self.make_dir(&own)?;
            let manifest = self.io.join(dir, &format!("{name}.manifest.json"));
            self.write(&manifest, &pretty(&agent.manifest))?;
            let rego = self.io.join(&own, "policy.rego");
            self.write(&rego, &agent.rego)?;
            let requirement = self
                .io
                .join(dir, &format!("{name}.sandbox-requirement.json"));
            self.write(
                &requirement,
                &pretty(&JsValue::Object(agent.requirement.to_js())),
            )?;
        }
        // The target as cli.ts reads it, for the members of the summary.
        let whole = t.to_js();
        let member = |name: &str| whole.get(name).cloned().unwrap_or(JsValue::Null);
        let summary = JsObject::new()
            .with("format", member("format"))
            .with("acs_version", member("acs_version"))
            .with("program", t.program.as_str())
            .with("binding", t.binding.as_str())
            .with("agents", names)
            .with("profile", member("profile"));
        let profile = self.io.join(dir, "profile.json");
        self.write(&profile, &pretty(&JsValue::Object(summary.clone())))?;
        self.report(&t.diagnostics, file, as_json, &summary.with("out", dir));
        if !as_json {
            self.out(&format!(
                "wrote {} agent(s) to {dir}; hosts present {} as envelope.agent.version\n",
                t.agents.len(),
                t.binding
            ));
        }
        Ok(i32::from(has_errors(&t.diagnostics)))
    }

    /// `mandate view <file> …`: the program's views, the diff with an older
    /// version, the card of a workflow, or the attention view of its
    /// workflows.
    fn view(&mut self, a: &Args, modules: &Modules) -> Done {
        let Some(file) = a.arg(0) else {
            return Err(self.usage());
        };
        let format = a.format.as_str();
        if !["md", "html", "json"].contains(&format) {
            return Err(self.usage());
        }
        let lock = self.read_lock(file, a.lock.as_deref(), false)?;
        let given = self.given(a, lock.as_ref())?;
        let (program, _) = self.checked_program(file, modules, lock.as_ref(), &given, false)?;
        let mut all = given.with_modules(modules);
        // What the check of the attention view is given besides the lock:
        // the program's own modules and the libraries its lock pins.
        let attention_opts = CheckOptions {
            lock: lock.as_ref(),
            modules: Some(modules),
            libraries: (!given.libraries.is_empty()).then_some(given.libraries.as_slice()),
            revoked: given.revoked.as_ref(),
            ..CheckOptions::default()
        };
        if a.flag("--attention") {
            if a.against.is_some() || a.flag("--card") {
                return Err(self.usage());
            }
            // The attention view is of a program of 0.7: of each of its
            // workflows, in the order of its definitions, or of the one
            // --workflow names.
            if !has_attention(&program) {
                return Err(self.fail(
                    1,
                    &format!(
                        "{file} is not a program of language 0.7, so it has no attention view"
                    ),
                ));
            }
            let names = workflow_names(&program);
            let chosen: Vec<&str> = match a.workflow.as_deref() {
                Some(w) if names.iter().any(|n| n == w) => vec![w],
                Some(w) => {
                    return Err(self.fail(
                        2,
                        &format!(
                            "no workflow {w} in {file}; name one of: {}",
                            names.join(", ")
                        ),
                    ));
                }
                None => names.iter().map(String::as_str).collect(),
            };
            if chosen.is_empty() {
                return Err(self.fail(
                    1,
                    &format!("{file} has no workflow, so it has no attention view"),
                ));
            }
            let source = self.read(file)?;
            let mut views = Vec::with_capacity(chosen.len());
            for name in chosen {
                match attention_view(&source, kind_of(file), &attention_opts, name) {
                    Some(v) => views.push(v),
                    None => {
                        return Err(self.fail(
                            1,
                            &format!("the attention view of {name} of {file} could not be made"),
                        ));
                    }
                }
            }
            // JSON: the view of the one workflow --workflow names, as the
            // door `attention` gives it, else `{ format, kind, program,
            // workflows }` whatever their number. Markdown and HTML: the
            // document of the one workflow, or of all of them.
            let text = match (views.as_slice(), format) {
                ([only], "json") if a.workflow.is_some() => pretty(&only.to_js()),
                ([only], "md" | "html") => rendered(&attention_doc(only), format),
                (all, "json") => all.first().map_or_else(String::new, |first| {
                    pretty(&attention_views_js(&first.program, all))
                }),
                (all, _) => attention_program_doc(all)
                    .map_or_else(String::new, |doc| rendered(&doc, format)),
            };
            self.out(&text);
        } else if a.flag("--card") {
            if a.against.is_some() {
                return Err(self.usage());
            }
            // The card is of one workflow that has one: the only one, or
            // the one --workflow names.
            let names = envelope_workflows(&program);
            let Some(first) = names.first() else {
                return Err(self.fail(
                    1,
                    &format!("{file} has no workflow with an envelope, so it has no card"),
                ));
            };
            let name = match a.workflow.as_deref() {
                Some(w) if names.iter().any(|n| n == w) => w,
                None if names.len() == 1 => first.as_str(),
                asked => {
                    let why = match asked {
                        Some(w) => format!("no workflow {w} with an envelope in {file}"),
                        None => format!("{file} has several workflows with an envelope"),
                    };
                    return Err(self.fail(
                        2,
                        &format!("{why}; name one with --workflow: {}", names.join(", ")),
                    ));
                }
            };
            let text = if format == "json" {
                card_given(&program, name, lock.as_ref(), Some(&all), &attention_opts)
                    .map(|view| pretty(&view.to_js()))
            } else {
                card_doc_given(&program, name, lock.as_ref(), Some(&all), &attention_opts)
                    .map(|doc| rendered(&doc, format))
            };
            match text {
                Some(text) => self.out(&text),
                None => return Err(self.fail(1, &format!("{name} of {file} has no card"))),
            }
        } else if let Some(against) = a.against.as_deref() {
            // The old version is checked without its lock, as cli.ts checks
            // it, but with the libraries that lock pins (0.6).
            let pinned = self.peek_lock(against, a.against_lock.as_deref());
            let old_given = self.given(a, pinned.as_ref())?;
            let (before, _) = self.checked_program(against, modules, None, &old_given, false)?;
            // None next to the old file is no lock, not an error.
            let before_lock = self.read_lock(against, a.against_lock.as_deref(), false)?;
            let locks = Some(Locks {
                before: before_lock.as_ref(),
                after: lock.as_ref(),
            });
            let mut both = old_given.with_modules(modules);
            for (m, p) in all.iter() {
                both.insert(m, p.clone());
            }
            all = both;
            let m = view_modules(&all, &[&before, &program]);
            let text = if format == "json" {
                pretty(&semantic_diff_with(&before, &program, locks, m).to_js())
            } else {
                rendered(&diff_doc_with(&before, &program, locks, m), format)
            };
            self.out(&text);
        } else {
            let m = view_modules(&all, &[&program]);
            // 0.7: every view reads std.patterns at the version the lock pins.
            let pin = mandate_check::library::std_patterns_pin(lock.as_ref());
            let text = if format == "json" {
                let views = JsObject::new()
                    .with(
                        "architecture",
                        architecture_pinned(
                            &program,
                            lock.as_ref().filter(|_| m.is_some()),
                            m,
                            pin.as_ref(),
                        )
                        .to_js(),
                    )
                    .with(
                        "authority",
                        authority_pinned(&program, m, pin.as_ref()).to_js(),
                    )
                    .with("cost", cost_with(&program, lock.as_ref(), m).to_js());
                pretty(&JsValue::Object(views))
            } else {
                rendered(
                    &program_doc_given(&program, lock.as_ref(), m, None, &attention_opts),
                    format,
                )
            };
            self.out(&text);
        }
        Ok(0)
    }

    /// The lock `read_lock` would give, or none when there is none or it
    /// cannot be read: nothing is reported.
    fn peek_lock(&mut self, file: &str, named: Option<&str>) -> Option<Value> {
        let path = match named {
            Some(path) => path.to_owned(),
            None => self.beside(file, "mandate.lock.json"),
        };
        let bytes = self.io.read_file(&path).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        parse(&text).ok().map(|p| p.value).filter(Value::is_truthy)
    }

    /// `mandate explain <code> [--json]`, from the table of codes, through
    /// the door `explain`.
    fn explain(&mut self, a: &Args) -> Done {
        let Some(raw) = a.arg(0) else {
            return Err(self.usage());
        };
        let mut input = Map::new();
        input.insert("code", raw);
        let answer = mandate_doors::door("explain")
            .and_then(|door| (door.call)(&Value::Object(input)).ok())
            .filter(|row| !row.is_null() && !row.is_undefined());
        let Some(row) = answer else {
            return Err(self.fail(2, &format!("unknown code {raw}")));
        };
        if a.json() {
            self.out(&pretty(&row));
        } else {
            let member = |name: &str| row.get(name).and_then(JsValue::as_str).unwrap_or_default();
            self.out(&format!(
                "{} {}\n\n{}\n",
                member("code"),
                member("title"),
                member("explain")
            ));
        }
        Ok(0)
    }
}
