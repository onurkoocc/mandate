//! `mandate publish`'s version rule (spec/library.md "`mandate add`,
//! `upgrade` and `publish`"; the facts of E1607).
//!
//! `publish` refuses a version already published, and a version that is not
//! a major one above the highest published version *below* it when, against
//! that version, it widens the authority signature, removes a criterion or
//! adds a waiver. A major version is one whose `MAJOR` is greater: `2.0.0`
//! is a major one above `1.9.9`, `1.1.0` is not a major one above `1.0.0`.
//! The first version of a library, and a version with none below it, is any
//! version.
//!
//! The comparison with the base is made by the caller (it needs the
//! checker), and it needs the base first, so the rule is two steps that a
//! caller cannot run out of order or skip:
//!
//! 1. [`plan_publish`] refuses a version already published and gives a
//!    [`PublishPlan`]: [`PublishPlan::First`], for which nothing is
//!    compared, or [`PublishPlan::Above`], which holds the base to compare
//!    with.
//! 2. [`Above::judge`] takes the [`BaseComparison`] the caller made of the
//!    new version against that base, and gives the verdict. It takes `self`
//!    by value and the comparison as a value of a type nothing else makes,
//!    so there is no way to a verdict on a version that has a base without
//!    the comparison.

use mandate_ir::JsObject;

use crate::problem::problem_object;
use crate::version::Version;

/// What the caller found of a new version against its base.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct BaseComparison {
    /// The new version widens the authority signature of the base.
    pub widens_authority: bool,
    /// The new version removes a criterion the base has.
    pub removes_criterion: bool,
    /// The new version adds a waiver the base does not have.
    pub adds_waiver: bool,
    /// 0.7: the new version changes who approves a workflow's card and signs
    /// its promotions (its `owner` added, removed or another role). Only a
    /// module of 0.7 has an `owner`, so a library of 0.6 never sets it, and
    /// its facts do not name it.
    pub changes_owner: bool,
}

impl BaseComparison {
    /// Whether any of them holds: the new version must then be a major one
    /// above its base.
    #[must_use]
    pub const fn requires_major(&self) -> bool {
        self.widens_authority || self.removes_criterion || self.adds_waiver || self.changes_owner
    }

    /// The facts of a refusal: the three of 0.6, and `changes_owner` when it
    /// holds, so that what a library of 0.6 is told does not change.
    fn facts(&self, o: JsObject) -> JsObject {
        let o = o
            .with("widens_authority", self.widens_authority)
            .with("removes_criterion", self.removes_criterion)
            .with("adds_waiver", self.adds_waiver);
        if self.changes_owner {
            o.with("changes_owner", true)
        } else {
            o
        }
    }
}

/// A version that may be published, and what it is to be compared with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublishPlan {
    /// No published version is below it: any version is allowed, and
    /// nothing is compared.
    First(Version),
    /// A published version is below it, which it must be compared with.
    Above(Above),
}

impl PublishPlan {
    /// The version to be published.
    #[must_use]
    pub const fn version(&self) -> &Version {
        match self {
            PublishPlan::First(version) => version,
            PublishPlan::Above(above) => &above.version,
        }
    }

    /// The version to compare it with, when there is one.
    #[must_use]
    pub const fn base(&self) -> Option<&Version> {
        match self {
            PublishPlan::First(_) => None,
            PublishPlan::Above(above) => Some(&above.base),
        }
    }
}

/// A version to publish above a published one, awaiting the comparison.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Above {
    version: Version,
    base: Version,
}

impl Above {
    /// The version to be published.
    #[must_use]
    pub const fn version(&self) -> &Version {
        &self.version
    }

    /// The highest published version below it: what to compare with.
    #[must_use]
    pub const fn base(&self) -> &Version {
        &self.base
    }

    /// The verdict, given what the caller found of the version against the
    /// base: the version when it may be published, and
    /// [`PublishProblem::NeedsMajor`] when the comparison finds something
    /// that needs a major version and its `MAJOR` is not greater than the
    /// base's.
    ///
    /// # Errors
    ///
    /// [`PublishProblem::NeedsMajor`].
    pub fn judge(self, comparison: BaseComparison) -> Result<Version, PublishProblem> {
        if comparison.requires_major() && self.version.major() <= self.base.major() {
            return Err(PublishProblem::NeedsMajor {
                version: self.version,
                base: self.base,
                comparison,
            });
        }
        Ok(self.version)
    }
}

/// Why a version may not be published (E1607).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PublishProblem {
    /// The version is already published.
    AlreadyPublished {
        /// The version.
        version: Version,
    },
    /// The version widens the authority signature, removes a criterion or
    /// adds a waiver against its base, and is not a major version above it.
    NeedsMajor {
        /// The version to publish.
        version: Version,
        /// Its base: the highest published version below it.
        base: Version,
        /// What was found.
        comparison: BaseComparison,
    },
    /// The lowest version published above it within its `MAJOR` widens the
    /// authority signature, removes a criterion or adds a waiver against it:
    /// publishing it would make that version a widening that is not a major
    /// one.
    NextNeedsMajor {
        /// The version to publish.
        version: Version,
        /// The lowest published version above it with its `MAJOR`.
        next: Version,
        /// What was found of `next` against `version`.
        comparison: BaseComparison,
    },
}

impl PublishProblem {
    /// The problem's identifier.
    #[must_use]
    pub const fn id(&self) -> &'static str {
        match self {
            PublishProblem::AlreadyPublished { .. } => "already_published",
            PublishProblem::NeedsMajor { .. } => "needs_major",
            PublishProblem::NextNeedsMajor { .. } => "next_needs_major",
        }
    }

    /// The problem as JSON: `{ problem, ...facts }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let base = problem_object(self.id());
        match self {
            PublishProblem::AlreadyPublished { version } => {
                base.with("version", version.to_string())
            }
            PublishProblem::NeedsMajor {
                version,
                base: against,
                comparison,
            } => comparison.facts(
                base.with("version", version.to_string())
                    .with("base", against.to_string()),
            ),
            PublishProblem::NextNeedsMajor {
                version,
                next,
                comparison,
            } => comparison.facts(
                base.with("version", version.to_string())
                    .with("next", next.to_string()),
            ),
        }
    }
}

/// The lowest published version above `version` with its `MAJOR`: the one a
/// version published below it must not make a widening of. When `1.0.0` and
/// `1.2.0` are published and `1.1.0` is published in between, `1.2.0` is
/// still not a major version above its new base `1.1.0`, so it must not
/// widen against it either; [`judge_next`] holds that. `None` when no
/// published version of that `MAJOR` is above it.
#[must_use]
pub fn lowest_above(published: &[Version], version: &Version) -> Option<Version> {
    published
        .iter()
        .filter(|other| *other > version && other.major() == version.major())
        .min()
        .copied()
}

/// The verdict on the version published above `version` within its `MAJOR`
/// ([`lowest_above`]), given what the caller found of `next` against
/// `version`: since `next` is not a major version above `version`, it may
/// not widen against it, remove a criterion of it or add a waiver to it.
///
/// # Errors
///
/// [`PublishProblem::NextNeedsMajor`] when the comparison finds one.
pub fn judge_next(
    version: &Version,
    next: &Version,
    comparison: BaseComparison,
) -> Result<(), PublishProblem> {
    if comparison.requires_major() && next.major() <= version.major() {
        return Err(PublishProblem::NextNeedsMajor {
            version: *version,
            next: *next,
            comparison,
        });
    }
    Ok(())
}

/// Plans the publication of `version` among the versions `published`, in any
/// order.
///
/// # Errors
///
/// [`PublishProblem::AlreadyPublished`] when `version` is one of them.
pub fn plan_publish(
    published: &[Version],
    version: &Version,
) -> Result<PublishPlan, PublishProblem> {
    if published.contains(version) {
        return Err(PublishProblem::AlreadyPublished { version: *version });
    }
    let base = published.iter().filter(|other| *other < version).max();
    Ok(match base {
        Some(base) => PublishPlan::Above(Above {
            version: *version,
            base: *base,
        }),
        None => PublishPlan::First(*version),
    })
}
