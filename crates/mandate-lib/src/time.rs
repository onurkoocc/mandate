//! Time, as much of it as a library's publication and waiting period need:
//! a UTC time to the second ([`Timestamp`]), the day it falls on ([`Day`])
//! and a number of days of waiting ([`WaitDays`]). No clock is read: the
//! time a waiting period is compared with is an argument. No time library is
//! used: the calendar is [Howard Hinnant's civil-date
//! algorithms](https://howardhinnant.github.io/date_algorithms.html) over
//! checked arithmetic.
//!
//! A time is written as `mandate publish` writes it, `YYYY-MM-DDTHH:MM:SSZ`:
//! four-digit year from 1970 to 9999, upper-case `T` and `Z`, a real calendar
//! date (leap years by the Gregorian rule), hour 00 to 23, minute 00 to 59,
//! second 00 to 59 (no leap second), no offset (`+00:00` is another text, and
//! not accepted), and **no fraction of a second**: `.000Z` is refused, so
//! that a time has one written form and the file that holds it is read as it
//! was written.

use std::fmt;

/// 9999-12-31T23:59:59Z in seconds since 1970-01-01T00:00:00Z.
pub const MAX_UNIX_SECONDS: i64 = 253_402_300_799;

/// The longest waiting period, in days: 36 500 (a hundred years). A larger
/// number is a mistake, and one that makes a sum of days overflow nothing but
/// waits for ever.
pub const WAIT_DAYS_MAX: u32 = 36_500;

/// Seconds in a day.
const DAY: u64 = 86_400;

/// Days from 0000-03-01 to 1970-01-01.
const EPOCH_SHIFT: u64 = 719_468;

/// Why a text is not a time. The first fault found is the one given, in the
/// order of this list.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TimeFault {
    /// The text is not `YYYY-MM-DDTHH:MM:SSZ`: another length, a character
    /// in a place where it may not be (lower-case `t` or `z`, a space for
    /// `T`, an offset, a sign, a digit of another script).
    Shape,
    /// The text has a fraction of a second.
    Fraction,
    /// The year is before 1970 (`0000` is). Nine thousand nine hundred
    /// ninety-nine is the last year a four-digit year can write.
    Year,
    /// The month is not 01 to 12.
    Month,
    /// The day is not one of its month's.
    Day,
    /// The hour is not 00 to 23.
    Hour,
    /// The minute is not 00 to 59.
    Minute,
    /// The second is not 00 to 59.
    Second,
}

impl TimeFault {
    /// The fault's identifier.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            TimeFault::Shape => "shape",
            TimeFault::Fraction => "fraction",
            TimeFault::Year => "year",
            TimeFault::Month => "month",
            TimeFault::Day => "day",
            TimeFault::Hour => "hour",
            TimeFault::Minute => "minute",
            TimeFault::Second => "second",
        }
    }
}

/// The number the `len` ASCII digits of `bytes` from `from` write.
fn digits(bytes: &[u8], from: usize, len: usize) -> Option<u64> {
    let part = bytes.get(from..from.checked_add(len)?)?;
    part.iter().try_fold(0_u64, |acc, &b| {
        if b.is_ascii_digit() {
            acc.checked_mul(10)?
                .checked_add(u64::from(b.checked_sub(b'0')?))
        } else {
            None
        }
    })
}

/// Whether `year` is a leap year.
fn is_leap(year: u64) -> bool {
    year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400))
}

/// The days of `month` (1 to 12) of `year`.
fn month_days(year: u64, month: u64) -> u64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The days from 1970-01-01 to the date `year`-`month`-`day`, for a date from
/// 1970 on.
fn days_from_civil(year: u64, month: u64, day: u64) -> Option<u64> {
    // The year starts in March, so that a leap day is the last of it.
    let shifted = if month <= 2 {
        year.checked_sub(1)?
    } else {
        year
    };
    let era = shifted / 400;
    let yoe = shifted % 400;
    let month_from_march = month.checked_add(9)? % 12;
    let doy = month_from_march
        .checked_mul(153)?
        .checked_add(2)?
        .checked_div(5)?
        .checked_add(day.checked_sub(1)?)?;
    let doe = yoe
        .checked_mul(365)?
        .checked_add(yoe / 4)?
        .checked_sub(yoe / 100)?
        .checked_add(doy)?;
    era.checked_mul(146_097)?
        .checked_add(doe)?
        .checked_sub(EPOCH_SHIFT)
}

/// The date of the day `days` days after 1970-01-01: year, month, day.
fn civil_from_days(days: u64) -> Option<(u64, u64, u64)> {
    let z = days.checked_add(EPOCH_SHIFT)?;
    let era = z / 146_097;
    let doe = z % 146_097;
    let yoe = doe
        .checked_sub(doe / 1460)?
        .checked_add(doe / 36_524)?
        .checked_sub(doe / 146_096)?
        / 365;
    let year_from_march = yoe.checked_add(era.checked_mul(400)?)?;
    let doy = doe.checked_sub(
        yoe.checked_mul(365)?
            .checked_add(yoe / 4)?
            .checked_sub(yoe / 100)?,
    )?;
    let mp = doy.checked_mul(5)?.checked_add(2)? / 153;
    let day = doy
        .checked_sub(mp.checked_mul(153)?.checked_add(2)? / 5)?
        .checked_add(1)?;
    let (month, year) = if mp < 10 {
        (mp.checked_add(3)?, year_from_march)
    } else {
        (mp.checked_sub(9)?, year_from_march.checked_add(1)?)
    };
    Some((year, month, day))
}

/// A time in UTC to the second, from 1970-01-01T00:00:00Z to
/// 9999-12-31T23:59:59Z. Times compare by the instant they are.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(i64);

impl Timestamp {
    /// The time `seconds` seconds after 1970-01-01T00:00:00Z, when it is
    /// within [`MAX_UNIX_SECONDS`].
    #[must_use]
    pub fn from_unix_seconds(seconds: i64) -> Option<Timestamp> {
        (0..=MAX_UNIX_SECONDS)
            .contains(&seconds)
            .then_some(Timestamp(seconds))
    }

    /// Seconds since 1970-01-01T00:00:00Z.
    #[must_use]
    pub const fn unix_seconds(&self) -> i64 {
        self.0
    }

    /// Reads a time: exactly `YYYY-MM-DDTHH:MM:SSZ`.
    ///
    /// # Errors
    ///
    /// The [`TimeFault`] that says why `text` is not one.
    pub fn parse(text: &str) -> Result<Timestamp, TimeFault> {
        let bytes = text.as_bytes();
        if bytes.len() > 20 && bytes.get(19) == Some(&b'.') {
            return Err(TimeFault::Fraction);
        }
        let separators = [
            (4, b'-'),
            (7, b'-'),
            (10, b'T'),
            (13, b':'),
            (16, b':'),
            (19, b'Z'),
        ];
        let shaped =
            bytes.len() == 20 && separators.iter().all(|&(at, c)| bytes.get(at) == Some(&c));
        let fields = if shaped {
            (
                digits(bytes, 0, 4),
                digits(bytes, 5, 2),
                digits(bytes, 8, 2),
                digits(bytes, 11, 2),
                digits(bytes, 14, 2),
                digits(bytes, 17, 2),
            )
        } else {
            (None, None, None, None, None, None)
        };
        let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second)) = fields
        else {
            return Err(TimeFault::Shape);
        };
        if !(1970..=9999).contains(&year) {
            return Err(TimeFault::Year);
        }
        if !(1..=12).contains(&month) {
            return Err(TimeFault::Month);
        }
        if !(1..=month_days(year, month)).contains(&day) {
            return Err(TimeFault::Day);
        }
        if hour > 23 {
            return Err(TimeFault::Hour);
        }
        if minute > 59 {
            return Err(TimeFault::Minute);
        }
        if second > 59 {
            return Err(TimeFault::Second);
        }
        let seconds = days_from_civil(year, month, day)
            .and_then(|days| days.checked_mul(DAY))
            .and_then(|s| s.checked_add(hour.checked_mul(3600)?))
            .and_then(|s| s.checked_add(minute.checked_mul(60)?))
            .and_then(|s| s.checked_add(second))
            .and_then(|s| i64::try_from(s).ok())
            .ok_or(TimeFault::Shape)?;
        Timestamp::from_unix_seconds(seconds).ok_or(TimeFault::Year)
    }
}

impl fmt::Display for Timestamp {
    /// The one written form, `YYYY-MM-DDTHH:MM:SSZ`.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let seconds = u64::try_from(self.0).unwrap_or(0);
        let in_day = seconds % DAY;
        let (year, month, day) = civil_from_days(seconds / DAY).unwrap_or((1970, 1, 1));
        write!(
            f,
            "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
            in_day / 3600,
            in_day % 3600 / 60,
            in_day % 60
        )
    }
}

/// A day of the calendar, in UTC.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Day {
    year: u32,
    month: u8,
    day: u8,
}

impl Day {
    /// The day that `seconds` seconds after 1970-01-01T00:00:00Z falls on
    /// (`None` before 1970, or when the date does not fit).
    #[must_use]
    pub fn of_unix_seconds(seconds: i64) -> Option<Day> {
        let seconds = u64::try_from(seconds).ok()?;
        let (year, month, day) = civil_from_days(seconds / DAY)?;
        Some(Day {
            year: u32::try_from(year).ok()?,
            month: u8::try_from(month).ok()?,
            day: u8::try_from(day).ok()?,
        })
    }

    /// The day that `seconds` falls on, as [`Day::of_unix_seconds`], and
    /// 1970-01-01 for a time it has no day for (before 1970). Every instant
    /// the waiting period gives ([`WaitDays::ready_at_unix`]) has one.
    #[must_use]
    pub fn of_unix_seconds_or_epoch(seconds: i64) -> Day {
        Day::of_unix_seconds(seconds).unwrap_or(Day {
            year: 1970,
            month: 1,
            day: 1,
        })
    }

    /// The year.
    #[must_use]
    pub const fn year(&self) -> u32 {
        self.year
    }

    /// The month, 1 to 12.
    #[must_use]
    pub const fn month(&self) -> u8 {
        self.month
    }

    /// The day of the month, 1 to 31.
    #[must_use]
    pub const fn day(&self) -> u8 {
        self.day
    }
}

impl fmt::Display for Day {
    /// `YYYY-MM-DD`. A year over 9999, which a time of 9999 plus a long wait
    /// reaches, is written with the digits it has.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }
}

/// The days a published version waits before `add` or `upgrade` resolves it:
/// 0 to [`WAIT_DAYS_MAX`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct WaitDays(u32);

impl WaitDays {
    /// The waiting period of `days` days, when it is within
    /// [`WAIT_DAYS_MAX`].
    #[must_use]
    pub fn new(days: u32) -> Option<WaitDays> {
        (days <= WAIT_DAYS_MAX).then_some(WaitDays(days))
    }

    /// The number of days.
    #[must_use]
    pub const fn get(&self) -> u32 {
        self.0
    }

    /// The instant a version published at `published` may be resolved, in
    /// seconds since 1970-01-01T00:00:00Z: `published` and the days, at
    /// 86 400 seconds each.
    #[must_use]
    pub fn ready_at_unix(&self, published: Timestamp) -> i64 {
        let wait = i64::from(self.0).saturating_mul(86_400);
        published.unix_seconds().saturating_add(wait)
    }
}
