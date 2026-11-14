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
