//! The closed sets of tags `spec/ir.schema.json` defines, as enums.
//!
//! Each enum lists its values in the schema's order, with the tag's text
//! ([`Language::as_str`]) and the conversion from it ([`Language::from_tag`]);
//! a tag the schema does not have converts to `None`.

/// Defines an enum of tags: each variant with its text, `ALL`, `as_str`,
/// `from_tag` and `from_value`.
macro_rules! tags {
    ($(#[$doc:meta])* $name:ident { $($variant:ident = $tag:literal,)+ }) => {
        $(#[$doc])*
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub enum $name {
            $(
                #[doc = concat!("`", $tag, "`.")]
                $variant,
            )+
        }

        impl $name {
            /// Every value, in the order the schema lists them.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The tag as the IR writes it.
            #[must_use]
            pub const fn as_str(self) -> &'static str {
                match self {
                    $($name::$variant => $tag,)+
                }
            }

            /// The value whose tag is `tag`, if the schema has one.
            #[must_use]
            pub fn from_tag(tag: &str) -> Option<$name> {
                match tag {
                    $($tag => Some($name::$variant),)+
                    _ => None,
                }
            }

            /// The value whose tag `v` is, when it is a string the schema has.
            #[must_use]
            pub fn from_value(v: &crate::Value) -> Option<$name> {
                v.as_str().and_then($name::from_tag)
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }
    };
}

tags! {
    /// A language version: the root `language` of a program
    /// (`LANGUAGE_VERSIONS` in `compiler/src/ir/types.ts`). Versions are
    /// ordered: a later one reads what an earlier one added.
    Language {
        V0_1 = "mandate/0.1",
        V0_2 = "mandate/0.2",
        V0_3 = "mandate/0.3",
        V0_4 = "mandate/0.4",
        V0_5 = "mandate/0.5",
    }
}

impl Language {
    /// The newest version this compiler reads.
    pub const NEWEST: Language = Language::V0_5;

    /// Whether this is `since` or a later version: `atLeast(v, since)`.
    #[must_use]
    pub fn at_least(self, since: Language) -> bool {
        self >= since
    }
}

tags! {
    /// The `kind` of a definition (`$defs/Def`).
    DefKind {
        Type = "type",
        Capability = "capability",
        Const = "const",
        Fn = "fn",
        Extern = "extern",
        Effect = "effect",
        Agent = "agent",
        Workflow = "workflow",
        Contract = "contract",
        Component = "component",
        Interface = "interface",
        Environment = "environment",
        Role = "role",
    }
}

impl DefKind {
    /// The language version that added the kind: `SINCE.kinds` in
    /// `validate.ts`, 0.1 for a kind it does not list.
    #[must_use]
    pub const fn since(self) -> Language {
        match self {
            DefKind::Component | DefKind::Interface | DefKind::Environment => Language::V0_3,
            DefKind::Role => Language::V0_4,
            _ => Language::V0_1,
        }
    }
}

tags! {
    /// The `op` of an expression (`$defs/Expr`).
    ExprOp {
        Int = "int",
        Dec = "dec",
        Text = "text",
        Bool = "bool",
        Money = "money",
        Duration = "duration",
        List = "list",
        Set = "set",
        Template = "template",
        Prompt = "prompt",
        Var = "var",
        Field = "field",
        Call = "call",
        Unary = "unary",
        Binary = "binary",
        Range = "range",
        Record = "record",
        Infer = "infer",
        Delegate = "delegate",
        Spawn = "spawn",
        Await = "await",
        Verify = "verify",
        Effect = "effect",
        Escalate = "escalate",
        Pause = "pause",
        Switch = "switch",
        Try = "try",
        Block = "block",
        Changeset = "changeset",
        Map = "map",
        Plan = "plan",
    }
}

impl ExprOp {
    /// The language version that added the expression: `SINCE.ops` in
    /// `validate.ts`, 0.1 for one it does not list.
    #[must_use]
    pub const fn since(self) -> Language {
        match self {
            ExprOp::Changeset => Language::V0_3,
            ExprOp::Map | ExprOp::Plan => Language::V0_4,
            _ => Language::V0_1,
        }
    }
}

tags! {
    /// The `op` of a statement (`$defs/Stmt`).
    StmtOp {
        Let = "let",
        Par = "par",
        If = "if",
        Loop = "loop",
        Return = "return",
        OnError = "on_error",
        Run = "run",
        Expr = "expr",
    }
}

tags! {
    /// The `p` of a pattern (`$defs/Pattern`).
    PatternKind {
        Wild = "wild",
        Bind = "bind",
        Tag = "tag",
    }
}

tags! {
    /// The `by` of an authorization tier (`$defs/Tier`).
    TierBy {
        Policy = "policy",
        Human = "human",
    }
}

tags! {
    /// A form of type (`$defs/TypeExpr`), named by the member that holds it.
    TypeForm {
        Ref = "ref",
        Record = "record",
        Enum = "enum",
        Union = "union",
        Refine = "refine",
    }
}

tags! {
    /// A form of verifier (`$defs/Verifier`), named by the member that holds it.
    VerifierForm {
        Static = "static",
        Call = "call",
        All = "all",
    }
}

tags! {
    /// A form of a read source's `query` (`$defs/ReadSource`), named by the
    /// member that holds it.
    ReadSource {
        Sql = "sql",
        Logs = "logs",
    }
}

tags! {
    /// A part of a template or a prompt (`$defs/TemplatePart`), named by the
    /// member that holds it.
    TemplatePart {
        Text = "text",
        Expr = "expr",
    }
}

/// The forms that the schema tells apart by which member is present, not
/// by a tag's value.
macro_rules! form_of {
    ($($name:ident),+) => {
        $(
            impl $name {
                /// The form of `v`: the first of [`Self::ALL`] whose member
                /// it has. A value the schema accepts has exactly one.
                #[must_use]
                pub fn of(v: &crate::Value) -> Option<$name> {
                    $name::ALL.iter().copied().find(|f| v.get(f.as_str()).is_some())
                }
            }
        )+
    };
}

form_of!(TypeForm, VerifierForm, ReadSource, TemplatePart);
