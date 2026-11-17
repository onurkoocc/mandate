//! The door of language 0.7 that no TypeScript function stands for, in the
//! views' crate since the attention view is made here: `attention`
//! (spec/attention.md "The attention view").

use mandate_check::CheckOptions;
use mandate_check::json_doors::input::args;
use mandate_check::json_doors::{DoorError, config_of, sources_of};
use mandate_ir::{JsValue, Value};

use crate::attention::{attention_doc, attention_view};
use crate::doc::{to_html, to_markdown};

/// The parameters of [`attention`].
pub(super) const ATTENTION: &[&str] = &["text", "kind", "opts", "workflow", "format"];

/// `attention`: the attention view of one workflow of a program of 0.7
/// ([`crate::attention`]), the fourth view of a program, made from the
/// attention facts and the lock only.
///
/// Input: `{ text, kind, opts?, workflow, format? }`: `text`, `kind`, `opts`
/// and `workflow` as the door `attention_facts` takes them (`opts`: `lock`,
/// `modules`, `claim`, `libraries`, `config`, `linked`, which is read and
/// does not matter, and `std_patterns`, a version of `std.patterns` the compiler
/// embeds, for a caller that holds no lock: with a lock it must be the lock's pin), and `format`, `json` (the default), `md` or `html`.
///
/// Output: `null` when the program does not check, is older than 0.7, or
/// defines no workflow of that name (the cases in which `attention_facts`
/// gives `null`). Else, for `json`, the view,
/// [`crate::attention::AttentionView::to_js`]:
///
/// ```json
/// { "format": "mandate/view/0.1", "kind": "attention", "program": "sha256:…", "workflow": "W",
///   "stages": [ { "name", "title" } ], "lock": true,
///   "bound": { "total", "asks", "left", "declared", "unbounded_because", "leaves_out_plans", "text" },
///   "owner": { "role", "members", "from", "promotion", "text" },
///   "configuration": "…", "uncounted_effects": [ { "effect", "at_most" } ],
///   "questions": [ { "kind", "role", "members", "notified", "class", "shown", "known", "stage",
///                    "only", "effect", "at_most", "unbounded_because", "deadline_ms",
///                    "on_no_answer", "escalates_to", "contract", "criterion", "items",
///                    "waivable", "when", "what", "at_most_text",
///                    "deadline", "if_no_answer" } ],
///   "reports": [ { "role", "stage", "when", "title", "at_most",
///                  "fields": [ { "name", "type", "class", "known", "known_text" } ] } ] }
/// ```
///
/// and for `md` or `html` a string, the document of the view
/// ([`crate::attention::attention_doc`]) as Markdown or as one script-free
/// HTML page. The same input gives the same answer on every run.
pub(super) fn attention(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ATTENTION)?;
    let text = a.str("text")?;
    let kind = a.kind("kind")?;
    let workflow = a.str("workflow")?;
    let format = a.opt_str("format")?.unwrap_or("json");
    if !["json", "md", "html"].contains(&format) {
        return Err(DoorError::bad_input(format!(
            "`format` is \"{format}\", not \"json\", \"md\" or \"html\""
        )));
    }
    let mut opts = CheckOptions::default();
    let mut libraries = Vec::new();
    let mut config = None;
    if let Some(o) = a.opt_members("opts", "opts.")? {
        opts.lock = o.opt_lock("lock");
        opts.modules = o.opt_modules("modules")?;
        opts.claim = o.opt_object("claim")?;
        libraries = sources_of(o, "libraries")?;
        config = config_of(o)?;
        o.opt_bool("linked")?;
        // 0.7: the version of std.patterns a caller that holds no lock
        // names; with a lock it must be the lock's pin (the lock wins, a
        // version that contradicts it is refused), as for the other views.
        let named = o.opt_std_patterns("std_patterns")?;
        opts.std_patterns = mandate_check::library::pin_of(opts.lock, named.as_ref())
            .map_err(|e| DoorError::bad_input(format!("`opts.std_patterns`: {e}")))?
            .filter(|_| named.is_some());
    }
    if !libraries.is_empty() {
        opts.libraries = Some(&libraries);
    }
    opts.revoked = config.as_ref().map(|c| c.revoked());
    Ok(match attention_view(text, kind, &opts, workflow) {
        None => JsValue::Null,
        Some(v) => match format {
            "md" => JsValue::from(to_markdown(&attention_doc(&v)).as_str()),
            "html" => JsValue::from(to_html(&attention_doc(&v)).as_str()),
            _ => v.to_js(),
        },
    })
}
