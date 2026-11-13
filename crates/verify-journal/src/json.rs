//! The values an export holds: JSON as `JSON.parse` reads it
//! (spec/journal.md "Reading an export").
//!
//! It is wider than the IR's value domain ([`mandate_ir::Value`]): a number
//! is any finite double, with a fraction or an exponent, and -0 is kept as
//! read. Strings are Unicode scalar values: the reader refuses a lone
//! surrogate. An object never has two members of the same name: the reader
//! refuses a duplicate.

/// A JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    /// `null`.
    Null,
    /// `true` or `false`.
    Bool(bool),
    /// A finite double; -0 is kept, and equals 0.
    Number(f64),
    /// A string, its escapes read.
    String(String),
    /// An array.
    Array(Vec<Json>),
    /// An object's members, in the order they were read. Names are unique.
    Object(Vec<(String, Json)>),
}

impl Json {
    /// The member `key` when this is an object that has one.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Object(members) => members.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// The string when this is a string.
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Json::String(s) => Some(s),
            _ => None,
        }
    }

    /// The number when this is a number.
    #[must_use]
    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Json::Number(x) => Some(*x),
            _ => None,
        }
    }

    /// The elements when this is an array.
    #[must_use]
    pub fn as_array(&self) -> Option<&[Json]> {
        match self {
            Json::Array(items) => Some(items),
            _ => None,
        }
    }

    /// The members when this is an object.
    #[must_use]
    pub fn as_object(&self) -> Option<&[(String, Json)]> {
        match self {
            Json::Object(members) => Some(members),
            _ => None,
        }
    }

    /// Whether this is an object.
    #[must_use]
    pub fn is_object(&self) -> bool {
        matches!(self, Json::Object(_))
    }

    /// The value as the IR's value domain, which the package's hashes are
    /// computed over (spec/journal.md, step 4 of "Verification"); `None` when
    /// it holds a number the IR's canonical form does not admit: one that is
    /// not an integer, one beyond ±(2^53−1), or -0.
    #[must_use]
    pub fn to_ir(&self) -> Option<mandate_ir::Value> {
        use mandate_ir::Value;
        Some(match self {
            Json::Null => Value::Null,
            Json::Bool(b) => Value::Bool(*b),
            Json::Number(x) => Value::Number(ir_int(*x)?),
            Json::String(s) => Value::String(s.clone()),
            Json::Array(items) => {
                Value::Array(items.iter().map(Json::to_ir).collect::<Option<Vec<_>>>()?)
            }
            Json::Object(members) => {
                let entries = members
                    .iter()
                    .map(|(k, v)| Some((k.clone(), v.to_ir()?)))
                    .collect::<Option<Vec<_>>>()?;
                Value::Object(mandate_ir::Map::from_entries(entries)?)
            }
        })
    }
}

/// The largest integer a double holds exactly with all below it, 2^53−1.
pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `x` as an integer when it is one of magnitude at most 2^53−1, as
/// ECMAScript's `Number.isSafeInteger` says; -0 is the integer 0.
#[must_use]
pub fn safe_integer(x: f64) -> Option<i64> {
    // Exact when it is used: `x` is then an integer of magnitude below 2^53.
    // (A cast from a double saturates, and never panics.)
    let n = x as i64;
    (x.is_finite() && x.trunc() == x && x.abs() <= MAX_SAFE_INTEGER).then_some(n)
}

/// `x` as an integer of the IR: a safe integer that is not -0.
fn ir_int(x: f64) -> Option<mandate_ir::Int> {
    if x == 0.0 && x.is_sign_negative() {
        return None;
    }
    mandate_ir::Int::new(safe_integer(x)?)
}
