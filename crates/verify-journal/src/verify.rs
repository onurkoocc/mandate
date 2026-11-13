//! Verification, step by step (spec/journal.md "Verification").

use std::collections::{BTreeSet, HashMap, HashSet};

use mandate_ir::{hash_program, package_hash};

use crate::canonical::{digest, digest_of_canonical, write_canonical};
use crate::export::{Anchor, Event, Export, Package, read_export};
use crate::json::Json;
use crate::keys::{PublicKey, parse_signature};
use crate::read::ReadError;
use crate::report::{Code, Finding, Report, Status};

/// The format of an anchor's statement, and the line its signature begins
/// with.
pub const ANCHOR_FORMAT: &str = "mandate/journal-anchor/0.1";

/// The events a state change writes; each of a chained run is anchored.
pub const STATE_EVENTS: [&str; 8] = [
    "run_accepted",
    "run_running",
    "run_waiting",
    "run_cancelling",
    "run_attention_required",
    "run_succeeded",
    "run_failed",
    "run_cancelled",
];

/// Verifies an export's bytes under the public keys given, and nothing else.
#[must_use]
pub fn verify_export(bytes: &[u8], keys: &[PublicKey]) -> Report {
    match read_export(bytes) {
        Ok(export) => verify(&export, keys),
        Err(e) => {
            let code = match e {
                ReadError::OverLimit(_) => Code::ExportOverLimit,
                ReadError::Malformed(_) => Code::MalformedExport,
            };
            Report {
                run: None,
                status: Status::Unreadable,
                events: 0,
                last_seq: None,
                anchored_through: None,
                unanchored: 0,
                signed_by: Vec::new(),
                findings: vec![Finding { code, seq: None }],
                problem: Some(e.problem().to_owned()),
            }
        }
    }
}

/// The canonical form of an event's link `{run, seq, type, data, at, prev}`,
/// its members in canonical order: `at`, `data`, `prev`, `run`, `seq`, `type`.
#[must_use]
pub fn event_link(run: &str, event: &Event, prev: Option<&str>) -> String {
    let mut out = String::new();
    out.push_str("{\"at\":");
    out.push_str(&event.at.to_string());
    out.push_str(",\"data\":");
    write_canonical(&mut out, &event.data);
    out.push_str(",\"prev\":");
    match prev {
        Some(p) => mandate_ir::write_json_string(&mut out, p),
        None => out.push_str("null"),
    }
    out.push_str(",\"run\":");
    mandate_ir::write_json_string(&mut out, run);
    out.push_str(",\"seq\":");
    out.push_str(&event.seq.to_string());
    out.push_str(",\"type\":");
    mandate_ir::write_json_string(&mut out, &event.kind);
    out.push('}');
    out
}

/// An event's hash: the `event` digest of its link.
#[must_use]
pub fn event_hash(run: &str, event: &Event, prev: Option<&str>) -> String {
    digest_of_canonical("event", &event_link(run, event, prev))
}

/// What an anchor's signature covers: `mandate/journal-anchor/0.1`, a line
/// feed, and the canonical form of `{format, run, seq, hash, at}`, its
/// members in canonical order: `at`, `format`, `hash`, `run`, `seq`.
#[must_use]
pub fn anchor_message(run: &str, seq: u64, hash: &str, at: i64) -> String {
    let mut out = String::new();
    out.push_str(ANCHOR_FORMAT);
    out.push('\n');
    out.push_str("{\"at\":");
    out.push_str(&at.to_string());
    out.push_str(",\"format\":");
    mandate_ir::write_json_string(&mut out, ANCHOR_FORMAT);
    out.push_str(",\"hash\":");
    mandate_ir::write_json_string(&mut out, hash);
    out.push_str(",\"run\":");
    mandate_ir::write_json_string(&mut out, run);
    out.push_str(",\"seq\":");
    out.push_str(&seq.to_string());
    out.push('}');
    out
}

fn finding(code: Code, seq: u64) -> Finding {
    Finding {
        code,
        seq: Some(seq),
    }
}

/// Verifies an export read and held to its shape.
#[must_use]
pub fn verify(x: &Export, keys: &[PublicKey]) -> Report {
    let last_seq = x.events.last().map(|e| e.seq);
    let report = |status, anchored_through, unanchored, signed_by, findings| Report {
        run: Some(x.run.clone()),
        status,
        events: x.events.len(),
        last_seq,
        anchored_through,
        unanchored,
        signed_by,
        findings,
        problem: None,
    };

    // 0. Unchained: no event has a hash and there is no anchor.
    if x.events.iter().all(|e| e.hash.is_none()) && x.anchors.is_empty() {
        return report(
            Status::Unchained,
            None,
            x.events.len(),
            Vec::new(),
            Vec::new(),
        );
    }
    let mut findings: Vec<Finding> = Vec::new();

    // 1. Seqs: the i-th event has seq i; the first that does not is a gap.
    let gap = x
        .events
        .iter()
        .zip(1_u64..)
        .find(|(e, i)| e.seq != *i)
        .map(|(_, i)| i);
    if let Some(i) = gap {
        findings.push(finding(Code::SeqGap, i));
    }

    // 2. The chain, `prev` being each event's hash as the export gives it.
    let mut prev: Option<&str> = None;
    for e in &x.events {
        match &e.hash {
            None => findings.push(finding(Code::HashMissing, e.seq)),
            Some(h) if *h != event_hash(&x.run, e, prev) => {
                findings.push(finding(Code::ChainBroken, e.seq));
            }
            Some(_) => {}
        }
        prev = e.hash.as_deref();
    }

    // 3 and 4. The manifest and the package the first event names.
    let accepted = x
        .events
        .first()
        .filter(|e| e.seq == 1 && e.kind == "run_accepted" && e.data.is_object())
        .map(|e| &e.data);
    if !manifest_holds(x, accepted) {
        findings.push(Finding {
            code: Code::ManifestMismatch,
            seq: None,
        });
    }
    let named = accepted
        .and_then(|a| a.get("package"))
        .and_then(Json::as_str);
    if !named.is_some_and(|n| package_holds(&x.package, n)) {
        findings.push(Finding {
            code: Code::PackageMismatch,
            seq: None,
        });
    }

    // 5. Anchors. The event an anchor names is the first with its seq in the
    //    export's order.
    let by_id: HashMap<&str, &PublicKey> = keys.iter().map(|k| (k.id(), k)).collect();
    let max_seq = x.events.iter().map(|e| e.seq).max().unwrap_or(0);
    let mut by_seq: HashMap<u64, &Event> = HashMap::new();
    for e in &x.events {
        by_seq.entry(e.seq).or_insert(e);
    }
    let mut through: Option<u64> = None;
    let mut signers: BTreeSet<&str> = BTreeSet::new();
    for a in &x.anchors {
        let key = by_id.get(a.key_id.as_str());
        let signed = key.is_some_and(|k| anchor_signed(k, &x.run, a));
        if key.is_none() {
            findings.push(finding(Code::AnchorUnknownKey, a.seq));
        } else if !signed {
            findings.push(finding(Code::AnchorSignatureInvalid, a.seq));
        }
        let matches = by_seq
            .get(&a.seq)
            .is_some_and(|e| e.hash.as_deref() == Some(a.hash.as_str()) && e.at == a.at);
        if a.seq > max_seq {
            findings.push(finding(Code::AnchorBeyondEnd, a.seq));
        } else if !matches {
            findings.push(finding(Code::AnchorMismatch, a.seq));
        }
        if signed && matches {
            through = Some(a.seq);
            signers.insert(a.key_id.as_str());
        }
    }

    // 6. Every state event has an anchor at its seq.
    let anchored: HashSet<u64> = x.anchors.iter().map(|a| a.seq).collect();
    for e in &x.events {
        if STATE_EVENTS.contains(&e.kind.as_str()) && !anchored.contains(&e.seq) {
            findings.push(finding(Code::AnchorMissing, e.seq));
        }
    }

    // 7. The tail no signature covers.
    let floor = through.unwrap_or(0);
    let mut after = x.events.iter().filter(|e| e.seq > floor);
    let first_after = after.next().map(|e| e.seq);
    let unanchored = usize::from(first_after.is_some()).saturating_add(after.count());
    if let Some(seq) = first_after {
        findings.push(finding(Code::UnanchoredTail, seq));
    }

    let status = if findings.iter().any(|f| f.code != Code::UnanchoredTail) {
        Status::Broken
    } else {
        Status::Verified
    };
    // A BTreeSet of ASCII key ids is in the order of their UTF-16 code units.
    let signed_by = signers.into_iter().map(str::to_owned).collect();
    report(status, through, unanchored, signed_by, findings)
}

/// Whether an anchor's signature is a canonical `ed25519:` signature by
/// `key` over its statement.
fn anchor_signed(key: &PublicKey, run: &str, a: &Anchor) -> bool {
    parse_signature(&a.signature)
        .is_some_and(|sig| key.verifies(anchor_message(run, a.seq, &a.hash, a.at).as_bytes(), &sig))
}

/// Step 3: the manifest is the one the first event names.
fn manifest_holds(x: &Export, accepted: Option<&Json>) -> bool {
    let Some(accepted) = accepted else {
        return false;
    };
    let Some(named) = accepted.get("manifest").and_then(Json::as_str) else {
        return false;
    };
    if !x.manifest.is_object() || digest("run", &x.manifest) != named {
        return false;
    }
    if x.manifest_hash.as_deref() != Some(named) {
        return false;
    }
    let tenant = x.manifest.get("tenant").and_then(Json::as_str);
    if tenant != Some(x.tenant.as_str()) {
        return false;
    }
    let in_manifest = x.manifest.get("package").and_then(Json::as_str);
    let in_event = accepted.get("package").and_then(Json::as_str);
    in_manifest.is_some() && in_manifest == in_event
}

/// Step 4: the package hashes to `named`, the hash the first event names,
/// and each module to its pin in the lock. The hashes are over the IR's
/// canonical form, so a program, lock or module that holds a number the IR
/// does not admit hashes to no package.
fn package_holds(p: &Package, named: &str) -> bool {
    if p.hash != named {
        return false;
    }
    let (Some(program), Some(lock)) = (p.program.to_ir(), p.lock.to_ir()) else {
        return false;
    };
    if package_hash(&hash_program(&program).program, &lock) != named {
        return false;
    }
    // A lock whose `modules` is not an object pins no module.
    let pins: HashMap<&str, &Json> = p
        .lock
        .get("modules")
        .and_then(Json::as_object)
        .unwrap_or_default()
        .iter()
        .map(|(n, v)| (n.as_str(), v))
        .collect();
    let modules = p.modules.as_object().unwrap_or_default();
    modules.iter().all(|(name, module)| {
        let pin = pins.get(name.as_str()).and_then(|v| v.as_str());
        module.is_object()
            && module.get("module").and_then(Json::as_str) == Some(name.as_str())
            && pin.is_some_and(|pin| {
                module
                    .to_ir()
                    .is_some_and(|m| hash_program(&m).program == pin)
            })
    })
}
