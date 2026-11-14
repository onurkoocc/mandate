//! The pending-list rule of a gate test.
//!
//! A gate runs a set of named items (golden outputs, conformance cases,
//! vectors) against an explicit list of the items known not to pass yet,
//! given as patterns. Every item not on the list must pass. An item on the
//! list that passes is an error: the list is shortened in the same commit.
//! An entry of the list that names no item is an error too. So the list says
//! exactly what is left, and it can only shrink by being edited.

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
            (Err(_), Some(_)) => still = still.saturating_add(1),
            (Err(why), None) => problems.push(format!("{name}: {why}")),
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
