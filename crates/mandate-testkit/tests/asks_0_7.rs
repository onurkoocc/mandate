//! The attention bound of language 0.7 (spec/attention.md "The algebra"),
//! held on generated programs: a body built of the constructs of the table
//! of sites with known counts (`human.ask` to a role, `escalate`, `pause`,
//! `supervise escalate`, a `verify` against a contract of k approvals, a
//! `verify` against a contract whose `require` asks, an `on error` handler
//! that asks, a map whose body verifies against a contract whose invariant
//! a person approves), and of `if`, `switch`, `loop max_iter n`, `par`
//! (under `supervise restart_all` or not, its branches questions or calls,
//! so that a `restart_all` in a function called from a branch of another
//! nests) and calls of functions, written as text, checked, and its bound
//! read from the attention facts, against the count the generator computes
//! of its own tree, by its own algebra: the total and each role's count.
//! Then three relations of the bound to itself: the whole body in `loop
//! max_iter k` is k times it; an `if` of two bodies is the larger; a body
//! moved into a function called twice is twice it. The generator is the
//! RL2 and RL3 property tests' (xorshift64*, a fixed seed), so a failure is
//! found again.
//!
//! Left out, and counted by hand elsewhere (`crates/mandate-check/tests/
//! asks_0_7.rs` and the fixture `fixtures/attention/asks.mdt`): effects and
//! their owners' gates, change sets, reviews and `plan`s, which need the
//! system model, capabilities, a review's source or an envelope; `ensures`,
//! a loop's `until`, and a map bound by an envelope's `agents`.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use std::collections::BTreeMap;

use mandate_check::{CheckOptions, Count, attention_facts};
use mandate_syntax::SourceKind;

/// xorshift64*, as `Places` of `stages_0_7.rs`.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

const ROLES: [&str; 3] = ["accountant", "finance_lead", "code_owner"];

/// One branch of a generated `par`.
#[derive(Clone, Copy, Debug)]
enum Branch {
    /// `human.ask(…, role: ROLES[r])`.
    Ask(usize),
    /// A call of the function `f<i>`.
    Call(usize),
}

/// One construct of a generated body.
#[derive(Clone, Debug)]
enum Node {
    /// `human.ask(…, role: ROLES[r])`: 1, to that role.
    Ask(usize),
    /// `escalate human(…)`: 1, to no role.
    Escalate,
    /// `pause`: 1, to no role.
    Pause,
    /// `delegate … supervise escalate(human)`: 5, to no role.
    Supervise,
    /// `verify n against A<k>(n)`: k approvals, each to the accountant.
    Approve(u64),
    /// `verify n against R(n)`, whose `require` asks the code owner: 1.
    Required,
    /// A delegation and an `on error` handler that asks the finance lead:
    /// the statement's own and the handler's, 1.
    Handled,
    /// `map it in notes max k { verify it against Kept(it) }`, whose
    /// invariant the accountant approves: k.
    Mapped(u64),
    /// `if … { a } else { b }`: the larger.
    If(Vec<Node>, Vec<Node>),
    /// `switch m { Fast => { a } Slow => { b } }`: the larger.
    Switch(Vec<Node>, Vec<Node>),
    /// `loop max_iter n { … }`: n times.
    Loop(u64, Vec<Node>),
    /// `par [supervise restart_all] { … }`: the sum, twice under
    /// restart_all.
    Par(bool, Vec<Branch>),
    /// A call of the function `f<i>`.
    Call(usize),
}

/// A count by role (`None`: no role), and the total, as the generator
/// computes them.
#[derive(Clone, Debug, Default, PartialEq)]
struct Counts {
    roles: BTreeMap<Option<String>, u64>,
    total: u64,
}

impl Counts {
    fn add(&mut self, role: Option<&str>, n: u64) {
        *self.roles.entry(role.map(str::to_owned)).or_insert(0) += n;
        self.total += n;
    }

    fn plus(&mut self, o: &Counts) {
        for (r, n) in &o.roles {
            *self.roles.entry(r.clone()).or_insert(0) += n;
        }
        self.total += o.total;
    }

    fn or(&self, o: &Counts) -> Counts {
        let mut out = self.clone();
        for (r, n) in &o.roles {
            let slot = out.roles.entry(r.clone()).or_insert(0);
            *slot = (*slot).max(*n);
        }
        out.total = self.total.max(o.total);
        out
    }

    fn times(&self, k: u64) -> Counts {
        Counts {
            roles: self.roles.iter().map(|(r, n)| (r.clone(), n * k)).collect(),
            total: self.total * k,
        }
    }

    /// Without the roles counted 0.
    fn tidy(mut self) -> Counts {
        self.roles.retain(|_, n| *n > 0);
        self
    }
}

/// The generator's count of `body`, with the functions' bodies `fns`.
fn count(body: &[Node], fns: &[Vec<Node>]) -> Counts {
    let mut out = Counts::default();
    for n in body {
        match n {
            Node::Ask(r) => out.add(Some(ROLES[*r]), 1),
            Node::Escalate | Node::Pause => out.add(None, 1),
            Node::Supervise => out.add(None, 5),
            Node::Approve(k) => out.add(Some("accountant"), *k),
            Node::Required => out.add(Some("code_owner"), 1),
            Node::Handled => out.add(Some("finance_lead"), 1),
            Node::Mapped(k) => out.add(Some("accountant"), *k),
            Node::If(a, b) | Node::Switch(a, b) => out.plus(&count(a, fns).or(&count(b, fns))),
            Node::Loop(k, b) => out.plus(&count(b, fns).times(*k)),
            Node::Par(restart, branches) => {
                let mut sum = Counts::default();
                for b in branches {
                    match b {
                        Branch::Ask(r) => sum.add(Some(ROLES[*r]), 1),
                        Branch::Call(f) => sum.plus(&count(&fns[*f], fns)),
                    }
                }
                out.plus(&sum.times(if *restart { 2 } else { 1 }));
            }
            Node::Call(f) => out.plus(&count(&fns[*f], fns)),
        }
    }
    out
}

/// A body of at most `width` constructs, nested at most `depth` deep;
/// `fns` functions may be called, and `in_fn` keeps to what a function may
/// hold (no delegation, no `switch` on the workflow's mode, no map of its
/// notes).
fn body(rng: &mut Rng, depth: u32, width: u64, fns: usize, in_fn: bool) -> Vec<Node> {
    let n = 1 + rng.below(width);
    (0..n)
        .map(|_| {
            let mut options: Vec<u8> = vec![0, 1, 2, 5, 6];
            if depth > 0 {
                options.extend([3, 4]);
            }
            if !in_fn {
                options.extend([7, 8, 10, 11]);
                if depth > 0 {
                    options.push(9);
                }
            }
            if fns > 0 {
                options.push(12);
            }
            match options[rng.below(options.len() as u64) as usize] {
                0 => Node::Ask(rng.below(3) as usize),
                1 => Node::Escalate,
                2 => Node::Pause,
                3 => Node::If(
                    body(rng, depth - 1, width, fns, in_fn),
                    body(rng, depth - 1, width, fns, in_fn),
                ),
                4 => Node::Loop(1 + rng.below(3), body(rng, depth - 1, width, fns, in_fn)),
                5 => Node::Par(
                    rng.below(2) == 0,
                    (0..1 + rng.below(2))
                        .map(|_| {
                            if fns > 0 && rng.below(2) == 0 {
                                Branch::Call(rng.below(fns as u64) as usize)
                            } else {
                                Branch::Ask(rng.below(3) as usize)
                            }
                        })
                        .collect(),
                ),
                6 => Node::Required,
                7 => Node::Supervise,
                8 => Node::Approve(1 + rng.below(3)),
                9 => Node::Switch(
                    body(rng, depth - 1, width, fns, in_fn),
                    body(rng, depth - 1, width, fns, in_fn),
                ),
                10 => Node::Handled,
                11 => Node::Mapped(1 + rng.below(4)),
                _ => Node::Call(rng.below(fns as u64) as usize),
            }
        })
        .collect()
}

/// The text of `body`, indented by `pad`.
fn text(body: &[Node], pad: &str, next: &mut usize) -> String {
    let mut out = String::new();
    for n in body {
        *next += 1;
        let i = *next;
        let inner = format!("{pad}  ");
        let line = match n {
            Node::Ask(r) => format!("{pad}human.ask(\"Question {i}?\", role: {})\n", ROLES[*r]),
            Node::Escalate => format!("{pad}escalate human(\"Escalation {i}\")\n"),
            Node::Pause => format!("{pad}pause\n"),
            Node::Supervise => {
                format!("{pad}delegate Writer.write(\"w{i}\") supervise escalate(human)\n")
            }
            Node::Approve(k) => format!("{pad}verify n against A{k}(n)\n"),
            Node::Required => format!("{pad}verify n against R(n)\n"),
            Node::Handled => format!(
                "{pad}let h{i} = delegate Writer.write(\"h{i}\")\n{pad}on error(_) => human.ask(\"Failed {i}?\", role: finance_lead)\n"
            ),
            Node::Mapped(k) => format!(
                "{pad}let m{i} = map it in notes max {k} {{\n{inner}verify it against Kept(it)\n{pad}}}\n"
            ),
            Node::If(a, b) => format!(
                "{pad}if len(t) > {i} {{\n{}{inner}t\n{pad}}} else {{\n{}{inner}t\n{pad}}}\n",
                text(a, &inner, next),
                text(b, &inner, next)
            ),
            Node::Switch(a, b) => {
                let deep = format!("{inner}  ");
                format!(
                    "{pad}let s{i} = switch m {{\n{inner}Fast => {{\n{}{deep}t\n{inner}}}\n{inner}Slow => {{\n{}{deep}t\n{inner}}}\n{pad}}}\n",
                    text(a, &deep, next),
                    text(b, &deep, next)
                )
            }
            Node::Loop(k, b) => format!(
                "{pad}loop max_iter {k} {{\n{}{inner}t\n{pad}}}\n",
                text(b, &inner, next)
            ),
            Node::Par(restart, branches) => {
                let sup = if *restart {
                    " supervise restart_all"
                } else {
                    ""
                };
                let mut s = format!("{pad}par{sup} {{\n");
                for (j, b) in branches.iter().enumerate() {
                    let value = match b {
                        Branch::Ask(r) => {
                            format!("human.ask(\"Branch {i} {j}?\", role: {})", ROLES[*r])
                        }
                        Branch::Call(f) => format!("f{f}(t, n)"),
                    };
                    s.push_str(&format!("{inner}b{i}x{j} = {value}\n"));
                }
                s.push_str(&format!("{pad}}}\n"));
                s
            }
            Node::Call(f) => format!("{pad}f{f}(t, n)\n"),
        };
        out.push_str(&line);
    }
    out
}

/// The program of a workflow `W` whose body is `body`, with the functions
/// `fns` (each may call those before it).
fn program(body: &[Node], fns: &[Vec<Node>]) -> String {
    let mut next = 0;
    let mut out = String::from(
        "mandate @ 0.7\n\nmodule example.generated @ 0.1\n\nuse std.{human, model}\n\nrole accountant   \"Accountant\"\nrole finance_lead \"Finance lead\"\nrole code_owner   \"Code owner\"\n\ntype Note = { text: Text }\ntype Mode = Fast | Slow\n\ncapability ModelStd = model.infer(tier: standard, max_class: internal)\n\nagent Writer {\n  role   \"Writes.\"\n  caps   ModelStd\n  budget { time: 2m, steps: 2 }\n  skill write(t: Text) -> Inferred<Text> ! {Model}\n}\n\ncontract A1(n: Note) {\n  accept a \"One\" by human.approve(role: accountant)\n}\n\ncontract A2(n: Note) {\n  accept a \"Two\" by human.approve(role: accountant) and human.approve(role: accountant)\n}\n\ncontract A3(n: Note) {\n  accept a \"One\" by human.approve(role: accountant)\n  accept b \"Two more\" by human.approve(role: accountant) and human.approve(role: accountant)\n}\n\ncontract R(n: Note) {\n  require len(human.ask(\"Sure of {n.text}?\", role: code_owner)) > 0\n  accept a \"It is\" by static true\n}\n\ncontract Kept(n: Note) {\n  accept a \"It is\" by static true\n  invariant k \"The accountant keeps it\" by human.approve(role: accountant)\n}\n\n",
    );
    for (i, f) in fns.iter().enumerate() {
        out.push_str(&format!(
            "fn f{i}(t: Text, n: Note) -> Text ! {{Human}} {{\n{}  t\n}}\n\n",
            text(f, "  ", &mut next)
        ));
    }
    out.push_str(&format!(
        "workflow W(n: Note, t: Text, m: Mode, notes: List<Note>) -> Text\n  caps   ModelStd\n  budget {{ steps: 9 }}\n{{\n  let w = delegate Writer.write(t)\n{}  t\n}}\n",
        text(body, "  ", &mut next)
    ));
    out
}

/// The bound the facts give: each role's count and the total.
fn bound(text: &str) -> Counts {
    let f = attention_facts(text, SourceKind::Mdt, &CheckOptions::default(), "W").unwrap_or_else(
        || {
            let r = mandate_check::check(text, SourceKind::Mdt, &CheckOptions::default());
            panic!(
                "a generated program does not check: {:?}\n{text}",
                r.diagnostics
                    .iter()
                    .map(|d| format!(
                        "{} at {}: {}",
                        d.code,
                        d.at.path.as_deref().unwrap_or(""),
                        d.message
                    ))
                    .collect::<Vec<_>>()
            )
        },
    );
    let n = |c: Count| match c {
        Count::Finite(n) => n,
        Count::Unbounded => panic!("unbounded"),
    };
    Counts {
        roles: f
            .bound
            .asks
            .by_role
            .iter()
            .map(|(r, c)| (r.clone(), n(*c)))
            .collect(),
        total: n(f.bound.asks.total),
    }
    .tidy()
}

/// The functions of one program: `k` of them, each of what a function may
/// hold, and calling only those before it.
fn functions(rng: &mut Rng, k: usize) -> Vec<Vec<Node>> {
    (0..k).map(|i| body(rng, 1, 3, i, true)).collect()
}

#[test]
fn the_bound_of_a_generated_program_is_the_generators_count() {
    let mut rng = Rng(0x5EED_0007_A55C_0DE5);
    let (mut programs, mut values) = (0_usize, 0_usize);
    for _ in 0..60 {
        let k = rng.below(3) as usize;
        let fns = functions(&mut rng, k);
        let b = body(&mut rng, 2, 4, fns.len(), false);
        let want = count(&b, &fns).tidy();
        let got = bound(&program(&b, &fns));
        assert_eq!(got, want, "{}", program(&b, &fns));
        programs += 1;
        values += 1 + want.roles.len();
        // The whole body in a loop of k rounds: k times.
        let k = 2 + rng.below(3);
        let looped = vec![Node::Loop(k, b.clone())];
        let got = bound(&program(&looped, &fns));
        assert_eq!(got, want.times(k).tidy(), "loop of {k}");
        programs += 1;
        values += 1 + want.roles.len();
        // An if of this body and another: the larger, role by role.
        let other = body(&mut rng, 1, 3, fns.len(), false);
        let either = vec![Node::If(b.clone(), other.clone())];
        let larger = count(&b, &fns).or(&count(&other, &fns)).tidy();
        let got = bound(&program(&either, &fns));
        assert_eq!(got, larger, "if");
        programs += 1;
        values += 1 + larger.roles.len();
    }
    // A body moved into a function called twice: twice it.
    for _ in 0..30 {
        let inner = body(&mut rng, 2, 4, 0, true);
        let once = count(&inner, &[]).tidy();
        let moved = vec![inner.clone()];
        let twice = vec![Node::Call(0), Node::Call(0)];
        let got = bound(&program(&twice, &moved));
        assert_eq!(got, once.times(2).tidy(), "{}", program(&twice, &moved));
        assert_eq!(bound(&program(&inner, &[])), once);
        programs += 2;
        values += 2 * (1 + once.roles.len());
    }
    println!("attention bound: {programs} generated programs, {values} counts compared");
    assert!(programs >= 200);
}
