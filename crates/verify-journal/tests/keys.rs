//! Public keys in PEM, their key ids, and signatures (spec/journal.md
//! "Anchors").

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

use verify_journal::keys::{SPKI_PREFIX, parse_signature};
use verify_journal::{KeyError, PublicKey, public_keys_in};

/// RFC 8032 §7.1, test 1: the key, and its signature of the empty message.
const RFC_KEY: &str = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
const RFC_SIG: &str = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b";
/// The same signature with S + L in place of S: the same scalar mod L, which
/// a verifier must refuse (OpenSSL, the reference's, does).
const RFC_SIG_S_PLUS_L: &str = "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901554c8c7872aa064e049dbb3013fbf29380d25bf5f0595bbe24655141438e7a101b";
/// The key as `createPublicKey(…).export({ type: "spki", format: "pem" })`
/// writes it, and its id, from Node.
const RFC_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=\n-----END PUBLIC KEY-----\n";
const RFC_KEY_ID: &str = "sha256:06e3fd8fda29bb60ab59557de61edb0aecdb231134be30e75b455f8e1b792fa9";
const RFC_SIG_B64: &str =
    "5VZDAMNgrHKQhuLMgG6CioSHfx645dl02HPgZSJJAVVfuIIVkKM7rMYeOXAc+bRr0lv18FlbviRlUUFDjnoQCw==";

fn hex(s: &str) -> Vec<u8> {
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).expect("hex"))
        .collect()
}

fn rfc_key() -> PublicKey {
    PublicKey::from_raw(hex(RFC_KEY).try_into().expect("32 bytes"))
}

#[test]
fn a_pem_public_key_and_its_id() {
    let keys = public_keys_in(RFC_PEM).expect("a key");
    assert_eq!(keys, vec![rfc_key()]);
    assert_eq!(keys[0].id(), RFC_KEY_ID);
    assert_eq!(hex(RFC_KEY), keys[0].raw().to_vec());
    let mut der = SPKI_PREFIX.to_vec();
    der.extend_from_slice(&hex(RFC_KEY));
    assert_eq!(PublicKey::from_spki_der(&der), Ok(rfc_key()));
}

#[test]
fn several_blocks_and_text_around_them() {
    let two = format!(
        "a comment\r\n{}\r\nbetween\n{}",
        RFC_PEM.replace('\n', "\r\n"),
        J01_PEM
    );
    let keys = public_keys_in(&two).expect("two keys");
    assert_eq!(keys.len(), 2);
    assert_eq!(keys[0], rfc_key());
    // The spellings Node's createPublicKey (OpenSSL) reads, and those it
    // refuses, which are no Ed25519 key here either.
    let body = "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=";
    let (begin, end) = ("-----BEGIN PUBLIC KEY-----", "-----END PUBLIC KEY-----");
    for spelled in [
        format!("{begin}\n{}\n{}\n{end}", &body[..10], &body[10..]),
        format!("{begin}\n  {body}\t\n{end}"),
        format!("{begin} \n{body}\n{end}"),
        format!("{begin}\n{} {}\n{end}", &body[..20], &body[20..]),
        format!("{begin}\n{body}\n{end}"),
    ] {
        assert_eq!(public_keys_in(&spelled), Ok(vec![rfc_key()]), "{spelled}");
    }
    for refused in [
        format!("{begin}{body}{end}"),
        format!("{begin}\n{body}{end}"),
        format!("{begin}\r{body}\r{end}"),
        format!("{begin}\n\n{body}\n\n{end}"),
        format!("{begin}\n{}\n{end}", &body[..body.len() - 1]),
        format!("{begin}\n{body}{body}\n{end}"),
    ] {
        assert!(
            matches!(
                public_keys_in(&refused),
                Err(KeyError::NotEd25519 { block: 1, .. })
            ),
            "{refused}"
        );
    }
}

const J01_PEM: &str = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAOOBpcACH508avRnRhV4M45mfAeUfINN5Lpn6ycvi1Gw=\n-----END PUBLIC KEY-----\n";

#[test]
fn only_public_key_blocks_are_read() {
    assert_eq!(public_keys_in(""), Err(KeyError::NoPublicKey));
    assert_eq!(
        public_keys_in("MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo="),
        Err(KeyError::NoPublicKey)
    );
    // Another kind of block is not read: a private key (`mandate journal
    // verify` reads none from a key file), a certificate. Their labels are
    // put together here so that no file holds what looks like a key; the
    // bodies are not keys.
    for label in [["PRIVATE", "KEY"].join(" "), "CERTIFICATE".to_owned()] {
        let other = format!("-----BEGIN {label}-----\nAAAA\n-----END {label}-----\n");
        assert_eq!(
            public_keys_in(&other),
            Err(KeyError::NoPublicKey),
            "{label}"
        );
        assert_eq!(
            public_keys_in(&format!("{other}{RFC_PEM}")),
            Ok(vec![rfc_key()])
        );
    }
    // A block with a `-` in its body is no block; the next one is read.
    let dashed = format!("-----BEGIN PUBLIC KEY-----\nab-cd\n-----END PUBLIC KEY-----\n{RFC_PEM}");
    assert_eq!(public_keys_in(&dashed), Ok(vec![rfc_key()]));
    // A BEGIN without its END reads nothing.
    assert_eq!(
        public_keys_in("-----BEGIN PUBLIC KEY-----\nMCow\n"),
        Err(KeyError::NoPublicKey)
    );
}

#[test]
fn a_public_key_block_that_is_not_an_ed25519_key() {
    let block =
        |b64: &str| format!("-----BEGIN PUBLIC KEY-----\n{b64}\n-----END PUBLIC KEY-----\n");
    for b64 in [
        // X25519 (OID 1.3.101.110), an Ed25519 key one byte short, one byte
        // long, not base64, and padding in the middle.
        "MCowBQYDK2VuAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
        "MCkwBQYDK2VwAyAA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHUQ==",
        "MCswBQYDK2VwAyIA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURoA",
        "MCowBQYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHUR*=",
        "MCow=QYDK2VwAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=",
        "",
    ] {
        assert!(
            matches!(
                public_keys_in(&block(b64)),
                Err(KeyError::NotEd25519 { block: 1, .. })
            ),
            "{b64}"
        );
    }
    // One good block does not excuse a bad one.
    let mixed = format!(
        "{RFC_PEM}{}",
        block("MCowBQYDK2VuAyEA11qYAYKxCrfVS/7TyWQHOg7hcvPapiMlrwIaaPcHURo=")
    );
    assert!(matches!(
        public_keys_in(&mixed),
        Err(KeyError::NotEd25519 { block: 2, .. })
    ));
}

#[test]
fn signatures_are_canonical_base64_of_64_bytes() {
    let good = format!("ed25519:{RFC_SIG_B64}");
    assert_eq!(
        parse_signature(&good).map(|s| s.to_vec()),
        Some(hex(RFC_SIG))
    );
    // The last character before == carries 2 bits of data and 4 unused ones:
    // `w` is 110000; `x` (110001) differs only in an unused bit.
    let unused = good.replacen("Cw==", "Cx==", 1);
    assert_ne!(unused, good);
    assert_eq!(parse_signature(&unused), None);
    for bad in [
        RFC_SIG_B64.to_owned(),
        format!("ED25519:{RFC_SIG_B64}"),
        format!("ed25519:{}", &RFC_SIG_B64[..86]),
        format!("ed25519:{}=", &RFC_SIG_B64[..86]),
        format!("ed25519:{RFC_SIG_B64}="),
        format!("ed25519: {RFC_SIG_B64}"),
        format!("ed25519:{}", RFC_SIG_B64.replace('+', "-")),
        format!("ed25519:{}===", &RFC_SIG_B64[..85]),
        "ed25519:".to_owned(),
    ] {
        assert_eq!(parse_signature(&bad), None, "{bad}");
    }
}

#[test]
fn verification_is_rfc_8032_with_s_below_l() {
    let key = rfc_key();
    let sig: [u8; 64] = hex(RFC_SIG).try_into().expect("64 bytes");
    assert!(key.verifies(b"", &sig));
    assert!(!key.verifies(b"x", &sig));
    let mut flipped = sig;
    flipped[0] ^= 1;
    assert!(!key.verifies(b"", &flipped));
    let s_plus_l: [u8; 64] = hex(RFC_SIG_S_PLUS_L).try_into().expect("64 bytes");
    assert!(!key.verifies(b"", &s_plus_l), "S must be below L");
    // Any 32 bytes are a key; one that is no point verifies nothing.
    assert!(!PublicKey::from_raw([0xff; 32]).verifies(b"", &sig));
    assert!(!PublicKey::from_raw([0; 32]).verifies(b"", &sig));
}
