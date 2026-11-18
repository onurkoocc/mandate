//! The views of one program as one document: `programDoc` of
//! `compiler/src/views/views.ts` (lines 1563-1583).

use mandate_check::{CheckOptions, Modules, VIEW_FORMAT, linked_program, program_ref};
use mandate_ir::{Program, Value};

use crate::architecture::{architecture_blocks, architecture_pinned};
use crate::attention::attention_doc_blocks;
use crate::authority::{authority_blocks, authority_pinned};
use crate::cost::{cost_blocks, cost_pinned};
use crate::doc::{Block, Doc};
use crate::system::{has_system, system, system_blocks};
use mandate_check::is_kind;

/// The program's views as one document, headed by the hash they show: the
/// architecture, the authority and the cost, then the system when the program
/// has one. With `modules`, capabilities over components open into the
/// imported system model, which is shown too: the views are of the program as
/// linked with the modules, and the title and the hash are of the program
/// itself. `programDoc(program, lock, modules)`.
///
/// A program of 0.7 has the attention view of each of its workflows after
/// the others ([`crate::attention`]); the document of a program of 0.1 to
/// 0.6 is what it was. The attention view is made from the facts of the
/// check, which is given the same `modules` and the same lock; a program that
/// needs libraries read from a directory is given them by
/// [`program_doc_given`].
#[must_use]
pub fn program_doc(program: &Value, lock: Option<&Value>, modules: Option<&Modules>) -> Doc {
    program_doc_pinned(program, lock, modules, None)
}

/// [`program_doc`] with the version of `std.patterns` a caller that holds
/// no lock names (0.7, `named`): each view's expansion reads the version
/// the lock pins, else `named`, else the version of the program's language.
/// What the document says it was generated from does not change with it. The
/// attention view reads the same version.
#[must_use]
pub fn program_doc_pinned(
    program: &Value,
    lock: Option<&Value>,
    modules: Option<&Modules>,
    named: Option<&mandate_check::library::Version>,
) -> Doc {
    let given = CheckOptions {
        modules,
        ..CheckOptions::default()
    };
    program_doc_given(program, lock, modules, named, &given)
}

/// [`program_doc_pinned`], with the options the check of the attention view
/// is given besides the lock and the version of `std.patterns`: the modules
/// the program was checked with and the libraries its lock pins
/// (`CheckOptions`; its `lock` and `std_patterns` are those given here).
/// `modules` is what the other views are given.
#[must_use]
pub fn program_doc_given(
    program: &Value,
    lock: Option<&Value>,
    modules: Option<&Modules>,
    named: Option<&mandate_check::library::Version>,
    check_with: &CheckOptions<'_>,
) -> Doc {
    let pin = mandate_check::library::std_patterns_pin(lock).or(named.copied());
    // The attention view's check reads the lock's pin itself; a version a
    // caller names is handed on only where the lock pins none (the lock wins).
    let check_with = CheckOptions {
        std_patterns: named
            .copied()
            .filter(|_| mandate_check::library::std_patterns_pin(lock).is_none()),
        ..*check_with
    };
    let r = program_ref(program);
    let given = modules.filter(|m| !m.is_empty());
    let p = Program::of(program);
    let linked_value: Option<Value> = match (p, given) {
        (Some(p), Some(_)) => Some(linked_program(p, modules)),
        _ => None,
    };
    let linked: &Value = linked_value.as_ref().unwrap_or(program);
    // A module that only describes a system (a system model) has no workflows or agents to show.
    let runs = p.is_some_and(|p| {
        p.definitions()
            .any(|(_, d)| is_kind(d.value(), "workflow") || is_kind(d.value(), "agent"))
    });
    let mut blocks: Vec<Block> = Vec::new();
    if runs {
        blocks.extend(architecture_blocks(&architecture_pinned(
            linked,
            lock,
            None,
            pin.as_ref(),
        )));
        blocks.extend(authority_blocks(&authority_pinned(
            linked,
            None,
            pin.as_ref(),
        )));
        blocks.extend(cost_blocks(&cost_pinned(linked, lock, None, pin.as_ref())));
    }
    if has_system(program, modules) {
        blocks.extend(system_blocks(&system(program, modules)));
    }
    blocks.extend(attention_doc_blocks(program, lock, &check_with));
    Doc {
        title: format!("{} {}", r.module, r.version),
        meta: vec![
            ("Program".to_owned(), r.hash.clone()),
            ("Language".to_owned(), r.language.clone()),
            (
                "View".to_owned(),
                format!(
                    "{VIEW_FORMAT}, generated from the program{}",
                    if given.is_some() {
                        " and the modules it imports"
                    } else {
                        " alone"
                    }
                ),
            ),
        ],
        blocks,
    }
}
