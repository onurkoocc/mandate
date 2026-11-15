//! Hostile input: texts and bytes made at random from a fixed seed, which no
//! reader may panic on, which it answers the same way each time, and which
//! it accepts only when what it accepts has the properties the rules give
//! it. A panic ends a WASI test executable, so a test that finishes is a
//! test that did not panic.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use mandate_ir::{JsValue, parse, stringify};
use mandate_lib::{
    Range, Timestamp, Version, check_module_path, check_name, read_index, read_libraries_config,
    read_lock_libraries, read_manifest, read_manifest_bytes,
};

/// A small deterministic generator (xorshift64*).
struct Rng(u64);

impl Rng {
    fn next_u64(&mut self) -> u64 {
        self.0 ^= self.0 >> 12;
        self.0 ^= self.0 << 25;
        self.0 ^= self.0 >> 27;
        self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
    }

    fn below(&mut self, n: usize) -> usize {
        (self.next_u64() % n as u64) as usize
    }

    fn text(&mut self, alphabet: &[char], max_len: usize) -> String {
        let len = self.below(max_len + 1);
        (0..len)
            .map(|_| alphabet[self.below(alphabet.len())])
            .collect()
    }
}

const CASES: usize = 30_000;

#[test]
fn versions_and_ranges_have_one_written_form() {
    let alphabet: Vec<char> = "0123456789..^^-+ x\u{661}\n".chars().collect();
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let (mut versions, mut ranges) = (0, 0);
    for _ in 0..CASES {
        // Half of them in the shape of a version or a range, with a few
        // characters of the alphabet where a digit should be.
        let text = if rng.below(2) == 0 {
            rng.text(&alphabet, 14)
        } else {
            let mut parts: Vec<String> = Vec::new();
            for _ in 0..=rng.below(3) {
                parts.push(rng.text(&alphabet[..11], 3));
            }
            let caret = if rng.below(2) == 0 { "^" } else { "" };
            format!("{caret}{}", parts.join("."))
        };
        if let Ok(version) = Version::parse(&text) {
            versions += 1;
            assert_eq!(version.to_string(), text);
        }
        if let Ok(range) = Range::parse(&text) {
            ranges += 1;
            assert_eq!(range.to_string(), text);
            assert!(range.holds(&range.lowest()));
        }
        // And twice the same.
        assert_eq!(Range::parse(&text), Range::parse(&text));
    }
    // The generator does reach what is accepted.
    assert!(versions > 50 && ranges > 100, "{versions} {ranges}");
}

#[test]
fn times_have_one_written_form() {
    let alphabet: Vec<char> = "0123456789-T:Zz.+ ".chars().collect();
    let template: Vec<char> = "2026-02-28T23:59:59Z".chars().collect();
    let mut rng = Rng(0x1234_5678_9abc_def1);
    let mut accepted = 0;
    for _ in 0..CASES {
        // Mostly the shape of a time with a few characters replaced.
        let mut chars = template.clone();
        for _ in 0..rng.below(4) {
            let at = rng.below(chars.len());
            chars[at] = alphabet[rng.below(alphabet.len())];
        }
        if rng.below(10) == 0 {
            chars.truncate(rng.below(chars.len() + 1));
        }
        let text: String = chars.into_iter().collect();
        if let Ok(time) = Timestamp::parse(&text) {
            accepted += 1;
            assert_eq!(time.to_string(), text);
            assert_eq!(
                Timestamp::from_unix_seconds(time.unix_seconds()),
                Some(time)
            );
        }
        let free = rng.text(&alphabet, 24);
        if let Ok(time) = Timestamp::parse(&free) {
            assert_eq!(time.to_string(), free);
        }
    }
    assert!(accepted > 500, "{accepted}");
}

#[test]
fn what_names_and_paths_accept_has_the_properties_of_the_rules() {
    let alphabet: Vec<char> = "ab_AB09.-/\\: \u{435}\0~$con".chars().collect();
    let mut rng = Rng(0x0f0f_1e1e_2d2d_3c3c);
    let (mut names, mut paths) = (0, 0);
    for _ in 0..CASES * 2 {
        let text = rng.text(&alphabet, 16);
        if check_name(&text).is_ok() {
            names += 1;
            assert!(!text.is_empty() && text.is_ascii());
            assert!(text.split('.').all(|s| !s.is_empty()));
            assert!(
                text.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || b == b'_'
                    || b == b'.')
            );
            assert!(
                !text
                    .split('.')
                    .any(|s| s.starts_with(|c: char| c.is_ascii_digit()))
            );
        }
        let candidate = format!("{text}.mdt");
        for path in [text.as_str(), candidate.as_str()] {
            if check_module_path(path).is_ok() {
                paths += 1;
                assert!(path.is_ascii());
                assert!(path.ends_with(".mdt") || path.ends_with(".json"));
                assert!(!path.starts_with('/'));
                assert!(!path.contains(['\\', ':', '\0', ' ', '~', '$']));
                for segment in path.split('/') {
                    assert!(!segment.is_empty() && segment != "." && segment != "..");
                    assert!(!segment.starts_with('.') && !segment.ends_with('.'));
                    let stem = segment.split('.').next().unwrap().to_ascii_lowercase();
                    assert!(!["con", "prn", "aux", "nul"].contains(&stem.as_str()));
                }
            }
        }
    }
    assert!(names > 100 && paths > 100, "{names} {paths}");
}

const VALID_MANIFEST: &str = r#"{"library":"mandate/library/0.6","name":"acme.connectors","version":"2.3.0","modules":["connectors.mdt","sub/types.json"],"requires":{"std.patterns":"^1.0","acme.util":"^0.3.1","other":"4.5.6"}}"#;

/// The text of `manifest` as a `mandate.library.json`.
fn written(manifest: &mandate_lib::Manifest) -> String {
    let mut object = manifest.to_js();
    object.insert("library", "mandate/library/0.6");
    stringify(&JsValue::Object(object)).unwrap()
}

#[test]
fn a_mutated_manifest_is_refused_or_is_a_manifest_that_reads_back() {
    let mut rng = Rng(0xdead_beef_cafe_f00d);
    let inserts: Vec<u8> = br#"{}[]",:\/.^~-+ 0Aa_"#.to_vec();
    let (mut accepted, mut refused) = (0, 0);
    for _ in 0..CASES {
        let mut bytes = VALID_MANIFEST.as_bytes().to_vec();
        for _ in 0..=rng.below(3) {
            if bytes.is_empty() {
                break;
            }
            let at = rng.below(bytes.len());
            match rng.below(4) {
                0 => {
                    bytes.remove(at);
                }
                1 => bytes.insert(at, inserts[rng.below(inserts.len())]),
                2 => bytes[at] = inserts[rng.below(inserts.len())],
                _ => bytes[at] = (rng.next_u64() & 0xff) as u8,
            }
        }
        let first = read_manifest_bytes(&bytes);
        let second = read_manifest_bytes(&bytes);
        assert_eq!(first, second, "not deterministic");
        match first {
            Ok(manifest) => {
                accepted += 1;
                // What is accepted writes and reads back the same.
                let text = written(&manifest);
                assert_eq!(read_manifest(&text).as_ref(), Ok(&manifest), "{text}");
                // And has what the rules give it.
                assert!(check_name(manifest.name()).is_ok());
                let mut seen = std::collections::BTreeSet::new();
                for path in manifest.modules() {
                    assert!(check_module_path(path).is_ok());
                    assert!(seen.insert(path.to_ascii_lowercase()), "{path} twice");
                }
                assert!(!manifest.modules().is_empty());
                assert!(!manifest.requires().contains_key(manifest.name()));
            }
            Err(problems) => {
                refused += 1;
                assert!(!problems.is_empty());
            }
        }
    }
    assert!(accepted > 100 && refused > 1000, "{accepted} {refused}");
}

#[test]
fn a_mutated_lock_index_and_configuration_never_panic() {
    let d = format!("sha256:{:064x}", 7);
    let lock = format!(
        r#"{{"acme.connectors":{{"version":"2.3.0","digest":"{d}","modules":{{"acme.connectors":"{d}","acme.connectors.types":"{d}"}}}},"std.patterns":{{"version":"1.0.0","digest":"{d}","modules":{{"std.patterns":"{d}"}}}}}}"#
    );
    let config = format!(r#"{{"dir":"/srv/libs","wait_days":7,"revoked":["{d}","{d}"]}}"#);
    let index = r#"{"published_at":"2026-11-14T09:30:00Z"}"#;
    let mut rng = Rng(0x5555_aaaa_3333_cccc);
    let inserts: Vec<char> = r#"{}[]",:\/.^~-+ 0Aa_"#.chars().collect();
    let (mut locks, mut configs, mut indexes) = (0, 0, 0);
    for _ in 0..CASES {
        for (kind, source) in [(0, lock.as_str()), (1, config.as_str()), (2, index)] {
            let mut chars: Vec<char> = source.chars().collect();
            for _ in 0..=rng.below(3) {
                let at = rng.below(chars.len());
                match rng.below(3) {
                    0 => {
                        chars.remove(at);
                    }
                    1 => chars.insert(at, inserts[rng.below(inserts.len())]),
                    _ => chars[at] = inserts[rng.below(inserts.len())],
                }
            }
            let text: String = chars.into_iter().collect();
            if kind == 2 {
                assert_eq!(read_index(&text), read_index(&text));
                indexes += usize::from(read_index(&text).is_ok());
                continue;
            }
            let Ok(parsed) = parse(&text) else { continue };
            if kind == 0 {
                let first = read_lock_libraries(Some(&parsed.value));
                assert_eq!(first, read_lock_libraries(Some(&parsed.value)));
                locks += usize::from(first.is_ok());
            } else {
                let first = read_libraries_config(&parsed.value);
                assert_eq!(first, read_libraries_config(&parsed.value));
                configs += usize::from(first.is_ok());
            }
        }
    }
    assert!(
        locks > 50 && configs > 50 && indexes > 50,
        "{locks} {configs} {indexes}"
    );
}

#[test]
fn nothing_is_read_from_arbitrary_bytes_without_a_verdict() {
    let mut rng = Rng(0x0123_4567_89ab_cdef);
    for _ in 0..5000 {
        let len = rng.below(200);
        let bytes: Vec<u8> = (0..len).map(|_| (rng.next_u64() & 0xff) as u8).collect();
        assert!(read_manifest_bytes(&bytes).is_err());
    }
    // Deep nesting, a long run of one character, an enormous key.
    assert!(read_manifest(&"[".repeat(100_000)).is_err());
    assert!(read_manifest(&format!("{{\"{}\":1}}", "k".repeat(100_000))).is_err());
    assert!(read_manifest(&format!("{{\"requires\":{{{}}}}}", "\"a\":1,".repeat(3000))).is_err());
    assert!(Version::parse(&"9".repeat(100_000)).is_err());
    assert!(Range::parse(&format!("^{}", "1.".repeat(100_000))).is_err());
    assert!(Timestamp::parse(&"1".repeat(100_000)).is_err());
    assert!(check_module_path(&"a/".repeat(100_000)).is_err());
    assert!(check_name(&"a.".repeat(100_000)).is_err());
}
