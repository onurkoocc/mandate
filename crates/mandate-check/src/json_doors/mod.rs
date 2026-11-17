//! The JSON doors of `mandate-ir`, `mandate-syntax` and `mandate-check`: the
//! functions through which a host (the Node runtime, through the
//! WebAssembly module of `mandate-wasm`) calls the compiler, each a pure
//! function from a JSON value to a JSON value.
//!
//! The table of doors is [`DOORS`]; [`door`] finds one by name. The same
//! table is committed as data, `crates/mandate-check/tests/json_doors/doors.json`
//! (`mandate/doors/0.1`), which a test holds equal to [`DOORS`], so that the
//! Node side can read it. `crates/mandate-check/tests/json_doors/` also holds
//! the vectors that hold every door to the TypeScript compiler
//! (`scripts/json-doors-vectors.mjs` writes the expectations).
//!
//! # The contract
//!
//! - A door is a [`DoorFn`]: `fn(&Value) -> Result<JsValue, DoorError>`.
//! - Its name is the snake_case of the TypeScript function's
//!   (`checkSubprogram` is `check_subprogram`); [`Door::ts`] is the
//!   TypeScript's name, exported by `compiler/src/index.ts`, or, for the
//!   four run-time authority decisions (`grant`, `narrow`, `mapScopes`,
//!   `inFlightOverlap`), by `bridge/src/index.ts` (the bridge exports the
//!   compiler's names too, and these four besides). A door with no
//!   TypeScript function of its own ([`Door::ts`] is `None`) answers the
//!   question its TypeScript counterpart is used for, which [`Door::note`]
//!   says.
//! - Its input is a JSON object whose members are named exactly as the
//!   TypeScript function's parameters ([`Door::params`], in order); an
//!   options object keeps its TypeScript member names. An optional parameter
//!   may be absent or `null`. An input that is not an object, has a member
//!   that is not a parameter, lacks a required member, or has a member of the
//!   wrong JSON type is [`DoorErrorKind::BadInput`]; so is a member whose
//!   TypeScript type is a closed set of strings (a source kind, a data
//!   class, a language version, a hash domain) and that is none of them.
//!   Deeper in the input, members a TypeScript type does not have are
//!   ignored, as the TypeScript ignores them. A parameter whose TypeScript
//!   type is a `Set` is an array, one that is a `Map` an object (`within` of
//!   `caps_of`, `spans` of `role_lock_checks` and `binding_checks`), and
//!   `undefined` cannot be given (a required parameter must be there). A
//!   program is an object; what the TypeScript does with an object that is
//!   not a valid program is not specified (its types forbid it), and a door
//!   does not check the IR. Numbers are the IR's (integers within
//!   ±(2^53−1)), which is what the strict reader a request is read with
//!   gives.
//! - Its output is what `JSON.stringify` gives for the TypeScript function's
//!   return value, with these rules for what JSON cannot carry: a `Map` is an
//!   object with its entries in insertion order; a `Set` is an array in
//!   insertion order; a member whose value is `undefined` is left out; a
//!   return value of `undefined` is `null`. Where the TypeScript function
//!   throws on an input the door accepts, the door gives
//!   [`DoorErrorKind::BadInput`], with the message of the TypeScript's
//!   `Error` where the Rust function gives it.
//! - A door never panics, whatever it is given, and is deterministic: the
//!   same input gives the same output text. It reads no file, environment,
//!   clock, network or randomness.
//! - The constants that the TypeScript entry point exports as values come
//!   through one door, `tables`.
//!
//! The doors are grouped by what they stand on, in private modules beside
//! this one: `front` (reading, checking, hashing, printing), `program` (what
//! a program is made of), `lock` (the lock, the Managed Agents binding, the
//! sandbox), `patch` (patches, sub-programs, amendments and diffs),
//! `authority` (the run-time authority decisions of
//! [`crate::grant`](mod@crate::grant), whose
//! TypeScript is `bridge/src/authority.ts`) and `tables` (constants and the
//! codes). [`input`], public, reads the input by
//! the rules above. Each door's doc comment names the TypeScript function and
//! file it stands for, its input members and its output.
//!
//! # Another table of doors
//!
//! A crate whose functions the host calls too (the views, `mandate-views`)
//! has a table of its own, which a dispatcher (`mandate-doors`) merges with
//! this one; the names of the two must not meet. It is made the same way:
//!
//! - Its doors are [`DoorFn`]s that read their input with [`input`]
//!   ([`input::args`] and the methods of [`input::Members`]), so that every
//!   door reads by the same rules and refuses in the same words, and fail
//!   with [`DoorError`]. Its table is a `static` of [`Door`]s, made with
//!   [`Door::new`] and [`Door::own`], with a lookup by name like [`door`].
//! - It keeps three files in `crates/<crate>/tests/json_doors/`: `doors.json`
//!   (its table as data), `inputs.json` (its calls) and `expected.json`,
//!   which `scripts/json-doors-vectors.mjs` writes, since it reads every
//!   such directory (a door with no TypeScript function of its own needs an
//!   entry in its table `OWN`, and a `Set` or `Map` parameter one in
//!   `COLLECTIONS`).
//! - Its test is a copy of `crates/mandate-check/tests/json_doors.rs` with its
//!   own table, directory and lists of optional and any-value parameters:
//!   the tests themselves are `mandate_testkit::json_doors`.

use mandate_ir::{JsObject, JsValue, Value};

mod attention;
mod authority;
mod front;
pub mod input;
mod library;
mod lock;
mod patch;
mod program;
mod tables;

/// A door: the input object in, the output value or the error out.
pub type DoorFn = fn(&Value) -> Result<JsValue, DoorError>;

/// What kind of failure a door reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DoorErrorKind {
    /// The input is not what the door takes, or the TypeScript function
    /// throws on it.
    BadInput,
}

impl DoorErrorKind {
    /// Its name in the answer of the bridge: `bad_input`.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            DoorErrorKind::BadInput => "bad_input",
        }
    }
}

/// A door's failure, with a message for a person.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DoorError {
    /// What kind of failure.
    pub kind: DoorErrorKind,
    /// What was wrong.
    pub message: String,
}

impl DoorError {
    /// A [`DoorErrorKind::BadInput`] with `message`.
    #[must_use]
    pub fn bad_input(message: impl Into<String>) -> DoorError {
        DoorError {
            kind: DoorErrorKind::BadInput,
            message: message.into(),
        }
    }

    /// `{ kind, message }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("kind", self.kind.as_str())
            .with("message", self.message.as_str())
            .into()
    }
}

/// One door of the table.
#[derive(Clone, Copy, Debug)]
pub struct Door {
    /// Its name, such as `check_subprogram`.
    pub name: &'static str,
    /// The TypeScript function it stands for, as `compiler/src/index.ts`
    /// exports it, such as `checkSubprogram` (or `bridge/src/index.ts`, for
    /// the run-time authority decisions); `None` for a door that has no
    /// TypeScript function of its own.
    pub ts: Option<&'static str>,
    /// The members of its input: the TypeScript function's parameters, in
    /// order.
    pub params: &'static [&'static str],
    /// What a door without a TypeScript function answers, or how it differs
    /// from the function it stands for.
    pub note: Option<&'static str>,
    /// The door itself.
    pub call: DoorFn,
}

/// The door named `name`.
#[must_use]
pub fn door(name: &str) -> Option<&'static Door> {
    DOORS.iter().find(|d| d.name == name)
}

impl Door {
    /// A door named `name` that stands for the TypeScript function `ts`,
    /// whose parameters are `params`, with no note.
    #[must_use]
    pub const fn new(
        name: &'static str,
        ts: &'static str,
        params: &'static [&'static str],
        call: DoorFn,
    ) -> Door {
        Door {
            name,
            ts: Some(ts),
            params,
            note: None,
            call,
        }
    }

    /// A door named `name` that stands for the TypeScript function `ts`,
    /// with `note` saying how it differs from it (a parameter of `params`
    /// that is the Rust's alone, which the function is not given).
    #[must_use]
    pub const fn noted(
        name: &'static str,
        ts: &'static str,
        params: &'static [&'static str],
        note: &'static str,
        call: DoorFn,
    ) -> Door {
        Door {
            name,
            ts: Some(ts),
            params,
            note: Some(note),
            call,
        }
    }

    /// A door named `name` that has no TypeScript function of its own, with
    /// `note` saying what it answers.
    #[must_use]
    pub const fn own(
        name: &'static str,
        params: &'static [&'static str],
        note: &'static str,
        call: DoorFn,
    ) -> Door {
        Door {
            name,
            ts: None,
            params,
            note: Some(note),
            call,
        }
    }
}

/// The note of a view door that takes the modules besides what its
/// TypeScript function takes (language 0.6, which only the Rust reads).
pub const MODULES_NOTE: &str = "modules (optional) is the Rust's alone: the modules a workflow's pattern comes from (language 0.6), so that a workflow that applies one is read as its expansion. The TypeScript function is not given it; a program that applies no pattern gives the same with or without it.";

/// Every door, in the order of `doors.json`: reading and checking, the parts
/// of a program, the lock and the sandbox, patches and diffs, the run-time
/// authority decisions, then the constants and the codes.
pub static DOORS: &[Door] = &[
    Door::new("load", "load", front::LOAD, front::load),
    Door::new("check", "check", front::CHECK, front::check),
    Door::new(
        "load_modules",
        "loadModules",
        front::LOAD_MODULES,
        front::load_modules,
    ),
    Door::new(
        "parse_strict_json",
        "parseStrictJson",
        front::PARSE_STRICT_JSON,
        front::parse_strict_json,
    ),
    Door::new(
        "canonicalize",
        "canonicalize",
        front::CANONICALIZE,
        front::canonicalize,
    ),
    Door::new(
        "hash_program",
        "hashProgram",
        front::HASH_PROGRAM,
        front::hash_program,
    ),
    Door::new(
        "package_hash",
        "packageHash",
        front::PACKAGE_HASH,
        front::package_hash,
    ),
    Door::new(
        "domain_hash",
        "domainHash",
        front::DOMAIN_HASH,
        front::domain_hash,
    ),
    Door::new(
        "print_program",
        "printProgram",
        front::PRINT_PROGRAM,
        front::print_program,
    ),
    Door::new("link", "link", program::LINK, program::link),
    Door::new(
        "linked_program",
        "linkedProgram",
        program::LINKED_PROGRAM,
        program::linked_program,
    ),
    Door::new(
        "references",
        "references",
        program::REFERENCES,
        program::references,
    ),
    Door::new(
        "roles_named",
        "rolesNamed",
        program::ROLES_NAMED,
        program::roles_named,
    ),
    Door::new(
        "program_ref",
        "programRef",
        program::PROGRAM_REF,
        program::program_ref,
    ),
    Door::new(
        "lead_classes",
        "leadClasses",
        program::LEAD_CLASSES,
        program::lead_classes,
    ),
    Door::new(
        "workflow_bounds",
        "workflowBounds",
        program::WORKFLOW_BOUNDS,
        program::workflow_bounds,
    ),
    Door::new("caps_of", "capsOf", program::CAPS_OF, program::caps_of),
    Door::new("show_cap", "showCap", program::SHOW_CAP, program::show_cap),
    Door::new(
        "governance_files",
        "governanceFiles",
        program::GOVERNANCE_FILES,
        program::governance_files,
    ),
    Door::own(
        "glob_match",
        program::GLOB_MATCH,
        "globRegExp(glob).test(text): whether the glob matches the whole of the text. globRegExp returns a RegExp, which JSON cannot carry; this is the one question the runtime asks of it.",
        program::glob_match,
    ),
    Door::new("skeleton", "skeleton", program::SKELETON, program::skeleton),
    Door::new(
        "subprogram_linked",
        "subprogramLinked",
        program::SUBPROGRAM_LINKED,
        program::subprogram_linked,
    ),
    Door::new(
        "validate_lock",
        "validateLock",
        lock::VALIDATE_LOCK,
        lock::validate_lock,
    ),
    Door::new(
        "role_lock_checks",
        "roleLockChecks",
        lock::ROLE_LOCK_CHECKS,
        lock::role_lock_checks,
    ),
    Door::new(
        "sandbox_lock_checks",
        "sandboxLockChecks",
        lock::SANDBOX_LOCK_CHECKS,
        lock::sandbox_lock_checks,
    ),
    Door::new(
        "binding_checks",
        "bindingChecks",
        lock::BINDING_CHECKS,
        lock::binding_checks,
    ),
    Door::new(
        "model_tiers",
        "modelTiers",
        lock::MODEL_TIERS,
        lock::model_tiers,
    ),
    Door::new(
        "packaged_lock",
        "packagedLock",
        lock::PACKAGED_LOCK,
        lock::packaged_lock,
    ),
    Door::new(
        "agent_models",
        "agentModels",
        lock::AGENT_MODELS,
        lock::agent_models,
    ),
    Door::new(
        "sandbox_requirements",
        "sandboxRequirements",
        lock::SANDBOX_REQUIREMENTS,
        lock::sandbox_requirements,
    ),
    Door::new(
        "requirement_for",
        "requirementFor",
        lock::REQUIREMENT_FOR,
        lock::requirement_for,
    ),
    Door::new(
        "denial_diagnostics",
        "denialDiagnostics",
        lock::DENIAL_DIAGNOSTICS,
        lock::denial_diagnostics,
    ),
    Door::new(
        "apply_patch",
        "applyPatch",
        patch::APPLY_PATCH,
        patch::apply_patch,
    ),
    Door::new(
        "check_patch",
        "checkPatch",
        patch::CHECK_PATCH,
        patch::check_patch,
    ),
    Door::new(
        "check_subprogram",
        "checkSubprogram",
        patch::CHECK_SUBPROGRAM,
        patch::check_subprogram,
    ),
    Door::new(
        "check_amendment",
        "checkAmendment",
        patch::CHECK_AMENDMENT,
        patch::check_amendment,
    ),
    Door::noted(
        "semantic_diff",
        "semanticDiff",
        patch::SEMANTIC_DIFF,
        MODULES_NOTE,
        patch::semantic_diff,
    ),
    Door::new(
        "governance_changes",
        "governanceChanges",
        patch::GOVERNANCE_CHANGES,
        patch::governance_changes,
    ),
    Door::new(
        "envelope_changes",
        "envelopeChanges",
        patch::ENVELOPE_CHANGES,
        patch::envelope_changes,
    ),
    Door::new("grant", "grant", authority::GRANT, authority::grant),
    Door::new("narrow", "narrow", authority::NARROW, authority::narrow),
    Door::new(
        "map_scopes",
        "mapScopes",
        authority::MAP_SCOPES,
        authority::map_scopes,
    ),
    Door::new(
        "in_flight_overlap",
        "inFlightOverlap",
        authority::IN_FLIGHT_OVERLAP,
        authority::in_flight_overlap,
    ),
    Door::own(
        "explain",
        tables::EXPLAIN,
        "What `mandate explain <code>` and the MCP tool mandate.explain answer: { code, title, explain } for the code, with MDT- put in front when it lacks it, or null when there is no such code. Every row of the Rust table of codes, those added from language 0.6 on included.",
        tables::explain,
    ),
    Door::own(
        "codes",
        tables::CODES,
        "The whole table of diagnostic codes, { \"MDT-E0101\": { title, explain }, ... } in the table's order, as CODES is written: every row of the Rust table, those added from language 0.6 on included: the rows of CODES, then the codes of 0.6, which CODES does not have.",
        tables::codes,
    ),
    Door::own(
        "tables",
        tables::TABLES,
        "Every constant the TypeScript entry point exports as a value, by its export name, in the order of the names (UTF-16): its JSON.stringify text, a Set as an array and a Map as an object. CODES is the rows of the TypeScript's table (the codes door has every row).",
        tables::tables,
    ),
];

/// The note of a library door: no TypeScript function stands for it.
const LIBRARY_NOTE: &str = "Language 0.6, which only the Rust compiler reads: no TypeScript function stands for it, and crates/mandate-check/tests/library_doors.rs holds it to the compiler's functions (crate::library).";

/// The library doors of language 0.6 (spec/library.md "The bridge"), in a
/// table of their own, since no TypeScript function stands for them and
/// [`DOORS`] is held to the TypeScript call for call. It is committed as
/// `crates/mandate-check/tests/library_doors/doors.json`, and the
/// dispatcher (`mandate-doors`) joins it after the views' table.
pub static LIBRARY_DOORS: &[Door] = &[
    Door::own(
        "library_verify",
        library::LIBRARY_VERIFY,
        LIBRARY_NOTE,
        library::library_verify,
    ),
    Door::own(
        "library_add",
        library::LIBRARY_ADD,
        LIBRARY_NOTE,
        library::library_add,
    ),
    Door::own(
        "library_upgrade",
        library::LIBRARY_UPGRADE,
        LIBRARY_NOTE,
        library::library_upgrade,
    ),
    Door::own(
        "library_publish",
        library::LIBRARY_PUBLISH,
        LIBRARY_NOTE,
        library::library_publish,
    ),
    Door::own(
        "authority_signature",
        library::AUTHORITY_SIGNATURE,
        LIBRARY_NOTE,
        library::authority_signature,
    ),
    Door::own(
        "attention_facts",
        attention::ATTENTION_FACTS,
        ATTENTION_NOTE,
        attention::attention_facts,
    ),
];

/// The note of the door of the attention facts (language 0.7).
const ATTENTION_NOTE: &str = "Language 0.7, which only the Rust compiler reads: the attention facts of a workflow (spec/attention.md, The facts), from the typing of the check that checks it, with the input of the door check and the workflow's name; null when the program does not check. No TypeScript function stands for it, and crates/mandate-testkit/tests/attention_0_7.rs holds it to the fixtures of 0.7.";

/// The library door named `name`.
#[must_use]
pub fn library_door(name: &str) -> Option<&'static Door> {
    LIBRARY_DOORS.iter().find(|d| d.name == name)
}
