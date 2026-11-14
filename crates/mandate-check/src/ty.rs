//! Checker-side types and the epistemic assignability rules (Doc 4 §5.2):
//! a port of `compiler/src/check/ty.ts`.
//!
//! A value's type carries how it is known. Ordered from most to least
//! trusted:
//!
//! ```text
//! Verified<T, C>  <:  T  <:  Inferred<T>  <:  Untrusted<T>
//! ```
//!
//! - R1: `Inferred<T>` is not a `T` (E0210).
//! - R3: `Verified<T>` can be used wherever `T` is expected.
//! - R4: critical effect parameters take only `T` or `Verified<T>` (E0210,
//!   E0211).
//! - R6: taint is contagious: fields, operators and records built from
//!   `Inferred` parts stay `Inferred` until verified.
//! - E0212: `Verified<T, C>` is accepted only where contract `C` is
//!   expected.
//!
//! [`Ty::Unknown`] stands for a type the checker cannot see (an opaque
//! import, an undescribed std call). It is compatible with everything, so
//! missing knowledge never produces a false error.
//!
//! A record's fields are kept in the order of the object the TypeScript
//! builds (`fields[k] = …` in `fromTypeExpr`): the order of the IR's
//! `record`, which [`mandate_ir::Map`] keeps. One TypeScript quirk is kept
//! with it: `fields["__proto__"] = t` on that plain object sets its
//! prototype and adds no field, so a field named `__proto__` is not one.

use mandate_ir::{TypeExpr, TypeForm, Value, write_json_string};

use crate::path::path_problem;

/// A type as the checker sees it: `Ty`. A named type is boxed, so that a
/// `Ty` is small: the checker's frames hold several each, and the deepest
/// program nests as many frames as the stack allows.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ty {
    /// `{ k: "unknown" }`.
    Unknown,
    /// `{ k: "named", name, args, lit? }`.
    Named(Box<NamedTy>),
    /// `{ k: "record", fields }`, the fields in the order of the object.
    Record {
        /// The fields, by name.
        fields: Vec<(String, Ty)>,
    },
}

/// A named type: `{ k: "named", name, args, lit? }`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamedTy {
    /// The name.
    pub name: String,
    /// The type arguments.
    pub args: Vec<Ty>,
    /// A text literal's value, so that it can stand where a Path is
    /// expected (K68).
    pub lit: Option<String>,
}

/// `UNKNOWN`.
pub const UNKNOWN: Ty = Ty::Unknown;

/// `named(name, ...args)`.
#[must_use]
pub fn named(name: &str, args: Vec<Ty>) -> Ty {
    Ty::named_lit(name, args, None)
}

/// `named(name)`, with no arguments.
#[must_use]
pub fn named0(name: &str) -> Ty {
    named(name, Vec::new())
}

/// `BOOL`.
#[must_use]
pub fn bool_ty() -> Ty {
    named0("Bool")
}

/// `TEXT`.
#[must_use]
pub fn text_ty() -> Ty {
    named0("Text")
}

impl Ty {
    /// `{ k: "named", name, args, lit }`.
    #[must_use]
    pub fn named_lit(name: &str, args: Vec<Ty>, lit: Option<String>) -> Ty {
        Ty::Named(Box::new(NamedTy {
            name: name.to_owned(),
            args,
            lit,
        }))
    }

    /// The name of a named type.
    #[must_use]
    pub fn name(&self) -> Option<&str> {
        match self {
            Ty::Named(n) => Some(&n.name),
            _ => None,
        }
    }

    /// Whether this is the named type `name`: `ty.k === "named" && ty.name === name`.
    #[must_use]
    pub fn is_named(&self, name: &str) -> bool {
        self.name() == Some(name)
    }

    /// The `i`th type argument of a named type, or [`Ty::Unknown`]:
    /// `ty.args[i] ?? UNKNOWN`.
    #[must_use]
    pub fn arg(&self, i: usize) -> Ty {
        match self {
            Ty::Named(n) => n.args.get(i).cloned().unwrap_or(Ty::Unknown),
            _ => Ty::Unknown,
        }
    }

    /// The type arguments of a named type; none for the others.
    #[must_use]
    pub fn args(&self) -> &[Ty] {
        match self {
            Ty::Named(n) => &n.args,
            _ => &[],
        }
    }

    /// `lit` of a named type.
    #[must_use]
    pub fn lit(&self) -> Option<&str> {
        match self {
            Ty::Named(n) => n.lit.as_deref(),
            _ => None,
        }
    }
}

/// How a value is known: `Level`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Level {
    /// `verified`.
    Verified,
    /// `plain`.
    Plain,
    /// `inferred`.
    Inferred,
    /// `untrusted`.
    Untrusted,
}

impl Level {
    /// Every level, in the order of `LEVEL_RANK`'s keys.
    pub const ALL: [Level; 4] = [
        Level::Verified,
        Level::Plain,
        Level::Inferred,
        Level::Untrusted,
    ];

    /// Its name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Level::Verified => "verified",
            Level::Plain => "plain",
            Level::Inferred => "inferred",
            Level::Untrusted => "untrusted",
        }
    }
}

/// `levelRank(l)`: verified 0, plain 1, inferred 2, untrusted 3.
#[must_use]
pub const fn level_rank(l: Level) -> usize {
    match l {
        Level::Verified => 0,
        Level::Plain => 1,
        Level::Inferred => 2,
        Level::Untrusted => 3,
    }
}

/// A type's level, its inner type, and for `Verified<T, C>` the contract:
/// `Epistemic`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Epistemic {
    /// How it is known.
    pub level: Level,
    /// The type inside the wrappers.
    pub inner: Ty,
    /// For `Verified<T, C>`: the contract, when named.
    pub contract: Option<String>,
}

/// Peels `Inferred`, `Untrusted` and `Verified` wrappers; the weakest
/// knowledge wins: `epistemic(ty)`.
#[must_use]
pub fn epistemic(ty: &Ty) -> Epistemic {
    let mut level = Level::Plain;
    let mut contract: Option<String> = None;
    let mut cur = ty;
    let mut saw_verified = false;
    while let Ty::Named(n) = cur {
        let (name, args) = (&n.name, &n.args);
        if name == "Inferred" || name == "Untrusted" {
            let l = if name == "Inferred" {
                Level::Inferred
            } else {
                Level::Untrusted
            };
            if level_rank(l) > level_rank(level) {
                level = l;
            }
            cur = args.first().unwrap_or(&UNKNOWN);
            continue;
        }
        if name == "Verified" {
            saw_verified = true;
            if let Some(Ty::Named(c)) = args.get(1) {
                contract = Some(c.name.clone());
            }
            cur = args.first().unwrap_or(&UNKNOWN);
            continue;
        }
        break;
    }
    if saw_verified && level == Level::Plain {
        level = Level::Verified;
    }
    Epistemic {
        level,
        inner: cur.clone(),
        contract: contract.filter(|_| level == Level::Verified),
    }
}

/// Wraps `inner` at `level`: `withLevel(inner, level, contract?)`. A
/// contract that is the empty string is none, as `contract ?` reads it.
#[must_use]
pub fn with_level(inner: Ty, level: Level, contract: Option<&str>) -> Ty {
    match level {
        Level::Plain => inner,
        Level::Inferred => named("Inferred", vec![inner]),
        Level::Untrusted => named("Untrusted", vec![inner]),
        Level::Verified => match contract.filter(|c| !c.is_empty()) {
            Some(c) => named("Verified", vec![inner, named0(c)]),
            None => named("Verified", vec![inner]),
        },
    }
}

/// The weaker of two levels; verified joined with plain is plain:
/// `joinLevel(a, b)`.
#[must_use]
pub fn join_level(a: Level, b: Level) -> Level {
    let r = level_rank(a).max(level_rank(b)).max(1);
    Level::ALL
        .into_iter()
        .find(|l| level_rank(*l) == r)
        .unwrap_or(Level::Plain)
}

/// A type as messages show it: `show(ty)`.
#[must_use]
pub fn show(ty: &Ty) -> String {
    match ty {
        Ty::Unknown => "?".to_owned(),
        Ty::Named(n) => {
            if n.args.is_empty() {
                n.name.clone()
            } else {
                let args: Vec<String> = n.args.iter().map(show).collect();
                format!("{}<{}>", n.name, args.join(", "))
            }
        }
        Ty::Record { fields } => {
            let fields: Vec<String> = fields
                .iter()
                .map(|(k, v)| format!("{k}: {}", show(v)))
                .collect();
            format!("{{ {} }}", fields.join(", "))
        }
    }
}

/// A type problem: `Problem`, `{ code, message }`, the code without `MDT-`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    /// The code, such as `E0201`.
    pub code: &'static str,
    /// The message.
    pub message: String,
}

/// Looks up local type definitions: `TypeEnv`.
pub trait TypeEnv {
    /// The `type` definition `name`, its value: `typeDef(name)`.
    fn type_def(&self, name: &str) -> Option<&Value>;
    /// Whether `name` is a contract: `isContract(name)`.
    fn is_contract(&self, name: &str) -> bool;
}

/// The generic parameters bound while a type is read: `generics`, a `Map`.
pub type Generics = Vec<(String, Ty)>;

/// The type a type expression stands for: `fromTypeExpr(t, env, generics)`.
#[must_use]
pub fn from_type_expr(t: TypeExpr<'_>, generics: &[(String, Ty)]) -> Ty {
    if t.has(TypeForm::Ref) {
        let r = t.ref_name().unwrap_or_default();
        if r == "?" {
            return Ty::Unknown;
        }
        if let Some((_, g)) = generics.iter().find(|(n, _)| n == r) {
            return g.clone();
        }
        let args = t
            .args()
            .unwrap_or_default()
            .iter()
            .filter_map(TypeExpr::of)
            .map(|a| from_type_expr(a, generics))
            .collect();
        return named(r, args);
    }
    if t.has(TypeForm::Record) {
        let mut fields: Vec<(String, Ty)> = Vec::new();
        for (k, v) in t.record() {
            // `fields["__proto__"] = …` on a plain object sets its prototype.
            if k == "__proto__" {
                continue;
            }
            let Some(v) = TypeExpr::of(v) else { continue };
            fields.push((k.to_owned(), from_type_expr(v, generics)));
        }
        return Ty::Record { fields };
    }
    if t.has(TypeForm::Refine) {
        return t
            .refine()
            .map_or(Ty::Unknown, |r| from_type_expr(r, generics));
    }
    Ty::Unknown
}

/// The type of a type expression with no generics bound:
/// `fromTypeExpr(t, env)`. A missing type expression is unknown.
#[must_use]
pub fn ty_of(t: Option<TypeExpr<'_>>) -> Ty {
    t.map_or(Ty::Unknown, |t| from_type_expr(t, &[]))
}

/// The `type` of a `type` definition, its refinements peeled:
/// `let te = d.type; while ("refine" in te) te = te.refine`.
fn peeled(d: &Value) -> Option<TypeExpr<'_>> {
    let mut te = d.get("type").and_then(TypeExpr::of)?;
    while te.has(TypeForm::Refine) {
        te = te.refine()?;
    }
    Some(te)
}

/// The `type` of a `type` definition, its refinements peeled
/// (`while ("refine" in te) te = te.refine`).
#[must_use]
pub fn peeled_type(d: &Value) -> Option<TypeExpr<'_>> {
    peeled(d)
}

/// The deepest alias chain [`unalias`] follows: `depth > 16` stops it.
pub const UNALIAS_DEPTH: usize = 16;

/// Expands a local alias (`type X = Text`) to what it names; records,
/// enums and unions stay nominal: `unalias(ty, env)`. It follows at most
/// 17 aliases, as `depth > 16` stops it.
#[must_use]
pub fn unalias(ty: &Ty, env: &dyn TypeEnv) -> Ty {
    unalias_at(ty, env, 0)
}

fn unalias_at(ty: &Ty, env: &dyn TypeEnv, depth: usize) -> Ty {
    let Ty::Named(n) = ty else {
        return ty.clone();
    };
    if depth > UNALIAS_DEPTH {
        return ty.clone();
    }
    let Some(d) = env.type_def(&n.name) else {
        return ty.clone();
    };
    // `d.generics` is truthy when it is there, an empty list too.
    if d.get("generics").is_some() {
        return ty.clone();
    }
    match peeled(d) {
        Some(te) if te.has(TypeForm::Ref) => {
            unalias_at(&from_type_expr(te, &[]), env, depth.saturating_add(1))
        }
        _ => ty.clone(),
    }
}

/// The fields of a type, when the checker can see them: `fieldsOf(ty, env)`.
#[must_use]
pub fn fields_of(ty: &Ty, env: &dyn TypeEnv) -> Option<Vec<(String, Ty)>> {
    let u = unalias(ty, env);
    match &u {
        Ty::Record { fields } => Some(fields.clone()),
        Ty::Named(n) => {
            let args = &n.args;
            let d = env.type_def(&n.name)?;
            let te = peeled(d)?;
            if !te.has(TypeForm::Record) {
                return None;
            }
            // `fromTypeExpr(te, …)` of a type with `ref` too is a named
            // type, whose `fields` is undefined.
            if te.has(TypeForm::Ref) {
                return None;
            }
            let mut generics: Generics = Vec::new();
            let names = d
                .get("generics")
                .and_then(Value::as_array)
                .unwrap_or_default();
            for (i, g) in names.iter().enumerate() {
                let Some(g) = g.as_str() else { continue };
                let t = args.get(i).cloned().unwrap_or(Ty::Unknown);
                // `generics.set(g, …)`: a name given again keeps its place.
                match generics.iter_mut().find(|(n, _)| n == g) {
                    Some(slot) => slot.1 = t,
                    None => generics.push((g.to_owned(), t)),
                }
            }
            match from_type_expr(te, &generics) {
                Ty::Record { fields } => Some(fields),
                _ => None,
            }
        }
        Ty::Unknown => None,
    }
}

/// The field `name` of `fields`: `Object.hasOwn(fields, name) ? fields[name] : undefined`.
#[must_use]
pub fn field<'f>(fields: &'f [(String, Ty)], name: &str) -> Option<&'f Ty> {
    fields.iter().find(|(k, _)| k == name).map(|(_, t)| t)
}

/// `NUMERIC_WIDENING[name] ?? []`: the types a named type widens to.
///
/// `NUMERIC_WIDENING` is a plain object, so for a name of a member of
/// `Object.prototype` (`toString`, `constructor`, `__proto__`, …) the
/// TypeScript reads that member, and `.includes` of it throws a
/// `TypeError`: `check` throws. That cannot be a result here; such a name
/// widens to nothing (see the crate's documentation of differences).
fn widens_to(name: &str) -> &'static [&'static str] {
    if name == "Int" { &["Dec"] } else { &[] }
}

/// Can a value of type `actual` be used where `expected` is required?
/// `None` when it can, else the problem: `assignable(actual, expected, env)`.
#[must_use]
pub fn assignable(actual: &Ty, expected: &Ty, env: &dyn TypeEnv) -> Option<Problem> {
    if matches!(actual, Ty::Unknown) || matches!(expected, Ty::Unknown) {
        return None;
    }
    let a = epistemic(actual);
    let e = epistemic(expected);
    if e.level == Level::Verified {
        if a.level != Level::Verified {
            let how = e
                .contract
                .as_deref()
                .map(|c| format!(" against {c}"))
                .unwrap_or_default();
            let code = match a.level {
                Level::Plain => "E0201",
                Level::Inferred => "E0210",
                _ => "E0211",
            };
            return Some(Problem {
                code,
                message: format!(
                    "Expected {} but got {}; verify the value{how} first.",
                    show(expected),
                    show(actual)
                ),
            });
        }
        if let Some(c) = &e.contract
            && a.contract.as_ref() != Some(c)
        {
            return Some(Problem {
                code: "E0212",
                message: format!(
                    "Expected a value verified against {c}, but this one was verified against {}.",
                    a.contract.as_deref().unwrap_or("an unnamed contract")
                ),
            });
        }
    } else if level_rank(a.level) > level_rank(e.level) {
        let (code, what) = if a.level == Level::Inferred {
            ("E0210", "Model output")
        } else {
            ("E0211", "Untrusted content")
        };
        return Some(Problem {
            code,
            message: format!(
                "{what} of type {} cannot be used where {} is expected; verify it first.",
                show(actual),
                show(expected)
            ),
        });
    }
    same_shape(&a.inner, &e.inner, env, actual, expected)
}

fn same_shape(a: &Ty, e: &Ty, env: &dyn TypeEnv, full_a: &Ty, full_e: &Ty) -> Option<Problem> {
    let ua = unalias(a, env);
    let ue = unalias(e, env);
    if matches!(ua, Ty::Unknown) || matches!(ue, Ty::Unknown) {
        return None;
    }
    let mismatch = || Problem {
        code: "E0201",
        message: format!("Expected {} but got {}.", show(full_e), show(full_a)),
    };
    if let (Ty::Named(na), Ty::Named(ne)) = (&ua, &ue) {
        let (an, aa, lit) = (&na.name, &na.args, &na.lit);
        let (en, ea) = (&ne.name, &ne.args);
        // A text literal is a Path where one is expected, if it keeps the Path rule.
        if an == "Text" && en == "Path" {
            if let Some(lit) = lit {
                return path_problem(lit).map(|why| {
                    let mut quoted = String::new();
                    write_json_string(&mut quoted, lit);
                    Problem {
                        code: "E0204",
                        message: format!(
                            "{quoted} is not a Path: {why}. A Path is relative to the working copy's root, with `/` between segments and no `.` or `..` segment."
                        ),
                    }
                });
            }
        }
        if an != en && !widens_to(an).contains(&en.as_str()) {
            return Some(mismatch());
        }
        for (x, y) in aa.iter().zip(ea) {
            if let Some(p) = assignable(x, y, env) {
                return Some(if p.code == "E0201" { mismatch() } else { p });
            }
        }
        return None;
    }
    let fa = fields_of(&ua, env);
    let fe = fields_of(&ue, env);
    if let (Some(fa), Some(fe)) = (fa, fe) {
        for (k, v) in &fe {
            let Some(x) = field(&fa, k) else {
                return Some(mismatch());
            };
            if let Some(p) = assignable(x, v, env) {
                return Some(p);
            }
        }
        return None;
    }
    Some(mismatch())
}

/// The first name of `names` the type mentions anywhere, depth first:
/// `mentions(ty, names)`.
#[must_use]
pub fn mentions<'n>(ty: &Ty, names: &[&'n str]) -> Option<&'n str> {
    match ty {
        Ty::Named(t) => {
            if let Some(n) = names.iter().find(|n| **n == t.name.as_str()) {
                return Some(n);
            }
            t.args.iter().find_map(|a| mentions(a, names))
        }
        Ty::Record { fields } => fields.iter().find_map(|(_, v)| mentions(v, names)),
        Ty::Unknown => None,
    }
}
