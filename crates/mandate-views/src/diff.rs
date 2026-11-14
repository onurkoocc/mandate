//! The document of a semantic diff: `diffBlocks` and `diffDoc` of
//! `compiler/src/views/views.ts` (lines 1549-1561 and 1585-1596). The
//! analysis is [`mandate_check::semantic_diff`]; this is how it is shown.

use mandate_check::{Change, DiffView, Locks, VIEW_FORMAT, semantic_diff};
use mandate_ir::Value;

use crate::doc::{Block, Cell, Doc};

/// The blocks of the document of a diff: `diffBlocks(v)`. A change is a line
/// of code; a list with nothing in it says `none` (changes) or `—`
/// (unchanged).
#[must_use]
pub fn diff_blocks(v: &DiffView) -> Vec<Block> {
    let lines = |cs: &[Change]| -> Vec<Cell> {
        if cs.is_empty() {
            vec![Cell::plain("none")]
        } else {
            cs.iter().map(|c| Cell::mono(c.text.as_str())).collect()
        }
    };
    vec![
        Block::H("What changed".to_owned()),
        Block::P(format!("From {} to {}.", v.from.hash, v.to.hash)),
        Block::H("Governance changes (a person must approve)".to_owned()),
        Block::List(lines(&v.governance)),
        Block::H("Behavior changes".to_owned()),
        Block::List(lines(&v.behavior)),
        Block::H("Unchanged".to_owned()),
        Block::List(if v.unchanged.is_empty() {
            vec![Cell::plain("—")]
        } else {
            v.unchanged
                .iter()
                .map(|u| Cell::plain(u.as_str()))
                .collect()
        }),
    ]
}

/// The document of the diff of two programs: `diffDoc(before, after, locks)`.
/// Its title is `<module>: <version before> → <version after>`, headed by the
/// two program hashes.
#[must_use]
pub fn diff_doc(before: &Value, after: &Value, locks: Option<Locks<'_>>) -> Doc {
    let v = semantic_diff(before, after, locks);
    Doc {
        title: format!("{}: {} → {}", v.to.module, v.from.version, v.to.version),
        meta: vec![
            ("From".to_owned(), v.from.hash.clone()),
            ("To".to_owned(), v.to.hash.clone()),
            (
                "View".to_owned(),
                format!("{VIEW_FORMAT}, generated from the two programs"),
            ),
        ],
        blocks: diff_blocks(&v),
    }
}
