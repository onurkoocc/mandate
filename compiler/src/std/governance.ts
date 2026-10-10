// Governance-class files (K70, item 46). In a target repository, some files
// change what the next run, or the next person, is allowed to do: CI
// workflows decide which checks gate a change, lockfiles decide which code
// is fetched, agent settings decide what an agent may run, the Mandate lock
// pins models and modules, and CODEOWNERS decides who approves. An agent
// that changes one of them can weaken the gate it is being judged by (the
// target repository's G06). So an action that lands or proposes such a file
// needs the code owner's approval, whatever else authorizes it.
//
// The defaults below are the language's: every implementation uses them and
// a program cannot remove one. A component of the system model may add its
// own patterns (`governance "deploy/**"`); a change to them is a system
// model change, itself a governance change.

/** The kinds of governance-class file, in the order views list them. */
export const GOVERNANCE_KINDS = ["ci", "lockfile", "agent_settings", "mandate", "code_owners", "component"] as const;
export type GovernanceKind = (typeof GOVERNANCE_KINDS)[number];

/** The default patterns, by kind. `**` is any number of segments, `*` part of one. */
export const GOVERNANCE_FILES: Readonly<Record<Exclude<GovernanceKind, "component">, readonly string[]>> = {
  ci: [
    ".github/workflows/**",
    ".github/actions/**",
    ".gitlab-ci.yml",
    ".gitlab/**",
    ".circleci/**",
    "**/Jenkinsfile",
    "azure-pipelines.yml",
    ".azure-pipelines/**",
    ".buildkite/**",
    ".travis.yml",
    "bitbucket-pipelines.yml",
    ".drone.yml",
  ],
  lockfile: [
    "**/package-lock.json",
    "**/npm-shrinkwrap.json",
    "**/yarn.lock",
    "**/pnpm-lock.yaml",
    "**/bun.lock",
    "**/bun.lockb",
    "**/poetry.lock",
    "**/uv.lock",
    "**/Pipfile.lock",
    "**/pdm.lock",
    "**/Cargo.lock",
    "**/go.sum",
    "**/Gemfile.lock",
    "**/composer.lock",
    "**/gradle.lockfile",
    "**/packages.lock.json",
    "**/flake.lock",
  ],
  agent_settings: [
    ".claude/**",
    "**/CLAUDE.md",
    "**/CLAUDE.local.md",
    "**/AGENTS.md",
    ".mcp.json",
    ".cursor/**",
    ".cursorrules",
    ".codex/**",
    ".gemini/**",
    "**/GEMINI.md",
    ".github/copilot-instructions.md",
    ".github/instructions/**",
    ".windsurfrules",
  ],
  mandate: ["**/mandate.lock.json", "**/mandate.runtime.json"],
  code_owners: ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"],
};

/** Why `glob` is not a pattern relative to a repository's root, or undefined when it is one. */
export function patternProblem(glob: string): string | undefined {
  if (glob === "") return "it is empty";
  if (/[\\:\0]/.test(glob)) return "it contains `\\`, `:` or NUL";
  if (glob.startsWith("/")) return "it is absolute";
  if (glob.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return "it has an empty, `.` or `..` segment";
  return undefined;
}

/** A glob over `/`-separated paths: `**` any number of segments, `*` within a segment, `?` one character. */
export function globRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      const slash = glob[i + 2] === "/";
      re += slash ? "(?:[^/]+/)*" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const DEFAULTS: Array<[GovernanceKind, RegExp]> = Object.entries(GOVERNANCE_FILES).flatMap(([kind, globs]) => globs.map((g): [GovernanceKind, RegExp] => [kind as GovernanceKind, globRegExp(g)]));

/** The kind of governance-class file `file` is (a path relative to its repository), or undefined. `extra`: a component's own patterns. */
export function governanceKind(file: string, extra: readonly string[] = []): GovernanceKind | undefined {
  for (const [kind, re] of DEFAULTS) if (re.test(file)) return kind;
  return extra.some((g) => globRegExp(g).test(file)) ? "component" : undefined;
}

/** The governance-class files among `files`, sorted, each with its kind. */
export function governanceFiles(files: Iterable<string>, extra: readonly string[] = []): Array<{ file: string; kind: GovernanceKind }> {
  const out: Array<{ file: string; kind: GovernanceKind }> = [];
  for (const file of [...files].sort()) {
    const kind = governanceKind(file, extra);
    if (kind) out.push({ file, kind });
  }
  return out;
}
