//! Which stage of the compiler raises each diagnostic code: the table the
//! gates name their pending items by (and which stage the Rust compiler
//! gives, which is every one now).
//!
//! An item of a gate that runs the compiler (a conformance case, a stored
//! result, a golden output, a program of the corpus) is named
//! `<door> @ <id> [<codes>]` ([`item_name`]), the codes being the sorted set
//! of the codes its expected result holds (`[]` for none). Its pending list
//! is then a handful of globs by code family, `*MDT-E03*`, each the glob of
//! a row of [`FAMILIES`] that the Rust does not give yet, and of door globs
//! for a front door it does not give (`check_subprogram @ *`), and the few
//! items that still fail although every code they hold is of a row the Rust
//! gives, by name or by a pattern that starts with their door (`check @
//! conformance/S08a [MDT-E0213]`), each with the function that ends it
//! beside it. [`check_pending`] holds a list to that. Every row is given now
//! and every list is empty; the rows stay so that a new family of codes can
//! be added as a row that is not given yet.
//!
//! The rows come from the table of codes (`mandate_ir::codes`, which equals
//! `compiler/src/codes.ts` up to language 0.5; a test below holds every code
//! of it to a row) and from where each code is raised in `compiler/src`
//! (`diag("E…"`). A row is one code or
//! a few that one stage raises, so a family that two stages share is cut
//! into rows (E02, E04, E05, E07, E10, E17). Some codes are raised in
//! several stages: E0105 (the reader and `validateIr`; the static checks'
//! limit of expanded nodes), E0201 (the core of the static checks; `map`,
//! `delegate`, `effectCall`; `changeset`), E0210 and E0213 (the core;
//! `checkEffectDecl`, `checkExtern`, `checkAgent`), E0215 (`prompt`;
//! capability arguments), E0501 (`checkBudget`; `mapBudget`) and E0504
//! (`check/static.ts`; `lock.ts`). Their row says given once its first stage
//! is, and a gate names each item that still fails for a later one.

use mandate_ir::codes::Reference;

/// One row of the table: a family of codes, where it is raised, and whether
/// the Rust compiler gives them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Family {
    /// The glob an item name is matched by, such as `*MDT-E02*`.
    pub glob: &'static str,
    /// The codes, as `codes.ts` has them.
    pub codes: &'static str,
    /// The stage of `check` (or the other front door) that raises them.
    pub stage: &'static str,
    /// Whether the Rust compiler gives them (all of them do). A pending
    /// list may name only a family for which this is false.
    pub ported: bool,
    /// The compiler that is the reference for the codes of the family: the
    /// reference of every row of `mandate_ir::codes` that the family holds.
    pub reference: Reference,
}

/// The families, in the order of the codes.
pub const FAMILIES: &[Family] = &[
    Family {
        glob: "*MDT-E010*",
        codes: "E0101-E0108",
        stage: "load: the strict JSON reader, the parser, validateIr",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E012*",
        codes: "E0120, E0121",
        stage: "load (the parser), link (modules.ts), resolveNames (resolve/resolve.ts), loadModules",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E013*",
        codes: "E0130, E0131",
        stage: "applyOps (patch/patch.ts), the apply_ops door",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E014*",
        codes: "E0140-E0142",
        stage: "validateLock and lockChecks (lock.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E020*",
        codes: "E0201-E0204",
        stage: "staticCheck: types (check/ty.ts; call, verify, field, record in check/static.ts); E0201 also from map, delegate, effectCall and changeset",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E021*",
        codes: "E0210-E0215",
        stage: "staticCheck: epistemic rules (check/ty.ts; switchExpr, record, infer, prompt in check/static.ts); E0210 also from checkEffectDecl, E0213 from checkExtern and checkAgent, E0215 from capability arguments",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E022*",
        codes: "E0220",
        stage: "staticCheck: data classes against a model's capability and an envelope (overEnvelope, overModel, reach in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E023*",
        codes: "E0230-E0233",
        stage: "staticCheck: switch and Choice (switchExpr, choiceOptions in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-W02*",
        codes: "W0207, W0232",
        stage: "staticCheck: peek and a Choice's options (call, choiceOptions in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E03*",
        codes: "E0301-E0320",
        stage: "staticCheck: capabilities and delegation (check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-W0310*",
        codes: "W0310",
        stage: "staticCheck (check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-W0311*",
        codes: "W0311",
        stage: "denialDiagnostics (target/sandbox.ts), not check",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0401*",
        codes: "E0401",
        stage: "staticCheck: a public function without effects (fnUsages in check/static.ts); what a body uses but does not declare (checkUsagesDeclared)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0402*",
        codes: "E0402",
        stage: "staticCheck: an unknown effect (effectNames in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0403*",
        codes: "E0403",
        stage: "staticCheck: idempotency of a critical effect (checkEffectDecl, effectCall in check/static.ts; changeset)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0405*",
        codes: "E0405",
        stage: "staticCheck: an irreversible effect without an approval (effectCall in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0408*",
        codes: "E0408",
        stage: "staticCheck: a critical effect outside a workflow (checkAgent, effectCall in check/static.ts; changeset)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0501*",
        codes: "E0501",
        stage: "staticCheck: budgets (checkBudget in check/static.ts, check/cost.ts); also mapBudget",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0502*",
        codes: "E0502",
        stage: "staticCheck: call cycles and unbounded loops (findRecursion, body in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0503*",
        codes: "E0503",
        stage: "staticCheck: an agent loop without steps (checkAgent in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0504*",
        codes: "E0504",
        stage: "staticCheck: a delegation in another currency than the budget (overBudget in check/static.ts); lockChecks: an agent's budget in another currency than its tier's price (lock.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-W0504*",
        codes: "W0504",
        stage: "lockChecks (lock.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E06*",
        codes: "E0603",
        stage: "staticCheck: a criterion only review(…) satisfies (verifier in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-W06*",
        codes: "W0601",
        stage: "staticCheck: a criterion checked at run time (verifier in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E070*",
        codes: "E0701",
        stage: "staticCheck: C2, what a delegation or a map hands over (given, map in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0710*",
        codes: "E0710",
        stage: "staticCheck: restart_all over external effects (par in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0711*",
        codes: "E0711",
        stage: "staticCheck: spawn (exprInner in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0712*",
        codes: "E0712",
        stage: "staticCheck: UnknownOutcome handled only by reconcile (body in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0713*",
        codes: "E0713",
        stage: "staticCheck: supervision (supervise in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0714*",
        codes: "E0714",
        stage: "staticCheck: supervision (supervise, map in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E0715*",
        codes: "E0715",
        stage: "staticCheck: supervision (supervise in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E09*",
        codes: "E0902-E0906",
        stage: "the targets: E0903-E0905 from bindingChecks (target/managed-agents.ts), which lockChecks runs in check with a lock; E0906 from target/acs.ts; E0902 from the runtime only",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-W0907*",
        codes: "W0907",
        stage: "the targets: target/acs.ts",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1001*",
        codes: "E1001",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1002*",
        codes: "E1002",
        stage: "staticCheck: a capability over a component that cannot be opened or narrowed as one (evalCap in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1003*",
        codes: "E1003",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1004*",
        codes: "E1004",
        stage: "staticCheck: declared reads (checkRead in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1005*",
        codes: "E1005",
        stage: "staticCheck: declared reads (checkRead in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1006*",
        codes: "E1006",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1007*",
        codes: "E1007",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E11*",
        codes: "E1101-E1105",
        stage: "staticCheck: change sets (check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E12*",
        codes: "E1201",
        stage: "staticCheck: reads (check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1301*",
        codes: "E1301",
        stage: "Rust only: a pattern of a 0.6 program, its declaration and the uses of its slots (check_pattern, crates/mandate-check/src/expand/pattern.rs), at the pattern, or at the application of an imported one",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1302*",
        codes: "E1302",
        stage: "Rust only: a pattern of a 0.6 program, the authority it would bring (check_pattern, crates/mandate-check/src/expand/pattern.rs), at the pattern, or at the application of an imported one",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1303*",
        codes: "E1303",
        stage: "Rust only: an application of a 0.6 program, the name it applies (crates/mandate-check/src/expand/mod.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1304*",
        codes: "E1304",
        stage: "Rust only: an application of a 0.6 program, its slots and arguments (Reader::read, crates/mandate-check/src/expand/apply.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1305*",
        codes: "E1305",
        stage: "Rust only: an application of a 0.6 program, the fit of an argument (Reader::bind, crates/mandate-check/src/expand/apply.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1306*",
        codes: "E1306",
        stage: "Rust only: a pattern of a 0.6 program, its names (check_pattern, crates/mandate-check/src/expand/pattern.rs); an application, what its expansion names and captures (crates/mandate-check/src/expand/mod.rs, subst.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1307*",
        codes: "E1307",
        stage: "Rust only: an application of a 0.6 program where none may stand (crates/mandate-check/src/expand/mod.rs, apply.rs, pattern.rs; resolveNames, crates/mandate-check/src/resolve.rs; and staticCheck, a workflow left unexpanded)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1401*",
        codes: "E1401",
        stage: "Rust only: the connectors of a 0.6 program, a tool's class (crates/mandate-check/src/statics/tools.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1402*",
        codes: "E1402",
        stage: "Rust only: the connectors of a 0.6 program, a connector's declaration (and a tool declared twice, in the parser) (crates/mandate-check/src/statics/tools.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1403*",
        codes: "E1403",
        stage: "Rust only: the connectors of a 0.6 program, a tool's result (crates/mandate-check/src/statics/tools.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1404*",
        codes: "E1404",
        stage: "Rust only: the connectors of a 0.6 program, a tool.call (evalCap, crates/mandate-check/src/statics/tools.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1405*",
        codes: "E1405",
        stage: "Rust only: the connectors of a 0.6 program, where a tool is called (crates/mandate-check/src/statics/tools.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1406*",
        codes: "E1406",
        stage: "Rust only: the connectors of a 0.6 program, an agent that would hold a write tool (checkAgent, delegate) (crates/mandate-check/src/statics/tools.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1407*",
        codes: "E1407",
        stage: "Rust only: the connectors of a 0.6 program, the lock's connectors (connector_lock_checks, crates/mandate-check/src/lock.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1408*",
        codes: "E1408",
        stage: "Rust only: the connectors of a 0.6 program, the lock's connectors (connector_lock_checks, crates/mandate-check/src/lock.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1501*",
        codes: "E1501",
        stage: "roleChecks (check/roles.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1502*",
        codes: "E1502",
        stage: "roleLockChecks (lock.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1503*",
        codes: "E1503",
        stage: "roleChecks (check/roles.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1504*",
        codes: "E1504",
        stage: "Rust only: a contract of a 0.6 program, a waiver of a criterion a person approves (check_waivers, crates/mandate-check/src/statics/review.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1505*",
        codes: "E1505",
        stage: "Rust only: an irreversible effect of a 0.6 program, and a change set's (waivable_args, waivable_plan, crates/mandate-check/src/statics/review.rs), reached through effectCall and changeset",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1506*",
        codes: "E1506",
        stage: "Rust only: the source of a human.review (review_source, crates/mandate-check/src/statics/review.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1507*",
        codes: "E1507",
        stage: "Rust only: the arguments of a human.review (review_arguments, crates/mandate-check/src/statics/review.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1508*",
        codes: "E1508",
        stage: "Rust only: the roles of a human.review against the contract's waivers (review_roles, crates/mandate-check/src/statics/review.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1509*",
        codes: "E1509",
        stage: "Rust only: the method names of a contract's criteria, in a program of 0.7 (check_reserved_methods, crates/mandate-check/src/statics/review.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1602*",
        codes: "E1602",
        stage: "Rust only: the import checks of a 0.6 program (a use list, crates/mandate-check/src/imports.rs); an application of an imported pattern whose expansion names what its module does not make pub (crates/mandate-check/src/expand/mod.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1603*",
        codes: "E1603",
        stage: "Rust only: the import checks of a 0.1 to 0.5 program (crates/mandate-check/src/imports.rs); loadModules",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1604*",
        codes: "E1604",
        stage: "Rust only: the import checks of a 0.6 program (crates/mandate-check/src/imports.rs); loadModules",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1601*",
        codes: "E1601",
        stage: "Rust only: a library read (load_library, crates/mandate-check/src/library/mod.rs), in check and in the library doors",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1605*",
        codes: "E1605",
        stage: "Rust only: a library against the lock's pin (for_check, crates/mandate-check/src/library/mod.rs); upgrade",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1606*",
        codes: "E1606",
        stage: "Rust only: a library's requires against the pins (assemble, crates/mandate-check/src/library/mod.rs); add's resolution",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1607*",
        codes: "E1607",
        stage: "Rust only: publish's version rule (publish, crates/mandate-check/src/library/ops.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1608*",
        codes: "E1608",
        stage: "Rust only: a revoked pin with the configuration (for_check); add's and upgrade's resolution (crates/mandate-check/src/library/ops.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1609*",
        codes: "E1609",
        stage: "Rust only: a 0.6 program or later that imports a module of a newer language (the import checks, crates/mandate-check/src/imports.rs) or whose lock pins a library of one (for_check, crates/mandate-check/src/library/mod.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1701*",
        codes: "E1701",
        stage: "staticCheck: an envelope's own fields (checkEnvelope in check/envelope.ts); also checkAmendment (check.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1702*",
        codes: "E1702",
        stage: "staticCheck: a map's bound (map in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1703*",
        codes: "E1703",
        stage: "staticCheck: a map's par against the envelope (map in check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1704*",
        codes: "E1704",
        stage: "staticCheck: an envelope's approvals (checkEnvelope in check/envelope.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1705*",
        codes: "E1705",
        stage: "checkSubprogram: a sub-program's shape (subprogramShape in check/subprogram.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1706*",
        codes: "E1706",
        stage: "checkSubprogram: containment (check/subprogram.ts); staticCheck with a claim: overEnvelope, overModel (check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1707*",
        codes: "E1707",
        stage: "staticCheck: a plan outside an envelope's body (plansOutside in check/envelope.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1708*",
        codes: "E1708",
        stage: "staticCheck: a person or a critical effect in a map's body (person, critical in check/static.ts), reached through map and changeset",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1709*",
        codes: "E1709",
        stage: "checkAmendment: an amendment narrows nothing (narrowings in check/amendment.ts); 0.6, Rust only: the envelope's shapes, dimension shapes (crates/mandate-check/src/amendment.rs)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1710*",
        codes: "E1710",
        stage: "Rust only: check_subprogram, a sub-program under an envelope with shapes applies one of them (subprogram_shape_of, crates/mandate-check/src/shapes.rs)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1711*",
        codes: "E1711",
        stage: "Rust only: an envelope's shapes in a 0.6 program, each a pattern (shape_checks, crates/mandate-check/src/shapes.rs), after the role checks",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1801*",
        codes: "E1801",
        stage: "staticCheck: methods of net.https (check/static.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1802*",
        codes: "E1802",
        stage: "lockChecks (lock.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1803*",
        codes: "E1803",
        stage: "lockChecks (lock.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1804*",
        codes: "E1804",
        stage: "importedMethods (check/caps.ts)",
        ported: true,
        reference: Reference::TypeScript,
    },
    Family {
        glob: "*MDT-E1901*",
        codes: "E1901",
        stage: "Rust only: the stages of a 0.7 program, where each stands (stage_checks, crates/mandate-check/src/stages.rs), after the shapes of an envelope, and again on what an expansion writes",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1902*",
        codes: "E1902",
        stage: "Rust only: the stages of a 0.7 program, the list of each body and each title (stage_checks, crates/mandate-check/src/stages.rs), after the shapes of an envelope, and again on what an expansion writes",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1903*",
        codes: "E1903",
        stage: "Rust only: the reports of a 0.7 program, each title, the names of its fields and a pattern's role slot (report_checks, crates/mandate-check/src/reports.rs), after the stages, and again on what an expansion writes",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1904*",
        codes: "E1904",
        stage: "Rust only: the fields of a 0.7 report, pure (report_checks, crates/mandate-check/src/reports.rs, after the stages and again on an expansion) and of a type a person is shown (the static checks' typing, statics::report_stmt)",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1905*",
        codes: "E1905",
        stage: "Rust only: where a 0.7 report stands (report_checks, crates/mandate-check/src/reports.rs), after the stages, and again on what an expansion writes",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1906*",
        codes: "E1906",
        stage: "Rust only: the attention bound of a 0.7 workflow against its declared asks (crates/mandate-check/src/asks.rs), at the end of the static checks, once every definition is typed; on an expansion, reported at the application",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1907*",
        codes: "E1907",
        stage: "Rust only: a question the attention bound cannot count, in a 0.7 workflow that declares asks (crates/mandate-check/src/asks.rs), at the end of the static checks",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1908*",
        codes: "E1908",
        stage: "Rust only: asks in a budget that is neither a workflow's nor an envelope's (asks_checks, crates/mandate-check/src/asks.rs), after the reports",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1910*",
        codes: "E1910",
        stage: "Rust only: a 0.7 workflow's owner beside an envelope (owner_checks, crates/mandate-check/src/owner.rs), after asks_checks; with a lock that asks for the promotion ladder, a workflow with neither an owner nor an envelope (promotion_checks), after the lock checks, on the program as written",
        ported: true,
        reference: Reference::Rust,
    },
    Family {
        glob: "*MDT-E1911*",
        codes: "E1911",
        stage: "Rust only: a lock's role_classes or promotion with a program older than 0.7 (attention_lock_checks, crates/mandate-check/src/lock.rs), the last of the lock checks",
        ported: true,
        reference: Reference::Rust,
    },
];

/// The family of `code` (`MDT-E0120`), when the table has one.
#[must_use]
pub fn family_of(code: &str) -> Option<&'static Family> {
    FAMILIES.iter().find(|f| {
        let prefix = f.glob.trim_matches('*');
        code.starts_with(prefix)
    })
}

/// The sorted set of `codes`, each once.
#[must_use]
pub fn code_set<S: AsRef<str>>(codes: impl IntoIterator<Item = S>) -> Vec<String> {
    let mut out: Vec<String> = codes.into_iter().map(|c| c.as_ref().to_owned()).collect();
    out.sort();
    out.dedup();
    out
}

/// The name of a gate item: `<door> @ <id> [<codes>]`, the codes being the
/// sorted set of those its expected result holds, such as
/// `check @ conformance/S03a [MDT-E0120]` or `check @ fixtures/a.mdt []`.
#[must_use]
pub fn item_name<S: AsRef<str>>(
    door: &str,
    id: &str,
    codes: impl IntoIterator<Item = S>,
) -> String {
    format!("{door} @ {id} [{}]", code_set(codes).join(" "))
}

/// Holds a pending list to the rule of the gates: each entry that names a
/// family of codes (`*MDT-…*`) is the glob of a row of [`FAMILIES`] that is
/// not ported; each other entry names a door (`<door> @ *`) or items of one
/// door, by name or by a pattern after its door and ` @ ` that is not `*`
/// alone (`check @ conformance/S08a [MDT-E0213]`, `check @ check-1f* [*`).
///
/// # Errors
///
/// Each entry that is none of these, one a line.
pub fn check_pending(pending: &[&str]) -> Result<(), String> {
    let mut problems = Vec::new();
    for entry in pending {
        if entry.starts_with("*MDT-") {
            match FAMILIES.iter().find(|f| f.glob == *entry) {
                Some(f) if !f.ported => {}
                Some(f) => problems.push(format!(
                    "{entry:?} is the family {}, which the Rust compiler gives",
                    f.codes
                )),
                None => problems.push(format!("{entry:?} is no family of the table")),
            }
            continue;
        }
        let door_ok = |door: &str| !door.is_empty() && !door.contains('*');
        match entry.split_once(" @ ") {
            Some((door, rest)) if door_ok(door) && !rest.is_empty() => {}
            _ => problems.push(format!(
                "{entry:?} names neither a family of codes, nor a door, nor items of one door"
            )),
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::{FAMILIES, check_pending, family_of, item_name};

    #[test]
    fn names_and_families() {
        assert_eq!(
            item_name(
                "check",
                "conformance/V02",
                ["MDT-W0504", "MDT-E0301", "MDT-W0504"]
            ),
            "check @ conformance/V02 [MDT-E0301 MDT-W0504]"
        );
        assert_eq!(
            item_name::<&str>("load", "fixtures/a.mdt", []),
            "load @ fixtures/a.mdt []"
        );
        assert_eq!(family_of("MDT-E0120").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-W0601").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E0220").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E0213").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E1708").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E1706").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E1705").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E1502").map(|f| f.ported), Some(true));
        assert!(family_of("MDT-X0000").is_none());
        // Every code of the table of codes has a row, and the row names the
        // same compiler as the reference as the code's own does.
        for row in mandate_ir::codes::iter() {
            let family = family_of(row.code);
            assert!(family.is_some(), "{} belongs to no family", row.code);
            assert_eq!(
                family.map(|f| f.reference),
                Some(row.reference),
                "{}",
                row.code
            );
        }
        // No two rows claim one code.
        for f in FAMILIES {
            let prefix = f.glob.trim_matches('*');
            let claimed = FAMILIES
                .iter()
                .filter(|g| {
                    let p = g.glob.trim_matches('*');
                    p.starts_with(prefix) || prefix.starts_with(p)
                })
                .count();
            assert_eq!(claimed, 1, "{}", f.glob);
        }
        // Every family is ported, so none is a family a list may name.
        assert!(FAMILIES.iter().all(|f| f.ported));
        assert!(check_pending(&["apply_ops @ *"]).is_ok());
        assert!(check_pending(&["*MDT-E1001*"]).is_err());
        assert!(check_pending(&["*MDT-E022*"]).is_err());
        assert!(check_pending(&["*MDT-E10*"]).is_err());
        assert!(
            check_pending(&[
                "check @ conformance/S08a [MDT-E0213]",
                "check @ check-1f* [*"
            ])
            .is_ok()
        );
        assert!(check_pending(&["*MDT-E012*"]).is_err());
        assert!(check_pending(&["*MDT-E021*"]).is_err());
        assert!(check_pending(&["*MDT-E2*"]).is_err());
        assert!(check_pending(&["something"]).is_err());
        assert!(check_pending(&["* @ x"]).is_err());
        assert!(check_pending(&["check @ "]).is_err());
    }
}
