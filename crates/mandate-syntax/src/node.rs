//! The IR as the parser builds it: values whose objects may carry a span.
//!
//! The TypeScript parser builds plain objects and records each one's span in
//! a `WeakMap` keyed by the object, then walks the finished tree to turn that
//! into a table of JSON Pointers (`sourceMap` in `compiler/src/ir/sourcemap.ts`).
//! A Rust value has no identity to key a table by, so here the span is part
//! of the object ([`Obj::span`]), and the walk ([`finish`]) is the same walk.
//! That gives the `WeakMap`'s answers in every case the parser has:
//!
//! - An object given a span twice keeps the last one (`WeakMap.set`).
//! - Only the objects the parser passes to `at` have one. An object built
//!   anew from another's members (`budget.spend` from a money expression) has
//!   none, as a fresh object is not in the `WeakMap`; arrays and scalars have
//!   none, since the parser never marks one.
//! - The TypeScript parser never puts one object at two places in the IR,
//!   and never marks an object after copying it, so an object that is moved
//!   into the tree and its span cannot disagree.
//!
//! Objects keep their members in ECMAScript order, as `mandate_ir::Map` does:
//! names that are array indices first, ascending, then the others in the
//! order they were first assigned; assigning a name again keeps its place
//! (`o[k] = v`). Only `tests`, whose names are free text, can have
//! array-index names in practice.
//!
//! An expression can be nested without bound (`a + a + … + a` is left
//! associative and is read in a loop), so nothing here recurses on the tree
//! before its depth is known: dropping a tree ([`Obj`]'s `Drop`) and its
//! canonical text ([`canonical`]) use an explicit stack; [`too_deep`] stops at
//! the depth limit; [`finish`] runs only on a tree within it.

use std::collections::HashMap;
use std::fmt::Write as _;

use mandate_ir::{
    Diagnostic, Int, JsObject, Location, Map, Span, Value, compare_utf16, limits::JSON_DEPTH,
    ptr_token, write_json_string,
};

use crate::sourcemap::SourceMap;

/// A value of the IR under construction.
#[derive(Debug)]
pub(crate) enum Node {
    /// `true` or `false`.
    Bool(bool),
    /// A number; the parser only makes safe integers.
    Int(Int),
    /// A string.
    Str(String),
    /// An array.
    List(Vec<Node>),
    /// An object.
    Obj(O),
}

/// An object, boxed so that a [`Node`] stays small on the parser's stack.
pub(crate) type O = Box<Obj>;

/// A new empty object: `{}` or `Object.create(null)`.
pub(crate) fn obj() -> O {
    Box::default()
}

impl From<bool> for Node {
    fn from(b: bool) -> Self {
        Node::Bool(b)
    }
}

impl From<Int> for Node {
    fn from(n: Int) -> Self {
        Node::Int(n)
    }
}

impl From<String> for Node {
    fn from(s: String) -> Self {
        Node::Str(s)
    }
}

impl From<&str> for Node {
    fn from(s: &str) -> Self {
        Node::Str(s.to_owned())
    }
}

impl From<Vec<Node>> for Node {
    fn from(items: Vec<Node>) -> Self {
        Node::List(items)
    }
}

impl From<O> for Node {
    fn from(o: O) -> Self {
        Node::Obj(o)
    }
}

impl Node {
    /// The object, when this is one.
    pub(crate) fn as_obj(&self) -> Option<&Obj> {
        match self {
            Node::Obj(o) => Some(o),
            _ => None,
        }
    }

    /// The object, to change in place, when this is one.
    pub(crate) fn as_obj_mut(&mut self) -> Option<&mut Obj> {
        match self {
            Node::Obj(o) => Some(o),
            _ => None,
        }
    }
}

/// The size from which an object keeps the places of its names, so that
/// `defs`, `fields` and the like of a large input are not searched linearly.
const INDEXED_FROM: usize = 16;

/// An object of the IR under construction, with its span when the parser
/// gave it one.
#[derive(Debug, Default)]
pub(crate) struct Obj {
    /// The members, in ECMAScript order.
    entries: Vec<(String, Node)>,
    /// How many of the first entries have array-index names.
    indexed: usize,
    /// Each name's place in `entries`, once there are `INDEXED_FROM` of them.
    places: Option<HashMap<String, usize>>,
    /// The span `at` gave it: the `WeakMap` entry of the TypeScript object.
    pub(crate) span: Option<Span>,
}

/// The numeric value of `key` when it is an array index: the canonical
/// decimal form of an integer from 0 to 2^32 − 2.
fn array_index(key: &str) -> Option<u32> {
    let canonical = match key.as_bytes() {
        [b'0'] => true,
        [b'1'..=b'9', rest @ ..] => rest.len() < 10 && rest.iter().all(u8::is_ascii_digit),
        _ => false,
    };
    if !canonical {
        return None;
    }
    key.parse::<u32>().ok().filter(|&n| n != u32::MAX)
}

impl Obj {
    /// The object with member `key` set to `value`, as `{ …, key: value }`.
    pub(crate) fn with(mut self: Box<Self>, key: &str, value: impl Into<Node>) -> O {
        self.set(key, value);
        self
    }

    /// The object with member `key` set when there is a value, as
    /// `if (v) o.key = v`.
    pub(crate) fn with_some<T: Into<Node>>(self: Box<Self>, key: &str, value: Option<T>) -> O {
        match value {
            Some(v) => self.with(key, v),
            None => self,
        }
    }

    fn place(&self, key: &str) -> Option<usize> {
        match &self.places {
            Some(places) => places.get(key).copied(),
            None => self.entries.iter().position(|(k, _)| k == key),
        }
    }

    /// `o[key] = value`: a name already present keeps its place.
    pub(crate) fn set(&mut self, key: &str, value: impl Into<Node>) {
        let value = value.into();
        if let Some(slot) = self.get_mut(key) {
            *slot = value;
            return;
        }
        let place = match array_index(key) {
            None => self.entries.len(),
            Some(index) => {
                let before = self
                    .entries
                    .get(..self.indexed)
                    .unwrap_or_default()
                    .partition_point(|(k, _)| array_index(k).is_some_and(|n| n < index));
                self.indexed = self.indexed.saturating_add(1);
                before
            }
        };
        let at_end = place == self.entries.len();
        self.entries.insert(place, (key.to_owned(), value));
        match &mut self.places {
            Some(places) if at_end => {
                places.insert(key.to_owned(), place);
            }
            Some(places) => {
                for (i, (k, _)) in self.entries.iter().enumerate().skip(place) {
                    places.insert(k.clone(), i);
                }
            }
            None if self.entries.len() >= INDEXED_FROM => {
                let places = self
                    .entries
                    .iter()
                    .enumerate()
                    .map(|(i, (k, _))| (k.clone(), i))
                    .collect();
                self.places = Some(places);
            }
            None => {}
        }
    }

    /// The value of member `key`.
    pub(crate) fn get(&self, key: &str) -> Option<&Node> {
        let at = self.place(key)?;
        self.entries.get(at).map(|(_, v)| v)
    }

    /// The value of member `key`, to change in place.
    pub(crate) fn get_mut(&mut self, key: &str) -> Option<&mut Node> {
        let at = self.place(key)?;
        self.entries.get_mut(at).map(|(_, v)| v)
    }

    /// `key in o` for an object of the parser's own making: whether the
    /// member is present (see `Parser::in_plain_object` for `{}`).
    pub(crate) fn has(&self, key: &str) -> bool {
        self.place(key).is_some()
    }

    /// The string member `key`.
    pub(crate) fn str(&self, key: &str) -> Option<&str> {
        match self.get(key)? {
            Node::Str(s) => Some(s),
            _ => None,
        }
    }

    /// The number of members.
    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether there are no members (`Object.keys(o).length === 0`).
    pub(crate) fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// `(o[key] ??= []).push(item)`.
    pub(crate) fn push(&mut self, key: &str, item: impl Into<Node>) {
        if !matches!(self.get(key), Some(Node::List(_))) {
            self.set(key, Vec::new());
        }
        if let Some(Node::List(items)) = self.get_mut(key) {
            items.push(item.into());
        }
    }

    /// `o[key] ??= Object.create(null)`: the object member `key`, made empty
    /// when absent. (It is always `Some`; the type says what `get_mut` can.)
    pub(crate) fn map(&mut self, key: &str) -> Option<&mut Obj> {
        if !matches!(self.get(key), Some(Node::Obj(_))) {
            self.set(key, obj());
        }
        self.get_mut(key).and_then(Node::as_obj_mut)
    }

    /// The members, in order.
    pub(crate) fn iter(&self) -> impl Iterator<Item = (&str, &Node)> {
        self.entries.iter().map(|(k, v)| (k.as_str(), v))
    }

    /// The members, taken out in order; the object is left empty.
    fn take_entries(&mut self) -> Vec<(String, Node)> {
        self.places = None;
        self.indexed = 0;
        std::mem::take(&mut self.entries)
    }
}

impl Drop for Obj {
    /// Drops the members with a stack of its own, so that a chain such as
    /// `a + a + … + a`, nested as deep as the input is long, does not
    /// overflow the call stack.
    fn drop(&mut self) {
        if !self
            .entries
            .iter()
            .any(|(_, v)| matches!(v, Node::Obj(_) | Node::List(_)))
        {
            return;
        }
        let mut stack: Vec<Node> = self.take_entries().into_iter().map(|(_, v)| v).collect();
        while let Some(node) = stack.pop() {
            match node {
                Node::Obj(mut o) => stack.extend(o.take_entries().into_iter().map(|(_, v)| v)),
                Node::List(items) => stack.extend(items),
                Node::Bool(_) | Node::Int(_) | Node::Str(_) => {}
            }
        }
    }
}

// ── canonical text ───────────────────────────────────────────────────────

enum Piece<'a> {
    Node(&'a Node),
    Key(&'a str),
    Text(char),
}

/// The canonical (RFC 8785) text of `node`, as `canonicalize` in
/// `compiler/src/json/jcs.ts` gives it, with a stack of its own: the
/// parser's `sortCanon` takes it of expressions of any depth.
pub(crate) fn canonical(node: &Node) -> String {
    let mut out = String::new();
    let mut stack = vec![Piece::Node(node)];
    while let Some(piece) = stack.pop() {
        match piece {
            Piece::Text(c) => out.push(c),
            Piece::Key(k) => {
                write_json_string(&mut out, k);
                out.push(':');
            }
            Piece::Node(Node::Bool(true)) => out.push_str("true"),
            Piece::Node(Node::Bool(false)) => out.push_str("false"),
            Piece::Node(Node::Int(n)) => {
                // Writing to a String cannot fail.
                let _ = write!(out, "{n}");
            }
            Piece::Node(Node::Str(s)) => write_json_string(&mut out, s),
            Piece::Node(Node::List(items)) => {
                out.push('[');
                stack.push(Piece::Text(']'));
                for (i, item) in items.iter().enumerate().rev() {
                    stack.push(Piece::Node(item));
                    if i > 0 {
                        stack.push(Piece::Text(','));
                    }
                }
            }
            Piece::Node(Node::Obj(o)) => {
                let mut members: Vec<(&str, &Node)> = o.iter().collect();
                members.sort_by(|a, b| compare_utf16(a.0, b.0));
                out.push('{');
                stack.push(Piece::Text('}'));
                for (i, (k, v)) in members.into_iter().enumerate().rev() {
                    stack.push(Piece::Node(v));
                    stack.push(Piece::Key(k));
                    if i > 0 {
                        stack.push(Piece::Text(','));
                    }
                }
            }
        }
    }
    out
}

/// `sortCanon` in `parser.ts`: the items in the order of their canonical
/// text, compared as JavaScript compares strings (by UTF-16 code units), and
/// stable, as `Array.prototype.sort` is.
pub(crate) fn sort_canon(items: Vec<Node>) -> Vec<Node> {
    let mut keyed: Vec<(String, Node)> = items.into_iter().map(|v| (canonical(&v), v)).collect();
    keyed.sort_by(|a, b| compare_utf16(&a.0, &b.0));
    keyed.into_iter().map(|(_, v)| v).collect()
}

// ── the depth limit ──────────────────────────────────────────────────────

/// `tooDeep` in `parser.ts`: the first value of the IR, members taken in
/// canonical order, nested deeper than [`JSON_DEPTH`] (the root is at depth
/// 1), reported as the JSON reader reports it for the program's `.ir.json`,
/// at the nearest span: `MDT-E0105` with `{ span, path }`, or `{ path }`
/// when no object on the way has a span.
pub(crate) fn too_deep(root: &Node) -> Option<Box<Diagnostic>> {
    let mut path = String::new();
    walk_depth(root, &mut path, 1, None)
}

fn walk_depth(
    node: &Node,
    path: &mut String,
    depth: usize,
    near: Option<Span>,
) -> Option<Box<Diagnostic>> {
    let span = node.as_obj().and_then(|o| o.span).or(near);
    if depth > JSON_DEPTH {
        let facts = JsObject::new().with("limit", JSON_DEPTH);
        let message = format!("JSON nesting exceeds the depth limit of {JSON_DEPTH}.");
        let at = Location::span_then_path(span, path.as_str());
        return Some(Box::new(Diagnostic::new("E0105", message, at, Some(facts))));
    }
    let inner = depth.saturating_add(1);
    match node {
        Node::List(items) => items.iter().enumerate().find_map(|(i, item)| {
            let len = path.len();
            path.push('/');
            path.push_str(&i.to_string());
            let found = walk_depth(item, path, inner, span);
            path.truncate(len);
            found
        }),
        Node::Obj(o) => {
            let mut members: Vec<(&str, &Node)> = o.iter().collect();
            members.sort_by(|a, b| compare_utf16(a.0, b.0));
            members.into_iter().find_map(|(k, v)| {
                let len = path.len();
                path.push('/');
                path.push_str(&ptr_token(k));
                let found = walk_depth(v, path, inner, span);
                path.truncate(len);
                found
            })
        }
        Node::Bool(_) | Node::Int(_) | Node::Str(_) => None,
    }
}

// ── the finished IR and its source map ──────────────────────────────────

/// The IR value of `node` and its source map: `sourceMap(program, spans)` in
/// `sourcemap.ts`, then `JSON.parse(JSON.stringify(program))` in `load`.
///
/// The walk is `sourceMap`'s: depth first, an object's span before its
/// members, members in the object's order, elements by index; every object
/// with a span adds `pointer → span`, in that order. It recurses once per
/// level, on a tree [`too_deep`] has found within the depth limit.
pub(crate) fn finish(node: Node) -> (Value, SourceMap) {
    let mut spans = SourceMap::new();
    let mut path = String::new();
    let value = finish_at(node, &mut path, &mut spans);
    (value, spans)
}

fn finish_at(node: Node, path: &mut String, spans: &mut SourceMap) -> Value {
    match node {
        Node::Bool(b) => Value::Bool(b),
        Node::Int(n) => Value::Number(n),
        Node::Str(s) => Value::String(s),
        Node::List(items) => Value::Array(
            items
                .into_iter()
                .enumerate()
                .map(|(i, item)| {
                    let len = path.len();
                    path.push('/');
                    path.push_str(&i.to_string());
                    let v = finish_at(item, path, spans);
                    path.truncate(len);
                    v
                })
                .collect(),
        ),
        Node::Obj(mut o) => {
            if let Some(span) = o.span {
                spans.insert(path.clone(), span);
            }
            let members: Vec<(String, Value)> = o
                .take_entries()
                .into_iter()
                .map(|(k, v)| {
                    let len = path.len();
                    path.push('/');
                    path.push_str(&ptr_token(&k));
                    let v = finish_at(v, path, spans);
                    path.truncate(len);
                    (k, v)
                })
                .collect();
            // The members are in ECMAScript order already and their names
            // unique; `collect` keeps both.
            Value::Object(members.into_iter().collect::<Map>())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn int(n: i64) -> Node {
        Node::Int(Int::saturating(n))
    }

    #[test]
    fn members_are_in_ecmascript_order() {
        let o = obj()
            .with("b", int(1))
            .with("10", int(2))
            .with("a", int(3))
            .with("9", int(4))
            .with("b", int(5))
            .with("01", int(6));
        let keys: Vec<&str> = o.iter().map(|(k, _)| k).collect();
        assert_eq!(keys, ["9", "10", "b", "a", "01"]);
        assert!(matches!(o.get("b"), Some(Node::Int(n)) if n.get() == 5));
    }

    #[test]
    fn a_large_object_finds_its_members() {
        let mut o = obj();
        for i in 0..100 {
            o.set(&format!("k{i}"), int(i));
        }
        o.set("5", int(-1));
        o.set("k50", int(500));
        assert_eq!(o.iter().next().map(|(k, _)| k), Some("5"));
        assert!(matches!(o.get("k50"), Some(Node::Int(n)) if n.get() == 500));
        assert!(matches!(o.get("k99"), Some(Node::Int(n)) if n.get() == 99));
        assert_eq!(o.len(), 101);
    }

    #[test]
    fn canonical_text_sorts_by_utf16_and_does_not_recurse() {
        let o = obj()
            .with("\u{e000}", int(1))
            .with("\u{1f600}", Node::List(vec![Node::Bool(true), "x".into()]));
        assert_eq!(
            canonical(&Node::Obj(o)),
            "{\"\u{1f600}\":[true,\"x\"],\"\u{e000}\":1}"
        );
        // A chain a hundred thousand deep has a canonical text, and drops.
        let mut chain = Node::Str("a".to_owned());
        for _ in 0..100_000 {
            chain = Node::Obj(obj().with("of", chain));
        }
        assert_eq!(canonical(&chain).len(), 100_000 * 7 + 3);
        assert!(too_deep(&chain).is_some());
    }
}
