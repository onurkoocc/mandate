//! Publish's version rule: a version already published, a base that is the
//! highest published version below the new one, and a `MAJOR` that is
//! greater.

#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    missing_docs
)]

mod common;

use common::{Table, json};
use mandate_lib::{BaseComparison, PublishPlan, PublishProblem, Version, plan_publish};

fn v(text: &str) -> Version {
    Version::parse(text).unwrap()
}

fn published(list: &[&str]) -> Vec<Version> {
    list.iter().map(|t| v(t)).collect()
}

/// The base of `new` among `list`, or the problem.
fn base_of(list: &[&str], new: &str) -> Result<Option<String>, String> {
    match plan_publish(&published(list), &v(new)) {
        Ok(plan) => Ok(plan.base().map(ToString::to_string)),
        Err(problem) => Err(json(problem.to_js())),
    }
}

const WIDENS: BaseComparison = BaseComparison {
    widens_authority: true,
    removes_criterion: false,
    adds_waiver: false,
};
const REMOVES: BaseComparison = BaseComparison {
    widens_authority: false,
    removes_criterion: true,
    adds_waiver: false,
};
const WAIVES: BaseComparison = BaseComparison {
    widens_authority: false,
    removes_criterion: false,
    adds_waiver: true,
};
const NOTHING: BaseComparison = BaseComparison {
    widens_authority: false,
    removes_criterion: false,
    adds_waiver: false,
};

fn verdict(list: &[&str], new: &str, comparison: BaseComparison) -> Result<String, String> {
    match plan_publish(&published(list), &v(new)).unwrap() {
        PublishPlan::First(version) => Ok(version.to_string()),
        PublishPlan::Above(above) => above
            .judge(comparison)
            .map(|version| version.to_string())
            .map_err(|problem| json(problem.to_js())),
    }
}

#[test]
fn a_version_already_published_is_refused() {
    let mut t = Table::new();
    for (list, new) in [
        (&["1.0.0"][..], "1.0.0"),
        (&["1.0.0", "2.0.0"], "2.0.0"),
        (&["2.0.0", "1.0.0", "1.5.3"], "1.5.3"),
        (&["0.0.0"], "0.0.0"),
    ] {
        t.eq(
            &format!("{new} among {list:?}"),
            base_of(list, new),
            Err(format!(
                r#"{{"problem":"already_published","version":"{new}"}}"#
            )),
        );
    }
    // A version that differs in any component is not the same.
    t.eq(
        "another patch",
        base_of(&["1.0.0"], "1.0.1"),
        Ok(Some("1.0.0".to_owned())),
    );
    // Versions are compared as numbers: 1.10.0 is not 1.1.0.
    t.eq(
        "another minor",
        base_of(&["1.1.0"], "1.10.0"),
        Ok(Some("1.1.0".to_owned())),
    );
    t.finish();
}

#[test]
fn the_base_is_the_highest_published_version_below() {
    let mut t = Table::new();
    for (list, new, base) in [
        (&[][..], "1.0.0", None),
        (&["1.0.0"][..], "1.0.1", Some("1.0.0")),
        (&["1.0.0", "1.1.0", "2.0.0"][..], "1.5.0", Some("1.1.0")),
        (&["2.0.0", "1.0.0", "1.1.0"][..], "1.5.0", Some("1.1.0")),
        (&["1.1.0", "2.0.0", "1.0.0"][..], "3.0.0", Some("2.0.0")),
        // Below the highest: the highest is not the base.
        (&["1.0.0", "2.0.0", "3.0.0"][..], "2.5.0", Some("2.0.0")),
        (&["1.0.0", "2.0.0", "3.0.0"][..], "2.0.1", Some("2.0.0")),
        (&["1.0.0", "2.0.0", "3.0.0"][..], "0.9.0", None),
        // The first version of a line: nothing is below it.
        (&["2.0.0", "3.0.0"][..], "1.9.9", None),
        (&["0.0.1"][..], "0.0.0", None),
        // By number, not by text.
        (&["1.9.0", "1.10.0", "1.2.0"][..], "1.11.0", Some("1.10.0")),
        (&["1.9.0", "1.10.0", "1.2.0"][..], "1.9.5", Some("1.9.0")),
        (&["9.0.0", "10.0.0"][..], "10.0.1", Some("10.0.0")),
        // The same version listed twice is one.
        (&["1.0.0", "1.0.0"][..], "1.0.1", Some("1.0.0")),
    ] {
        t.eq(
            &format!("{new} among {list:?}"),
            base_of(list, new),
            Ok(base.map(ToString::to_string)),
        );
    }
    t.finish();
}

#[test]
fn the_first_version_of_a_library_is_any_version() {
    let mut t = Table::new();
    for new in [
        "0.0.0",
        "0.1.0",
        "1.0.0",
        "7.3.2",
        "999999999.999999999.999999999",
    ] {
        let plan = plan_publish(&[], &v(new)).unwrap();
        t.eq(new, plan.clone(), PublishPlan::First(v(new)));
        t.eq(new, plan.base(), None);
        t.eq(new, plan.version(), &v(new));
    }
    t.finish();
}

#[test]
fn a_version_that_changes_nothing_that_matters_is_any_version_above_its_base() {
    let mut t = Table::new();
    for (list, new) in [
        (&["1.0.0"][..], "1.0.1"),
        (&["1.0.0"][..], "1.1.0"),
        (&["1.0.0"][..], "2.0.0"),
        (&["1.5.0", "2.0.0"][..], "1.5.1"),
        (&["0.1.0"][..], "0.1.1"),
    ] {
        t.eq(
            &format!("{new} over {list:?}"),
            verdict(list, new, NOTHING),
            Ok(new.to_owned()),
        );
    }
    t.finish();
}

#[test]
fn a_widening_needs_a_major_one_above_the_base() {
    let mut t = Table::new();
    let needs = |version: &str, base: &str, widens: bool, removes: bool, waives: bool| {
        Err(format!(
            r#"{{"problem":"needs_major","version":"{version}","base":"{base}","widens_authority":{widens},"removes_criterion":{removes},"adds_waiver":{waives}}}"#
        ))
    };
    // The same MAJOR is not enough: a patch, a minor.
    t.eq(
        "patch widens",
        verdict(&["1.0.0"], "1.0.1", WIDENS),
        needs("1.0.1", "1.0.0", true, false, false),
    );
    t.eq(
        "minor widens",
        verdict(&["1.0.0"], "1.1.0", WIDENS),
        needs("1.1.0", "1.0.0", true, false, false),
    );
    t.eq(
        "minor removes a criterion",
        verdict(&["1.0.0"], "1.1.0", REMOVES),
        needs("1.1.0", "1.0.0", false, true, false),
    );
    t.eq(
        "minor adds a waiver",
        verdict(&["1.0.0"], "1.1.0", WAIVES),
        needs("1.1.0", "1.0.0", false, false, true),
    );
    t.eq(
        "all three",
        verdict(
            &["1.0.0"],
            "1.0.1",
            BaseComparison {
                widens_authority: true,
                removes_criterion: true,
                adds_waiver: true,
            },
        ),
        needs("1.0.1", "1.0.0", true, true, true),
    );
    // A MAJOR that is greater is enough, whatever the rest.
    t.eq(
        "major widens",
        verdict(&["1.0.0"], "2.0.0", WIDENS),
        Ok("2.0.0".to_owned()),
    );
    t.eq(
        "major removes",
        verdict(&["1.9.9"], "2.0.0", REMOVES),
        Ok("2.0.0".to_owned()),
    );
    t.eq(
        "major waives",
        verdict(&["1.9.9"], "2.0.0", WAIVES),
        Ok("2.0.0".to_owned()),
    );
    t.eq(
        "major, minor and patch lower",
        verdict(&["1.9.9"], "2.0.0", WIDENS),
        Ok("2.0.0".to_owned()),
    );
    t.eq(
        "two majors",
        verdict(&["1.0.0"], "3.0.0", WIDENS),
        Ok("3.0.0".to_owned()),
    );
    // The base is the highest below, not the highest: a version between two.
    t.eq(
        "2.5.0 above 2.0.0 and below 3.0.0 widens",
        verdict(&["1.0.0", "2.0.0", "3.0.0"], "2.5.0", WIDENS),
        needs("2.5.0", "2.0.0", true, false, false),
    );
    t.eq(
        "3.0.0 above 2.0.0 widens: a major one",
        verdict(&["1.0.0", "2.0.0"], "3.0.0", WIDENS),
        Ok("3.0.0".to_owned()),
    );
    // 0.x is held to the same rule: MAJOR is the first component.
    t.eq(
        "0.1.0 to 0.2.0 widens",
        verdict(&["0.1.0"], "0.2.0", WIDENS),
        needs("0.2.0", "0.1.0", true, false, false),
    );
    t.eq(
        "0.9.0 to 1.0.0 widens",
        verdict(&["0.9.0"], "1.0.0", WIDENS),
        Ok("1.0.0".to_owned()),
    );
    // The first version of a line is not compared with anything.
    t.eq(
        "first of its line",
        verdict(&["2.0.0"], "1.0.0", WIDENS),
        Ok("1.0.0".to_owned()),
    );
    t.eq(
        "the first",
        verdict(&[], "1.0.0", WIDENS),
        Ok("1.0.0".to_owned()),
    );
    t.finish();
}

#[test]
fn the_comparison_is_asked_for_before_a_verdict() {
    // A version with a base cannot be judged but through `Above::judge`,
    // which takes the comparison; a first version has none to ask for.
    match plan_publish(&published(&["1.0.0"]), &v("1.1.0")).unwrap() {
        PublishPlan::Above(above) => {
            assert_eq!(above.base(), &v("1.0.0"));
            assert_eq!(above.version(), &v("1.1.0"));
            assert!(above.clone().judge(NOTHING).is_ok());
            assert!(matches!(
                above.judge(WIDENS),
                Err(PublishProblem::NeedsMajor { .. })
            ));
        }
        PublishPlan::First(_) => panic!("1.1.0 has a base"),
    }
    assert!(!NOTHING.requires_major());
    assert!(WIDENS.requires_major() && REMOVES.requires_major() && WAIVES.requires_major());
    assert_eq!(BaseComparison::default(), NOTHING);
}

#[test]
fn problems_have_identifiers() {
    assert_eq!(
        PublishProblem::AlreadyPublished {
            version: v("1.0.0")
        }
        .id(),
        "already_published"
    );
    assert_eq!(
        PublishProblem::NeedsMajor {
            version: v("1.1.0"),
            base: v("1.0.0"),
            comparison: WIDENS
        }
        .id(),
        "needs_major"
    );
}
