//! Untrusted input never panics: every truncation of a real export (case
//! J01), and byte changes all through it, give a report, and each report
//! holds together. A panic anywhere fails the test.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use verify_journal::{Code, PublicKey, Report, Status, public_keys_in, verify_export};

fn case(file: &str) -> Vec<u8> {
    mandate_testkit::read_bytes(&format!("conformance/J01/{file}")).expect("J01")
}

fn keys() -> Vec<PublicKey> {
    public_keys_in(&String::from_utf8(case("key.pem")).expect("text")).expect("a key")
}

/// What every report says, whatever the export.
fn holds_together(r: &Report, what: &str) {
    match r.status {
        Status::Unreadable => {
            assert_eq!(r.run, None, "{what}");
            assert_eq!(r.findings.len(), 1, "{what}");
            assert!(
                matches!(
                    r.findings[0].code,
                    Code::MalformedExport | Code::ExportOverLimit
                ),
                "{what}"
            );
            assert_eq!(
                (r.events, r.unanchored, r.last_seq, r.anchored_through),
                (0, 0, None, None),
                "{what}"
            );
        }
        Status::Unchained => {
            assert!(
                r.findings.is_empty() && r.signed_by.is_empty() && r.anchored_through.is_none(),
                "{what}"
            );
            assert_eq!(r.unanchored, r.events, "{what}");
        }
        Status::Verified | Status::Broken => {
            assert!(
                r.run.as_deref().is_some_and(|run| !run.is_empty()),
                "{what}"
            );
            assert!(r.events >= 1 && r.unanchored <= r.events, "{what}");
            let broken = r.findings.iter().any(|f| f.code != Code::UnanchoredTail);
            assert_eq!(broken, r.status == Status::Broken, "{what}");
            assert_eq!(
                r.anchored_through.is_none(),
                r.signed_by.is_empty(),
                "{what}"
            );
            assert!(r.signed_by.windows(2).all(|w| w[0] < w[1]), "{what}");
            assert!(
                r.findings
                    .iter()
                    .all(|f| !matches!(f.code, Code::MalformedExport | Code::ExportOverLimit)),
                "{what}"
            );
        }
    }
}

#[test]
fn every_truncation_gives_a_report() {
    let bytes = case("export.json");
    let keys = keys();
    for len in 0..=bytes.len() {
        let r = verify_export(&bytes[..len], &keys);
        holds_together(&r, &format!("the first {len} bytes"));
        // Only white space can be cut and leave the export whole.
        if bytes[len..].iter().any(|b| !b.is_ascii_whitespace()) {
            assert_eq!(r.status, Status::Unreadable, "the first {len} bytes");
        } else {
            assert_eq!(r.status, Status::Verified, "the first {len} bytes");
        }
    }
}

#[test]
fn byte_changes_all_through_give_a_report() {
    let bytes = case("export.json");
    let keys = keys();
    let mut statuses = [0_usize; 4];
    let replacements: [fn(u8) -> u8; 6] = [
        |b| b ^ 0x01,
        |b| b ^ 0x20,
        |b| b ^ 0x80,
        |_| b'"',
        |_| b'9',
        |_| b'[',
    ];
    for at in (0..bytes.len()).step_by(5) {
        for (i, replace) in replacements.iter().enumerate() {
            let mut changed = bytes.clone();
            changed[at] = replace(changed[at]);
            let r = verify_export(&changed, &keys);
            holds_together(&r, &format!("byte {at} changed by replacement {i}"));
            statuses[r.status as usize] += 1;
        }
    }
    println!(
        "byte changes: {} verified, {} broken, {} unchained, {} unreadable",
        statuses[0], statuses[1], statuses[2], statuses[3]
    );
    // The changes reach every part of the verifier, not only the reader.
    assert!(statuses[1] > 0 && statuses[3] > 0);
}

#[test]
fn bytes_inserted_and_removed_give_a_report() {
    let bytes = case("export.json");
    let keys = keys();
    for at in (0..bytes.len()).step_by(37) {
        for insert in [
            &b"\\u0000"[..],
            b"[[[[",
            b"1e400",
            b"\xff",
            b"\xed\xa0\x80",
            b"\\ud800",
            b",",
            b"}",
        ] {
            let mut changed = bytes[..at].to_vec();
            changed.extend_from_slice(insert);
            changed.extend_from_slice(&bytes[at..]);
            holds_together(
                &verify_export(&changed, &keys),
                &format!("{insert:?} inserted at {at}"),
            );
        }
        let mut cut = bytes.clone();
        cut.drain(at..(at + 3).min(bytes.len()));
        holds_together(&verify_export(&cut, &keys), &format!("3 bytes cut at {at}"));
    }
}

#[test]
fn every_value_where_a_seq_or_time_stands() {
    let text = String::from_utf8(case("export.json")).expect("text");
    let keys = keys();
    for value in [
        "0",
        "-0",
        "-1",
        "1.5",
        "1e0",
        "9007199254740991",
        "9007199254740992",
        "1e308",
        "-1e308",
        "1e-400",
        "\"1\"",
        "null",
        "true",
        "[]",
        "{}",
        "-9007199254740991",
    ] {
        for member in ["\"seq\": 1,", "\"seq\": 5,", "\"at\": "] {
            let replaced = if member == "\"at\": " {
                // The first time in the export.
                let at = text.find(member).expect("an at");
                let end = at + member.len() + text[at + member.len()..].find(',').expect("a comma");
                format!("{}{member}{value}{}", &text[..at], &text[end..])
            } else {
                text.replacen(member, &format!("\"seq\": {value},"), 1)
            };
            holds_together(
                &verify_export(replaced.as_bytes(), &keys),
                &format!("{member} {value}"),
            );
        }
    }
}
