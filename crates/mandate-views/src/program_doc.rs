//! The views of one program as one document: `programDoc` of
//! `compiler/src/views/views.ts` (lines 1563-1583).

use mandate_check::{Modules, VIEW_FORMAT, linked_program, program_ref};
use mandate_ir::{Program, Value};

use crate::architecture::{architecture, architecture_blocks};
use crate::authority::{authority, authority_blocks};
use crate::cost::{ViewError, cost, cost_blocks};
use crate::doc::{Block, Doc};
use crate::shown::is_kind;
use crate::system::{has_system, system, system_blocks};

/// The program's views as one document, headed by the hash they show: the
/// architecture, the authority and the cost, then the system when the program
/// has one. With `modules`, capabilities over components open into the
/// imported system model, which is shown too: the views are of the program as
/// linked with the modules, and the title and the hash are of the program
/// itself. `programDoc(program, lock, modules)`.
///
/// # Errors
///
/// The cost of a workflow with an envelope is not ported yet ([`ViewError`]).
pub fn program_doc(
    program: &Value,
    lock: Option<&Value>,
    modules: Option<&Modules>,
) -> Result<Doc, ViewError> {
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
        blocks.extend(architecture_blocks(&architecture(linked)));
        blocks.extend(authority_blocks(&authority(linked)));
        blocks.extend(cost_blocks(&cost(linked, lock)?));
    }
    if has_system(program, modules) {
        blocks.extend(system_blocks(&system(program, modules)));
    }
    Ok(Doc {
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
    })
}
