//! Times, the waiting period, `index.json` and the configuration's
//! `libraries` member.

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
use mandate_ir::parse;
use mandate_lib::{
    ConfigProblem, DIR_MAX_BYTES, Day, IndexProblem, MAX_UNIX_SECONDS, TimeFault, Timestamp,
    WAIT_DAYS_MAX, WaitDays, read_index, read_index_bytes, read_libraries_config,
};

fn t(text: &str) -> Timestamp {
    Timestamp::parse(text).unwrap()
}

#[test]
fn times_accepted_are_seconds_since_1970() {
    let mut table = Table::new();
    // The seconds are node's `Date.parse(...) / 1000`, not this crate's.
    for (text, seconds) in [
        ("1970-01-01T00:00:00Z", 0),
        ("1970-01-01T00:00:01Z", 1),
        ("1970-03-01T00:00:00Z", 5_097_600),
        ("1999-12-31T23:59:59Z", 946_684_799),
        ("2000-02-29T12:00:00Z", 951_825_600),
        ("2000-03-01T00:00:00Z", 951_868_800),
        ("2024-02-29T00:00:00Z", 1_709_164_800),
        ("2024-12-31T23:59:59Z", 1_735_689_599),
        ("2026-11-14T09:30:00Z", 1_794_648_600),
        ("2026-11-15T00:00:00Z", 1_794_700_800),
        ("2038-01-19T03:14:07Z", 2_147_483_647),
        ("2038-01-19T03:14:08Z", 2_147_483_648),
        ("2100-03-01T00:00:00Z", 4_107_542_400),
        ("2400-02-29T00:00:00Z", 13_574_563_200),
        ("9999-12-31T23:59:59Z", 253_402_300_799),
    ] {
        let time = Timestamp::parse(text).unwrap();
        table.eq(text, time.unix_seconds(), seconds);
        table.eq(text, time.to_string(), text.to_owned());
        table.eq(text, Timestamp::from_unix_seconds(seconds), Some(time));
    }
    table.eq("the last second", MAX_UNIX_SECONDS, 253_402_300_799);
    table.eq(
        "past the last",
        Timestamp::from_unix_seconds(MAX_UNIX_SECONDS + 1),
        None,
    );
    table.eq("before the first", Timestamp::from_unix_seconds(-1), None);
    table.finish();
}

#[test]
fn times_refused_say_why() {
    use TimeFault::{Day, Fraction, Hour, Minute, Month, Second, Shape, Year};
    let mut table = Table::new();
    for (text, fault) in [
        // The calendar.
        ("2026-02-29T00:00:00Z", Day),
        ("2025-02-29T00:00:00Z", Day),
        ("2100-02-29T00:00:00Z", Day),
        ("2200-02-29T00:00:00Z", Day),
        ("2024-02-30T00:00:00Z", Day),
        ("2026-04-31T00:00:00Z", Day),
        ("2026-06-31T00:00:00Z", Day),
        ("2026-09-31T00:00:00Z", Day),
        ("2026-11-31T00:00:00Z", Day),
        ("2026-01-32T00:00:00Z", Day),
        ("2026-01-00T00:00:00Z", Day),
        ("2026-13-01T00:00:00Z", Month),
        ("2026-00-01T00:00:00Z", Month),
        ("2026-99-99T99:99:99Z", Month),
        ("2026-01-01T24:00:00Z", Hour),
        ("2026-01-01T99:00:00Z", Hour),
        ("2026-01-01T00:60:00Z", Minute),
        ("2026-01-01T00:00:60Z", Second),
        ("2016-12-31T23:59:60Z", Second),
        ("2026-01-01T24:60:60Z", Hour),
        // Years.
        ("0000-01-01T00:00:00Z", Year),
        ("1969-12-31T23:59:59Z", Year),
        ("1900-02-29T00:00:00Z", Year),
        // The form.
        ("10000-01-01T00:00:00Z", Shape),
        ("999-01-01T00:00:00Z", Shape),
        ("2026-01-01T00:00:00z", Shape),
        ("2026-01-01t00:00:00Z", Shape),
        ("2026-01-01T00:00:00", Shape),
        ("2026-01-01T00:00Z", Shape),
        ("2026-01-01T00:00:00+00:00", Shape),
        ("2026-01-01T00:00:00-00:00", Shape),
        ("2026-01-01T00:00:00+0000", Shape),
        ("2026-01-01 00:00:00Z", Shape),
        ("2026-01-01T00:00:00 Z", Shape),
        ("2026-01-01T00:00:00Z ", Shape),
        (" 2026-01-01T00:00:00Z", Shape),
        ("2026-01-01T00:00:00Z\n", Shape),
        ("2026/01/01T00:00:00Z", Shape),
        ("20260101T000000Z", Shape),
        ("2026-1-1T0:0:0Z", Shape),
        ("2026-01-01", Shape),
        ("", Shape),
        ("-026-01-01T00:00:00Z", Shape),
        ("+026-01-01T00:00:00Z", Shape),
        ("2026-01-01T00:00:0\u{661}Z", Shape),
        ("2026-01-01T00:00:00\u{200b}", Shape),
        ("2026-01-01T00:00:00ZZ", Shape),
        ("2026-01-01T00:00:00Z.", Shape),
        // A fraction, which a time has none of.
        ("2026-01-01T00:00:00.5Z", Fraction),
        ("2026-01-01T00:00:00.000Z", Fraction),
        ("2026-01-01T00:00:00.Z", Fraction),
        ("2026-01-01T00:00:00.123456789Z", Fraction),
    ] {
        table.eq(
            &format!("{text:?}"),
            Timestamp::parse(text).err(),
            Some(fault),
        );
    }
    table.finish();
}

/// The date after `(year, month, day)`, by the rules of the calendar written
/// out here and not by the crate's arithmetic.
fn next_day(year: u32, month: u32, day: u32) -> (u32, u32, u32) {
    let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
    let length = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        _ if leap => 29,
        _ => 28,
    };
    if day < length {
        (year, month, day + 1)
    } else if month < 12 {
        (year, month + 1, 1)
    } else {
        (year + 1, 1, 1)
    }
}

#[test]
fn every_day_from_1970_to_9999_is_the_day_a_calendar_says() {
    let (mut year, mut month, mut day) = (1970, 1, 1);
    let mut days = 0_i64;
    let mut bad = Vec::new();
    loop {
        let start = days * 86_400;
        let date = format!("{year:04}-{month:02}-{day:02}");
        let text = format!("{date}T00:00:00Z");
        let mut wrong = Timestamp::from_unix_seconds(start).map(|x| x.to_string()) != Some(text)
            || Timestamp::parse(&format!("{date}T00:00:00Z")).map(|x| x.unix_seconds())
                != Ok(start)
            || Day::of_unix_seconds(start).map(|d| d.to_string()) != Some(date.clone());
        // The last second of the day, for one day in eleven.
        if days % 11 == 0 {
            let end = start + 86_399;
            let text = format!("{date}T23:59:59Z");
            wrong = wrong
                || Timestamp::from_unix_seconds(end).map(|x| x.to_string()) != Some(text.clone())
                || Timestamp::parse(&text).map(|x| x.unix_seconds()) != Ok(end)
                || Day::of_unix_seconds(end).map(|d| d.to_string()) != Some(date.clone());
        }
        if wrong {
            bad.push(date);
            if bad.len() > 5 {
                break;
            }
        }
        if (year, month, day) == (9999, 12, 31) {
            break;
        }
        (year, month, day) = next_day(year, month, day);
        days += 1;
    }
    assert!(bad.is_empty(), "days that differ: {bad:?}");
    assert_eq!(days, 2_932_896);
    assert_eq!(days * 86_400 + 86_399, MAX_UNIX_SECONDS);
}

#[test]
fn a_day_is_a_utc_date() {
    let mut table = Table::new();
    for (seconds, day) in [
        (0, "1970-01-01"),
        (86_399, "1970-01-01"),
        (86_400, "1970-01-02"),
        (1_794_648_600, "2026-11-14"),
        (1_794_700_799, "2026-11-14"),
        (1_794_700_800, "2026-11-15"),
        (1_709_164_800, "2024-02-29"),
        (253_402_300_799, "9999-12-31"),
        // Past the last time a text can write: the year has more digits.
        (253_402_300_800, "10000-01-01"),
        (253_402_300_800 + 36_500 * 86_400, "10099-12-07"),
    ] {
        table.eq(
            &seconds.to_string(),
            Day::of_unix_seconds(seconds).map(|d| d.to_string()),
            Some(day.to_owned()),
        );
    }
    table.eq("before 1970", Day::of_unix_seconds(-1), None);
    table.eq(
        "or the epoch",
        Day::of_unix_seconds_or_epoch(-1).to_string(),
        "1970-01-01".to_owned(),
    );
    let day = Day::of_unix_seconds(1_794_648_600).unwrap();
    table.eq(
        "parts",
        (day.year(), day.month(), day.day()),
        (2026, 11, 14),
    );
    table.finish();
}

#[test]
fn the_waiting_period() {
    let mut table = Table::new();
    table.eq("none", WaitDays::default().get(), 0);
    table.eq("the bound", WAIT_DAYS_MAX, 36_500);
    table.ok("at the bound", WaitDays::new(WAIT_DAYS_MAX).is_some());
    table.ok("over the bound", WaitDays::new(WAIT_DAYS_MAX + 1).is_none());
    table.ok("u32::MAX", WaitDays::new(u32::MAX).is_none());
    let published = t("2026-11-14T09:30:00Z");
    table.eq(
        "0 days",
        WaitDays::new(0).unwrap().ready_at_unix(published),
        1_794_648_600,
    );
    table.eq(
        "1 day",
        WaitDays::new(1).unwrap().ready_at_unix(published),
        1_794_648_600 + 86_400,
    );
    table.eq(
        "7 days",
        WaitDays::new(7).unwrap().ready_at_unix(published),
        1_794_648_600 + 7 * 86_400,
    );
    // The latest publication and the longest wait: nothing wraps.
    let last = t("9999-12-31T23:59:59Z");
    table.eq(
        "the bound after the last second",
        WaitDays::new(WAIT_DAYS_MAX).unwrap().ready_at_unix(last),
        MAX_UNIX_SECONDS + 36_500 * 86_400,
    );
    table.finish();
}

fn config(text: &str) -> Result<mandate_lib::LibrariesConfig, Vec<String>> {
    let value = parse(text).unwrap().value;
    read_libraries_config(&value)
        .map_err(|problems| problems.iter().map(|p| json(p.to_js())).collect())
}

const D1: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000001";
const D2: &str = "sha256:0000000000000000000000000000000000000000000000000000000000000002";

#[test]
fn the_configuration_is_read() {
    let mut table = Table::new();
    let full = config(&format!(
        r#"{{"dir":"/srv/mandate/libraries","wait_days":7,"revoked":["{D2}","{D1}","{D2}"]}}"#
    ))
    .unwrap();
    table.eq("dir", full.dir(), "/srv/mandate/libraries");
    table.eq("wait_days", full.wait_days().get(), 7);
    table.eq(
        "revoked: sorted, once each",
        full.revoked()
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>(),
        vec![D1.to_owned(), D2.to_owned()],
    );
    table.ok(
        "is_revoked",
        full.is_revoked(&mandate_lib::Digest::parse(D1).unwrap()),
    );
    table.ok(
        "is not revoked",
        !full.is_revoked(&mandate_lib::Digest::parse(&D1.replace('1', "3")).unwrap()),
    );
    table.eq(
        "as JSON",
        json(full.to_js()),
        format!(r#"{{"dir":"/srv/mandate/libraries","wait_days":7,"revoked":["{D1}","{D2}"]}}"#),
    );
    // `wait_days` is 0 and `revoked` empty when absent; `dir` is not read.
    let minimal = config(r#"{"dir":"libs"}"#).unwrap();
    table.eq("absent wait_days", minimal.wait_days().get(), 0);
    table.eq("absent revoked", minimal.revoked().len(), 0);
    table.eq(
        "minimal as JSON",
        json(minimal.to_js()),
        r#"{"dir":"libs","wait_days":0,"revoked":[]}"#.to_owned(),
    );
    for dir in [
        "libs", "../libs", "C:\\libs", "a b", "\u{e9}", "~/libs", "/", ".",
    ] {
        let text = format!(
            r#"{{"dir":{}}}"#,
            mandate_ir::stringify(&mandate_ir::JsValue::from(dir)).unwrap()
        );
        table.eq(
            &format!("dir {dir:?}"),
            config(&text).map(|c| c.dir().to_owned()),
            Ok(dir.to_owned()),
        );
    }
    table.eq(
        "wait_days 0",
        config(r#"{"dir":"x","wait_days":0}"#).map(|c| c.wait_days().get()),
        Ok(0),
    );
    table.eq(
        "wait_days at the bound",
        config(r#"{"dir":"x","wait_days":36500}"#).map(|c| c.wait_days().get()),
        Ok(36_500),
    );
    let longest = "d".repeat(DIR_MAX_BYTES);
    table.ok(
        "longest dir",
        config(&format!(r#"{{"dir":"{longest}"}}"#)).is_ok(),
    );
    table.finish();
}

#[test]
fn the_configuration_refused() {
    let mut table = Table::new();
    let long = "d".repeat(DIR_MAX_BYTES + 1);
    let upper = format!("sha256:{}", "A".repeat(64));
    let many_bad = format!(r#"{{"dir":"","wait_days":-1,"revoked":["{D1}","SHA256:x"]}}"#);
    let cases = [
        ("not an object", "[]".to_owned(), vec![r#"{"problem":"wrong_type","at":"","expected":"object","found":"array"}"#.to_owned()]),
        ("null", "null".to_owned(), vec![r#"{"problem":"wrong_type","at":"","expected":"object","found":"null"}"#.to_owned()]),
        ("empty", "{}".to_owned(), vec![r#"{"problem":"missing_field","at":"","field":"dir"}"#.to_owned()]),
        (
            "an unknown member: a typo must not be a wait of 0",
            r#"{"dir":"x","wait_day":7}"#.to_owned(),
            vec![r#"{"problem":"unknown_field","at":"","field":"wait_day"}"#.to_owned()],
        ),
        (
            "unknown members by name",
            r#"{"dir":"x","z":1,"A":2}"#.to_owned(),
            vec![
                r#"{"problem":"unknown_field","at":"","field":"A"}"#.to_owned(),
                r#"{"problem":"unknown_field","at":"","field":"z"}"#.to_owned(),
            ],
        ),
        ("dir not a string", r#"{"dir":1}"#.to_owned(), vec![r#"{"problem":"wrong_type","at":"/dir","expected":"string","found":"number"}"#.to_owned()]),
        ("dir null", r#"{"dir":null}"#.to_owned(), vec![r#"{"problem":"wrong_type","at":"/dir","expected":"string","found":"null"}"#.to_owned()]),
        ("dir empty", r#"{"dir":""}"#.to_owned(), vec![r#"{"problem":"empty_dir"}"#.to_owned()]),
        ("dir with a NUL", r#"{"dir":"a\u0000b"}"#.to_owned(), vec![r#"{"problem":"dir_has_nul"}"#.to_owned()]),
        (
            "dir too long",
            format!(r#"{{"dir":"{long}"}}"#),
            vec![format!(r#"{{"problem":"dir_too_long","length":{},"limit":{DIR_MAX_BYTES}}}"#, DIR_MAX_BYTES + 1)],
        ),
        ("wait_days negative", r#"{"dir":"x","wait_days":-1}"#.to_owned(), vec![r#"{"problem":"wait_days_out_of_range","found":-1,"max":36500}"#.to_owned()]),
        ("wait_days over", r#"{"dir":"x","wait_days":36501}"#.to_owned(), vec![r#"{"problem":"wait_days_out_of_range","found":36501,"max":36500}"#.to_owned()]),
        ("wait_days huge", r#"{"dir":"x","wait_days":9007199254740991}"#.to_owned(), vec![r#"{"problem":"wait_days_out_of_range","found":9007199254740991,"max":36500}"#.to_owned()]),
        ("wait_days a string", r#"{"dir":"x","wait_days":"7"}"#.to_owned(), vec![r#"{"problem":"wrong_type","at":"/wait_days","expected":"number","found":"string"}"#.to_owned()]),
        ("wait_days null", r#"{"dir":"x","wait_days":null}"#.to_owned(), vec![r#"{"problem":"wrong_type","at":"/wait_days","expected":"number","found":"null"}"#.to_owned()]),
        ("wait_days true", r#"{"dir":"x","wait_days":true}"#.to_owned(), vec![r#"{"problem":"wrong_type","at":"/wait_days","expected":"number","found":"boolean"}"#.to_owned()]),
        ("revoked not an array", r#"{"dir":"x","revoked":"sha256:x"}"#.to_owned(), vec![r#"{"problem":"wrong_type","at":"/revoked","expected":"array","found":"string"}"#.to_owned()]),
        ("revoked null", r#"{"dir":"x","revoked":null}"#.to_owned(), vec![r#"{"problem":"wrong_type","at":"/revoked","expected":"array","found":"null"}"#.to_owned()]),
        ("revoked entry not a string", format!(r#"{{"dir":"x","revoked":["{D1}",1]}}"#), vec![r#"{"problem":"wrong_type","at":"/revoked/1","expected":"string","found":"number"}"#.to_owned()]),
        (
            "revoked entries that are not digests",
            format!(
                r#"{{"dir":"x","revoked":["", "{}", "{}", "sha256:{}", "{D1}x"]}}"#,
                upper,
                D1.replace("sha256", "sha1"),
                "0".repeat(63),
            ),
            vec![
                r#"{"problem":"invalid_revoked","index":0,"found":""}"#.to_owned(),
                format!(r#"{{"problem":"invalid_revoked","index":1,"found":"{upper}"}}"#),
                format!(r#"{{"problem":"invalid_revoked","index":2,"found":"{}"}}"#, D1.replace("sha256", "sha1")),
                format!(r#"{{"problem":"invalid_revoked","index":3,"found":"sha256:{}"}}"#, "0".repeat(63)),
                format!(r#"{{"problem":"invalid_revoked","index":4,"found":"{D1}x"}}"#),
            ],
        ),
        (
            "several, shape first",
            many_bad,
            vec![
                r#"{"problem":"empty_dir"}"#.to_owned(),
                r#"{"problem":"wait_days_out_of_range","found":-1,"max":36500}"#.to_owned(),
                r#"{"problem":"invalid_revoked","index":1,"found":"SHA256:x"}"#.to_owned(),
            ],
        ),
    ];
    for (case, text, want) in cases {
        table.eq(case, config(&text).err(), Some(want));
    }
    table.finish();
}

fn index(text: &str) -> Result<Timestamp, Vec<String>> {
    read_index(text).map_err(|problems| problems.iter().map(|p| json(p.to_js())).collect())
}

#[test]
fn an_index_is_read() {
    let mut table = Table::new();
    table.eq(
        "the specification's",
        index(r#"{ "published_at": "2026-11-14T09:30:00Z" }"#),
        Ok(t("2026-11-14T09:30:00Z")),
    );
    table.eq(
        "compact",
        index(r#"{"published_at":"1970-01-01T00:00:00Z"}"#),
        Ok(t("1970-01-01T00:00:00Z")),
    );
    table.eq(
        "with white space",
        index("\n{\n\t\"published_at\"\t:\t\"2024-02-29T23:59:59Z\"\r\n}\n"),
        Ok(t("2024-02-29T23:59:59Z")),
    );
    table.eq(
        "bytes",
        read_index_bytes(br#"{"published_at":"2026-11-14T09:30:00Z"}"#).map_err(|p| p.len()),
        Ok(t("2026-11-14T09:30:00Z")),
    );
    table.finish();
}

#[test]
fn an_index_refused() {
    let mut table = Table::new();
    let wrong = |at: &str, expected: &str, found: &str| {
        format!(
            r#"{{"problem":"wrong_type","at":"{at}","expected":"{expected}","found":"{found}"}}"#
        )
    };
    let time = |found: &str, fault: &str| {
        format!(r#"{{"problem":"invalid_published_at","found":"{found}","fault":"{fault}"}}"#)
    };
    for (case, text, want) in [
        (
            "empty object",
            "{}",
            vec![r#"{"problem":"missing_field","at":"","field":"published_at"}"#.to_owned()],
        ),
        (
            "an extra member",
            r#"{"published_at":"2026-11-14T09:30:00Z","by":"x"}"#,
            vec![r#"{"problem":"unknown_field","at":"","field":"by"}"#.to_owned()],
        ),
        (
            "another member",
            r#"{"published":"2026-11-14T09:30:00Z"}"#,
            vec![
                r#"{"problem":"unknown_field","at":"","field":"published"}"#.to_owned(),
                r#"{"problem":"missing_field","at":"","field":"published_at"}"#.to_owned(),
            ],
        ),
        ("an array", "[]", vec![wrong("", "object", "array")]),
        (
            "a string",
            r#""2026-11-14T09:30:00Z""#,
            vec![wrong("", "object", "string")],
        ),
        (
            "a number",
            r#"{"published_at":1794648600}"#,
            vec![wrong("/published_at", "string", "number")],
        ),
        (
            "null",
            r#"{"published_at":null}"#,
            vec![wrong("/published_at", "string", "null")],
        ),
        (
            "a leap day that is not",
            r#"{"published_at":"2026-02-29T00:00:00Z"}"#,
            vec![time("2026-02-29T00:00:00Z", "day")],
        ),
        (
            "an hour 24",
            r#"{"published_at":"2026-01-01T24:00:00Z"}"#,
            vec![time("2026-01-01T24:00:00Z", "hour")],
        ),
        (
            "an offset",
            r#"{"published_at":"2026-01-01T00:00:00+00:00"}"#,
            vec![time("2026-01-01T00:00:00+00:00", "shape")],
        ),
        (
            "a fraction",
            r#"{"published_at":"2026-01-01T00:00:00.5Z"}"#,
            vec![time("2026-01-01T00:00:00.5Z", "fraction")],
        ),
        (
            "lower case",
            r#"{"published_at":"2026-01-01t00:00:00z"}"#,
            vec![time("2026-01-01t00:00:00z", "shape")],
        ),
        (
            "a duplicate key",
            r#"{"published_at":"2026-01-01T00:00:00Z","published_at":"2026-01-01T00:00:00Z"}"#,
            vec![
                r#"{"problem":"invalid_json","fault":"duplicate_key","at":"/published_at"}"#
                    .to_owned(),
            ],
        ),
        (
            "text after",
            r#"{"published_at":"2026-01-01T00:00:00Z"} x"#,
            vec![r#"{"problem":"invalid_json","fault":"syntax","at":""}"#.to_owned()],
        ),
        (
            "a byte order mark",
            "\u{feff}{\"published_at\":\"2026-01-01T00:00:00Z\"}",
            vec![r#"{"problem":"byte_order_mark"}"#.to_owned()],
        ),
    ] {
        table.eq(case, index(text).err(), Some(want));
    }
    table.eq(
        "not utf-8",
        read_index_bytes(&[0xff])
            .map_err(|p| p.iter().map(|p| json(p.to_js())).collect::<Vec<_>>()),
        Err(vec![r#"{"problem":"not_utf8"}"#.to_owned()]),
    );
    table.finish();
}

#[test]
fn problems_have_identifiers() {
    assert_eq!(
        IndexProblem::InvalidPublishedAt {
            found: String::new(),
            fault: TimeFault::Shape
        }
        .id(),
        "invalid_published_at"
    );
    assert_eq!(ConfigProblem::EmptyDir.id(), "empty_dir");
}
