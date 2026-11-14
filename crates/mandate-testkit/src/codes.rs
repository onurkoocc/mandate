//! Which stage of the compiler raises each diagnostic code, and which slice
//! of the Rust port brings that stage: the table the gates name their
//! pending items by.
//!
//! An item of a gate that runs the compiler (a conformance case, a stored
//! result, a golden output, a program of the corpus) is named
//! `<door> @ <id> [<codes>]` ([`item_name`]), the codes being the sorted set
//! of the codes its expected result holds (`[]` for none). Its pending list
//! is then a handful of globs by code family, `*MDT-E02*`, each the glob of
//! a row of [`FAMILIES`] that is not ported yet, and of door globs for a
//! front door that is not ported (`check_patched @ *`). [`check_pending`]
//! holds a list to that.
//!
//! The rows come from `compiler/src/codes.ts` (every code), from where each
//! code is raised in `compiler/src` (`diag("E…"`), and from the slices of
//! the port: R6 the schema, R7 the parser, R9 `link`, `resolveNames`,
//! `roleChecks` and the front door, R10 the capabilities, R11 the static
//! core (`check/ty.ts`, `check/cost.ts`, part of `check/static.ts`), R12
//! the static authority (part of `check/static.ts`, `check/envelope.ts`),
//! R13 the system model, change sets, sub-programs, amendments and patches
//! (the rest of `check/static.ts`, `check/subprogram.ts`,
//! `check/amendment.ts`, `patch/patch.ts`), R14 the lock and the sandbox
//! (`lock.ts`, `target/managed-agents.ts`, `target/sandbox.ts`), R15 the views.
//!
//! Two codes are raised in two stages of different slices: E0105 (the reader
//! and `validateIr`, R6; the static checks' limit of expanded nodes, R11) and
//! E0504 (`check/static.ts`, R11; `lock.ts`, R14). Each has the row of the
//! stage that is ported, so that no gate lists its family as pending, and the
//! items the other stage gives are named one by one in the gates that hold
//! them (the corpus's `check`).

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
        slice: "R13",
        ported: false,
    },
    Family {
        glob: "*MDT-E014*",
        codes: "E0140-E0142",
        stage: "validateLock and lockChecks (lock.ts)",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E02*",
        codes: "E0201-E0233",
        stage: "staticCheck: types and expressions (check/ty.ts, check/static.ts)",
        slice: "R11",
        ported: false,
    },
    Family {
        glob: "*MDT-W02*",
        codes: "W0207, W0232",
        stage: "staticCheck (check/static.ts)",
        slice: "R11",
        ported: false,
    },
    Family {
        glob: "*MDT-E03*",
        codes: "E0301-E0320",
        stage: "staticCheck: capabilities and delegation (check/static.ts)",
        slice: "R12",
        ported: false,
    },
    Family {
        glob: "*MDT-W0310*",
        codes: "W0310",
        stage: "staticCheck (check/static.ts)",
        slice: "R12",
        ported: false,
    },
    Family {
        glob: "*MDT-W0311*",
        codes: "W0311",
        stage: "denialDiagnostics (target/sandbox.ts), not check",
        slice: "R14",
        ported: true,
    },
    Family {
        glob: "*MDT-E04*",
        codes: "E0401-E0408",
        stage: "staticCheck: effects (check/static.ts)",
        slice: "R12",
        ported: false,
    },
    Family {
        glob: "*MDT-E0501*",
        codes: "E0501",
        stage: "staticCheck: budgets and cost (check/static.ts, check/cost.ts)",
        slice: "R11",
        ported: false,
    },
    Family {
        glob: "*MDT-E0502*",
        codes: "E0502",
        stage: "staticCheck: budgets and cost (check/static.ts, check/cost.ts)",
        slice: "R11",
        ported: false,
    },
    Family {
        glob: "*MDT-E0503*",
        codes: "E0503",
        stage: "staticCheck: budgets and cost (check/static.ts, check/cost.ts)",
        slice: "R11",
        ported: false,
    },
    Family {
        glob: "*MDT-E0504*",
        codes: "E0504",
        stage: "lockChecks: an agent's budget in another currency than its tier's price (lock.ts, R14); also staticCheck: a delegation in two currencies (check/static.ts, R11), whose items a gate names itself",
        slice: "R14",
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
        stage: "staticCheck (check/static.ts)",
        slice: "R12",
        ported: false,
    },
    Family {
        glob: "*MDT-W06*",
        codes: "W0601",
        stage: "staticCheck: a criterion checked at run time (check/static.ts)",
        slice: "R12",
        ported: false,
    },
    Family {
        glob: "*MDT-E07*",
        codes: "E0701-E0715",
        stage: "staticCheck (check/static.ts)",
        slice: "R12",
        ported: false,
    },
    Family {
        glob: "*MDT-E09*",
        codes: "E0902-E0906, W0907",
        stage: "the targets: E0903-E0905 from bindingChecks (target/managed-agents.ts), which lockChecks runs in check with a lock; E0906, W0907 from target/acs.ts; E0902 from the runtime only",
        slice: "R14 (managed agents); ACS is out of the port",
        ported: true,
    },
    Family {
        glob: "*MDT-E10*",
        codes: "E1001-E1007",
        stage: "staticCheck: the system model (check/static.ts)",
        slice: "R13",
        ported: false,
    },
    Family {
        glob: "*MDT-E11*",
        codes: "E1101-E1105",
        stage: "staticCheck: change sets (check/static.ts)",
        slice: "R13",
        ported: false,
    },
    Family {
        glob: "*MDT-E12*",
        codes: "E1201",
        stage: "staticCheck: reads (check/static.ts)",
        slice: "R13",
        ported: false,
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
        glob: "*MDT-E17*",
        codes: "E1701-E1709",
        stage: "staticCheck: envelopes (check/static.ts, check/envelope.ts, R12); checkSubprogram, checkAmendment (check/subprogram.ts, check/amendment.ts, R13)",
        slice: "R12, R13",
        ported: false,
    },
    Family {
        glob: "*MDT-E1801*",
        codes: "E1801",
        stage: "staticCheck: methods of net.https (check/static.ts)",
        slice: "R12",
        ported: false,
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
/// not ported, and each other entry names a door (`<door> @ *`).
///
/// # Errors
///
/// Each entry that is neither, one a line.
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
        } else if !entry.ends_with(" @ *") {
            problems.push(format!(
                "{entry:?} names neither a family of codes nor a door"
            ));
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
        assert_eq!(family_of("MDT-W0601").map(|f| f.slice), Some("R12"));
        assert_eq!(family_of("MDT-E1502").map(|f| f.slice), Some("R14"));
        assert!(family_of("MDT-X0000").is_none());
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
        assert!(check_pending(&["*MDT-E02*", "check_patched @ *"]).is_ok());
        assert!(check_pending(&["*MDT-E012*"]).is_err());
        assert!(check_pending(&["*MDT-E2*"]).is_err());
        assert!(check_pending(&["something"]).is_err());
    }
}
