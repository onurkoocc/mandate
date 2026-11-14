//! A JSON Schema validator that gives Ajv's raw errors: the subset of draft
//! 2020-12 that `spec/ir.schema.json` and `spec/lock.schema.json` use, run
//! as Ajv 8.20.0 runs it with `allErrors` (`compiler/src/ir/validate.ts`,
//! `compiler/src/lock.ts`).
//!
//! The diagnostics the compiler makes depend on the number, the order and the
//! text of Ajv's errors, so this follows Ajv's generated code rather than the
//! specification. What a reader of this file should know about Ajv (see also
//! `vectors/README.md`, "What Ajv does that a port must copy"):
//!
//! - **The order of the keywords of one schema** (`ajv.RULES`, applied by
//!   `schemaKeywords` in `compile/validate/index.js`). A `type` is checked
//!   first ("at once") unless it has a group of keywords and the schema uses
//!   one of them; then, in this order, `$ref`, `const`, `enum`, `oneOf`; for a
//!   number `maximum`, `minimum`; for a string `maxLength`, `minLength`,
//!   `pattern`; for an array `minItems`, `items` (by index), `uniqueItems`; for
//!   an object `minProperties`, `required` (in the list's order),
//!   `propertyNames`, `additionalProperties` (in the document's order),
//!   `properties` (in the schema's order), `discriminator`. A group's keywords
//!   are skipped for a value of another type, and the `type` error of a schema
//!   whose type has that group comes in the group's place ([`Node::eval`]).
//! - **`$ref`.** Ajv inlines a target with no `$ref` in it (`inlineRef` in
//!   `compile/resolve.js`) and writes `schemaPath` from the `$ref` text
//!   (`#/$defs/Name/pattern`); any other target is a function of its own, whose
//!   paths start again at `#` ([`Builder::reserve`]).
//! - **`oneOf`.** Every branch is run; when exactly one passes, the errors of
//!   all of them are taken back, else they stay and one `oneOf` error follows
//!   with `passingSchemas` (`null` when none passed) ([`Run::one_of`]).
//! - **`discriminator`** (IR only). `oneOf` is not run: the branch whose tag
//!   value matches is, and its paths are `…/oneOf/<i>/…`; a tag that is not a
//!   string, or matches no branch, is a `discriminator` error, after the
//!   `required` one when the tag is missing ([`Run::discriminator`]).
//! - **`propertyNames`.** Errors inside it are at the object's path and carry
//!   `propertyName`; each failing name adds a `propertyNames` error.
//! - **`uniqueItems`.** When `items` has a scalar `type`, Ajv walks from the
//!   end with an object for an index (`loopN` in `uniqueItems.js`): `i` is the
//!   earlier index and `j` the later, and an item `"__proto__"` is never
//!   found again, since assigning a number to `__proto__` of `{}` does
//!   nothing. Otherwise (`loopN2`) it compares deeply: `i` is the later index
//!   and `j` the largest earlier one equal to it. Both stop at the first pair.
//!   Here each is one pass with a hash map ([`Run::unique_items`]), not Ajv's
//!   quadratic loop.
//! - **Lengths** count code points (`ucs2length`), and `const`, `enum` and
//!   `uniqueItems` compare deeply, an object's member order aside.
//!
//! A keyword this validator does not implement, anywhere in a schema, makes
//! [`Schema::prepare`] fail, as does a `pattern` with no hand-written matcher
//! (`pattern.rs`): nothing is ignored.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::OnceLock;

use crate::diag::ptr_token;
use crate::jcs::canonicalize;
use crate::js_value::{JsObject, JsValue};
use crate::pattern::Pattern;
use crate::reader::parse;
use crate::value::{Int, Map, Value};

/// `spec/ir.schema.json`, as it was when this crate was built.
pub const IR_SCHEMA_TEXT: &str = include_str!("../../../spec/ir.schema.json");

/// `spec/lock.schema.json`, as it was when this crate was built.
pub const LOCK_SCHEMA_TEXT: &str = include_str!("../../../spec/lock.schema.json");

/// The only `$schema` a schema may name.
const DRAFT_2020_12: &str = "https://json-schema.org/draft/2020-12/schema";

/// One error as Ajv makes it (`ErrorObject`), without `verbose`.
#[derive(Clone, Debug, PartialEq)]
pub struct SchemaError {
    /// The JSON Pointer of the value at fault.
    pub instance_path: String,
    /// Where in the schema: `#/…/<keyword>`.
    pub schema_path: String,
    /// The keyword, such as `required`.
    pub keyword: &'static str,
    /// Ajv's parameters of the error, in Ajv's member order.
    pub params: JsObject,
    /// Ajv's message, such as `must be string`.
    pub message: String,
    /// The member name a `propertyNames` subschema was checking, for an error
    /// raised inside one.
    pub property_name: Option<String>,
}

impl SchemaError {
    /// The object Ajv gives: `{ instancePath, schemaPath, keyword, params,
    /// message, propertyName? }`.
    #[must_use]
    pub fn to_js(&self) -> JsValue {
        JsObject::new()
            .with("instancePath", self.instance_path.as_str())
            .with("schemaPath", self.schema_path.as_str())
            .with("keyword", self.keyword)
            .with("params", self.params.clone())
            .with("message", self.message.as_str())
            .with_some("propertyName", self.property_name.as_deref())
            .into()
    }
}

/// How a schema is prepared: the options of `new Ajv2020(…)` that change
/// what it accepts.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SchemaOptions {
    /// Ajv's `discriminator` option: the keyword is known only with it.
    pub discriminator: bool,
}

/// A JSON type, as `type` names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Type {
    Null,
    Boolean,
    Object,
    Array,
    Number,
    Integer,
    String,
}

/// The groups of `ajv.RULES` that apply to one type of value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Group {
    Number,
    String,
    Array,
    Object,
}

impl Type {
    fn parse(name: &str) -> Option<Type> {
        Some(match name {
            "null" => Type::Null,
            "boolean" => Type::Boolean,
            "object" => Type::Object,
            "array" => Type::Array,
            "number" => Type::Number,
            "integer" => Type::Integer,
            "string" => Type::String,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Type::Null => "null",
            Type::Boolean => "boolean",
            Type::Object => "object",
            Type::Array => "array",
            Type::Number => "number",
            Type::Integer => "integer",
            Type::String => "string",
        }
    }

    /// The group of keywords of this type; `integer`, `boolean` and `null`
    /// have none (the number keywords apply to an integer through `number`).
    fn group(self) -> Option<Group> {
        match self {
            Type::Number => Some(Group::Number),
            Type::String => Some(Group::String),
            Type::Array => Some(Group::Array),
            Type::Object => Some(Group::Object),
            Type::Null | Type::Boolean | Type::Integer => None,
        }
    }

    /// Whether `v` is of this type. Every number of the IR domain is an
    /// integer.
    fn holds(self, v: &Value) -> bool {
        matches!(
            (self, v),
            (Type::Null, Value::Null)
                | (Type::Boolean, Value::Bool(_))
                | (Type::Object, Value::Object(_))
                | (Type::Array, Value::Array(_))
                | (Type::Number | Type::Integer, Value::Number(_))
                | (Type::String, Value::String(_))
        )
    }
}

impl Group {
    fn holds(self, v: &Value) -> bool {
        matches!(
            (self, v),
            (Group::Number, Value::Number(_))
                | (Group::String, Value::String(_))
                | (Group::Array, Value::Array(_))
                | (Group::Object, Value::Object(_))
        )
    }
}

/// `additionalProperties`.
#[derive(Clone, Copy, Debug)]
enum Additional {
    /// `false`: every member not in `properties` is an error.
    Refused,
    /// A schema for every member not in `properties`.
    Schema(usize),
}

/// A `$ref`, resolved.
#[derive(Clone, Copy, Debug)]
struct Ref {
    target: usize,
    /// Whether Ajv inlines the target, which then keeps the propertyNames
    /// context of the place it is used in.
    inline: bool,
}

/// `discriminator`, with the mapping Ajv builds from the branches.
#[derive(Clone, Debug)]
struct Discriminator {
    tag: String,
    /// Each tag value and the index of its branch in `oneOf`.
    mapping: Vec<(String, usize)>,
}

/// One schema object, prepared.
#[derive(Clone, Debug, Default)]
struct Node {
    /// Ajv's `errSchemaPath` of this schema.
    path: String,
    ty: Option<Type>,
    /// Whether `type` is checked before every other keyword.
    type_at_once: bool,
    reference: Option<Ref>,
    constant: Option<Value>,
    allowed: Option<Vec<Value>>,
    one_of: Option<Vec<usize>>,
    discriminator: Option<Discriminator>,
    maximum: Option<Int>,
    minimum: Option<Int>,
    max_length: Option<usize>,
    min_length: Option<usize>,
    pattern: Option<(Pattern, String)>,
    min_items: Option<usize>,
    items: Option<usize>,
    unique_items: Option<bool>,
    /// The scalar type of `items`, when it has one: Ajv's fast `uniqueItems`.
    unique_by: Option<Type>,
    min_properties: Option<usize>,
    required: Option<Vec<String>>,
    property_names: Option<usize>,
    additional: Option<Additional>,
    properties: Option<Vec<(String, usize)>>,
}

impl Node {
    /// Whether the schema uses a keyword of `group` (`shouldUseGroup`).
    fn uses(&self, group: Group) -> bool {
        match group {
            Group::Number => self.maximum.is_some() || self.minimum.is_some(),
            Group::String => {
                self.max_length.is_some() || self.min_length.is_some() || self.pattern.is_some()
            }
            Group::Array => {
                self.min_items.is_some() || self.items.is_some() || self.unique_items.is_some()
            }
            Group::Object => {
                self.min_properties.is_some()
                    || self.required.is_some()
                    || self.property_names.is_some()
                    || self.additional.is_some()
                    || self.properties.is_some()
                    || self.discriminator.is_some()
            }
        }
    }
}

/// A schema prepared for validation.
#[derive(Clone, Debug)]
pub struct Schema {
    nodes: Vec<Node>,
    root: usize,
}

/// Whether a schema has a `$ref` anywhere in it (`hasRef` in
/// `compile/resolve.js`): then Ajv does not inline it.
fn has_ref(v: &Value) -> bool {
    const REF_KEYWORDS: [&str; 5] = [
        "$ref",
        "$recursiveRef",
        "$recursiveAnchor",
        "$dynamicRef",
        "$dynamicAnchor",
    ];
    match v {
        Value::Object(map) => map
            .iter()
            .any(|(k, x)| REF_KEYWORDS.contains(&k) || has_ref(x)),
        Value::Array(items) => items.iter().any(has_ref),
        _ => false,
    }
}

/// `escapeFragment`: a JSON Pointer token, then `encodeURIComponent`.
fn escape_fragment(s: &str) -> String {
    let mut out = String::new();
    for byte in ptr_token(s).bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(char::from(byte));
        } else {
            // Writing to a String cannot fail.
            let _ = write!(out, "%{byte:02X}");
        }
    }
    out
}

fn count(v: &Value, at: &str) -> Result<usize, String> {
    v.as_i64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| format!("{at}: must be a non-negative integer"))
}

/// Builds the nodes of one schema document.
struct Builder<'a> {
    nodes: Vec<Node>,
    /// Each entry of `$defs`: its node and whether Ajv inlines it.
    defs: HashMap<&'a str, Ref>,
    options: SchemaOptions,
}

impl<'a> Builder<'a> {
    /// Reserves a node for each entry of `$defs`, so that a `$ref` can name
    /// one before it is built.
    fn reserve(&mut self, defs: &'a Map) {
        for (name, def) in defs.iter() {
            let target = self.nodes.len();
            self.nodes.push(Node::default());
            self.defs.insert(
                name,
                Ref {
                    target,
                    inline: !has_ref(def),
                },
            );
        }
    }

    fn add(&mut self, schema: &'a Value, path: String, at: &str) -> Result<usize, String> {
        let node = self.node(schema, path, at, false)?;
        self.nodes.push(node);
        Ok(self.nodes.len().saturating_sub(1))
    }

    fn resolve(&self, reference: &str, at: &str) -> Result<Ref, String> {
        reference
            .strip_prefix("#/$defs/")
            .filter(|name| {
                name.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .and_then(|name| self.defs.get(name).copied())
            .ok_or_else(|| format!("{at}: $ref {reference:?} names no entry of $defs"))
    }

    fn node(
        &mut self,
        schema: &'a Value,
        path: String,
        at: &str,
        root: bool,
    ) -> Result<Node, String> {
        let Some(members) = schema.as_object() else {
            return Err(format!("{at}: a schema here must be an object"));
        };
        let mut node = Node {
            path,
            ..Node::default()
        };
        for (key, v) in members.iter() {
            let here = format!("{at}/{}", ptr_token(key));
            match key {
                "title" | "description" | "$comment" => {}
                "$schema" if root => {
                    if v.as_str() != Some(DRAFT_2020_12) {
                        return Err(format!("{here}: only {DRAFT_2020_12} is supported"));
                    }
                }
                "$id" if root && v.as_str().is_some() => {}
                // Built by `prepare`.
                "$defs" if root => {}
                "type" => {
                    let name = v.as_str().unwrap_or_default();
                    node.ty = Some(
                        Type::parse(name).ok_or_else(|| format!("{here}: one type, by name"))?,
                    );
                }
                "$ref" => {
                    let reference = v.as_str().unwrap_or_default();
                    node.reference = Some(self.resolve(reference, &here)?);
                }
                "const" => node.constant = Some(v.clone()),
                "enum" => match v.as_array() {
                    Some(values) if !values.is_empty() => node.allowed = Some(values.to_vec()),
                    _ => return Err(format!("{here}: enum must have a non-empty array")),
                },
                "oneOf" => {
                    let branches = v
                        .as_array()
                        .filter(|b| !b.is_empty())
                        .ok_or_else(|| format!("{here}: oneOf must have a non-empty array"))?;
                    let mut ids = Vec::new();
                    for (i, branch) in branches.iter().enumerate() {
                        let p = format!("{}/oneOf/{i}", node.path);
                        ids.push(self.add(branch, p, &format!("{here}/{i}"))?);
                    }
                    node.one_of = Some(ids);
                }
                "discriminator" => {
                    if !self.options.discriminator {
                        return Err(format!(
                            "{here}: discriminator needs the discriminator option"
                        ));
                    }
                    let tag = v
                        .as_object()
                        .filter(|d| d.len() == 1)
                        .and_then(|d| d.get("propertyName"))
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("{here}: only {{ propertyName }} is supported"))?;
                    node.discriminator = Some(Discriminator {
                        tag: tag.to_owned(),
                        mapping: Vec::new(),
                    });
                }
                "maximum" => {
                    let n = v.as_i64().and_then(Int::new);
                    node.maximum = Some(n.ok_or_else(|| format!("{here}: an integer"))?);
                }
                "minimum" => {
                    let n = v.as_i64().and_then(Int::new);
                    node.minimum = Some(n.ok_or_else(|| format!("{here}: an integer"))?);
                }
                "maxLength" => node.max_length = Some(count(v, &here)?),
                "minLength" => node.min_length = Some(count(v, &here)?),
                "pattern" => {
                    let source = v.as_str().unwrap_or_default();
                    let pattern = Pattern::from_source(source).ok_or_else(|| {
                        format!("{here}: no hand-written matcher for the pattern {source:?}")
                    })?;
                    node.pattern = Some((pattern, source.to_owned()));
                }
                "minItems" => node.min_items = Some(count(v, &here)?),
                "items" => {
                    let p = format!("{}/items", node.path);
                    node.items = Some(self.add(v, p, &here)?);
                    node.unique_by = v
                        .get("type")
                        .and_then(Value::as_str)
                        .and_then(Type::parse)
                        .filter(|t| !matches!(t, Type::Object | Type::Array));
                }
                "uniqueItems" => match v {
                    Value::Bool(b) => node.unique_items = Some(*b),
                    _ => return Err(format!("{here}: a boolean")),
                },
                "minProperties" => node.min_properties = Some(count(v, &here)?),
                "required" => {
                    let names = v.as_array().and_then(|names| {
                        names
                            .iter()
                            .map(|n| n.as_str().map(str::to_owned))
                            .collect::<Option<Vec<String>>>()
                    });
                    node.required =
                        Some(names.ok_or_else(|| format!("{here}: an array of names"))?);
                }
                "propertyNames" => {
                    let p = format!("{}/propertyNames", node.path);
                    node.property_names = Some(self.add(v, p, &here)?);
                }
                "additionalProperties" => {
                    node.additional = Some(match v {
                        Value::Bool(false) => Additional::Refused,
                        Value::Object(_) => {
                            let p = format!("{}/additionalProperties", node.path);
                            Additional::Schema(self.add(v, p, &here)?)
                        }
                        _ => return Err(format!("{here}: false or a schema")),
                    });
                }
                "properties" => {
                    let props = v
                        .as_object()
                        .ok_or_else(|| format!("{here}: an object of schemas"))?;
                    let mut out = Vec::new();
                    for (name, sub) in props.iter() {
                        if name == "__proto__" {
                            return Err(format!("{here}: a property named __proto__"));
                        }
                        let p = format!("{}/properties/{}", node.path, escape_fragment(name));
                        let id = self.add(sub, p, &format!("{here}/{}", ptr_token(name)))?;
                        out.push((name.to_owned(), id));
                    }
                    node.properties = Some(out);
                }
                _ => return Err(format!("{here}: the keyword {key:?} is not supported")),
            }
        }
        self.finish(node, members, at)
    }

    /// The checks Ajv makes of a whole schema object, and what follows from it.
    fn finish(&self, mut node: Node, members: &'a Map, at: &str) -> Result<Node, String> {
        if let Some(d) = node.discriminator.as_mut() {
            let branches = members
                .get("oneOf")
                .and_then(Value::as_array)
                .ok_or_else(|| format!("{at}: discriminator requires oneOf"))?;
            let top_required = node.required.as_ref().is_some_and(|r| r.contains(&d.tag));
            for (i, branch) in branches.iter().enumerate() {
                let required = branch
                    .get("required")
                    .and_then(Value::as_array)
                    .is_some_and(|r| r.iter().any(|n| n.as_str() == Some(d.tag.as_str())));
                if !top_required && !required {
                    return Err(format!("{at}: discriminator: {:?} must be required", d.tag));
                }
                let prop = branch.get("properties").and_then(|p| p.get(&d.tag));
                // `if (sch.const)`: a const that is not a non-empty string is
                // not taken as one.
                let constant = prop
                    .and_then(|p| p.get("const"))
                    .filter(|c| c.as_str().is_some_and(|s| !s.is_empty()));
                let values: Vec<&Value> = match (constant, prop.and_then(|p| p.get("enum"))) {
                    (Some(c), _) => vec![c],
                    (None, Some(Value::Array(e))) => e.iter().collect(),
                    _ => {
                        return Err(format!(
                            "{at}/oneOf/{i}: discriminator: properties/{} must have const or enum",
                            d.tag
                        ));
                    }
                };
                for value in values {
                    let tag_value = value
                        .as_str()
                        .filter(|s| !d.mapping.iter().any(|(m, _)| m == s));
                    let tag_value = tag_value.ok_or_else(|| {
                        format!("{at}: discriminator: tag values must be unique strings")
                    })?;
                    d.mapping.push((tag_value.to_owned(), i));
                }
            }
        }
        node.type_at_once = node
            .ty
            .is_some_and(|t| !t.group().is_some_and(|g| node.uses(g)));
        Ok(node)
    }
}

impl Schema {
    /// Prepares `schema`, a draft 2020-12 schema read as JSON.
    ///
    /// # Errors
    ///
    /// When it uses a keyword, a form of a keyword or a `pattern` this
    /// validator does not implement, or a `$ref` it cannot resolve: what and
    /// where.
    pub fn prepare(schema: &Value, options: SchemaOptions) -> Result<Schema, String> {
        let mut builder = Builder {
            nodes: Vec::new(),
            defs: HashMap::new(),
            options,
        };
        let defs = match schema.get("$defs") {
            None => None,
            Some(Value::Object(defs)) => Some(defs),
            Some(_) => return Err("/$defs: an object of schemas".to_owned()),
        };
        if let Some(defs) = defs {
            builder.reserve(defs);
            for (name, def) in defs.iter() {
                let reference = builder.resolve(&format!("#/$defs/{name}"), "/$defs")?;
                let path = if reference.inline {
                    format!("#/$defs/{name}")
                } else {
                    "#".to_owned()
                };
                let node =
                    builder.node(def, path, &format!("/$defs/{}", ptr_token(name)), false)?;
                if let Some(slot) = builder.nodes.get_mut(reference.target) {
                    *slot = node;
                }
            }
        }
        let node = builder.node(schema, "#".to_owned(), "", true)?;
        builder.nodes.push(node);
        let root = builder.nodes.len().saturating_sub(1);
        Ok(Schema {
            nodes: builder.nodes,
            root,
        })
    }

    /// Prepares the schema written as `text`.
    ///
    /// # Errors
    ///
    /// When the text is not strict JSON, or as [`Schema::prepare`].
    pub fn from_text(text: &str, options: SchemaOptions) -> Result<Schema, String> {
        let parsed = parse(text).map_err(|d| {
            d.first()
                .map_or_else(|| "not strict JSON".to_owned(), |d| d.message.clone())
        })?;
        Schema::prepare(&parsed.value, options)
    }

    /// The errors of `value`, in Ajv's order; empty when it is valid.
    #[must_use]
    pub fn errors(&self, value: &Value) -> Vec<SchemaError> {
        let mut run = Run {
            schema: self,
            errors: Vec::new(),
            path: String::new(),
        };
        run.eval(self.root, value, None);
        run.errors
    }
}

/// The IR schema, prepared once, as `validateIr` compiles it:
/// `new Ajv2020({ allErrors: true, discriminator: true, strict: true,
/// strictRequired: false })`.
///
/// # Errors
///
/// When the embedded schema cannot be prepared, which a test of this crate
/// rules out.
pub fn ir_schema() -> Result<&'static Schema, &'static str> {
    static IR: OnceLock<Result<Schema, String>> = OnceLock::new();
    IR.get_or_init(|| {
        Schema::from_text(
            IR_SCHEMA_TEXT,
            SchemaOptions {
                discriminator: true,
            },
        )
    })
    .as_ref()
    .map_err(String::as_str)
}

/// The lock schema, prepared once, as `validateLock` compiles it:
/// `new Ajv2020({ allErrors: true, strict: true })`.
///
/// # Errors
///
/// As [`ir_schema`].
pub fn lock_schema() -> Result<&'static Schema, &'static str> {
    static LOCK: OnceLock<Result<Schema, String>> = OnceLock::new();
    LOCK.get_or_init(|| Schema::from_text(LOCK_SCHEMA_TEXT, SchemaOptions::default()))
        .as_ref()
        .map_err(String::as_str)
}

/// The raw errors of the IR schema for `value`, in Ajv's order:
/// `irSchemaErrors` in `compiler/src/ir/validate.ts`.
///
/// # Errors
///
/// As [`ir_schema`].
pub fn ir_schema_errors(value: &Value) -> Result<Vec<SchemaError>, &'static str> {
    ir_schema().map(|s| s.errors(value))
}

/// The raw errors of the lock schema for `value`, in Ajv's order:
/// `lockSchemaErrors` in `compiler/src/lock.ts`.
///
/// # Errors
///
/// As [`ir_schema`].
pub fn lock_schema_errors(value: &Value) -> Result<Vec<SchemaError>, &'static str> {
    lock_schema().map(|s| s.errors(value))
}

/// Deep equality, an object's member order aside (`fast-deep-equal`).
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().all(|(k, p)| y.get(k).is_some_and(|q| same(p, q)))
        }
        _ => a == b,
    }
}

/// One validation: the errors so far and the instance path of the value at
/// hand, which grows and shrinks as the walk goes down and up, and is copied
/// only into an error.
struct Run<'s> {
    schema: &'s Schema,
    errors: Vec<SchemaError>,
    path: String,
}

impl Run<'_> {
    fn error(
        &mut self,
        node: &Node,
        keyword: &'static str,
        params: JsObject,
        message: String,
        name: Option<&str>,
    ) {
        self.errors.push(SchemaError {
            instance_path: self.path.clone(),
            schema_path: format!("{}/{keyword}", node.path),
            keyword,
            params,
            message,
            property_name: name.map(str::to_owned),
        });
    }

    /// Runs `f` with `/<token>` (escaped) added to the instance path.
    fn at_member(&mut self, token: &str, f: impl FnOnce(&mut Self)) {
        let len = self.path.len();
        self.path.push('/');
        for c in token.chars() {
            match c {
                '~' => self.path.push_str("~0"),
                '/' => self.path.push_str("~1"),
                _ => self.path.push(c),
            }
        }
        f(self);
        self.path.truncate(len);
    }

    /// Runs `f` with `/<index>` added to the instance path.
    fn at_index(&mut self, index: usize, f: impl FnOnce(&mut Self)) {
        let len = self.path.len();
        // Writing to a String cannot fail.
        let _ = write!(self.path, "/{index}");
        f(self);
        self.path.truncate(len);
    }

    fn type_error(&mut self, node: &Node, ty: Type, name: Option<&str>) {
        let params = JsObject::new().with("type", ty.name());
        self.error(node, "type", params, format!("must be {}", ty.name()), name);
    }

    /// Validates `data` against node `id`; `name` is the member name a
    /// `propertyNames` subschema is checking, if this is inside one.
    fn eval(&mut self, id: usize, data: &Value, name: Option<&str>) {
        let schema = self.schema;
        let Some(node) = schema.nodes.get(id) else {
            return;
        };
        if let Some(ty) = node.ty
            && node.type_at_once
            && !ty.holds(data)
        {
            self.type_error(node, ty, name);
        }
        // The keywords that apply to any value.
        if let Some(r) = node.reference {
            self.reference(r, data, name);
        }
        if let Some(c) = &node.constant
            && !same(data, c)
        {
            let params = JsObject::new().with("allowedValue", JsValue::from(c));
            self.error(
                node,
                "const",
                params,
                "must be equal to constant".to_owned(),
                name,
            );
        }
        if let Some(allowed) = &node.allowed
            && !allowed.iter().any(|a| same(data, a))
        {
            let values = JsValue::Array(allowed.iter().map(JsValue::from).collect());
            let params = JsObject::new().with("allowedValues", values);
            let message = "must be equal to one of the allowed values".to_owned();
            self.error(node, "enum", params, message, name);
        }
        if let Some(branches) = &node.one_of
            && node.discriminator.is_none()
        {
            self.one_of(node, branches, data, name);
        }
        for group in [Group::Number, Group::String, Group::Array, Group::Object] {
            if !node.uses(group) {
                continue;
            }
            if group.holds(data) {
                match (group, data) {
                    (Group::Number, Value::Number(n)) => self.number(node, *n, name),
                    (Group::String, Value::String(s)) => self.string(node, s, name),
                    (Group::Array, Value::Array(items)) => self.array(node, items, name),
                    (Group::Object, Value::Object(map)) => self.object(node, data, map, name),
                    _ => {}
                }
            } else if let Some(ty) = node.ty
                && !node.type_at_once
                && ty.group() == Some(group)
            {
                self.type_error(node, ty, name);
            }
        }
    }

    fn reference(&mut self, r: Ref, data: &Value, name: Option<&str>) {
        // A target Ajv does not inline is a function of its own, which knows
        // nothing of the propertyNames it is called from.
        let name = if r.inline { name } else { None };
        self.eval(r.target, data, name);
    }

    fn one_of(&mut self, node: &Node, branches: &[usize], data: &Value, name: Option<&str>) {
        let before = self.errors.len();
        let mut valid = false;
        let mut passing = JsValue::Null;
        for (i, &branch) in branches.iter().enumerate() {
            let start = self.errors.len();
            self.eval(branch, data, name);
            let passed = self.errors.len() == start;
            if i > 0 && passed && valid {
                valid = false;
                passing = JsValue::Array(vec![passing, JsValue::from(i)]);
            } else if passed {
                valid = true;
                passing = JsValue::from(i);
            }
        }
        if valid {
            self.errors.truncate(before);
        } else {
            let params = JsObject::new().with("passingSchemas", passing);
            let message = "must match exactly one schema in oneOf".to_owned();
            self.error(node, "oneOf", params, message, name);
        }
    }

    fn number(&mut self, node: &Node, n: Int, name: Option<&str>) {
        if let Some(limit) = node.maximum
            && n > limit
        {
            let params = JsObject::new()
                .with("comparison", "<=")
                .with("limit", limit);
            self.error(node, "maximum", params, format!("must be <= {limit}"), name);
        }
        if let Some(limit) = node.minimum
            && n < limit
        {
            let params = JsObject::new()
                .with("comparison", ">=")
                .with("limit", limit);
            self.error(node, "minimum", params, format!("must be >= {limit}"), name);
        }
    }

    fn string(&mut self, node: &Node, s: &str, name: Option<&str>) {
        // Code points, as `ucs2length` counts them.
        let length = s.chars().count();
        if let Some(limit) = node.max_length
            && length > limit
        {
            let params = JsObject::new().with("limit", limit);
            let message = format!("must NOT have more than {limit} characters");
            self.error(node, "maxLength", params, message, name);
        }
        if let Some(limit) = node.min_length
            && length < limit
        {
            let params = JsObject::new().with("limit", limit);
            let message = format!("must NOT have fewer than {limit} characters");
            self.error(node, "minLength", params, message, name);
        }
        if let Some((pattern, source)) = &node.pattern
            && !pattern.test(s)
        {
            let params = JsObject::new().with("pattern", source.as_str());
            let message = format!("must match pattern \"{source}\"");
            self.error(node, "pattern", params, message, name);
        }
    }

    fn array(&mut self, node: &Node, items: &[Value], name: Option<&str>) {
        if let Some(limit) = node.min_items
            && items.len() < limit
        {
            let params = JsObject::new().with("limit", limit);
            let message = format!("must NOT have fewer than {limit} items");
            self.error(node, "minItems", params, message, name);
        }
        if let Some(sub) = node.items {
            for (i, item) in items.iter().enumerate() {
                self.at_index(i, |run| run.eval(sub, item, name));
            }
        }
        if node.unique_items == Some(true)
            && let Some((i, j)) = Self::unique_items(node.unique_by, items)
        {
            let params = JsObject::new().with("i", i).with("j", j);
            let message =
                format!("must NOT have duplicate items (items ## {j} and {i} are identical)");
            self.error(node, "uniqueItems", params, message, name);
        }
    }

    /// The pair Ajv reports for the first duplicate it finds, as `(i, j)`.
    fn unique_items(by: Option<Type>, items: &[Value]) -> Option<(usize, usize)> {
        if items.len() <= 1 {
            return None;
        }
        match by {
            // loopN: from the end, keyed by the item's text; `j` is the
            // nearest later index with that text. Items of another type are
            // skipped, and `__proto__` is never stored.
            Some(ty) => {
                let mut later: HashMap<String, usize> = HashMap::new();
                for (i, item) in items.iter().enumerate().rev() {
                    if !ty.holds(item) {
                        continue;
                    }
                    let key = JsValue::from(item).to_js_string();
                    if key == "__proto__" {
                        continue;
                    }
                    if let Some(&j) = later.get(&key) {
                        return Some((i, j));
                    }
                    later.insert(key, i);
                }
                None
            }
            // loopN2: the latest `i` that has an equal item before it, and
            // the latest such `j`; deep equality is equality of canonical
            // text.
            None => {
                let mut last: HashMap<String, usize> = HashMap::new();
                let mut found = None;
                for (i, item) in items.iter().enumerate() {
                    if let Some(j) = last.insert(canonicalize(item), i) {
                        found = Some((i, j));
                    }
                }
                found
            }
        }
    }

    fn object(&mut self, node: &Node, data: &Value, map: &Map, name: Option<&str>) {
        if let Some(limit) = node.min_properties
            && map.len() < limit
        {
            let params = JsObject::new().with("limit", limit);
            let message = format!("must NOT have fewer than {limit} properties");
            self.error(node, "minProperties", params, message, name);
        }
        for missing in node.required.iter().flatten() {
            if !map.contains_key(missing) {
                let params = JsObject::new().with("missingProperty", missing.as_str());
                let message = format!("must have required property '{missing}'");
                self.error(node, "required", params, message, name);
            }
        }
        if let Some(sub) = node.property_names {
            for key in map.keys() {
                let start = self.errors.len();
                self.eval(sub, &Value::String(key.to_owned()), Some(key));
                if self.errors.len() != start {
                    let params = JsObject::new().with("propertyName", key);
                    let message = "property name must be valid".to_owned();
                    self.error(node, "propertyNames", params, message, name);
                }
            }
        }
        if let Some(additional) = node.additional {
            let known = |key: &str| node.properties.iter().flatten().any(|(p, _)| p == key);
            for (key, value) in map.iter() {
                if known(key) {
                    continue;
                }
                match additional {
                    Additional::Refused => {
                        let params = JsObject::new().with("additionalProperty", key);
                        let message = "must NOT have additional properties".to_owned();
                        self.error(node, "additionalProperties", params, message, name);
                    }
                    Additional::Schema(sub) => {
                        self.at_member(key, |run| run.eval(sub, value, name));
                    }
                }
            }
        }
        for (prop, sub) in node.properties.iter().flatten() {
            if let Some(value) = map.get(prop) {
                let sub = *sub;
                self.at_member(prop, |run| run.eval(sub, value, name));
            }
        }
        if let Some(d) = &node.discriminator {
            self.discriminator(node, d, data, map, name);
        }
    }

    fn discriminator(
        &mut self,
        node: &Node,
        d: &Discriminator,
        data: &Value,
        map: &Map,
        name: Option<&str>,
    ) {
        let tag = d.tag.as_str();
        let (error, message) = match map.get(tag) {
            Some(Value::String(value)) => {
                let branch = d
                    .mapping
                    .iter()
                    .find(|(v, _)| v == value)
                    .and_then(|(_, i)| node.one_of.as_ref()?.get(*i).copied());
                if let Some(branch) = branch {
                    self.eval(branch, data, name);
                    return;
                }
                (
                    "mapping",
                    format!("value of tag \"{tag}\" must be in oneOf"),
                )
            }
            _ => ("tag", format!("tag \"{tag}\" must be string")),
        };
        let params = JsObject::new()
            .with("error", error)
            .with("tag", tag)
            .with("tagValue", map.get(tag).map(JsValue::from));
        self.error(node, "discriminator", params, message, name);
    }
}
