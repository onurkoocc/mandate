//! The report a verifier gives, `mandate/journal-verification/0.1`
//! (spec/journal.md "The report").

use std::fmt::Write as _;

use crate::canonical::write_number;
use crate::json::Json;

/// The format of a report.
pub const REPORT_FORMAT: &str = "mandate/journal-verification/0.1";

/// What a report says of the journal.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Status {
    /// The chain holds from seq 1, every state event is anchored, and the
    /// anchors that hold cover the events through `anchored_through`.
    Verified,
    /// The export was read, and the chain or the anchors do not hold.
    Broken,
    /// No event has a hash and nothing is anchored: nothing is said.
    Unchained,
    /// The export could not be read, or is beyond the limits.
    Unreadable,
}

impl Status {
    /// Its name in a report.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Status::Verified => "verified",
            Status::Broken => "broken",
            Status::Unchained => "unchained",
            Status::Unreadable => "unreadable",
        }
    }

    /// The exit status of `verify-journal` and `mandate journal verify`: 0
    /// verified; 1 broken or unchained, checked and not verified; 2
    /// unreadable, nothing checked.
    #[must_use]
    pub const fn exit_code(self) -> u8 {
        match self {
            Status::Verified => 0,
            Status::Broken | Status::Unchained => 1,
            Status::Unreadable => 2,
        }
    }
}

/// What a finding says.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Code {
    /// The export is not JSON by the rules, or not of an export's shape.
    MalformedExport,
    /// The export is larger or nests deeper than every verifier reads.
    ExportOverLimit,
    /// An event was removed or moved.
    SeqGap,
    /// An event of a chained run has no hash.
    HashMissing,
    /// The event's hash is not that of its contents and the hash before it.
    ChainBroken,
    /// The manifest is not the one the first event names.
    ManifestMismatch,
    /// The package is not the one the first event names.
    PackageMismatch,
    /// The anchor's key is not among the keys given.
    AnchorUnknownKey,
    /// The anchor's signature does not verify.
    AnchorSignatureInvalid,
    /// The anchor names an event past the last one: the tail was cut.
    AnchorBeyondEnd,
    /// The anchor's hash or time is not its event's.
    AnchorMismatch,
    /// A state event has no anchor.
    AnchorMissing,
    /// No signature covers the events from here on.
    UnanchoredTail,
}

impl Code {
    /// Its name in a report.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Code::MalformedExport => "malformed_export",
            Code::ExportOverLimit => "export_over_limit",
            Code::SeqGap => "seq_gap",
            Code::HashMissing => "hash_missing",
            Code::ChainBroken => "chain_broken",
            Code::ManifestMismatch => "manifest_mismatch",
            Code::PackageMismatch => "package_mismatch",
            Code::AnchorUnknownKey => "anchor_unknown_key",
            Code::AnchorSignatureInvalid => "anchor_signature_invalid",
            Code::AnchorBeyondEnd => "anchor_beyond_end",
            Code::AnchorMismatch => "anchor_mismatch",
            Code::AnchorMissing => "anchor_missing",
            Code::UnanchoredTail => "unanchored_tail",
        }
    }

    /// What it means, for a person, as `mandate journal verify` prints it.
    #[must_use]
    pub const fn meaning(self) -> &'static str {
        match self {
            Code::MalformedExport => "the export is not a journal export",
            Code::ExportOverLimit => "the export is larger or deeper than a verifier reads",
            Code::SeqGap => {
                "the events are not numbered 1, 2, 3, … from here: one was removed or moved"
            }
            Code::HashMissing => "the event of a chained run has no hash",
            Code::ChainBroken => {
                "the event's hash is not the hash of its contents and of the hash before it"
            }
            Code::ManifestMismatch => "the manifest is not the one the first event names",
            Code::PackageMismatch => "the package is not the one the first event names",
            Code::AnchorUnknownKey => "the anchor is signed by a key not given",
            Code::AnchorSignatureInvalid => "the anchor's signature does not verify",
            Code::AnchorBeyondEnd => {
                "the anchor names an event past the last one: the tail was cut"
            }
            Code::AnchorMismatch => "the anchor's hash or time is not the event's",
            Code::AnchorMissing => "the state event has no anchor",
            Code::UnanchoredTail => "no signature covers the events from here on",
        }
    }
}

/// One finding: a code, and the seq it is at when it has one.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Finding {
    /// What it says.
    pub code: Code,
    /// The seq it is at, for the codes that have one.
    pub seq: Option<u64>,
}

/// A verifier's report.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Report {
    /// The export's run id; `None` for an unreadable export.
    pub run: Option<String>,
    /// What it says of the journal.
    pub status: Status,
    /// How many events the export has; 0 for an unreadable export.
    pub events: usize,
    /// The seq of the export's last event; `None` for an unreadable export.
    pub last_seq: Option<u64>,
    /// The greatest seq of an anchor that holds.
    pub anchored_through: Option<u64>,
    /// How many events have a seq greater than `anchored_through`.
    pub unanchored: usize,
    /// The key ids of the anchors that hold, sorted, each once.
    pub signed_by: Vec<String>,
    /// The findings, in the order the steps find them.
    pub findings: Vec<Finding>,
    /// Why an unreadable export could not be read, for a person. Not a
    /// member of the report.
    pub problem: Option<String>,
}

impl Report {
    /// The report as a JSON value, its members in the order of the format.
    #[must_use]
    pub fn to_json(&self) -> Json {
        let count = |n: usize| Json::Number(n as f64);
        let seq = |s: Option<u64>| s.map_or(Json::Null, |n| Json::Number(n as f64));
        let findings = self
            .findings
            .iter()
            .map(|f| {
                let mut members =
                    vec![("code".to_owned(), Json::String(f.code.as_str().to_owned()))];
                if let Some(s) = f.seq {
                    members.push(("seq".to_owned(), Json::Number(s as f64)));
                }
                Json::Object(members)
            })
            .collect();
        Json::Object(vec![
            ("format".to_owned(), Json::String(REPORT_FORMAT.to_owned())),
            (
                "run".to_owned(),
                self.run.clone().map_or(Json::Null, Json::String),
            ),
            (
                "status".to_owned(),
                Json::String(self.status.as_str().to_owned()),
            ),
            ("events".to_owned(), count(self.events)),
            ("last_seq".to_owned(), seq(self.last_seq)),
            ("anchored_through".to_owned(), seq(self.anchored_through)),
            ("unanchored".to_owned(), count(self.unanchored)),
            (
                "signed_by".to_owned(),
                Json::Array(self.signed_by.iter().cloned().map(Json::String).collect()),
            ),
            ("findings".to_owned(), Json::Array(findings)),
        ])
    }

    /// The report as `mandate journal verify --json` prints it:
    /// `JSON.stringify(report, null, 2)` and a line feed.
    #[must_use]
    pub fn to_pretty(&self) -> String {
        let mut out = String::new();
        write_pretty(&mut out, &self.to_json(), 0);
        out.push('\n');
        out
    }

    /// What `mandate journal verify` prints without `--json`, for a person:
    /// the status, each finding with what it means, and for a verified
    /// journal how far the signatures reach. `export` names the file.
    #[must_use]
    pub fn summary(&self, export: &str) -> String {
        let mut lines = vec![match &self.run {
            Some(run) => format!(
                "{}: run {run}, {} events",
                self.status.as_str(),
                self.events
            ),
            None => format!("{}: {export}", self.status.as_str()),
        }];
        match self.status {
            Status::Unreadable => lines.push(
                "  the export could not be read, so nothing is said about the journal".to_owned(),
            ),
            Status::Unchained => lines.push(
                "  the run began before its journal was chained: no event has a hash and nothing is anchored, so nothing can be verified"
                    .to_owned(),
            ),
            Status::Verified | Status::Broken => {}
        }
        for f in &self.findings {
            let mut line = format!("  {}", f.code.as_str());
            if let Some(seq) = f.seq {
                let _ = write!(line, " at seq {seq}");
            }
            let _ = write!(line, ": {}", f.code.meaning());
            if let Some(problem) = &self.problem {
                let _ = write!(line, " ({problem})");
            }
            lines.push(line);
        }
        if self.status == Status::Verified
            && let Some(through) = self.anchored_through
        {
            let after = if self.unanchored == 1 {
                "1 event".to_owned()
            } else {
                format!("{} events", self.unanchored)
            };
            lines.push(format!(
                "  signed through seq {through} by {}; {after} after it covered by no signature",
                self.signed_by.join(", ")
            ));
        }
        let mut out = lines.join("\n");
        out.push('\n');
        out
    }
}

/// Writes `value` as `JSON.stringify(value, null, 2)` writes it, at `indent`
/// levels of two spaces.
fn write_pretty(out: &mut String, value: &Json, indent: usize) {
    let pad = |out: &mut String, level: usize| {
        for _ in 0..level {
            out.push_str("  ");
        }
    };
    let inner = indent.saturating_add(1);
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Number(x) => write_number(out, *x),
        Json::String(s) => mandate_ir::write_json_string(out, s),
        Json::Array(items) if items.is_empty() => out.push_str("[]"),
        Json::Object(members) if members.is_empty() => out.push_str("{}"),
        Json::Array(items) => {
            out.push_str("[\n");
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                pad(out, inner);
                write_pretty(out, item, inner);
            }
            out.push('\n');
            pad(out, indent);
            out.push(']');
        }
        Json::Object(members) => {
            out.push_str("{\n");
            for (i, (name, item)) in members.iter().enumerate() {
                if i > 0 {
                    out.push_str(",\n");
                }
                pad(out, inner);
                mandate_ir::write_json_string(out, name);
                out.push_str(": ");
                write_pretty(out, item, inner);
            }
            out.push('\n');
            pad(out, indent);
            out.push('}');
        }
    }
}
