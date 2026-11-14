//! The pending-list rule of a gate test.
//!
//! A gate runs a set of named items (golden outputs, conformance cases,
//! vectors) against an explicit list of the items known not to pass yet,
//! given as patterns. Every item not on the list must pass. An item on the
//! list that passes is an error: the list is shortened in the same commit.
//! An entry of the list that names no item is an error too. So the list says
//! exactly what is left, and it can only shrink by being edited.
//!
//! A gate of the compiler's results ([`run_held_gate`]) also holds each
//! pending item to failing only by omission: what the Rust gives must be
//! what the TypeScript gives with some diagnostics left out, in the same
//! order ([`omission`]), never a diagnostic the TypeScript does not give.
//! So an item is pending only because the Rust does not give it yet, not
//! because what it does give is wrong.
//!
//! Every pending list is empty now: the Rust gives everything the stored
//! results hold. The lists stay for the next rule of the language. A new rule
//! is written first as a conformance case or a vector, listed as pending in
//! the gates that run it, and the list is shortened by the commit that makes
//! the Rust pass it.

use std::collections::HashSet;

/// Whether `name` matches `pattern`, in which `*` stands for any text
/// (empty included) and every other character for itself.
fn glob_match(pattern: &str, name: &str) -> bool {
    let mut parts = pattern.split('*');
    let first = parts.next().unwrap_or_default();
    let Some(mut rest) = name.strip_prefix(first) else {
        return false;
    };
    let parts: Vec<&str> = parts.collect();
    let Some((last, middle)) = parts.split_last() else {
        // No `*`: the whole name.
        return rest.is_empty();
    };
    for part in middle {
        match rest.split_once(part) {
            Some((_, after)) => rest = after,
            None => return false,
        }
    }
    rest.ends_with(last)
}

/// Runs a gate: `check` on every item, against the list `pending` of the
/// items known not to pass yet (patterns of item names, with `*`).
///
/// It evaluates every item, including the pending ones (to find one that
/// has started to pass), and prints and returns one line,
/// `<title>: ran N, passed M, pending K`. `check` gives `Err` with what is
/// wrong for an item that does not pass; it must not panic, since a panic
/// under WASI ends the test executable.
///
/// # Errors
///
/// The line and every problem, one a line: each item not on the list that
/// fails (with what `check` said), each item on the list that passes, each
/// entry of the list that names no item, each name given twice (the second
/// item is not run or counted), and a gate of no items at all.
pub fn run_gate<T>(
    title: &str,
    pending: &[&str],
    items: impl IntoIterator<Item = (String, T)>,
    mut check: impl FnMut(&T) -> Result<(), String>,
) -> Result<String, String> {
    gate(
        title,
        pending,
        items,
        |t| check(t).map_err(Miss::Omits),
        false,
    )
}

/// How an item that does not pass fails, for [`run_held_gate`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Miss {
    /// What the Rust gives is what the TypeScript gives with some
    /// diagnostics left out, in the same order: it fails only by omission.
    /// The text says what is missing.
    Omits(String),
    /// What the Rust gives is not that: a diagnostic the TypeScript does not
    /// give, one in another place of the order, or another program or span
    /// table. The text says which.
    Differs(String),
    /// The item cannot be held to that, for a reason that is not a fault of
    /// the port, stated by `rule` (the gate counts the items of each rule
    /// and prints the rule); `why` is the item's own failure.
    Excluded {
        /// The rule, the same text for every item it excludes.
        rule: &'static str,
        /// Why the item fails.
        why: String,
    },
}

impl Miss {
    /// What is wrong with the item, as a report line shows it.
    #[must_use]
    pub fn why(&self) -> &str {
        match self {
            Miss::Omits(why) | Miss::Differs(why) | Miss::Excluded { why, .. } => why,
        }
    }
}

/// [`run_gate`], with every pending item held to failing only by omission:
/// a pending item whose `check` gives [`Miss::Differs`] is an error, as one
/// that passes is. Besides the line of [`run_gate`] it prints how many
/// pending items were held so (`<title>: of the K pending, H give only what
/// the TypeScript gives, in its order`) and, for each rule of
/// [`Miss::Excluded`], how many items it excluded.
///
/// # Errors
///
/// As [`run_gate`], and each pending item that [`Miss::Differs`].
pub fn run_held_gate<T>(
    title: &str,
    pending: &[&str],
    items: impl IntoIterator<Item = (String, T)>,
    check: impl FnMut(&T) -> Result<(), Miss>,
) -> Result<String, String> {
    gate(title, pending, items, check, true)
}

/// Whether `actual` is `expected` with some elements left out, in the same
/// order: each element of `actual` is `same` as one of `expected` after the
/// one the element before it matched. Greedy, which decides a subsequence
/// exactly.
///
/// # Errors
///
/// The first element of `actual` that has no match after the one before it,
/// shown with `show`.
pub fn omission<E, A>(
    expected: &[E],
    actual: &[A],
    same: impl Fn(&E, &A) -> bool,
    show: impl Fn(&A) -> String,
) -> Result<usize, String> {
    let mut at = 0_usize;
    for (i, a) in actual.iter().enumerate() {
        match expected.iter().skip(at).position(|e| same(e, a)) {
            Some(k) => at = at.saturating_add(k).saturating_add(1),
            None => {
                let rest = expected.len().saturating_sub(at);
                return Err(format!(
                    "Rust's diagnostic {i} ({}) is not among the {rest} expected after the one before it",
                    show(a)
                ));
            }
        }
    }
    Ok(expected.len().saturating_sub(actual.len()))
}

fn gate<T>(
    title: &str,
    pending: &[&str],
    items: impl IntoIterator<Item = (String, T)>,
    mut check: impl FnMut(&T) -> Result<(), Miss>,
    held: bool,
) -> Result<String, String> {
    let mut held_count: usize = 0;
    let mut excluded: Vec<(&'static str, usize)> = Vec::new();
    let mut used = vec![false; pending.len()];
    let mut names: HashSet<String> = HashSet::new();
    let mut problems: Vec<String> = Vec::new();
    let (mut ran, mut passed, mut still): (usize, usize, usize) = (0, 0, 0);
    for (name, item) in items {
        if !names.insert(name.clone()) {
            // Two items with one name cannot both be reported; the second is
            // not run, and the gate fails.
            problems.push(format!(
                "{name}: the gate names this item twice; the second is not run"
            ));
            continue;
        }
        ran = ran.saturating_add(1);
        let mut listed: Option<&str> = None;
        for (pattern, used) in pending.iter().zip(used.iter_mut()) {
            if glob_match(pattern, &name) {
                *used = true;
                listed = listed.or(Some(pattern));
            }
        }
        match (check(&item), listed) {
            (Ok(()), None) => passed = passed.saturating_add(1),
            (Ok(()), Some(pattern)) => {
                passed = passed.saturating_add(1);
                problems.push(format!(
                    "{name}: passes, but the pending entry {pattern:?} lists it; take it off the list"
                ));
            }
            (Err(miss), Some(_)) => {
                still = still.saturating_add(1);
                match miss {
                    Miss::Omits(_) => held_count = held_count.saturating_add(1),
                    Miss::Differs(why) if held => problems.push(format!(
                        "{name}: pending, but it gives what the TypeScript does not: {why}"
                    )),
                    Miss::Differs(_) => {}
                    Miss::Excluded { rule, .. } => {
                        match excluded.iter_mut().find(|(r, _)| *r == rule) {
                            Some((_, n)) => *n = n.saturating_add(1),
                            None => excluded.push((rule, 1)),
                        }
                    }
                }
            }
            (Err(miss), None) => problems.push(format!("{name}: {}", miss.why())),
        }
    }
    for (pattern, used) in pending.iter().zip(&used) {
        if !used {
            problems.push(format!("the pending entry {pattern:?} names no item"));
        }
    }
    if ran == 0 {
        // A gate that ran nothing shows nothing.
        problems.push("the gate ran no item".to_owned());
    }
    let line = format!("{title}: ran {ran}, passed {passed}, pending {still}");
    println!("{line}");
    if held {
        let out: usize = excluded.iter().map(|(_, n)| *n).sum();
        println!(
            "{title}: of the {still} pending, {held_count} give only what the TypeScript gives, in its order, and {out} are excluded by rule"
        );
        for (rule, n) in &excluded {
            println!("  excluded {n}: {rule}");
        }
    }
    if problems.is_empty() {
        Ok(line)
    } else {
        Err(format!(
            "{line}\n{} problem(s):\n{}",
            problems.len(),
            problems.join("\n")
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::glob_match;

    #[test]
    fn patterns() {
        assert!(glob_match("check @ *", "check @ fixtures/a.mdt"));
        assert!(!glob_match("check @ *", "check --module @ fixtures/a.mdt"));
        assert!(glob_match("* @ *.mdt", "fmt @ fixtures/a.mdt"));
        assert!(!glob_match("* @ *.mdt", "fmt @ fixtures/a.ir.json"));
        assert!(glob_match("a*b*c", "abc"));
        assert!(glob_match("a*b*c", "axxbyybc"));
        assert!(!glob_match("a*b*c", "acb"));
        assert!(glob_match("exact", "exact"));
        assert!(!glob_match("exact", "exactly"));
        assert!(glob_match("*", ""));
    }
}
