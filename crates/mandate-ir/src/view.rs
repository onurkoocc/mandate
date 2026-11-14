//! What the typed views share: reading one member of an object as a list,
//! a map, a string or a number, where a member that is missing or of another
//! type reads as nothing.

use crate::value::{Map, Value};

/// The elements of the array member `key`, every one of them, so that an
/// element's index is its index in the IR; none when the member is missing
/// or not an array.
pub(crate) fn list<'a>(map: &'a Map, key: &str) -> &'a [Value] {
    map.get(key).and_then(Value::as_array).unwrap_or_default()
}

/// The array member `key` when it is there (an empty array is there).
pub(crate) fn list_given<'a>(map: &'a Map, key: &str) -> Option<&'a [Value]> {
    map.get(key).and_then(Value::as_array)
}

/// The members of the object member `key`, in the order of the object
/// (`Object.entries`); none when it is missing or not an object.
pub(crate) fn entries<'a>(map: &'a Map, key: &str) -> impl Iterator<Item = (&'a str, &'a Value)> {
    map.get(key)
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(Map::iter)
}

/// The string member `key`.
pub(crate) fn string<'a>(map: &'a Map, key: &str) -> Option<&'a str> {
    map.get(key).and_then(Value::as_str)
}

/// The strings of the array member `key`, in order; the elements that are
/// not strings are left out.
pub(crate) fn strings<'a>(map: &'a Map, key: &str) -> impl Iterator<Item = &'a str> {
    list(map, key).iter().filter_map(Value::as_str)
}
