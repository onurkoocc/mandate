//! Which stage of the compiler raises each diagnostic code, and which slice
//! of the Rust port brings that stage: the table the gates name their
//! pending items by.
//!
//! An item of a gate that runs the compiler (a conformance case, a stored
//! result, a golden output, a program of the corpus) is named
//! `<door> @ <id> [<codes>]` ([`item_name`]), the codes being the sorted set
//! of the codes its expected result holds (`[]` for none). Its pending list
//! is then a handful of globs by code family, `*MDT-E03*`, each the glob of
//! a row of [`FAMILIES`] that is not ported yet, and of door globs for a
//! front door that is not ported (`check_subprogram @ *`), and the few
//! items that still fail although every code they hold is of a ported row,
//! by name or by a pattern that starts with their door (`check @
//! conformance/S08a [MDT-E0213]`), each with the slice and the function
//! that ends it beside it. [`check_pending`] holds a list to that.
//!
//! The rows come from `compiler/src/codes.ts` (every code), from where each
//! code is raised in `compiler/src` (`diag("E…"`), and from the slices of
//! the port: R6 the schema, R7 the parser, R9 `link`, `resolveNames`,
//! `roleChecks` and the front door, R10 the capabilities, R11 the static
//! core (`check/ty.ts`, `check/cost.ts`, part of `check/static.ts`), R12
//! the static authority (part of `check/static.ts`, `check/envelope.ts`),
//! R13 the system model, change sets, sub-programs and amendments (the rest
//! of `check/static.ts`, `check/subprogram.ts`, `check/amendment.ts`), R14
//! the lock and the sandbox (`lock.ts`, `target/managed-agents.ts`,
//! `target/sandbox.ts`), R15 the views, R16 the comparison of two programs
//! and patches (`patch/patch.ts`).
//!
//! A row is one code or a few that one slice brings, so a family that two
//! slices share is cut into rows (E02, E04, E05, E07, E10, E17). Some codes are still
//! raised in stages of different slices: E0105 (the reader and
//! `validateIr`, R6; the static checks' limit of expanded nodes, R11),
//! E0201 (the core, R11; `map`, `delegate`, `effectCall`, R12; `changeset`,
//! R13), E0210 and E0213 (the core, R11; `checkEffectDecl`, `checkExtern`,
//! `checkAgent`, R12), E0215 (`prompt`, R11; capability arguments, R12),
//! E0501 (`checkBudget`, R11; `mapBudget`, R12) and E0504
//! (`check/static.ts`, R11; `lock.ts`, R14). Their row says ported once the
//! first slice is, and a gate names each item that still fails for the
//! later one.

/// One row of the table: a family of codes, where it is raised, and the
/// slice of the port that brings it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Family {
    /// The glob an item name is matched by, such as `*MDT-E02*`.
    pub glob: &'static str,
    /// The codes, as `codes.ts` has them.
    pub codes: &'static str,
    /// The stage of `check` (or the other front door) that raises them.
    pub stage: &'static str,
    /// The slice of the port that brings that stage.
    pub slice: &'static str,
    /// Whether the Rust compiler gives them now.
    pub ported: bool,
}

/// The families, in the order of the codes.
pub const FAMILIES: &[Family] = &[
    Family {
        glob: "*MDT-E010*",
        codes: "E0101-E0108",
        stage: "load: the strict JSON reader, the parser, validateIr",
        slice: "R6, R7",
        ported: true,
    },
    Family {
        glob: "*MDT-E012*",
        codes: "E0120, E0121",
        stage: "load (the parser), link (modules.ts), resolveNames (resolve/resolve.ts), loadModules",
        slice: "R7, R9",
        ported: true,
    },
    Family {
        glob: "*MDT-E013*",
        codes: "E0130, E0131",
        stage: "applyOps (patch/patch.ts), the apply_ops door",
        slice: "R16",
        ported: true,
    },
    Family {
        glob: "*MDT-E014*",
        codes: "E0140-E0142",
        stage: "validateLock and lockChecks (lock.ts)",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E020*",
        codes: "E0201-E0204",
        stage: "staticCheck: types (check/ty.ts; call, verify, field, record in check/static.ts); E0201 also from map, delegate, effectCall (R12) and changeset (R13)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E021*",
        codes: "E0210-E0215",
        stage: "staticCheck: epistemic rules (check/ty.ts; switchExpr, record, infer, prompt in check/static.ts); E0210 also from checkEffectDecl, E0213 from checkExtern and checkAgent, E0215 from capability arguments (R12)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E022*",
        codes: "E0220",
        stage: "staticCheck: data classes against a model's capability and an envelope (overEnvelope, overModel, reach in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E023*",
        codes: "E0230-E0233",
        stage: "staticCheck: switch and Choice (switchExpr, choiceOptions in check/static.ts)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-W02*",
        codes: "W0207, W0232",
        stage: "staticCheck: peek and a Choice's options (call, choiceOptions in check/static.ts)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E03*",
        codes: "E0301-E0320",
        stage: "staticCheck: capabilities and delegation (check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-W0310*",
        codes: "W0310",
        stage: "staticCheck (check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-W0311*",
        codes: "W0311",
        stage: "denialDiagnostics (target/sandbox.ts), not check",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E0401*",
        codes: "E0401",
        stage: "staticCheck: a public function without effects (fnUsages in check/static.ts, R11); what a body uses but does not declare (checkUsagesDeclared, R12)",
        slice: "R11, R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0402*",
        codes: "E0402",
        stage: "staticCheck: an unknown effect (effectNames in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0403*",
        codes: "E0403",
        stage: "staticCheck: idempotency of a critical effect (checkEffectDecl, effectCall in check/static.ts, R12; changeset, R13)",
        slice: "R12, R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E0405*",
        codes: "E0405",
        stage: "staticCheck: an irreversible effect without an approval (effectCall in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0408*",
        codes: "E0408",
        stage: "staticCheck: a critical effect outside a workflow (checkAgent, effectCall in check/static.ts, R12; changeset, R13)",
        slice: "R12, R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E0501*",
        codes: "E0501",
        stage: "staticCheck: budgets (checkBudget in check/static.ts, check/cost.ts); also mapBudget (R12)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E0502*",
        codes: "E0502",
        stage: "staticCheck: call cycles and unbounded loops (findRecursion, body in check/static.ts)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E0503*",
        codes: "E0503",
        stage: "staticCheck: an agent loop without steps (checkAgent in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0504*",
        codes: "E0504",
        stage: "staticCheck: a delegation in another currency than the budget (overBudget in check/static.ts, R11); lockChecks: an agent's budget in another currency than its tier's price (lock.ts, R14)",
        slice: "R11, R14",
        ported: true,
    },
    Family {
        glob: "*MDT-W0504*",
        codes: "W0504",
        stage: "lockChecks (lock.ts)",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E06*",
        codes: "E0603",
        stage: "staticCheck: a criterion only review(…) satisfies (verifier in check/static.ts)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-W06*",
        codes: "W0601",
        stage: "staticCheck: a criterion checked at run time (verifier in check/static.ts)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E070*",
        codes: "E0701",
        stage: "staticCheck: C2, what a delegation or a map hands over (given, map in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0710*",
        codes: "E0710",
        stage: "staticCheck: restart_all over external effects (par in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0711*",
        codes: "E0711",
        stage: "staticCheck: spawn (exprInner in check/static.ts)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E0712*",
        codes: "E0712",
        stage: "staticCheck: UnknownOutcome handled only by reconcile (body in check/static.ts)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E0713*",
        codes: "E0713",
        stage: "staticCheck: supervision (supervise in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0714*",
        codes: "E0714",
        stage: "staticCheck: supervision (supervise, map in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E0715*",
        codes: "E0715",
        stage: "staticCheck: supervision (supervise in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E09*",
        codes: "E0902-E0906, W0907",
        stage: "the targets: E0903-E0905 from bindingChecks (target/managed-agents.ts), which lockChecks runs in check with a lock; E0906, W0907 from target/acs.ts; E0902 from the runtime only",
        slice: "R14 (managed agents); ACS is out of the port",
        ported: true,
    },
    Family {
        glob: "*MDT-E1001*",
        codes: "E1001",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1002*",
        codes: "E1002",
        stage: "staticCheck: a capability over a component that cannot be opened or narrowed as one (evalCap in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E1003*",
        codes: "E1003",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1004*",
        codes: "E1004",
        stage: "staticCheck: declared reads (checkRead in check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1005*",
        codes: "E1005",
        stage: "staticCheck: declared reads (checkRead in check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1006*",
        codes: "E1006",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1007*",
        codes: "E1007",
        stage: "staticCheck: the system model (checkSystem in check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E11*",
        codes: "E1101-E1105",
        stage: "staticCheck: change sets (check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E12*",
        codes: "E1201",
        stage: "staticCheck: reads (check/static.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1501*",
        codes: "E1501",
        stage: "roleChecks (check/roles.ts)",
        slice: "R9",
        ported: true,
    },
    Family {
        glob: "*MDT-E1502*",
        codes: "E1502",
        stage: "roleLockChecks (lock.ts)",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E1503*",
        codes: "E1503",
        stage: "roleChecks (check/roles.ts)",
        slice: "R9",
        ported: true,
    },
    Family {
        glob: "*MDT-E1701*",
        codes: "E1701",
        stage: "staticCheck: an envelope's own fields (checkEnvelope in check/envelope.ts); also checkAmendment (check.ts, R13)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E1702*",
        codes: "E1702",
        stage: "staticCheck: a map's bound (map in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E1703*",
        codes: "E1703",
        stage: "staticCheck: a map's par against the envelope (map in check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E1704*",
        codes: "E1704",
        stage: "staticCheck: an envelope's approvals (checkEnvelope in check/envelope.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E1705*",
        codes: "E1705",
        stage: "checkSubprogram: a sub-program's shape (subprogramShape in check/subprogram.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1706*",
        codes: "E1706",
        stage: "checkSubprogram: containment (check/subprogram.ts, R13); staticCheck with a claim: overEnvelope, overModel (check/static.ts, R12)",
        slice: "R12, R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1707*",
        codes: "E1707",
        stage: "staticCheck: a plan outside an envelope's body (plansOutside in check/envelope.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E1708*",
        codes: "E1708",
        stage: "staticCheck: a person or a critical effect in a map's body (person, critical in check/static.ts), reached through map (R12) and changeset (R13)",
        slice: "R11",
        ported: true,
    },
    Family {
        glob: "*MDT-E1709*",
        codes: "E1709",
        stage: "checkAmendment: an amendment narrows nothing (narrowings in check/amendment.ts)",
        slice: "R13",
        ported: true,
    },
    Family {
        glob: "*MDT-E1801*",
        codes: "E1801",
        stage: "staticCheck: methods of net.https (check/static.ts)",
        slice: "R12",
        ported: true,
    },
    Family {
        glob: "*MDT-E1802*",
        codes: "E1802",
        stage: "lockChecks (lock.ts)",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E1803*",
        codes: "E1803",
        stage: "lockChecks (lock.ts)",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E1804*",
        codes: "E1804",
        stage: "importedMethods (check/caps.ts)",
        slice: "R9, R10",
        ported: true,
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
                    "{entry:?} is the family {}, which is ported ({})",
                    f.codes, f.slice
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
        assert_eq!(family_of("MDT-E0120").map(|f| f.slice), Some("R7, R9"));
        assert_eq!(family_of("MDT-W0601").map(|f| f.slice), Some("R11"));
        assert_eq!(family_of("MDT-E0220").map(|f| f.slice), Some("R12"));
        assert_eq!(family_of("MDT-E0213").map(|f| f.slice), Some("R11"));
        assert_eq!(family_of("MDT-E1708").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E1706").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E1705").map(|f| f.ported), Some(true));
        assert_eq!(family_of("MDT-E1502").map(|f| f.slice), Some("R14"));
        assert!(family_of("MDT-X0000").is_none());
        // Every code of codes.ts has a row.
        for code in [
            "E0201", "E0202", "E0203", "E0204", "E0210", "E0211", "E0212", "E0213", "E0215",
            "E0220", "E0230", "E0231", "E0233", "W0207", "W0232", "E0501", "E0502", "E0503",
            "E0504", "E0603", "W0601", "E0701", "E0710", "E0711", "E0712", "E0713", "E0714",
            "E0715", "E1701", "E1702", "E1703", "E1704", "E1705", "E1706", "E1707", "E1708",
            "E1709",
        ] {
            assert!(family_of(&format!("MDT-{code}")).is_some(), "{code}");
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
