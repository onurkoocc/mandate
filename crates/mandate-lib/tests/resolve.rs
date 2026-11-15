//! Resolution: which version `add` and `upgrade` take, and why the ones
//! above it were passed over.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use std::collections::BTreeSet;

use common::{Table, json};
use mandate_lib::{
    Candidate, Digest, PassedOver, Range, Resolve, Timestamp, Version, WaitDays, resolve,
};

/// A digest made of one number.
fn digest(n: u32) -> Digest {
    Digest::parse(&format!("sha256:{n:064x}")).unwrap()
}

fn d(n: u32) -> String {
    format!("sha256:{n:064x}")
}

fn at(text: &str) -> Timestamp {
    Timestamp::parse(text).unwrap()
}

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

/// A candidate whose digest is `n`.
fn cand(version: &str, n: u32, published: &str) -> Candidate {
    Candidate {
        version: v(version),
        digest: digest(n),
        published_at: at(published),
    }
}

struct Case<'a> {
    range: Option<&'a str>,
    candidates: &'a [Candidate],
    wait_days: u32,
    revoked: &'a [u32],
    now: &'a str,
    pinned: Option<&'a str>,
}

impl Case<'_> {
    fn run(&self) -> Result<String, Vec<String>> {
        let range = self.range.map(|r| Range::parse(r).unwrap());
        let revoked: BTreeSet<Digest> = self.revoked.iter().map(|&n| digest(n)).collect();
        let pinned = self.pinned.map(v);
        let request = Resolve {
            library: "acme",
            range: range.as_ref(),
            candidates: self.candidates,
            wait_days: WaitDays::new(self.wait_days).unwrap(),
            revoked: &revoked,
            now: at(self.now),
            pinned: pinned.as_ref(),
        };
        match resolve(&request) {
            Ok(resolution) => Ok(json(resolution.to_js())),
            Err(problems) => Err(problems.iter().map(|p| json(p.to_js())).collect()),
        }
    }
}

fn chosen(version: &str, n: u32, published: &str) -> String {
    format!(
        r#""chosen":{{"version":"{version}","digest":"{}","published_at":"{published}"}}"#,
        d(n)
    )
}

fn skipped(version: &str, n: u32, published: &str, reason: &str) -> String {
    format!(
        r#"{{"version":"{version}","digest":"{}","published_at":"{published}","reason":"{reason}"}}"#,
        d(n)
    )
}

fn waiting(version: &str, n: u32, published: &str, from: &str) -> String {
    format!(
        r#"{{"version":"{version}","digest":"{}","published_at":"{published}","reason":"waiting","available_from":"{from}"}}"#,
        d(n)
    )
}

fn answer(chosen: &str, passed_over: &[String]) -> String {
    format!(r#"{{{chosen},"passed_over":[{}]}}"#, passed_over.join(","))
}

const OLD: &str = "2026-01-01T00:00:00Z";
const PUBLISHED: &str = "2026-11-14T09:30:00Z";

#[test]
fn the_highest_is_taken() {
    let candidates = [
        cand("1.0.0", 1, OLD),
        cand("1.2.0", 3, OLD),
        cand("1.1.0", 2, OLD),
        cand("0.9.0", 9, OLD),
    ];
    let case = Case {
        range: None,
        candidates: &candidates,
        wait_days: 7,
        revoked: &[],
        now: "2026-11-20T00:00:00Z",
        pinned: None,
    };
    assert_eq!(case.run(), Ok(answer(&chosen("1.2.0", 3, OLD), &[])));
}

#[test]
fn the_highest_is_waiting_and_the_next_is_not() {
    let candidates = [cand("1.0.0", 1, OLD), cand("1.1.0", 2, PUBLISHED)];
    let mut t = Table::new();
    // Published 2026-11-14T09:30:00Z, a wait of 7 days: it ends at
    // 2026-11-21T09:30:00Z.
    for (now, want) in [
        (
            "2026-11-21T09:29:59Z",
            Ok(answer(
                &chosen("1.0.0", 1, OLD),
                &[waiting("1.1.0", 2, PUBLISHED, "2026-11-21")],
            )),
        ),
        (
            // The exact second it ends: `>=`.
            "2026-11-21T09:30:00Z",
            Ok(answer(&chosen("1.1.0", 2, PUBLISHED), &[])),
        ),
        (
            "2026-11-21T09:30:01Z",
            Ok(answer(&chosen("1.1.0", 2, PUBLISHED), &[])),
        ),
        (
            "2026-11-14T09:30:00Z",
            Ok(answer(
                &chosen("1.0.0", 1, OLD),
                &[waiting("1.1.0", 2, PUBLISHED, "2026-11-21")],
            )),
        ),
        (
            "2026-11-14T09:29:59Z",
            Ok(answer(
                &chosen("1.0.0", 1, OLD),
                &[waiting("1.1.0", 2, PUBLISHED, "2026-11-21")],
            )),
        ),
    ] {
        let case = Case {
            range: None,
            candidates: &candidates,
            wait_days: 7,
            revoked: &[],
            now,
            pinned: None,
        };
        t.eq(now, case.run(), want);
    }
    t.finish();
}

#[test]
fn a_wait_of_no_days() {
    let mut t = Table::new();
    let candidates = [cand("1.0.0", 1, PUBLISHED)];
    let run = |now: &str| {
        Case {
            range: None,
            candidates: &candidates,
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run()
    };
    t.eq(
        "at the instant",
        run(PUBLISHED),
        Ok(answer(&chosen("1.0.0", 1, PUBLISHED), &[])),
    );
    t.eq(
        "after",
        run("2030-01-01T00:00:00Z"),
        Ok(answer(&chosen("1.0.0", 1, PUBLISHED), &[])),
    );
    // `now` before the publication time is not past it, whatever the wait.
    t.eq(
        "a second before it was published",
        run("2026-11-14T09:29:59Z"),
        Ok(answer(
            "\"chosen\":null",
            &[waiting("1.0.0", 1, PUBLISHED, "2026-11-14")],
        )),
    );
    t.finish();
}

#[test]
fn the_wait_is_in_days_of_86_400_seconds() {
    let mut t = Table::new();
    let candidates = [cand("1.0.0", 1, "2026-11-14T23:59:59Z")];
    let run = |wait_days: u32, now: &str| {
        Case {
            range: None,
            candidates: &candidates,
            wait_days,
            revoked: &[],
            now,
            pinned: None,
        }
        .run()
    };
    // 1 day after 23:59:59 is the next day at 23:59:59, which is on that day.
    t.eq(
        "a second before",
        run(1, "2026-11-15T23:59:58Z"),
        Ok(answer(
            "\"chosen\":null",
            &[waiting("1.0.0", 1, "2026-11-14T23:59:59Z", "2026-11-15")],
        )),
    );
    t.eq(
        "the second",
        run(1, "2026-11-15T23:59:59Z"),
        Ok(answer(&chosen("1.0.0", 1, "2026-11-14T23:59:59Z"), &[])),
    );
    // A wait over the end of a leap February.
    let leap = [cand("1.0.0", 1, "2024-02-28T12:00:00Z")];
    let run_leap = |now: &str| {
        Case {
            range: None,
            candidates: &leap,
            wait_days: 2,
            revoked: &[],
            now,
            pinned: None,
        }
        .run()
    };
    t.eq(
        "over 29 February",
        run_leap("2024-03-01T11:59:59Z"),
        Ok(answer(
            "\"chosen\":null",
            &[waiting("1.0.0", 1, "2024-02-28T12:00:00Z", "2024-03-01")],
        )),
    );
    t.eq(
        "over 29 February, at the instant",
        run_leap("2024-03-01T12:00:00Z"),
        Ok(answer(&chosen("1.0.0", 1, "2024-02-28T12:00:00Z"), &[])),
    );
    t.finish();
}

#[test]
fn the_longest_wait_and_the_latest_publication() {
    let mut t = Table::new();
    let last = "9999-12-31T23:59:59Z";
    let candidates = [cand("1.0.0", 1, last)];
    let run = |now: &str| {
        Case {
            range: None,
            candidates: &candidates,
            wait_days: 36_500,
            revoked: &[],
            now,
            pinned: None,
        }
        .run()
    };
    // 36 500 days after the last second a time can write: a year over 9999.
    t.eq(
        "the last second is not enough",
        run(last),
        Ok(answer(
            "\"chosen\":null",
            &[waiting("1.0.0", 1, last, "10099-12-06")],
        )),
    );
    let early = [cand("1.0.0", 1, "1970-01-01T00:00:00Z")];
    let run_early = |now: &str| {
        Case {
            range: None,
            candidates: &early,
            wait_days: 36_500,
            revoked: &[],
            now,
            pinned: None,
        }
        .run()
    };
    // 1970-01-01 and 36 500 days is 2069-12-07 (leap days included).
    t.eq(
        "at the bound",
        run_early("2069-12-06T23:59:59Z"),
        Ok(answer(
            "\"chosen\":null",
            &[waiting("1.0.0", 1, "1970-01-01T00:00:00Z", "2069-12-07")],
        )),
    );
    t.eq(
        "at the bound, the day itself",
        run_early("2069-12-07T00:00:00Z"),
        Ok(answer(&chosen("1.0.0", 1, "1970-01-01T00:00:00Z"), &[])),
    );
    t.finish();
}

#[test]
fn the_highest_is_revoked() {
    let candidates = [
        cand("1.0.0", 1, OLD),
        cand("1.1.0", 2, OLD),
        cand("1.2.0", 3, OLD),
    ];
    let case = Case {
        range: None,
        candidates: &candidates,
        wait_days: 0,
        revoked: &[3],
        now: "2026-11-20T00:00:00Z",
        pinned: None,
    };
    assert_eq!(
        case.run(),
        Ok(answer(
            &chosen("1.1.0", 2, OLD),
            &[skipped("1.2.0", 3, OLD, "revoked")]
        ))
    );
    // Two revoked, in the middle too: only those above the one taken are told.
    let case = Case {
        revoked: &[3, 2],
        ..case
    };
    assert_eq!(
        case.run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[
                skipped("1.2.0", 3, OLD, "revoked"),
                skipped("1.1.0", 2, OLD, "revoked")
            ]
        ))
    );
    // A revoked digest that no candidate has changes nothing.
    let case = Case {
        revoked: &[77],
        ..case
    };
    assert_eq!(case.run(), Ok(answer(&chosen("1.2.0", 3, OLD), &[])));
}

#[test]
fn all_are_waiting() {
    let candidates = [
        cand("1.0.0", 1, "2026-11-14T09:30:00Z"),
        cand("1.1.0", 2, "2026-11-15T00:00:00Z"),
        cand("2.0.0", 3, "2026-11-16T23:59:59Z"),
    ];
    let case = Case {
        range: None,
        candidates: &candidates,
        wait_days: 7,
        revoked: &[],
        now: "2026-11-15T12:00:00Z",
        pinned: None,
    };
    assert_eq!(
        case.run(),
        Ok(answer(
            "\"chosen\":null",
            &[
                waiting("2.0.0", 3, "2026-11-16T23:59:59Z", "2026-11-23"),
                waiting("1.1.0", 2, "2026-11-15T00:00:00Z", "2026-11-22"),
                waiting("1.0.0", 1, "2026-11-14T09:30:00Z", "2026-11-21"),
            ]
        ))
    );
}

#[test]
fn the_pinned_version_is_not_held_to_the_wait_again() {
    let candidates = [cand("1.0.0", 1, OLD), cand("1.1.0", 2, PUBLISHED)];
    let mut t = Table::new();
    let now = "2026-11-15T00:00:00Z";
    // Without the pin, 1.1.0 is waiting; with it, it is the one.
    t.eq(
        "not pinned",
        Case {
            range: None,
            candidates: &candidates,
            wait_days: 7,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[waiting("1.1.0", 2, PUBLISHED, "2026-11-21")],
        )),
    );
    t.eq(
        "pinned",
        Case {
            range: None,
            candidates: &candidates,
            wait_days: 7,
            revoked: &[],
            now,
            pinned: Some("1.1.0"),
        }
        .run(),
        Ok(answer(&chosen("1.1.0", 2, PUBLISHED), &[])),
    );
    // Only that version: another one pinned changes nothing for this one.
    t.eq(
        "another version pinned",
        Case {
            range: None,
            candidates: &candidates,
            wait_days: 7,
            revoked: &[],
            now,
            pinned: Some("1.0.0"),
        }
        .run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[waiting("1.1.0", 2, PUBLISHED, "2026-11-21")],
        )),
    );
    t.eq(
        "a version pinned that is not a candidate",
        Case {
            range: None,
            candidates: &candidates,
            wait_days: 7,
            revoked: &[],
            now,
            pinned: Some("9.9.9"),
        }
        .run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[waiting("1.1.0", 2, PUBLISHED, "2026-11-21")],
        )),
    );
    // The pin is held to the range.
    t.eq(
        "pinned and outside the range",
        Case {
            range: Some("^1.0.0"),
            candidates: &[cand("1.0.0", 1, OLD), cand("2.0.0", 2, PUBLISHED)],
            wait_days: 7,
            revoked: &[],
            now,
            pinned: Some("2.0.0"),
        }
        .run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[skipped("2.0.0", 2, PUBLISHED, "outside_range")],
        )),
    );
    t.finish();
}

#[test]
fn the_pinned_version_is_held_to_revocation() {
    let candidates = [cand("1.0.0", 1, OLD), cand("1.1.0", 2, PUBLISHED)];
    let now = "2026-11-15T00:00:00Z";
    let case = Case {
        range: None,
        candidates: &candidates,
        wait_days: 7,
        revoked: &[2],
        now,
        pinned: Some("1.1.0"),
    };
    assert_eq!(
        case.run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[skipped("1.1.0", 2, PUBLISHED, "revoked")]
        ))
    );
    // A pinned version that is revoked and no other: nothing is taken.
    let only = [cand("1.1.0", 2, OLD)];
    let case = Case {
        candidates: &only,
        ..case
    };
    assert_eq!(
        case.run(),
        Ok(answer(
            "\"chosen\":null",
            &[skipped("1.1.0", 2, OLD, "revoked")]
        ))
    );
}

#[test]
fn an_empty_directory_and_a_range_nothing_meets() {
    let mut t = Table::new();
    let now = "2026-11-20T00:00:00Z";
    t.eq(
        "empty",
        Case {
            range: None,
            candidates: &[],
            wait_days: 7,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Ok(answer("\"chosen\":null", &[])),
    );
    let candidates = [
        cand("1.0.0", 1, OLD),
        cand("1.5.0", 2, OLD),
        cand("2.0.0", 3, OLD),
    ];
    t.eq(
        "nothing meets ^3",
        Case {
            range: Some("^3"),
            candidates: &candidates,
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Ok(answer(
            "\"chosen\":null",
            &[
                skipped("2.0.0", 3, OLD, "outside_range"),
                skipped("1.5.0", 2, OLD, "outside_range"),
                skipped("1.0.0", 1, OLD, "outside_range"),
            ],
        )),
    );
    t.eq(
        "^1 takes 1.5.0 and tells what is above it",
        Case {
            range: Some("^1"),
            candidates: &candidates,
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Ok(answer(
            &chosen("1.5.0", 2, OLD),
            &[skipped("2.0.0", 3, OLD, "outside_range")],
        )),
    );
    t.eq(
        "^1.0 and 1.0.0 exact",
        Case {
            range: Some("1.0.0"),
            candidates: &candidates,
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[
                skipped("2.0.0", 3, OLD, "outside_range"),
                skipped("1.5.0", 2, OLD, "outside_range"),
            ],
        )),
    );
    t.eq(
        "^0.0.0 does not hold 1.0.0",
        Case {
            range: Some("^0.0.0"),
            candidates: &candidates[..1],
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Ok(answer(
            "\"chosen\":null",
            &[skipped("1.0.0", 1, OLD, "outside_range")],
        )),
    );
    t.finish();
}

#[test]
fn which_reason_is_given_when_there_are_two() {
    let candidates = [
        cand("1.0.0", 1, OLD),
        cand("2.0.0", 2, PUBLISHED),
        cand("3.0.0", 3, PUBLISHED),
    ];
    let now = "2026-11-15T00:00:00Z";
    // 3.0.0 is revoked and waiting: revoked. 2.0.0 is outside ^1 and
    // waiting: outside the range.
    let case = Case {
        range: Some("^1"),
        candidates: &candidates,
        wait_days: 7,
        revoked: &[3],
        now,
        pinned: None,
    };
    assert_eq!(
        case.run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[
                skipped("3.0.0", 3, PUBLISHED, "outside_range"),
                skipped("2.0.0", 2, PUBLISHED, "outside_range")
            ]
        ))
    );
    let case = Case {
        range: None,
        ..case
    };
    assert_eq!(
        case.run(),
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[
                skipped("3.0.0", 3, PUBLISHED, "revoked"),
                waiting("2.0.0", 2, PUBLISHED, "2026-11-21")
            ]
        ))
    );
}

#[test]
fn two_candidates_with_one_version_are_a_problem_not_a_choice() {
    let mut t = Table::new();
    let now = "2026-11-20T00:00:00Z";
    let dup = |version: &str, count: usize| {
        format!(
            r#"{{"problem":"duplicate_version","library":"acme","version":"{version}","count":{count}}}"#
        )
    };
    t.eq(
        "the same digest twice",
        Case {
            range: None,
            candidates: &[cand("1.0.0", 1, OLD), cand("1.0.0", 1, OLD)],
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Err(vec![dup("1.0.0", 2)]),
    );
    t.eq(
        "two digests",
        Case {
            range: None,
            candidates: &[
                cand("1.0.0", 1, OLD),
                cand("1.0.0", 2, OLD),
                cand("2.0.0", 3, OLD),
            ],
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Err(vec![dup("1.0.0", 2)]),
    );
    t.eq(
        "even outside the range, and by version",
        Case {
            range: Some("^9"),
            candidates: &[
                cand("2.0.0", 1, OLD),
                cand("1.0.0", 2, OLD),
                cand("2.0.0", 3, OLD),
                cand("1.0.0", 4, OLD),
                cand("1.0.0", 5, OLD),
            ],
            wait_days: 0,
            revoked: &[],
            now,
            pinned: None,
        }
        .run(),
        Err(vec![dup("1.0.0", 3), dup("2.0.0", 2)]),
    );
    t.finish();
}

#[test]
fn the_answer_does_not_depend_on_the_order_of_the_candidates() {
    let candidates = [
        cand("1.0.0", 1, OLD),
        cand("1.1.0", 2, PUBLISHED),
        cand("2.0.0", 3, OLD),
        cand("0.1.0", 4, OLD),
        cand("1.1.1", 5, PUBLISHED),
    ];
    let case = |list: &[Candidate]| {
        Case {
            range: Some("^1"),
            candidates: list,
            wait_days: 7,
            revoked: &[3],
            now: "2026-11-15T00:00:00Z",
            pinned: None,
        }
        .run()
    };
    let expected = case(&candidates);
    let mut reversed = candidates.to_vec();
    reversed.reverse();
    assert_eq!(case(&reversed), expected);
    let mut rotated = candidates.to_vec();
    rotated.rotate_left(2);
    assert_eq!(case(&rotated), expected);
    assert_eq!(
        expected,
        Ok(answer(
            &chosen("1.0.0", 1, OLD),
            &[
                skipped("2.0.0", 3, OLD, "outside_range"),
                waiting("1.1.1", 5, PUBLISHED, "2026-11-21"),
                waiting("1.1.0", 2, PUBLISHED, "2026-11-21")
            ]
        ))
    );
}

#[test]
fn reasons_have_identifiers() {
    assert_eq!(PassedOver::OutsideRange.id(), "outside_range");
    assert_eq!(PassedOver::Revoked.id(), "revoked");
}
