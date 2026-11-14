//! The run-time authority decisions (decision 2 of the plan for 0.6): what
//! a delegation is granted ([`grant`]), what a narrowing with values known
//! only at run time stands for ([`narrow`]), what each item of a `map` is
//! handed and whether two items write the same place ([`map_scopes`]), and
//! whether a map writes where a sub-program in flight may write
//! ([`in_flight_overlap`]). The interpreter of the runtime decides none of
//! these itself: it evaluates, journals, waits and raises, and asks.
//!
//! # The reference
//!
//! The reference is `bridge/src/authority.ts`: its header states the
//! predicates and each function's doc comment its contract, step by step,
//! and where the text and the code differ the code is the reference. Each
//! function here is a port of one there, step for step, over the predicates
//! of [`crate::caps`] ([`cap_covers`], [`scope_within`], [`writes_overlap`],
//! [`show_cap`]), which are the compiler's own; nothing here decides
//! coverage, containment, overlap or display a second time. Three sets of
//! inputs hold the two to each other, each run through the JSON doors of
//! the four (`crate::json_doors`, `grant`, `narrow`, `map_scopes`,
//! `in_flight_overlap`), twice:
//!
//! - `bridge/test/authority-cases.json`: the recorded cases, an input and
//!   the TypeScript's output each, which `bridge/test/authority.test.ts`
//!   holds the TypeScript to and `crates/mandate-check/tests/authority.rs`
//!   this crate, from the one file;
//! - `vectors/authority/cases.json`: generated cases aimed at where a port
//!   goes wrong, which `scripts/authority-vectors.mjs` writes from the built
//!   TypeScript (a seeded generator, so the file is the same each time) and
//!   the same test holds this crate to;
//! - the doors' calls in `crates/mandate-check/tests/json_doors/`
//!   (`inputs.json`, with what the TypeScript gives in `expected.json`,
//!   which `scripts/json-doors-vectors.mjs` writes), held by
//!   `crates/mandate-check/tests/json_doors.rs`, with the inputs outside the
//!   contract, which the doors refuse.
//!
//! # Capabilities
//!
//! A capability is given and taken as a [`Capability`]: the [`CapVal`] that
//! the predicates read, and the object it was written as, which the outputs
//! carry unchanged, every member kept in its order, unknown ones included
//! (a narrowing sets two members of it). What the TypeScript reads by
//! truthiness is read so: `write` (any JSON value; the reader of the doors
//! refuses only `null`), `name` and `via` (an empty one is not shown) and
//! `maxClass` (an empty one is not compared; a name that is no data class
//! ranks below `public`); `tier`, `methods` and `argsPrefix` are read by
//! presence, an empty one included.
//!
//! Nothing is de-duplicated, and every list keeps the order the contract
//! gives it; the one sort, of what [`grant`] grants, is stable, by the
//! UTF-16 code units of the JSON text of each capability's kind and scope.

use std::iter;
use std::slice;

use mandate_ir::{JsObject, JsValue, Value, compare_utf16, write_json_string};

use crate::caps::{CapVal, cap_covers, scope_within, show_cap, writes_overlap};

/// A capability value as the decisions take and give it: a [`CapVal`],
/// which the predicates read, and the object it was written as, which an
/// output carries unchanged.
///
/// The object is the TypeScript's `CapVal` written as JSON, with every
/// member it has, unknown ones included and in their order; the [`CapVal`]
/// is what the predicates read of it (`write` by its truthiness, `maxClass`
/// as any name).
#[derive(Clone, Debug, PartialEq)]
pub struct Capability {
    cap: CapVal,
    js: JsObject,
}

impl Capability {
    /// A capability made in Rust, written as [`CapVal::to_js`] writes it.
    #[must_use]
    pub fn new(cap: CapVal) -> Capability {
        let js = cap.to_js();
        Capability { cap, js }
    }

    /// A capability read from JSON: `cap`, what the predicates read of the
    /// object `js`, which the reader holds to each other.
    #[must_use]
    pub(crate) fn read_as(cap: CapVal, js: JsObject) -> Capability {
        Capability { cap, js }
    }

    /// What the predicates read.
    #[must_use]
    pub fn cap(&self) -> &CapVal {
        &self.cap
    }

    /// The object, as written, every member kept.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        self.js.clone()
    }

    /// Whether it is of the same kind (`ctor`) as `other`.
    fn same_kind(&self, other: &Capability) -> bool {
        self.cap.ctor() == other.cap.ctor()
    }
}

impl From<CapVal> for Capability {
    fn from(cap: CapVal) -> Capability {
        Capability::new(cap)
    }
}

/// A list of capabilities as an array.
fn caps_js(caps: &[Capability]) -> JsValue {
    JsValue::Array(caps.iter().map(|c| JsValue::Object(c.to_js())).collect())
}

/// A list of strings as an array.
fn strings_js(items: &[String]) -> JsValue {
    JsValue::Array(items.iter().map(|s| JsValue::from(s.as_str())).collect())
}

/// A refusal: the fault the interpreter raises, `Fault(tag, args)`, whose
/// message is made from the tag and the arguments alone. [`Refusal::to_js`]
/// gives `{ tag, args }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// [`grant`], step 1: a member of the delegation's own `with caps` that
    /// nothing in force covers. `PolicyDenied`, `[{ reason:
    /// "outside_authority", delegate, capability }]`.
    OutsideAuthority {
        /// The agent's name.
        delegate: String,
        /// The capability refused, as [`show_cap`] shows it.
        capability: String,
    },
    /// [`map_scopes`], step 1: a member of an item's `with caps` that
    /// nothing in force covers. `PolicyDenied`, `[{ reason:
    /// "outside_authority", map, item, capability }]`.
    ItemOutsideAuthority {
        /// The map's path.
        map: String,
        /// The item's index in the map's list.
        item: usize,
        /// The capability refused, as [`show_cap`] shows it.
        capability: String,
    },
    /// [`narrow`]: a value that is not a path a host reads as `within`
    /// does, or a scope that is not inside the base. `PolicyDenied`, `[{
    /// reason: "outside_capability", capability, requested }]`.
    OutsideCapability {
        /// The base, as [`show_cap`] shows it.
        capability: String,
        /// The value refused, or the whole scope.
        requested: Vec<String>,
    },
    /// [`map_scopes`] with `par > 1`: two items that write the same place.
    /// `Rejected`, `["overlapping_scopes", { map, items: [i, j], left,
    /// right }]`.
    OverlappingItems {
        /// The map's path.
        map: String,
        /// The two items, the first one first.
        items: [usize; 2],
        /// The first item's write, as [`show_cap`] shows it.
        left: String,
        /// The second item's write, as [`show_cap`] shows it.
        right: String,
    },
    /// [`in_flight_overlap`]: an item that writes where a sub-program in
    /// flight may write. `Rejected`, `["overlapping_scopes", { map, items:
    /// [i], left, right, program }]`.
    OverlappingProgram {
        /// The map's path.
        map: String,
        /// The item.
        item: usize,
        /// The item's write, as [`show_cap`] shows it.
        left: String,
        /// The sub-program's write, as [`show_cap`] shows it.
        right: String,
        /// The command the sub-program was admitted as.
        program: String,
    },
}

impl Refusal {
    /// The fault's tag: `PolicyDenied` or `Rejected`.
    #[must_use]
    pub const fn tag(&self) -> &'static str {
        match self {
            Refusal::OutsideAuthority { .. }
            | Refusal::ItemOutsideAuthority { .. }
            | Refusal::OutsideCapability { .. } => "PolicyDenied",
            Refusal::OverlappingItems { .. } | Refusal::OverlappingProgram { .. } => "Rejected",
        }
    }

    /// `{ tag, args }`, the TypeScript's `Refusal`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        let args: Vec<JsValue> = match self {
            Refusal::OutsideAuthority {
                delegate,
                capability,
            } => vec![
                JsObject::new()
                    .with("reason", "outside_authority")
                    .with("delegate", delegate.as_str())
                    .with("capability", capability.as_str())
                    .into(),
            ],
            Refusal::ItemOutsideAuthority {
                map,
                item,
                capability,
            } => vec![
                JsObject::new()
                    .with("reason", "outside_authority")
                    .with("map", map.as_str())
                    .with("item", *item)
                    .with("capability", capability.as_str())
                    .into(),
            ],
            Refusal::OutsideCapability {
                capability,
                requested,
            } => vec![
                JsObject::new()
                    .with("reason", "outside_capability")
                    .with("capability", capability.as_str())
                    .with("requested", strings_js(requested))
                    .into(),
            ],
            Refusal::OverlappingItems {
                map,
                items,
                left,
                right,
            } => vec![
                JsValue::from("overlapping_scopes"),
                JsObject::new()
                    .with("map", map.as_str())
                    .with(
                        "items",
                        JsValue::Array(items.iter().map(|i| JsValue::from(*i)).collect()),
                    )
                    .with("left", left.as_str())
                    .with("right", right.as_str())
                    .into(),
            ],
            Refusal::OverlappingProgram {
                map,
                item,
                left,
                right,
                program,
            } => vec![
                JsValue::from("overlapping_scopes"),
                JsObject::new()
                    .with("map", map.as_str())
                    .with("items", JsValue::Array(vec![JsValue::from(*item)]))
                    .with("left", left.as_str())
                    .with("right", right.as_str())
                    .with("program", program.as_str())
                    .into(),
            ],
        };
        JsObject::new()
            .with("tag", self.tag())
            .with("args", JsValue::Array(args))
    }
}

/// Where a command stands, as far as authority goes: `AuthorityContext`.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AuthorityContext {
    /// What the workflow whose body is running holds, in the order it
    /// writes them: its envelope's `caps` (the envelope the command stands
    /// under, for a delegation) or its own.
    pub bounds: Vec<Capability>,
    /// Inside a map's body, each map around the item's `with caps`,
    /// outermost first, as [`map_scopes`] gave them; empty outside a map.
    pub given: Vec<Vec<Capability>>,
    /// Inside a map's body, what the maps around it hand each delegation of
    /// the body, as [`map_scopes`] gave it; empty outside a map.
    pub handed: Vec<Capability>,
}

/// avail(ctx): `bounds`, then for each list of `given` in order, the
/// capabilities of a kind (`ctor`) some member of that list has taken out,
/// and the list appended.
fn available(ctx: &AuthorityContext) -> Vec<&Capability> {
    let mut avail: Vec<&Capability> = ctx.bounds.iter().collect();
    for given in &ctx.given {
        avail.retain(|c| !given.iter().any(|g| g.same_kind(c)));
        avail.extend(given);
    }
    avail
}

/// Whether some member of `avail` covers `c` ([`cap_covers`]).
fn inside(avail: &[&Capability], c: &Capability) -> bool {
    avail.iter().any(|a| cap_covers(&a.cap, &c.cap))
}

/// A delegation [`grant`] decides: `GrantDelegation`.
#[derive(Clone, Debug, PartialEq)]
pub struct GrantDelegation {
    /// The agent's name, named in a refusal.
    pub agent: String,
    /// What the agent declares it holds (its `caps`), in its order.
    pub held: Vec<Capability>,
    /// Whether the agent is remote: a remote agent is handed a map's `with
    /// caps` whatever it holds. Nothing else differs: its `own` and its
    /// `held` are held to the context as any agent's are.
    pub remote: bool,
    /// The delegation's own `with caps`, evaluated (a narrowing at run time
    /// as [`narrow`] gave it), in order.
    pub own: Vec<Capability>,
}

/// What [`grant`] decides: `GrantInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct GrantInput {
    /// The context.
    pub context: AuthorityContext,
    /// The delegation to decide, or `None` (`null`) to ask only what is
    /// available in the context.
    pub delegation: Option<GrantDelegation>,
}

/// What [`grant`] gives: `GrantOutput`.
#[derive(Clone, Debug, PartialEq)]
pub enum GrantOutput {
    /// `{ available }`: what is available in the context, asked without a
    /// delegation.
    Available(Vec<Capability>),
    /// `{ granted }`: what the delegation is granted, sorted.
    Granted(Vec<Capability>),
    /// `{ refused }`.
    Refused(Refusal),
}

impl GrantOutput {
    /// The TypeScript's result object.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        match self {
            GrantOutput::Available(caps) => JsObject::new().with("available", caps_js(caps)),
            GrantOutput::Granted(caps) => JsObject::new().with("granted", caps_js(caps)),
            GrantOutput::Refused(r) => JsObject::new().with("refused", r.to_js()),
        }
    }
}

/// The key [`grant`] sorts by: the JSON text, as `JSON.stringify` writes
/// it, of `{"ctor": c.ctor}`, or of `{"ctor": c.ctor, "scope": c.scope}`
/// when the scope is there, an empty one included.
fn sort_key(c: &CapVal) -> String {
    let mut key = String::from("{\"ctor\":");
    write_json_string(&mut key, c.ctor());
    if let Some(scope) = c.scope() {
        key.push_str(",\"scope\":[");
        for (i, item) in scope.iter().enumerate() {
            if i > 0 {
                key.push(',');
            }
            write_json_string(&mut key, item);
        }
        key.push(']');
    }
    key.push('}');
    key
}

/// What the capabilities in force grant (C2, §9.1; spec/envelope.md
/// "map"): what is available in a context, or what a delegation is granted
/// in it. `grant(input)` of `bridge/src/authority.ts`.
///
/// Without a delegation: [`GrantOutput::Available`], avail(ctx) (`handed`
/// is not read). With one, a capability is inside when some member of
/// avail(ctx) covers it ([`cap_covers`]):
///
/// 1. the first member of `own`, in order, that is not inside is refused
///    ([`Refusal::OutsideAuthority`]);
/// 2. out is the members of `held` that are inside, in their order (inside
///    avail, which inside a map is what the item was given, not `bounds`);
/// 3. given is `own`, then the members of `handed`, in order, of a kind no
///    member of `own` has and that the agent holds at least as widely: it
///    is remote, or some member of `held` covers it;
/// 4. when given is not empty, out is its members of a kind no member of
///    given has, then given;
/// 5. out, sorted stably by [`sort_key`], compared by UTF-16 code units,
///    is [`GrantOutput::Granted`].
///
/// Nothing is de-duplicated, and the capabilities are those of the input,
/// every member kept.
#[must_use]
pub fn grant(input: &GrantInput) -> GrantOutput {
    let avail = available(&input.context);
    let Some(d) = &input.delegation else {
        return GrantOutput::Available(avail.into_iter().cloned().collect());
    };
    if let Some(g) = d.own.iter().find(|g| !inside(&avail, g)) {
        return GrantOutput::Refused(Refusal::OutsideAuthority {
            delegate: d.agent.clone(),
            capability: show_cap(&g.cap),
        });
    }
    let mut out: Vec<&Capability> = d.held.iter().filter(|c| inside(&avail, c)).collect();
    let handed = input.context.handed.iter().filter(|k| {
        !d.own.iter().any(|g| g.same_kind(k))
            && (d.remote || d.held.iter().any(|h| cap_covers(&h.cap, &k.cap)))
    });
    let given: Vec<&Capability> = d.own.iter().chain(handed).collect();
    if !given.is_empty() {
        out.retain(|c| !given.iter().any(|g| g.same_kind(c)));
        out.extend(given);
    }
    let mut keyed: Vec<(String, &Capability)> =
        out.into_iter().map(|c| (sort_key(&c.cap), c)).collect();
    // A stable sort: members with the same key keep their order, as the
    // engine's stable sort keeps them under the TypeScript's comparator.
    keyed.sort_by(|a, b| compare_utf16(&a.0, &b.0));
    GrantOutput::Granted(keyed.into_iter().map(|(_, c)| c.clone()).collect())
}

/// What [`narrow`] decides: `NarrowInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct NarrowInput {
    /// The one capability `c` of `c.narrow(…)`.
    pub base: Capability,
    /// The values of the narrowing's arguments, in order, as the
    /// interpreter evaluated them: a string, a list (whose members are read
    /// one by one) or any other JSON value. While `complete` is false, the
    /// first ones only.
    pub args: Vec<Value>,
    /// Whether `args` holds every argument.
    pub complete: bool,
}

/// What [`narrow`] gives: `NarrowOutput`.
#[derive(Clone, Debug, PartialEq)]
pub enum NarrowOutput {
    /// `{ caps: [n] }`: the narrowed capability.
    Caps(Capability),
    /// `{ partial: true }`: nothing refused so far, with arguments still to
    /// come.
    Partial,
    /// `{ notText: i }`: argument `i` is, or holds, a value that is not a
    /// string.
    NotText(usize),
    /// `{ refused }`.
    Refused(Refusal),
}

impl NarrowOutput {
    /// The TypeScript's result object.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        match self {
            NarrowOutput::Caps(n) => JsObject::new().with("caps", caps_js(slice::from_ref(n))),
            NarrowOutput::Partial => JsObject::new().with("partial", true),
            NarrowOutput::NotText(i) => JsObject::new().with("notText", *i),
            NarrowOutput::Refused(r) => JsObject::new().with("refused", r.to_js()),
        }
    }
}

/// `c.narrow(v…)` with a value known only at run time (C3, K68): c with
/// the scope the values name, held to c. `narrow(input)` of
/// `bridge/src/authority.ts`.
///
/// Each argument i in order, and each item s of it (its members when it is
/// a list, one level only, else the argument itself), in order, the first
/// problem met deciding, where "files" is whether the base's `ctor` starts
/// with `fs.`:
///
/// 1. s not a string: [`NarrowOutput::NotText`] of i (a list inside a list,
///    and `null`, are not strings);
/// 2. files, and s holds `\`, `:` or NUL: refused, with s alone as what was
///    requested;
/// 3. files, s not starting with `/`, and the base has a scope (an empty
///    one included): each item of the base's scope, in order, without its
///    trailing `/`s, then `/`, then s, is added to the scope (nothing under
///    an empty scope); otherwise s is added as it is.
///
/// Then, while the arguments are not complete, [`NarrowOutput::Partial`].
/// When they are: refused with the whole scope when it is not within the
/// base's ([`scope_within`]), else [`NarrowOutput::Caps`] of the base with
/// every member kept, `scope` the scope and `name` the base's `name` (or
/// its `ctor` when it has none; an empty name is kept) and `.narrow`.
#[must_use]
pub fn narrow(input: &NarrowInput) -> NarrowOutput {
    let base = &input.base;
    let files = base.cap.ctor().starts_with("fs.");
    let refused = |requested: Vec<String>| {
        NarrowOutput::Refused(Refusal::OutsideCapability {
            capability: show_cap(&base.cap),
            requested,
        })
    };
    let mut scope: Vec<String> = Vec::new();
    for (i, arg) in input.args.iter().enumerate() {
        let named: &[Value] = match arg {
            Value::Array(items) => items,
            other => slice::from_ref(other),
        };
        for item in named {
            let Value::String(s) = item else {
                return NarrowOutput::NotText(i);
            };
            if files && s.contains(['\\', ':', '\0']) {
                return refused(vec![s.clone()]);
            }
            match base.cap.scope() {
                Some(outer) if files && !s.starts_with('/') => scope.extend(
                    outer
                        .iter()
                        .map(|b| format!("{}/{s}", b.trim_end_matches('/'))),
                ),
                _ => scope.push(s.clone()),
            }
        }
    }
    if !input.complete {
        return NarrowOutput::Partial;
    }
    if !scope_within(base.cap.ctor(), Some(&scope), base.cap.scope()) {
        return refused(scope);
    }
    let name = format!("{}.narrow", base.cap.name().unwrap_or(base.cap.ctor()));
    let js = base
        .js
        .clone()
        .with("scope", strings_js(&scope))
        .with("name", name.as_str());
    let mut cap = base.cap.clone();
    cap.set_scope(Some(scope));
    cap.set_name(Some(name));
    NarrowOutput::Caps(Capability { cap, js })
}

/// What [`map_scopes`] decides: `MapScopesInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct MapScopesInput {
    /// The map's path, named in a refusal.
    pub map: String,
    /// How many items run side by side, at least 1.
    pub par: i64,
    /// The context the map stands in.
    pub context: AuthorityContext,
    /// Each item's `with caps`, evaluated (a narrowing at run time as
    /// [`narrow`] gave it), in the order of the map's list; an empty list
    /// for an item of a map without `with caps`. While `complete` is false,
    /// the first items only.
    pub items: Vec<Vec<Capability>>,
    /// Whether `items` holds every item.
    pub complete: bool,
}

/// What one item of a map stands in, when it is not the map's own context:
/// its context's `given` and `handed`. `ItemScopes`.
#[derive(Clone, Debug, PartialEq)]
pub struct ItemScopes {
    /// The context's `given`, then the item's `with caps`.
    pub given: Vec<Vec<Capability>>,
    /// The context's `handed` of a kind the item's `with caps` does not
    /// name, then the item's `with caps`.
    pub handed: Vec<Capability>,
}

impl ItemScopes {
    /// `{ given, handed }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new()
            .with(
                "given",
                JsValue::Array(self.given.iter().map(Vec::as_slice).map(caps_js).collect()),
            )
            .with("handed", caps_js(&self.handed))
    }
}

/// What [`map_scopes`] gives: `MapScopesOutput`.
#[derive(Clone, Debug, PartialEq)]
pub enum MapScopesOutput {
    /// `{ items, writes }`: each item's scopes (`None`, `null`, for an item
    /// that stands in the map's context) and writes, in the order of the
    /// map's list.
    Scopes {
        /// Each item's scopes.
        items: Vec<Option<ItemScopes>>,
        /// Each item's writes: the members of its `with caps` whose `write`
        /// is truthy, in order.
        writes: Vec<Vec<Capability>>,
    },
    /// `{ partial: true }`: nothing refused so far, with items still to
    /// come.
    Partial,
    /// `{ refused }`.
    Refused(Refusal),
}

impl MapScopesOutput {
    /// The TypeScript's result object.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        match self {
            MapScopesOutput::Scopes { items, writes } => JsObject::new()
                .with(
                    "items",
                    JsValue::Array(
                        items
                            .iter()
                            .map(|s| s.as_ref().map_or(JsValue::Null, |s| s.to_js().into()))
                            .collect(),
                    ),
                )
                .with(
                    "writes",
                    JsValue::Array(writes.iter().map(Vec::as_slice).map(caps_js).collect()),
                ),
            MapScopesOutput::Partial => JsObject::new().with("partial", true),
            MapScopesOutput::Refused(r) => JsObject::new().with("refused", r.to_js()),
        }
    }
}

/// The items of `map x in xs with caps K … { body }` before any is
/// dispatched (spec/envelope.md "map", N03, C5): what each item is handed,
/// whether it lies inside the context, and, with `par > 1`, whether two
/// items write the same place. `mapScopes(input)` of
/// `bridge/src/authority.ts`.
///
/// Each item i in order, with g its `with caps`:
///
/// 1. the first member of g that no member of avail(context) covers is
///    refused ([`Refusal::ItemOutsideAuthority`]); every item given is
///    checked, whether complete or not, the earlier ones again included;
/// 2. its scopes: `None` when g is empty, else the context's `given` with
///    g appended, and the context's `handed` of a kind g does not name,
///    then g;
/// 3. its writes: the members of g whose `write` is truthy.
///
/// Then, while the items are not complete, [`MapScopesOutput::Partial`].
/// When they are and `par > 1`, the first pair, for i ascending, then
/// j > i ascending, then a over item i's writes in order, where some write
/// b of item j overlaps a ([`writes_overlap`], b the first such), is
/// refused ([`Refusal::OverlappingItems`]). Otherwise
/// [`MapScopesOutput::Scopes`].
#[must_use]
pub fn map_scopes(input: &MapScopesInput) -> MapScopesOutput {
    let context = &input.context;
    let outer = available(context);
    let mut items: Vec<Option<ItemScopes>> = Vec::new();
    let mut writes: Vec<Vec<&Capability>> = Vec::new();
    for (i, given) in input.items.iter().enumerate() {
        if let Some(g) = given.iter().find(|g| !inside(&outer, g)) {
            return MapScopesOutput::Refused(Refusal::ItemOutsideAuthority {
                map: input.map.clone(),
                item: i,
                capability: show_cap(&g.cap),
            });
        }
        items.push((!given.is_empty()).then(|| {
            ItemScopes {
                given: context
                    .given
                    .iter()
                    .chain(iter::once(given))
                    .cloned()
                    .collect(),
                handed: context
                    .handed
                    .iter()
                    .filter(|c| !given.iter().any(|g| g.same_kind(c)))
                    .chain(given)
                    .cloned()
                    .collect(),
            }
        }));
        writes.push(given.iter().filter(|c| c.cap.write()).collect());
    }
    if !input.complete {
        return MapScopesOutput::Partial;
    }
    if input.par > 1 {
        for (i, left) in writes.iter().enumerate() {
            for (j, right) in writes.iter().enumerate().skip(i.saturating_add(1)) {
                for a in left {
                    if let Some(b) = right.iter().find(|b| writes_overlap(&a.cap, &b.cap)) {
                        return MapScopesOutput::Refused(Refusal::OverlappingItems {
                            map: input.map.clone(),
                            items: [i, j],
                            left: show_cap(&a.cap),
                            right: show_cap(&b.cap),
                        });
                    }
                }
            }
        }
    }
    MapScopesOutput::Scopes {
        items,
        writes: writes
            .into_iter()
            .map(|w| w.into_iter().cloned().collect())
            .collect(),
    }
}

/// A sub-program in flight, as [`in_flight_overlap`] compares it.
#[derive(Clone, Debug, PartialEq)]
pub struct InFlightProgram {
    /// The command it was admitted as.
    pub command: String,
    /// What its workflow may write: its write capabilities, in order.
    pub writes: Vec<Capability>,
}

/// What [`in_flight_overlap`] decides: `InFlightOverlapInput`.
#[derive(Clone, Debug, PartialEq)]
pub struct InFlightOverlapInput {
    /// The map's path, named in the refusal and compared with each
    /// sub-program's command.
    pub map: String,
    /// Each item's writes, as [`map_scopes`] gave them, in the order of the
    /// map's list.
    pub writes: Vec<Vec<Capability>>,
    /// The sub-programs in flight, in the order the run's journal lists
    /// them.
    pub programs: Vec<InFlightProgram>,
}

/// What [`in_flight_overlap`] gives: `InFlightOverlapOutput`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InFlightOverlapOutput {
    /// The refusal the interpreter raises, or `None` (`null`) when no item
    /// writes where a sub-program may.
    pub overlap: Option<Refusal>,
}

impl InFlightOverlapOutput {
    /// `{ overlap }`.
    #[must_use]
    pub fn to_js(&self) -> JsObject {
        JsObject::new().with(
            "overlap",
            self.overlap
                .as_ref()
                .map_or(JsValue::Null, |r| r.to_js().into()),
        )
    }
}

/// Whether the map at path `map` runs inside the sub-program admitted as
/// `command`: `map` starts with `command` and `/`. A command equal to the
/// path, or a prefix of it not followed by `/`, is not one.
fn runs_inside(map: &str, command: &str) -> bool {
    map.strip_prefix(command)
        .is_some_and(|rest| rest.starts_with('/'))
}

/// C5 across the run, for a map: whether an item writes where a
/// sub-program in flight may write. `inFlightOverlap(input)` of
/// `bridge/src/authority.ts`.
///
/// The sub-program the map runs inside ([`runs_inside`]) is left out. Over
/// the others: the first, for item i in order, then a over its writes in
/// order, then each sub-program p in order, where some write b of p
/// overlaps a ([`writes_overlap`], which reads `write` too; b the first
/// such), is [`Refusal::OverlappingProgram`]; none gives `None`.
#[must_use]
pub fn in_flight_overlap(input: &InFlightOverlapInput) -> InFlightOverlapOutput {
    let programs: Vec<&InFlightProgram> = input
        .programs
        .iter()
        .filter(|p| !runs_inside(&input.map, &p.command))
        .collect();
    for (i, held) in input.writes.iter().enumerate() {
        for a in held {
            for p in &programs {
                if let Some(b) = p.writes.iter().find(|b| writes_overlap(&a.cap, &b.cap)) {
                    return InFlightOverlapOutput {
                        overlap: Some(Refusal::OverlappingProgram {
                            map: input.map.clone(),
                            item: i,
                            left: show_cap(&a.cap),
                            right: show_cap(&b.cap),
                            program: p.command.clone(),
                        }),
                    };
                }
            }
        }
    }
    InFlightOverlapOutput { overlap: None }
}
