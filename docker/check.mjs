#!/usr/bin/env node
// Fails unless the Docker environment of docker/ is what the repository pins and what its secret boundary allows:
//
//   node docker/check.mjs
//
// 1. The Rust channel, components, target and profile of the Dockerfile are those of rust-toolchain.toml.
// 2. The Node releases, the OPA version and its sha256, the PostgreSQL image and the OpenTelemetry Collector image of
//    docker/ are those of .github/workflows/ci.yml (parsed from the two files: no value is repeated here), and each
//    job of docker/run-job.sh uses the Node release the job of the same name uses in ci.yml.
// 3. Statically, with no Docker: compose.yml has no dollar sign, no flow mapping and none of the keys that open a path
//    from the host; every invocation of Docker in scripts/docker-ci.sh is the `dc` wrapper or one of an explicit list
//    of exact forms; the Dockerfile has the one COPY it needs; .dockerignore admits only that.
// 4. With `docker compose` (always on a developer machine and in GitHub Actions; reported as skipped where there is no
//    Docker, such as inside the job container): the compose file as Compose resolves it is judged against an
//    allowlist of top-level keys, and of keys and values of each service. Anything not on the list fails.
// 5. Every step (`run:`) of the rust, test, parity and sandbox jobs of ci.yml is in docker/run-job.sh, in order, except
//    for the steps on the list of known differences below.
//
// No dependency; Node 22 or later. CI runs it in the rust job (.github/workflows/ci.yml). All checks run before
// anything is printed.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const problems = [];
const skipped = [];
const bad = (m) => problems.push(m);
const same = (what, got, want) => {
  if (got === undefined) bad(`${what}: not found`);
  else if (want === undefined) bad(`${what}: the pinned value is not found in the workflow`);
  else if (got !== want) bad(`${what}: docker/ has ${JSON.stringify(got)}, the repository pins ${JSON.stringify(want)}`);
};

const toolchain = read("rust-toolchain.toml");
const ci = read(".github/workflows/ci.yml");
const dockerfile = read("docker/Dockerfile");
const compose = read("docker/compose.yml");
const script = read("scripts/docker-ci.sh");
const runJob = read("docker/run-job.sh");

// ── what a file says, without its comments ──────────────────────────────

/** A YAML or Dockerfile text without comments (a `#` at the start of a line or after a space). */
const yamlCode = (t) => t.split("\n").map((l) => l.replace(/(^|\s)#.*$/, "")).join("\n");
/** A shell text without whole-line comments. */
const shellCode = (t) => t.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const composeCode = yamlCode(compose);
const dockerCode = yamlCode(dockerfile);
const scriptCode = shellCode(script);

/** The lines under a key (deeper indented than the key's line), for each occurrence of the pattern. */
function blocks(text, pattern) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(pattern);
    if (!m) continue;
    const indent = lines[i].match(/^\s*/)[0].length;
    const body = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (lines[j].match(/^\s*/)[0].length <= indent) break;
      body.push(lines[j]);
    }
    out.push({ head: lines[i], body });
  }
  return out;
}

// ── 1. Rust ─────────────────────────────────────────────────────────────

const tomlString = (key) => toolchain.match(new RegExp(`^${key}\\s*=\\s*"([^"]*)"`, "m"))?.[1];
const tomlList = (key) => {
  const m = toolchain.match(new RegExp(`^${key}\\s*=\\s*\\[([^\\]]*)\\]`, "m"));
  return m ? [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]).sort() : undefined;
};
const dockerArg = (name) => dockerfile.match(new RegExp(`^ARG ${name}=(?:"([^"]*)"|(\\S*))\\s*$`, "m"))?.slice(1).find((x) => x !== undefined);

same("Rust channel (RUST_CHANNEL)", dockerArg("RUST_CHANNEL"), tomlString("channel"));
same("Rust profile (RUST_PROFILE)", dockerArg("RUST_PROFILE"), tomlString("profile"));
same("Rust components (RUST_COMPONENTS)", JSON.stringify((dockerArg("RUST_COMPONENTS") ?? "").split(/\s+/).filter(Boolean).sort()), JSON.stringify(tomlList("components")));
same("Rust targets (RUST_TARGET)", JSON.stringify((dockerArg("RUST_TARGET") ?? "").split(/\s+/).filter(Boolean).sort()), JSON.stringify(tomlList("targets")));

// ── 2. Node, OPA, PostgreSQL, the collector ─────────────────────────────

/** The text of each job of ci.yml, by name. */
const jobs = {};
{
  let name;
  let inJobs = false;
  for (const line of ci.split("\n")) {
    if (/^jobs:\s*$/.test(line)) inJobs = true;
    else if (/^\S/.test(line)) inJobs = false;
    const m = inJobs && line.match(/^  ([A-Za-z0-9_-]+):\s*$/);
    if (m) {
      name = m[1];
      jobs[name] = "";
    } else if (name && inJobs) jobs[name] += `${line}\n`;
  }
}
for (const job of ["test", "rust", "parity", "sandbox"]) {
  const text = jobs[job];
  if (text === undefined) {
    bad(`.github/workflows/ci.yml has no job ${job}`);
    continue;
  }
  const version = text.match(/node-version:\s*"?([0-9][^"\s]*)"?/)?.[1];
  const major = version?.split(".")[0];
  same(`Node of the ${job} job (NODE${major}_VERSION)`, major && dockerArg(`NODE${major}_VERSION`), version);
  const uses = runJob.match(new RegExp(`^job_${job}\\(\\) \\{\\s*\\n\\s*use_node (\\d+)`, "m"))?.[1];
  same(`Node release the ${job} job of docker/run-job.sh uses`, uses, major);
}
if (!/node docker\/check\.mjs/.test(jobs["rust"] ?? "")) bad("the rust job of ci.yml does not run `node docker/check.mjs`");

const ciOpaVersion = ci.match(/OPA_VERSION:\s*"?([0-9][^"\s]*)"?/)?.[1];
const ciOpaSha = ci.match(/OPA_SHA256:\s*"?([0-9a-f]{64})"?/)?.[1];
same("OPA version (OPA_VERSION)", dockerArg("OPA_VERSION"), ciOpaVersion);
same("OPA sha256 (OPA_SHA256)", dockerArg("OPA_SHA256"), ciOpaSha);

const imageOf = (text, prefix) => text.match(new RegExp(`^\\s*(?:-\\s*)?(?:image:|COLLECTOR_IMAGE:)\\s*(${prefix}\\S+)`, "m"))?.[1];
same("PostgreSQL image", imageOf(composeCode, "postgres:"), imageOf(ci, "postgres:"));
same("OpenTelemetry Collector image", imageOf(composeCode, "ghcr\\.io/open-telemetry/"), imageOf(ci, "ghcr\\.io/open-telemetry/"));
for (const key of ["POSTGRES_USER", "POSTGRES_DB"]) {
  same(`${key}`, composeCode.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1], ci.match(new RegExp(`${key}:\\s*(\\S+)`))?.[1]);
}

// Every download and base image is pinned, and every checksum is a sha256.
if (!/^FROM \S+@sha256:[0-9a-f]{64}\s*$/m.test(dockerfile)) bad("the Dockerfile's FROM is not pinned by a sha256 digest");
for (const name of ["NODE22_SHA256", "NODE24_SHA256", "OPA_SHA256", "RUSTUP_INIT_SHA256"]) {
  if (!/^[0-9a-f]{64}$/.test(dockerArg(name) ?? "")) bad(`${name} in the Dockerfile is not a sha256`);
}
for (const m of composeCode.matchAll(/^\s*image:\s*(\S+)/gm)) {
  if (m[1] !== "mandate-ci-runner:local" && !/@sha256:[0-9a-f]{64}$/.test(m[1])) bad(`the image ${m[1]} in compose.yml is not pinned by digest`);
}

// ── 3. the secret boundary, statically ──────────────────────────────────

// compose.yml: nothing is computed in it, and no key that opens a path from the host is in it.
if (/\$/.test(compose)) bad("docker/compose.yml contains a dollar sign: it interpolates nothing (not even in a comment)");
if (/[{}]/.test(composeCode)) bad("docker/compose.yml contains a { or }: flow mappings are not allowed");
const deniedKeys = [
  "env_file", "extends", "include", "secrets", "configs", "ssh", "privileged", "pid", "network_mode", "cgroup", "cgroup_parent",
  "cgroupns_mode", "uts", "ipc", "userns_mode", "ports", "expose", "device_cgroup_rules", "cap_add", "driver", "driver_opts", "bind",
  "type", "volumes_from", "extra_hosts", "sysctls", "external", "additional_contexts", "args", "host", "links", "label", "labels",
  "entrypoint", "command", "devices_from", "oom_kill_disable", "security_opt_extra",
];
for (const key of deniedKeys) if (new RegExp(`\\b${key}\\b`, "i").test(composeCode)) bad(`docker/compose.yml mentions ${key}: not allowed in this file`);
if (/^[ \t]+build[ \t]*:[ \t]*\S/m.test(composeCode)) bad("docker/compose.yml has an inline build: write the block with context and dockerfile");
if (/^[ \t]+environment[ \t]*:[ \t]*\S/m.test(composeCode)) bad("docker/compose.yml has an inline environment (a list can name a variable of the host): write the mapping with a value for each");
for (const { body } of blocks(composeCode, /^\s+environment\s*:\s*$/)) {
  for (const l of body) if (!/^\s*[A-Za-z_][A-Za-z0-9_]*\s*:\s*\S/.test(l)) bad(`docker/compose.yml passes a variable of the host through, or has an entry this check cannot read: ${l.trim()}`);
}
for (const { body } of blocks(composeCode, /^\s+build\s*:\s*$/)) {
  for (const l of body) {
    const key = l.trim().match(/^([A-Za-z_]+)\s*:/)?.[1];
    if (key !== "context" && key !== "dockerfile") bad(`docker/compose.yml has the build key ${key ?? l.trim()}: only context and dockerfile are allowed`);
  }
}
if ((composeCode.match(/^\s+context\s*:/gm) ?? []).length !== 1 || !/^\s+context:\s*\.\s*$/m.test(composeCode)) bad("the build context in compose.yml is not exactly one context, `.` (docker/)");
for (const m of composeCode.matchAll(/\bdevices\s*:\s*\[([^\]]*)\]/g)) {
  for (const d of m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)) if (!/^\/dev\/net\/tun(:\/dev\/net\/tun)?$/.test(d)) bad(`compose.yml gives a container the device ${d}: only /dev/net/tun is allowed`);
}
if (/^[ \t]*devices[ \t]*:[ \t]*$/m.test(composeCode)) bad("compose.yml has a devices list in a form this check cannot read: write it as a flow list");
// Volumes: the named ones of the top-level `volumes:`, each without a key under it; mounts of services are `name:/path`.
const volumeNames = new Set();
for (const { body } of blocks(composeCode, /^volumes\s*:\s*$/)) {
  for (const l of body) {
    const m = l.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (m) volumeNames.add(m[1]);
    else bad(`docker/compose.yml has a top-level volume with a setting, or an entry this check cannot read: ${l.trim()}`);
  }
}
for (const { body } of blocks(composeCode, /^\s+volumes\s*:\s*$/)) {
  for (const l of body) {
    const entry = l.match(/^\s*-\s*(.*)$/)?.[1];
    const short = entry?.match(/^([^\s:]+):(\/[^:\s]*)(?::ro)?$/);
    if (!short) bad(`compose.yml has a volumes entry this check cannot read: ${l.trim()}`);
    else if (!volumeNames.has(short[1])) bad(`compose.yml mounts ${short[1]}, which is not a named volume of its top-level volumes`);
  }
}

// scripts/docker-ci.sh. Whatever reaches Docker or feeds a container is pinned: every logical line (continuation lines
// joined, whitespace normalised) that calls docker, dc, dcp or pack_of_commit, uses eval or source, pipes into a shell, or
// runs a variable as a command must be one of the lines below, exactly. Changing an invocation, or adding one, is
// therefore a visible change of this list. Every other line is scanned for the flags that open a path from the host.
const PINNED = [
  'command -v docker >/dev/null 2>&1 || die "Docker is not on the PATH"',
  'dc() { docker compose --project-directory "$dd" --env-file "$dd/empty.env" -f "$dd/compose.yml" "$@"; }',
  'dcp() { docker compose --project-directory "$dd" --env-file "$dd/empty.env" -f "$dd/compose.yml" -f "$1" "${@:2}"; }',
  `control_loads_dotenv() { ( cd "$tmp" && docker compose --project-directory "$ntmp" --profile run -f "$dd/compose.yml" -f "$ntmp/probe.yml" config 2>/dev/null | grep -q 'made-up-plain-words' ); }`,
  'insp() { docker inspect --format "$2" "$1"; }',
  'rm_container() { docker rm -f "$1" >/dev/null 2>&1; }',
  'container_of() { docker ps -aq --filter "name=^$1\\$"; }',
  'pack_of_commit() { git --no-replace-objects -C "$root_native" rev-list --objects --no-walk "$1" | git --no-replace-objects -C "$root_native" pack-objects --stdout -q; }',
  '( set -o pipefail; pack_of_commit "$sha" | dc --profile run run --rm -T --no-deps --name "$job_container" "${envs[@]}" "$service" bash /usr/local/lib/mandate-ci/boot.sh "$jobname" "$sha" "$@" ) &',
  'pack_of_commit "$sha" | docker exec -i -e "MANDATE_CI_IMAGE=$image_digest" -e "MANDATE_CI_STEPS=$steps_digest" "$1" bash /usr/local/lib/mandate-ci/boot.sh selfcheck "$sha"',
  'if ! dc --profile run build runner >"$log" 2>&1; then',
  'dc --profile run build runner',
  'dc --profile run --profile services down -v --remove-orphans',
  'if [ -n "$(container_of "mandate-ci-job-$pid")" ]; then return 1; fi',
  'dc --profile services rm -sfv postgres otel-collector >/dev/null 2>&1 || true',
  'git -C "$root_native" cat-file blob "$sha:runtime/test/otel-collector.yaml" | dc --profile run run --rm -T --no-deps runner sh -c \'cat > /otel/config/config.yaml && rm -f /otel/out/spans.json\' || return 1',
  'dc --profile services up -d --wait postgres otel-collector || rc=$?',
  'dc --profile services logs --no-color --tail 40 otel-collector 2>&1 || true',
  'dc --profile run run --rm -T --no-deps runner sh -c \'ls -l /otel/out; head -c 2000 /otel/out/spans.json\' 2>&1 || true',
  'cid="$(dc --profile run run -d -T --no-deps runner sleep 900 | tail -n 1)" || die "could not start the runner container"',
  'cid2="$(dc --profile run run -d -T --no-deps runner-sandbox sleep 900 | tail -n 1)" || die "could not start the sandbox container"',
  `out="$(cd "$tmp" && dcp "$ntmp/probe.yml" --profile run run --rm -T --no-deps runner sh -c 'printenv DECOY_PROBE; env | cut -d= -f1 | grep -c "^MANDATE_DECOY" || true' 2>/dev/null)"`,
  `out="$(MANDATE_DECOY_HOST=made-up-plain-words dc --profile run run --rm -T --no-deps runner sh -c 'env | cut -d= -f1 | grep -c "^MANDATE_DECOY" || true' 2>&1 | tail -n 1)"`,
];
const norm = (s) => s.replace(/\s+/g, " ").trim();
const unquote = (s) => s.replace(/""|''/g, "");
/** The lines of the script as the shell reads them: a line that ends in a pipe, && or a backslash goes on in the next. */
const logicalLines = (() => {
  const out = [];
  let cur = "";
  for (const l of scriptCode.split("\n")) {
    cur = cur === "" ? l.trim() : `${cur} ${l.trim()}`;
    if (/(\|\||\||&&|\\)$/.test(cur)) {
      cur = cur.replace(/\\$/, "");
      continue;
    }
    out.push(norm(cur));
    cur = "";
  }
  if (cur !== "") out.push(norm(cur));
  return out;
})();
/**
 * Whether a command word of the line, outside quotes or inside a $( ) substitution, starts with $ (a variable run as a
 * command: d=docker; "$d" cp ...). A small reader of shell words, not a parser.
 */
function variableAsCommand(line) {
  const KEEP = new Set(["if", "then", "else", "elif", "while", "until", "do", "!", "time"]);
  const closing = (s, from) => {
    // the index of the ) that closes the ( before from, skipping quoted text
    let depth = 1;
    for (let i = from; i < s.length; i++) {
      const c = s[i];
      if (c === "'") i = s.indexOf("'", i + 1) < 0 ? s.length : s.indexOf("'", i + 1);
      else if (c === '"') {
        for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
      } else if (c === "\\") i++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) return i;
    }
    return s.length;
  };
  /** The command substitutions $( ... ) inside a text that is not itself a command line (an array literal, an arithmetic expression). */
  const substitutions = (s) => {
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "$" && s[i + 1] === "(" && s[i + 2] !== "(") {
        const e = closing(s, i + 2);
        if (scan(s.slice(i + 2, e))) return true;
        i = e;
      }
    }
    return false;
  };
  const scan = (s) => {
    let i = 0;
    let cmd = true;
    while (i < s.length) {
      const c = s[i];
      if (c === " " || c === "\t") {
        i++;
        continue;
      }
      if ("|;&(){}".includes(c)) {
        cmd = true;
        i++;
        continue;
      }
      let word = "";
      const start = i;
      while (i < s.length && !" \t|;&(){}".includes(s[i])) {
        if (s[i] === "\\") {
          word += s.slice(i, i + 2);
          i += 2;
        } else if (s[i] === "'") {
          const e = s.indexOf("'", i + 1) < 0 ? s.length : s.indexOf("'", i + 1);
          word += s.slice(i, e + 1);
          i = e + 1;
        } else if (s[i] === '"') {
          i++;
          word += '"';
          while (i < s.length && s[i] !== '"') {
            if (s[i] === "\\") {
              word += s.slice(i, i + 2);
              i += 2;
            } else if (s[i] === "$" && s[i + 1] === "(") {
              const e = closing(s, i + 2);
              if (scan(s.slice(i + 2, e))) return true;
              word += s.slice(i, e + 1);
              i = e + 1;
            } else word += s[i++];
          }
          word += '"';
          i++;
        } else if (s[i] === "$" && s[i + 1] === "(" && s[i + 2] === "(") {
          // arithmetic: $(( ... )), whose substitutions are commands
          const e = closing(s, i + 2);
          if (substitutions(s.slice(i + 3, e))) return true;
          word += s.slice(i, e + 1);
          i = e + 1;
        } else if (s[i] === "$" && s[i + 1] === "(") {
          const e = closing(s, i + 2);
          if (scan(s.slice(i + 2, e))) return true;
          word += s.slice(i, e + 1);
          i = e + 1;
        } else word += s[i++];
      }
      if (i === start) i++;
      if (/\+?=$/.test(word) && s[i] === "(") {
        // an array literal: its words are arguments, its substitutions are commands
        const e = closing(s, i + 1);
        if (substitutions(s.slice(i + 1, e))) return true;
        i = e + 1;
        continue;
      }
      if (cmd && /^"?\$/.test(word)) return true;
      if (/^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/.test(word) || KEEP.has(word)) continue;
      cmd = false;
    }
    return false;
  };
  return scan(line);
}
const sensitive = (l) => {
  const t = unquote(l);
  return (
    /(^|[^\w./$-])(docker|dc|dcp|pack_of_commit)(?![\w./-])/.test(t) ||
    /(^|[^\w.-])(eval|source)(?![\w.-])/.test(t) ||
    variableAsCommand(t) ||
    /\x60/.test(t) ||
    /\b(command|env|exec|builtin|nohup|xargs|sudo|time|nice)\s+"?\$/.test(t) ||
    /\|\s*(ba|z|da)?sh\b/.test(t)
  );
};
const pinned = new Set(PINNED.map(norm));
let firstSensitive = -1;
logicalLines.forEach((l, i) => {
  if (!sensitive(l)) return;
  if (firstSensitive < 0) firstSensitive = i;
  if (!pinned.has(l)) bad(`scripts/docker-ci.sh: this line reaches Docker or feeds a container and is not one of the lines pinned in docker/check.mjs: ${l}`);
});
if (/(^|[^\w.-])eval(?![\w.-])/.test(unquote(scriptCode))) bad("scripts/docker-ci.sh uses eval");
{
  const unset = logicalLines.indexOf(`for v in $(compgen -e | grep '^COMPOSE_' || true); do unset "$v"; done`);
  if (unset < 0) bad("scripts/docker-ci.sh does not unset the COMPOSE_* variables of the host (the exact loop is required)");
  else if (firstSensitive >= 0 && unset > firstSensitive) bad("scripts/docker-ci.sh unsets the COMPOSE_* variables after a line that reaches Docker");
  for (const need of ['docker_dir="$root/docker"', 'dd="$(native "$docker_dir")"']) if (!logicalLines.includes(need)) bad(`scripts/docker-ci.sh does not have the line ${need}`);
}
// Flags that open a path from the host, in any line that is not pinned (an array of flags built elsewhere and expanded in a
// pinned line is caught here), and the rule for -e: NAME=value with a literal or one of the script's own variables.
const benignForms = ["command -v", "compgen -e", "cat-file -e", "grep -v", "set -u", "set -o pipefail"];
const testOperators = new Set(["-eq", "-ne", "-ge", "-gt", "-le", "-lt"]);
const bannedShort = /^-[vupw]/; // alone or with its value glued on: -v"$x:/y", -u0, -w/tmp
const bannedLong = /^(--volume|--mount|--volumes-from|--env-file|--env-from-file|--user|--entrypoint|--privileged|--cap-add|--device|--security-opt|--add-host|--userns|--cgroupns|--network|--net|--pid|--ipc|--uts|--publish|--add-file|--workdir)(=.*)?$/;
const okEnvValue = (v) => /^[A-Za-z_][A-Za-z0-9_]*=(\$\{?(image_digest|steps_digest|MANDATE_CI_NODE)\}?|[A-Za-z0-9._:/-]*)$/.test(v.replace(/^["']+|["')]+$/g, ""));
for (const l of logicalLines) {
  let line = unquote(l);
  for (const b of benignForms) line = line.replaceAll(b, b.split(" ")[0]);
  const words = line.split(/\s+/).map((x) => x.replace(/^[("']+/, ""));
  words.forEach((w0, i) => {
    const w = w0.replace(/[)"']+$/, "");
    if (/^-e/.test(w) && !testOperators.has(w)) {
      // -e NAME=value, or -eNAME=value, or -e"NAME=value": the value is read whichever way it is written
      const value = w.length > 2 ? w0.slice(2) : (words[i + 1] ?? "");
      if (!okEnvValue(value)) bad(`scripts/docker-ci.sh passes -e with a value that is not NAME=literal or NAME=one of the script's own variables (image_digest, steps_digest, MANDATE_CI_NODE): ${l}`);
    } else if (w === "--env" || /^--env=/.test(w)) {
      const value = w === "--env" ? (words[i + 1] ?? "") : w0.slice(6);
      if (!okEnvValue(value)) bad(`scripts/docker-ci.sh passes --env with a value that is not NAME=literal or NAME=one of the script's own variables: ${l}`);
    } else if (!pinned.has(l) && (bannedShort.test(w) || bannedLong.test(w))) {
      bad(`scripts/docker-ci.sh has the flag ${w} (a mount, a user, an entrypoint, a privilege, a host namespace, an extra file or an env file; a short one with its value glued on too), which is not allowed outside the pinned lines: ${l}`);
    }
  });
}
// No dotenv file: in the script only empty.env and the decoy the selfcheck makes in a temporary directory.
for (const line of logicalLines) {
  if (/\.env\b/.test(line.replaceAll("empty.env", "").replaceAll('"$tmp/.env"', ""))) bad(`scripts/docker-ci.sh mentions a dotenv file: ${line}`);
}

if (/\.env\b/.test(composeCode) || /\.env\b/.test(dockerCode)) bad("compose.yml or the Dockerfile mentions a dotenv file");
if (/docker[.]sock|\/var\/run\/docker|\/run\/docker/.test(composeCode + dockerCode + scriptCode)) bad("compose.yml, the Dockerfile or the script mentions the Docker socket");
if (!existsSync(join(root, "docker/empty.env"))) bad("docker/empty.env is missing");
else if (statSync(join(root, "docker/empty.env")).size !== 0) bad("docker/empty.env is not empty");

// The Dockerfile: one COPY, the last instruction but the user, of the four files the image needs; nothing that takes a
// secret or a host file.
const dockerInstructions = dockerCode.split("\n").filter((l) => l.trim() !== "");
const copies = dockerInstructions.filter((l) => /^\s*COPY\b/i.test(l));
if (copies.length !== 1 || !/^COPY --chmod=0755 Dockerfile \.dockerignore boot\.sh run-job\.sh \/usr\/local\/lib\/mandate-ci\/$/.test(copies[0].trim())) bad(`the Dockerfile must have exactly one COPY, of Dockerfile, .dockerignore, boot.sh and run-job.sh; it has: ${copies.map((c) => c.trim()).join(" | ") || "none"}`);
if (dockerInstructions.at(-2)?.trim().startsWith("COPY") !== true || dockerInstructions.at(-1)?.trim() !== "USER ci") bad("the Dockerfile's COPY must come last (before USER ci), after the strip of setuid bits, so that a rebuild for other scripts changes nothing before it");
if (!dockerInstructions.some((l) => /find \/ -xdev .*-perm -4000/.test(l) || /-exec chmod a-s/.test(l))) bad("the Dockerfile does not strip the setuid and setgid bits");
if (/^\s*ADD\b/im.test(dockerCode)) bad("the Dockerfile has an ADD");
if (/--mount\b|--secret\b|--ssh\b|--network\b|--from\b/.test(dockerCode)) bad("the Dockerfile has a --mount, --secret, --ssh, --network or --from");
for (const l of dockerCode.split("\n")) {
  const m = l.match(/^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/);
  if (m && (m[2] === undefined || m[2].trim().replace(/^["']|["']$/g, "") === "")) bad(`the Dockerfile has ARG ${m[1]} without a default (it would take a value from the build command)`);
}
for (const l of dockerCode.split("\n")) if (/^\s*(VOLUME|ENTRYPOINT|HEALTHCHECK|ONBUILD)\b/i.test(l)) bad(`the Dockerfile has an instruction this check does not allow: ${l.trim()}`);
// .dockerignore: everything is ignored but the files the COPY names.
{
  const ignore = existsSync(join(root, "docker/.dockerignore")) ? read("docker/.dockerignore").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")) : undefined;
  const want = ["*", "!Dockerfile", "!.dockerignore", "!boot.sh", "!run-job.sh"];
  if (!ignore) bad("docker/.dockerignore is missing");
  else if (JSON.stringify(ignore) !== JSON.stringify(want)) bad(`docker/.dockerignore must be exactly ${want.join(", ")} (the files the COPY names); it is: ${ignore.join(" ")}`);
}

// ── 4. the compose file as Compose resolves it ──────────────────────────

function checkModel(m) {
  const norm = (p) => String(p).replaceAll("\\", "/").toLowerCase();
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const only = (what, obj, allowed) => {
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) bad(`resolved model: ${what} has the key ${k}, which is not on the allowlist`);
  };
  only("the top level", m, ["name", "networks", "services", "volumes", "x-runner"]);
  if (m.name !== "mandate-ci") bad(`resolved model: the project name is ${m.name}, not mandate-ci`);
  const nets = m.networks ?? {};
  if (!eq(Object.keys(nets), ["default"]) || !eq(Object.keys(nets.default ?? {}).sort(), ["ipam", "name"]) || nets.default.name !== "mandate-ci_default" || !eq(nets.default.ipam, {})) bad(`resolved model: the networks are not just the default network of the project: ${JSON.stringify(nets)}`);
  const vols = m.volumes ?? {};
  const wantVols = ["cargo-home", "npm-cache", "otel-config", "otel-out"];
  if (!eq(Object.keys(vols).sort(), wantVols)) bad(`resolved model: the volumes are ${Object.keys(vols).sort().join(", ")}, not ${wantVols.join(", ")}`);
  for (const [k, v] of Object.entries(vols)) if (!eq(v, { name: `mandate-ci_${k}` })) bad(`resolved model: the volume ${k} has a setting beyond its name (a driver, driver_opts, external): ${JSON.stringify(v)}`);

  const volume = (source, target, ro) => ({ type: "volume", source, target, ...(ro ? { read_only: true } : {}), volume: {} });
  const runnerVolumes = [volume("cargo-home", "/cache/cargo"), volume("npm-cache", "/cache/npm"), volume("otel-config", "/otel/config"), volume("otel-out", "/otel/out")];
  const dockerDir = norm(resolve(root, "docker"));
  const nullable = (v) => v === null;
  const common = { command: nullable, entrypoint: nullable, networks: (v) => eq(v, { default: null }) };
  const spec = {
    runner: {
      ...common,
      profiles: (v) => eq(v, ["run"]),
      image: (v) => v === "mandate-ci-runner:local",
      pull_policy: (v) => v === "never",
      init: (v) => v === true,
      cap_drop: (v) => eq(v, ["ALL"]),
      security_opt: (v) => eq([...v].sort(), ["no-new-privileges:true"]),
      volumes: (v) => eq(v, runnerVolumes),
      build: (v) => eq(Object.keys(v).sort(), ["context", "dockerfile"]) && norm(v.context) === dockerDir && v.dockerfile === "Dockerfile",
    },
    "runner-sandbox": {
      ...common,
      profiles: (v) => eq(v, ["run"]),
      image: (v) => v === "mandate-ci-runner:local",
      pull_policy: (v) => v === "never",
      init: (v) => v === true,
      cap_drop: (v) => eq(v, ["ALL"]),
      security_opt: (v) => eq([...v].sort(), ["no-new-privileges:true", "seccomp=unconfined"]),
      devices: (v) => eq(v, [{ source: "/dev/net/tun", target: "/dev/net/tun", permissions: "rwm" }]),
      volumes: (v) => eq(v, runnerVolumes),
    },
    postgres: {
      ...common,
      profiles: (v) => eq(v, ["services"]),
      image: (v) => typeof v === "string" && /^postgres:[0-9.]+@sha256:[0-9a-f]{64}$/.test(v),
      environment: (v) => Object.entries(v).every(([k, x]) => ["POSTGRES_USER", "POSTGRES_DB", "POSTGRES_HOST_AUTH_METHOD"].includes(k) && typeof x === "string" && x !== ""),
      tmpfs: (v) => eq(v, ["/var/lib/postgresql/data"]),
      healthcheck: (v) => Object.keys(v).every((k) => ["test", "timeout", "interval", "retries"].includes(k)),
    },
    "otel-collector": {
      ...common,
      profiles: (v) => eq(v, ["services"]),
      image: (v) => typeof v === "string" && /^ghcr\.io\/open-telemetry\/\S+@sha256:[0-9a-f]{64}$/.test(v),
      user: (v) => v === "1000:1000",
      cap_drop: (v) => eq(v, ["ALL"]),
      security_opt: (v) => eq([...v].sort(), ["no-new-privileges:true"]),
      volumes: (v) => eq(v, [volume("otel-config", "/etc/otelcol", true), volume("otel-out", "/out")]),
    },
  };
  const services = m.services ?? {};
  if (!eq(Object.keys(services).sort(), Object.keys(spec).sort())) bad(`resolved model: the services are ${Object.keys(services).sort().join(", ")}, not ${Object.keys(spec).sort().join(", ")}`);
  for (const [name, svc] of Object.entries(services)) {
    const allowed = spec[name];
    if (!allowed) continue;
    for (const [key, value] of Object.entries(svc)) {
      if (!(key in allowed)) bad(`resolved model: the service ${name} has the key ${key}, which is not on the allowlist`);
      else if (!allowed[key](value)) bad(`resolved model: the service ${name} has ${key}: ${JSON.stringify(value)}, which is not what the allowlist says`);
    }
  }
}

function resolvedModel() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COMPOSE_")) delete env[k];
  let have = true;
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore", env });
  } catch {
    have = false;
  }
  if (!have) {
    if (process.env["GITHUB_ACTIONS"] === "true") bad("docker compose is not available in GitHub Actions: the resolved model cannot be checked");
    else skipped.push("the resolved model of compose.yml (no `docker compose` here: this is a machine or a container without Docker)");
    return;
  }
  const dir = join(root, "docker");
  let out;
  try {
    out = execFileSync("docker", ["compose", "--project-directory", dir, "--env-file", join(dir, "empty.env"), "-f", join(dir, "compose.yml"), "--profile", "run", "--profile", "services", "config", "--format", "json"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    bad(`docker compose cannot resolve docker/compose.yml: ${String(e.stderr ?? e.message).trim().split("\n")[0]}`);
    return;
  }
  checkModel(JSON.parse(out));
}
resolvedModel();

// ── 5. step parity with ci.yml ──────────────────────────────────────────

// The steps (`run:`) of ci.yml that are not in docker/run-job.sh, and why. Every other step of the four jobs must be
// there: each of its command lines a whole line of the matching job_* function (a leading NAME=value is allowed only when
// it is in the step's env:), in order, with the step's env and working-directory kept. A step that is neither here nor
// in the list fails, and so does an entry that matches no step.
const knownDifferences = [
  { job: "sandbox", re: /apt-get install|sysctl/, why: "Bubblewrap, slirp4netns and iptables are in the image; unprivileged user namespaces are the container's own (the service's seccomp setting)" },
  { job: "sandbox", re: /sudo mkdir -p \/work/, why: "/work exists in the image and belongs to the job's user" },
  { job: "sandbox", re: /test\/container\.test\.ts/, why: "the container sandbox host needs a real Docker engine, which the job container has not: CI only" },
  { job: "test", re: /opa_linux_amd64_static/, why: "OPA is in the image, checked against the same sha256 when the image is built" },
  { job: "test", re: /docker run -d --name otel-collector/, why: "the collector is a compose service that scripts/docker-ci.sh starts before the job, with the commit's configuration; run-job.sh waits for its receiver" },
  { job: "test", re: /docker logs otel-collector/, why: "the script prints the collector's log when the job fails" },
  { job: "test", re: /^docker rm -f otel-collector$/, why: "the script removes the services when the job ends (a trap)" },
];
// The variables of a step's env: whose value is not the one of ci.yml here, and why; the variable must still be set.
const knownEnvDifferences = [
  { job: "test", name: "MANDATE_TEST_DATABASE_URL", why: "the PostgreSQL service of the project, with trust authentication (no password)" },
  { job: "test", name: "MANDATE_OPA", why: "OPA is the binary of the image" },
  { job: "test", name: "MANDATE_OTEL_COLLECTOR", why: "the collector is a compose service" },
  { job: "test", name: "MANDATE_OTEL_COLLECTOR_OUT", why: "the collector's output is in a volume of the project" },
];
// Lines of docker/run-job.sh with `||` that are not `|| code=$?` (ci.yml's own form), with `|| true` or `|| :`: each one is
// listed, so that a step cannot be made to pass by adding one.
const allowedOr = [
  `code="$(curl -s -o /dev/null -w '%{http_code}' http://otel-collector:4318/v1/traces || true)"`,
  'found="$(find /ci /cache /otel /work /home/ci -name .env 2>/dev/null || true)"',
  'setuid="$(find / -xdev \\( -perm -4000 -o -perm -2000 \\) -type f 2>/dev/null | head -n 5 || true)"',
  'if [ -e /var/run/docker.sock ] || [ -e /run/docker.sock ]; then bad "a Docker socket is present"; else ok "no Docker socket"; fi',
  'if [ -d /mnt/c ] || [ -d /c/Users ]; then bad "a Windows drive is visible"; else ok "no Windows drive visible"; fi',
  '[ "$#" -gt 0 ] || { echo "quick needs a command"; exit 2; }',
];
const used = new Set();
const normalise = (s) => s.trim().replace(/\s+/g, " ").replaceAll("${{ runner.temp }}", "$RUNNER_TEMP");
const codeLines = (text) => text.split("\n").map(normalise).filter((l) => l !== "" && !l.startsWith("#"));
const unq = (v) => v.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
/** A line of a job function as the steps are compared: `(cd X && REST)` is two lines, and leading NAME=value words are taken off. */
function haveLines(fn) {
  const out = [];
  for (const raw of codeLines(fn)) {
    const sub = raw.match(/^\(cd (\S+) && (.*)\)$/);
    for (const text of sub ? [`cd ${sub[1]}`, sub[2]] : [raw]) {
      const env = [];
      let rest = text;
      for (let m; (m = rest.match(/^([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"$\x60]|\$(?!\())*"|'[^']*'|[^\s"'$\x60()]+) +/)); rest = rest.slice(m[0].length)) env.push([m[1], unq(m[2])]);
      out.push({ text, rest, env });
    }
  }
  return out;
}
/** The words NAME=value of a line, wherever they are (an export, an assignment, a prefix). */
const assignments = (line) => [...line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)/g)].map((m) => [m[1], unq(m[2])]);
function steps(jobText) {
  const out = [];
  let cur;
  for (const l of jobText.split("\n")) {
    if (/^ {6}- /.test(l)) {
      cur = [];
      out.push(cur);
    }
    cur?.push(l);
  }
  return out.map((raw) => {
    const key = (k) => raw.map((l) => l.match(new RegExp(`^(?: {6}- | {8})${k}:\\s*(.*)$`))?.[1]).find((x) => x !== undefined);
    const name = key("name");
    const workdir = key("working-directory");
    const envAt = raw.findIndex((l) => /^(?: {6}- | {8})env:\s*$/.test(l));
    const env = [];
    if (envAt >= 0) {
      for (const l of raw.slice(envAt + 1)) {
        const m = l.match(/^ {10}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
        if (!m) break;
        env.push([m[1], unq(normalise(m[2]))]);
      }
    }
    const at = raw.findIndex((l) => /^(?: {6}- | {8})run:/.test(l));
    if (at < 0) return { name, run: undefined, env, workdir };
    const value = raw[at].replace(/^(?: {6}- | {8})run:\s*/, "");
    if (/^[|>][+-]?$/.test(value)) {
      const body = [];
      for (const l of raw.slice(at + 1)) {
        if (l.trim() !== "" && l.match(/^\s*/)[0].length <= 8) break;
        body.push(l);
      }
      return { name, run: body.join("\n"), env, workdir };
    }
    return { name, run: value, env, workdir };
  });
}
const usedEnv = new Set();
for (const job of ["rust", "test", "parity", "sandbox"]) {
  const fn = runJob.match(new RegExp(`^job_${job}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}$`, "m"))?.[1];
  if (fn === undefined || jobs[job] === undefined) {
    bad(`step parity: no job_${job} in docker/run-job.sh or no ${job} job in ci.yml`);
    continue;
  }
  const have = haveLines(fn);
  let cursor = 0;
  for (const step of steps(jobs[job])) {
    if (step.run === undefined) continue;
    const label = step.name ?? step.run.trim().split("\n")[0];
    const known = knownDifferences.find((k) => k.job === job && k.re.test(step.run.trim()));
    if (known) {
      used.add(known);
      continue;
    }
    const before = cursor;
    let first = -1;
    const prefixes = [];
    for (const want of codeLines(step.run)) {
      let found = -1;
      for (let i = cursor; i < have.length; i++) {
        if (have[i].rest === want) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        bad(`step parity: the step "${label}" of the ${job} job of ci.yml has the command line \`${want}\`, which is not a whole line of job_${job} of docker/run-job.sh (after the line of the step before it); add it there as it is, or add the step to the known differences of docker/check.mjs with the reason`);
        break;
      }
      if (first < 0) first = found;
      cursor = found;
      for (const [name, value] of have[found].env) {
        prefixes.push([name, value]);
        const inEnv = step.env.some(([n, v]) => n === name && v === value);
        const known = knownEnvDifferences.find((k) => k.job === job && k.name === name);
        if (known) usedEnv.add(known);
        if (!inEnv && !known) bad(`step parity: the line \`${have[found].text}\` of job_${job} sets ${name}=${value} before the command, which the env: of the step "${label}" of ci.yml does not have (or has with another value)`);
      }
    }
    if (first < 0) continue;
    // The working directory of the step is the one the lines are run in.
    if (step.workdir && !have.slice(before, first + 1).some((h) => h.rest === `cd ${step.workdir}`)) bad(`step parity: the step "${label}" of the ${job} job has working-directory ${step.workdir}, and job_${job} has no \`cd ${step.workdir}\` before its lines`);
    // Its env: each variable is set, with the step's value, on a line of the step or before it (an export or an assignment).
    for (const [name, value] of step.env) {
      const knownEnv = knownEnvDifferences.find((k) => k.job === job && k.name === name);
      if (knownEnv) usedEnv.add(knownEnv);
      const set = have.slice(before, cursor + 1).flatMap((h) => [...h.env, ...assignments(h.rest)]);
      const ok = set.some(([n, v]) => n === name && (knownEnv ? true : normalise(v) === value));
      if (!ok) bad(`step parity: the step "${label}" of the ${job} job of ci.yml has env ${name}=${value}, which job_${job} of docker/run-job.sh does not set${knownEnv ? "" : " to that value"} on the lines of the step or before them`);
    }
  }
}
for (const k of knownDifferences) if (!used.has(k)) bad(`step parity: the known difference ${k.re} of the ${k.job} job matches no step of ci.yml any more: remove it from docker/check.mjs`);
for (const k of knownEnvDifferences) if (!usedEnv.has(k)) bad(`step parity: the known env difference ${k.name} of the ${k.job} job is not used by any step of ci.yml and run-job.sh any more: remove it from docker/check.mjs`);

// The steps must not be made to pass by weakening: set -eu at the top of run-job.sh and boot.sh, no `|| true`, `|| :`,
// `|| exit 0` or `set +e` but the listed lines, no `||` after a command of a step but the `|| code=$?` of ci.yml's own form.
const allowedOrSet = new Set(allowedOr.map(normalise));
for (const [file, text] of [["docker/run-job.sh", runJob], ["docker/boot.sh", read("docker/boot.sh")]]) {
  const lines = codeLines(text);
  if (!lines.includes("set -eu")) bad(`${file} does not have the line \`set -eu\``);
  else if (lines.findIndex((l) => /^(job_|[a-z_]+\(\) \{)/.test(l)) >= 0 && lines.indexOf("set -eu") > lines.findIndex((l) => /^[a-z_]+\(\) \{/.test(l))) bad(`${file} has \`set -eu\` after its first function`);
  for (const l of lines) {
    if (/(^|[;&|(]\s*)set\s+(\S+\s+)*\+\S/.test(l)) bad(`${file} turns an option off with set + (set +e, set +eu, set +o errexit, ...): ${l}`);
    if (/\btrap\b/.test(l)) bad(`${file} has a trap, which is not allowed in the steps or the entry: ${l}`);
    if (l.includes("||") && !/\|\| code=\$\?$/.test(l) && !allowedOrSet.has(l) && !(file === "docker/boot.sh" && /\|\| rc=\$\?$/.test(l))) bad(`${file} has a line with || that is not on the list of allowed ones in docker/check.mjs (a command made to pass with || true, || : or the like): ${l}`);
  }
}
// run-job.sh: the dispatch on the job name, exactly (what runs for each job name, and quick's command).
{
  const lines = codeLines(runJob);
  const at = lines.lastIndexOf('case "$job" in');
  const want = [
    'case "$job" in',
    "rust) job_rust ;;",
    "parity) job_parity ;;",
    "test) job_test ;;",
    "sandbox) job_sandbox ;;",
    "selfcheck) job_selfcheck ;;",
    "quick)",
    'case "${MANDATE_CI_NODE:-24}" in 22 | 24) use_node "${MANDATE_CI_NODE:-24}" ;; *) echo "MANDATE_CI_NODE must be 22 or 24"; exit 2 ;; esac',
    '[ "$#" -gt 0 ] || { echo "quick needs a command"; exit 2; }',
    '"$@"',
    ";;",
    '*) echo "unknown job $job"; exit 2 ;;',
    "esac",
  ];
  if (at < 0 || JSON.stringify(lines.slice(at)) !== JSON.stringify(want)) bad("docker/run-job.sh: the dispatch on the job name at the end of the file is not exactly the pinned one in docker/check.mjs");
}
// boot.sh: the checkout of the commit, its identity and the run of the steps. All its code lines, exactly: a line more or
// less is a change of this list.
{
  const lines = codeLines(read("docker/boot.sh"));
  const want = [
    "set -eu",
    'job="${1:?usage: boot.sh <job> <sha> [command...]}"',
    'sha="${2:?usage: boot.sh <job> <sha> [command...]}"',
    "shift 2",
    "lib=/usr/local/lib/mandate-ci",
    "sum() { sha256sum | cut -d' ' -f1; }",
    'if [ -z "${MANDATE_CI_IMAGE:-}" ]; then',
    'echo "boot: this image was built by a newer checkout of the Docker scripts; run the job again (your checkout rebuilds its own image)" >&2',
    "exit 97",
    "fi",
    'have="$(cat "$lib/Dockerfile" "$lib/.dockerignore" "$lib/boot.sh" | sum)"',
    'if [ "$have" != "$MANDATE_CI_IMAGE" ]; then',
    'echo "boot: the image was built from another Dockerfile, .dockerignore or boot.sh than the checkout that started it" >&2',
    "exit 97",
    "fi",
    "cd /ci/repo",
    "git init -q -b main .",
    'echo "$sha" > .git/shallow',
    "git unpack-objects --strict -q",
    'git checkout -q --detach "$sha"',
    'if [ "$(git rev-parse HEAD)" != "$sha" ]; then echo "boot: HEAD is not the tested commit $sha" >&2; exit 3; fi',
    'status="$(git status --porcelain)"',
    'if [ -n "$status" ]; then echo "boot: the checkout of $sha is not clean:" >&2; echo "$status" >&2; exit 3; fi',
    "git fsck --connectivity-only --no-dangling",
    'echo "tested commit: $sha (a depth-1 checkout of its own objects, made in the container)"',
    "if [ -f docker/run-job.sh ]; then",
    'echo "steps: docker/run-job.sh of the tested commit"',
    "steps=/ci/repo/docker/run-job.sh",
    "else",
    'if [ "$(sum < "$lib/run-job.sh")" != "${MANDATE_CI_STEPS:-}" ]; then',
    'echo "boot: the image holds another run-job.sh than the checkout that started it, and the tested commit has none" >&2',
    "exit 97",
    "fi",
    'echo "steps: the copy baked into the image (the tested commit has no docker/run-job.sh)"',
    'steps="$lib/run-job.sh"',
    "fi",
    "rc=0",
    'bash "$steps" "$job" "$sha" "$@" || rc=$?',
    'if [ "$rc" -eq 97 ]; then rc=1; fi',
    'exit "$rc"',
  ];
  if (JSON.stringify(lines) !== JSON.stringify(want)) {
    const i = lines.findIndex((l, k) => l !== want[k]);
    bad(`docker/boot.sh is not exactly the pinned text in docker/check.mjs (a line more, less or different); the first difference is at code line ${i < 0 ? Math.min(lines.length, want.length) + 1 : i + 1}: ${lines[i] ?? "(end of file)"}`);
  }
}

// ── the result: nothing is checked after this line ──────────────────────

for (const s of skipped) console.log(`docker/check.mjs: skipped: ${s}`);
if (problems.length > 0) {
  console.error(`docker/check.mjs: ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`docker/check.mjs: ok (Rust ${dockerArg("RUST_CHANNEL")}, Node ${dockerArg("NODE22_VERSION")} and ${dockerArg("NODE24_VERSION")}, OPA ${dockerArg("OPA_VERSION")}, the images of ci.yml, the steps of four jobs, no path from the host into a container${skipped.length ? `; skipped ${skipped.length}` : ""})`);
