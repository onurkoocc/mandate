//! The door of language 0.7 that no TypeScript function stands for:
//! `attention_facts` (spec/attention.md "The facts").

use mandate_ir::{JsValue, Value};

use super::DoorError;
use super::input::args;
use crate::check::CheckOptions;

/// The parameters of [`attention_facts`].
pub(super) const ATTENTION_FACTS: &[&str] = &["text", "kind", "opts", "workflow"];

/// `attention_facts`: the attention facts of one workflow of a program of
/// 0.7 ([`crate::attention`]), from the typing of the check that checks it.
///
/// Input: `{ text, kind, opts?, workflow }`, `text`, `kind` and `opts` as the
/// door `check` takes them (`lock`, `modules`, `claim`, `libraries`,
/// `config`; `linked` is read as a boolean and the running program is asked
/// for whatever it says), so that a caller gives both doors one input; and
/// `workflow`, the name of a workflow the program defines.
///
/// Output: `null` when the program does not check, is older than 0.7, or
/// defines no workflow of that name; else the facts, `mandate/attention/0.1`:
///
/// ```json
/// { "format": "mandate/attention/0.1", "workflow": "W", "program": "sha256:…",
///   "stages": [ { "path": "/defs/W/body/0", "name": "collect", "title": "Collect the items", "index": 0 } ],
///   "reports": [ { "path": "/defs/W/body/2", "role": "accountant", "title": "Items collected",
///                  "stage": "collect", "multiplicity": 1,
///                  "fields": [ { "name": "items", "type": "Int", "class": "confidential", "known": "plain" } ] } ] }
/// ```
///
/// Every `path` is in the running program (the expansion, for a workflow
/// that applies a pattern), the path of the statement a run runs.
/// `multiplicity` is an integer or `"unbounded"`, `known` one of `verified`,
/// `plain`, `model`, `external`, `stage` a stage's name or `null`.
///
/// After `reports`, the attention bound ([`crate::asks`], RL4), members
/// added beside those above, which keep their names and meanings:
///
/// ```json
/// { "questions": [ { "path", "wait", "kind", "role", "shown", "known", "deadline_ms",
///                    "on_no_answer", "escalates"?, "stage", "multiplicity", "only" } ],
///   "effects":   [ { "path", "effect", "multiplicity", "counted", "role", "batch", "stage" } ],
///   "totals":    { "questions", "by_role": [ { "role", "questions" } ], "reports": [ { "role", "reports" } ] },
///   "asks":      2,
///   "budget_exceeded": [ <a question, "only": "budget_exceeded"> ],
///   "plans":     [ { "path", "kind": "plan", "role", "shown", "known", "on_no_answer", "stage",
///                    "multiplicity", "from": "asks_left" } ] }
/// ```
///
/// `kind` is one of a closed list, one name for each row of the table of
/// sites ([`crate::asks::SiteKind`]), which the runtime tags every wait it
/// opens with: `verify`, `ask`, `escalate`, `pause`, `supervise_escalate`,
/// `effect`, `changeset`, `governance`, `review`, `plan`. `on_no_answer` is
/// one of `waits`, `unmet`, `escalates` (with `escalates: { to,
/// deadline_ms }`), `declined`, `refused_to_lead`; `only` is `null`,
/// `on_escalation`, `governance_file` or `budget_exceeded`. A count is an
/// integer, or the string `"unbounded"`. `asks` is the declared `asks`, or
/// `null`.
///
/// For a lead's sub-program the runtime passes, at its admission, `text`
/// the sub-program as its check reads it (`opened(sub, parent)`, as JSON,
/// `kind: "json"`), `opts.modules` with its parent under the parent's
/// module (and the modules the parent's check is given), `opts.claim` the
/// claim its check is given (`{ envelope, lead }`), and `workflow` its one
/// workflow: the facts are then of the program it runs as (`running` of
/// `check_subprogram`), with the stages, reports and questions of a listed
/// shape it applies.
pub(super) fn attention_facts(input: &Value) -> Result<JsValue, DoorError> {
    let a = args(input, ATTENTION_FACTS)?;
    let text = a.str("text")?;
    let kind = a.kind("kind")?;
    let workflow = a.str("workflow")?;
    let mut opts = CheckOptions::default();
    let mut libraries = Vec::new();
    let mut config = None;
    if let Some(o) = a.opt_members("opts", "opts.")? {
        opts.lock = o.opt_lock("lock");
        opts.modules = o.opt_modules("modules")?;
        opts.claim = o.opt_object("claim")?;
        libraries = super::library::sources_of(o, "libraries")?;
        config = super::library::config_of(o)?;
        o.opt_bool("linked")?;
    }
    if !libraries.is_empty() {
        opts.libraries = Some(&libraries);
    }
    opts.revoked = config.as_ref().map(mandate_lib::LibrariesConfig::revoked);
    Ok(
        crate::attention::attention_facts(text, kind, &opts, workflow)
            .map_or(JsValue::Null, |f| f.to_js()),
    )
}
