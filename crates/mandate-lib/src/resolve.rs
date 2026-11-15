//! Resolution: which version of a library `mandate add` and `upgrade` take
//! (spec/library.md "`mandate add`, `upgrade` and `publish`", "Waiting
//! period and revocation").
//!
//! [`resolve`] chooses the highest version of the candidates the directory
//! holds that is within the range (any version when there is none), whose
//! waiting period is over and whose digest is not revoked. It is given the
//! candidates (what the caller read from the directory and computed), the
//! time, the waiting period and the revoked digests: it reads nothing and
//! has no clock.
//!
//! - **The wait.** A version may be resolved once
//!   `now >= published_at + wait_days × 86 400 s`: at the exact second the
//!   period ends it may, a second before it may not.
//! - **The pin.** The version the lock already pins is not held to the wait
//!   again. It is held to revocation, and to the range, like any other.
//! - **What is passed over.** Every candidate above the one chosen, or all
//!   of them when none is chosen, comes back with why it was not taken: it
//!   is outside the range, it is revoked, or it is waiting and from which
//!   day. A candidate that is both outside the range and revoked is
//!   "outside the range"; one that is revoked and waiting is "revoked": the
//!   reasons are given in that order, one for each.
//! - **Two candidates with one version** are a problem, not a choice: the
//!   directory has one directory for each version, so a caller that finds
//!   two has read it wrongly, and which of two digests is the version's is
//!   not for this function to say.

use std::cmp::Reverse;
use std::collections::{BTreeMap, BTreeSet};

use mandate_ir::{JsObject, JsValue};

use crate::digest::Digest;
use crate::problem::problem_object;
use crate::time::{Day, Timestamp, WaitDays};
use crate::version::{Range, Version};

/// A version the directory holds, as the caller read and computed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Candidate {
    /// The version (of its directory and its manifest).
    pub version: Version,
    /// Its digest, computed from its manifest and modules.
    pub digest: Digest,
    /// When it was published, from its `index.json`.
    pub published_at: Timestamp,
}

impl Candidate {
    /// The candidate as JSON: `{ version, digest, published_at }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with("version", self.version.to_string())
            .with("digest", self.digest.as_str())
            .with("published_at", self.published_at.to_string())
    }
}

/// What [`resolve`] is asked.
#[derive(Clone, Copy, Debug)]
pub struct Resolve<'a> {
    /// The library's name, for what is said of it.
    pub library: &'a str,
    /// The range the version must be within; `None` for any version.
    pub range: Option<&'a Range>,
    /// The versions the directory holds.
    pub candidates: &'a [Candidate],
    /// The waiting period.
    pub wait_days: WaitDays,
    /// The revoked digests.
    pub revoked: &'a BTreeSet<Digest>,
    /// The time the waiting period is compared with.
    pub now: Timestamp,
    /// The version the lock already pins, if it pins the library.
    pub pinned: Option<&'a Version>,
}

/// Why a version was not taken.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PassedOver {
    /// It is not within the range.
    OutsideRange,
    /// Its digest is revoked.
    Revoked,
    /// It was published less than the waiting period ago, and may be
    /// resolved from this day (UTC): the day of the instant its period ends.
    Waiting {
        /// The day.
        available_from: Day,
    },
}

impl PassedOver {
    /// The reason's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            PassedOver::OutsideRange => "outside_range",
            PassedOver::Revoked => "revoked",
            PassedOver::Waiting { .. } => "waiting",
        }
    }
}

/// A candidate that was not taken, and why.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Skipped {
    /// The candidate.
    pub candidate: Candidate,
    /// Why not.
    pub reason: PassedOver,
}

impl Skipped {
    /// `{ version, digest, published_at, reason }`, and `available_from`
    /// (`YYYY-MM-DD`) for a version that is waiting.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let mut out = self.candidate.to_js().with("reason", self.reason.id());
        if let PassedOver::Waiting { available_from } = self.reason {
            out.insert("available_from", available_from.to_string());
        }
        out
    }
}

/// The answer of [`resolve`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Resolution {
    /// The version taken, if any is eligible.
    pub chosen: Option<Candidate>,
    /// The candidates above the one chosen (all of them when none is), the
    /// highest first, each with why it was not taken.
    pub passed_over: Vec<Skipped>,
}

impl Resolution {
    /// `{ chosen, passed_over }`: `chosen` is a candidate or `null`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with(
                "chosen",
                self.chosen
                    .as_ref()
                    .map_or(JsValue::Null, |c| JsValue::Object(c.to_js())),
            )
            .with(
                "passed_over",
                JsValue::Array(
                    self.passed_over
                        .iter()
                        .map(|s| JsValue::Object(s.to_js()))
                        .collect(),
                ),
            )
    }
}

/// A problem with what was given to [`resolve`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResolveProblem {
    /// Two or more candidates have one version.
    DuplicateVersion {
        /// The library.
        library: String,
        /// The version.
        version: Version,
        /// How many candidates have it.
        count: usize,
    },
}

impl ResolveProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            ResolveProblem::DuplicateVersion { .. } => "duplicate_version",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            ResolveProblem::DuplicateVersion {
                library,
                version,
                count,
            } => base
                .with("library", library.as_str())
                .with("version", version.to_string())
                .with("count", *count),
        }
    }
}

/// Why `candidate` may not be taken, or `None` when it may.
fn why_not(request: &Resolve<'_>, candidate: &Candidate) -> Option<PassedOver> {
    if request
        .range
        .is_some_and(|range| !range.holds(&candidate.version))
    {
        return Some(PassedOver::OutsideRange);
    }
    if request.revoked.contains(&candidate.digest) {
        return Some(PassedOver::Revoked);
    }
    if request.pinned == Some(&candidate.version) {
        return None;
    }
    let ready = request.wait_days.ready_at_unix(candidate.published_at);
    if request.now.unix_seconds() >= ready {
        return None;
    }
    Some(PassedOver::Waiting {
        available_from: Day::of_unix_seconds_or_epoch(ready),
    })
}

/// Chooses the version to take.
///
/// # Errors
///
/// [`ResolveProblem::DuplicateVersion`] for each version that more than one
/// candidate has, by version.
pub fn resolve(request: &Resolve<'_>) -> Result<Resolution, Vec<ResolveProblem>> {
    let mut counts: BTreeMap<Version, usize> = BTreeMap::new();
    for candidate in request.candidates {
        let count = counts.entry(candidate.version).or_insert(0);
        *count = count.saturating_add(1);
    }
    let duplicates: Vec<ResolveProblem> = counts
        .into_iter()
        .filter(|&(_, count)| count > 1)
        .map(|(version, count)| ResolveProblem::DuplicateVersion {
            library: request.library.to_owned(),
            version,
            count,
        })
        .collect();
    if !duplicates.is_empty() {
        return Err(duplicates);
    }

    let mut ordered: Vec<&Candidate> = request.candidates.iter().collect();
    ordered.sort_by_key(|candidate| Reverse(candidate.version));
    let mut passed_over = Vec::new();
    for candidate in ordered {
        match why_not(request, candidate) {
            None => {
                return Ok(Resolution {
                    chosen: Some(candidate.clone()),
                    passed_over,
                });
            }
            Some(reason) => passed_over.push(Skipped {
                candidate: candidate.clone(),
                reason,
            }),
        }
    }
    Ok(Resolution {
        chosen: None,
        passed_over,
    })
}
