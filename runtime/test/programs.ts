// Small workflows that put one runtime mechanism at a time under test.

const BASE = `module test.ops @ 0.1
use std.{fs, git, human, model, test}
use company.domain.{Issue, PullRequestDraft}

capability PR       = git.pr("company/backend")
capability ModelStd = model.infer(tier: standard)

agent Worker {
  caps   ModelStd
  budget { tokens: 1k, steps: 5 }
  skill fix(issue: Issue) -> Inferred<Text> ! {Model}
  skill test(issue: Issue) -> Inferred<Text> ! {Model}
}
`;

/** One delegate. */
export const FIX = `${BASE}
workflow Fix(issue: Issue) -> Inferred<Text>
  caps    ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  delegate Worker.fix(issue)
}
`;

/** A delegate, then an external effect. */
export const NOTIFY = `${BASE}
workflow Notify(issue: Issue) -> Bool
  caps    PR, ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  let note = delegate Worker.fix(issue)
  effect git.comment(issue, "fixed")
    idempotent_by issue.id
  true
}
`;

/** An external effect, then a delegate. */
export const FOLLOW = `${BASE}
workflow Follow(issue: Issue) -> Inferred<Text>
  caps    PR, ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  effect git.comment(issue, "fixed")
    idempotent_by issue.id
  delegate Worker.fix(issue)
}
`;

/** Two delegates in parallel; results joined by branch name. */
export const BOTH = `${BASE}
workflow Both(issue: Issue) -> Inferred<Text>
  caps    ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  par {
    tests = delegate Worker.test(issue)
    patch = delegate Worker.fix(issue)
  }
  patch + tests
}
`;

/** An external effect next to a delegate that may fail (fail_fast). */
export const RACE = `${BASE}
workflow Race(issue: Issue) -> Bool
  caps    PR, ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  par {
    comment = effect git.comment(issue, "working on it") idempotent_by issue.id
    patch   = delegate Worker.fix(issue)
  }
  true
}
`;

/** A delegate restarted on Timeout or SkillFailed. */
export const RETRY = `${BASE}
workflow Retry(issue: Issue) -> Inferred<Text>
  caps    ModelStd
  budget  { tokens: 10k, steps: 20 }
{
  delegate Worker.fix(issue) supervise restart(max: 2, backoff: 30s)
}
`;

/** A question to a person. */
export const ASK = `${BASE}
workflow Ask(issue: Issue) -> Untrusted<Text>
  caps    ModelStd
{
  human.ask("Proceed?")
}
`;

export const ISSUE = { issue: { id: "BUG-7", reproducible: true, scope: ["src/a.ts"] } };
