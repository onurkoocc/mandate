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

// scripts/docker-ci.sh: every invocation of Docker is one of these exact forms, or the `dc` wrapper's calls.
const allowedDocker = [
  /^command -v docker >\/dev\/null 2>&1 \|\| die "Docker is not on the PATH"$/,
  /^dc\(\) \{ docker compose --project-directory "\$dd" --env-file "\$dd\/empty\.env" -f "\$dd\/compose\.yml" "\$@"; \}$/,
  /^dcp\(\) \{ docker compose --project-directory "\$dd" --env-file "\$dd\/empty\.env" -f "\$dd\/compose\.yml" -f "\$1" "\$\{@:2\}"; \}$/,
  /^control_loads_dotenv\(\) \{ \( cd "\$tmp" && docker compose --project-directory "\$ntmp" --profile run -f "\$dd\/compose\.yml" -f "\$ntmp\/probe\.yml" config 2>\/dev\/null \| grep -q 'made-up-plain-words' \); \}$/,
  /^insp\(\) \{ docker inspect --format "\$2" "\$1"; \}$/,
  /^rm_container\(\) \{ docker rm -f "\$1" >\/dev\/null 2>&1; \}$/,
  /^git -C "\$root_native" archive --format=tar "\$sha" \| docker exec -i -e "MANDATE_CI_CONTEXT=\$ctx" "\$1" bash \/usr\/local\/lib\/mandate-ci\/boot\.sh selfcheck "\$sha" "\$tree"$/,
];
const scriptLines = scriptCode.split("\n");
for (const line of scriptLines) {
  const t = line.trim();
  if (/(^|[^\w./$-])docker\s+\S/.test(t) && !allowedDocker.some((re) => re.test(t))) bad(`scripts/docker-ci.sh has a Docker invocation that is not on the list of allowed forms: ${t}`);
}
for (const exact of [/^docker_dir="\$root\/docker"$/m, /^dd="\$\(native "\$docker_dir"\)"$/m]) if (!exact.test(scriptCode)) bad(`scripts/docker-ci.sh does not define ${exact.source.replace(/\\/g, "")}`);
// dc and dcp are the only ways to call compose; dcp (a second compose file) and the control only in the selfcheck.
const selfcheckAt = scriptLines.findIndex((l) => /^selfcheck\(\) \{/.test(l));
const caseAt = scriptLines.findIndex((l) => /^case "\$job" in/.test(l));
scriptLines.forEach((l, i) => {
  if (/(^|[\s(|&;])(dcp|control_loads_dotenv)\b/.test(l) && !/^(dcp|control_loads_dotenv)\(\)/.test(l.trim()) && !(i > selfcheckAt && i < caseAt)) bad(`scripts/docker-ci.sh uses ${l.trim().match(/dcp|control_loads_dotenv/)[0]} outside the selfcheck`);
  if (/^dc\(\)/.test(l.trim())) return;
  for (const m of l.matchAll(/(?:^|[\s(|&;])dc((?:\s+\S+)*)/g)) {
    // The global options of compose come before the subcommand; --profile takes a value.
    const tokens = m[1].trim().split(/\s+/);
    for (let k = 0; k < tokens.length && tokens[k].startsWith("-"); k++) {
      if (tokens[k] === "--profile") k++;
      else bad(`scripts/docker-ci.sh gives dc the option ${tokens[k]} before its subcommand (a file, a directory, a name or an env file of its own): ${l.trim()}`);
    }
  }
});
// Forms that look like a flag and are not: `down -v` removes volumes, `command -v` looks a program up, and so on.
const benign = ["down -v", "command -v", "compgen -e", "cat-file -e", "grep -v"];
const scrub = (s) => benign.reduce((acc, b) => acc.replaceAll(b, b.split(" ")[0]), s);
// Every -e/--env carries NAME=value, a value written in the script (a bare -e NAME takes the host's variable).
for (const m of scrub(scriptCode).matchAll(/(?:^|\s)(?:-e|--env)(?=[\s=])[\s=]*("[^"]*"|'[^']*'|\S*)/g)) {
  if (!/^["']?[A-Za-z_][A-Za-z0-9_]*=/.test(m[1])) bad(`scripts/docker-ci.sh passes -e/--env without NAME=value: ${m[0].trim()}`);
}
// No mount, no privilege, no host namespace, whatever the form. (`down -v` removes volumes, `command -v` looks a program up.)
const scriptFlags = scrub(scriptCode);
for (const [re, what] of [
  [/(^|\s)(-v|--volume|--mount|--volumes-from)(\s|=|$)/, "a mount (-v, --volume, --mount)"],
  [/--privileged\b|--cap-add\b|--device\b|--security-opt\b|--add-host\b|--userns\b|--cgroupns\b/, "a privilege flag"],
  [/--net(work)?[= ]host\b|--pid\b|--ipc\b|--uts\b/, "the host network or a host namespace"],
  [/--publish\b|(^|\s)-p\s+[0-9[]/, "a published port"],
  [/\bdocker\s+cp\b/, "docker cp"],
]) {
  if (re.test(scriptFlags)) bad(`scripts/docker-ci.sh has ${what}`);
}
// No dotenv file: in the script only empty.env and the decoy the selfcheck makes in a temporary directory.
for (const line of scriptLines) {
  if (/\.env\b/.test(line.replaceAll("empty.env", "").replaceAll('"$tmp/.env"', ""))) bad(`scripts/docker-ci.sh mentions a dotenv file: ${line.trim()}`);
}
if (/\.env\b/.test(composeCode) || /\.env\b/.test(dockerCode)) bad("compose.yml or the Dockerfile mentions a dotenv file");
if (/docker[.]sock|\/var\/run\/docker|\/run\/docker/.test(composeCode + dockerCode + scriptCode)) bad("compose.yml, the Dockerfile or the script mentions the Docker socket");
if (!existsSync(join(root, "docker/empty.env"))) bad("docker/empty.env is missing");
else if (statSync(join(root, "docker/empty.env")).size !== 0) bad("docker/empty.env is not empty");

// The Dockerfile: one COPY, of the two files boot.sh and run-job.sh; nothing that takes a secret or a host file.
const copies = dockerCode.split("\n").filter((l) => /^\s*COPY\b/i.test(l));
if (copies.length !== 1 || !/^COPY --chmod=0755 boot\.sh run-job\.sh \/usr\/local\/lib\/mandate-ci\/$/.test(copies[0].trim())) bad(`the Dockerfile must have exactly one COPY, of boot.sh and run-job.sh; it has: ${copies.map((c) => c.trim()).join(" | ") || "none"}`);
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
  if (!ignore) bad("docker/.dockerignore is missing");
  else if (JSON.stringify(ignore) !== JSON.stringify(["*", "!boot.sh", "!run-job.sh"])) bad(`docker/.dockerignore must be exactly *, !boot.sh, !run-job.sh (the files the COPY names); it is: ${ignore.join(" ")}`);
}
// git archive carries the commit into the container: nothing may be left out of it or changed by it.
if (existsSync(join(root, ".gitattributes")) && /export-(ignore|subst)/.test(read(".gitattributes"))) bad(".gitattributes has export-ignore or export-subst: git archive would not give the commit's files");

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
// there, its command lines in order; a step that is neither here nor in the list fails, and so does an entry that
// matches no step.
const knownDifferences = [
  { job: "sandbox", re: /apt-get install|sysctl/, why: "Bubblewrap, slirp4netns and iptables are in the image; unprivileged user namespaces are the container's own (the service's seccomp setting)" },
  { job: "sandbox", re: /sudo mkdir -p \/work/, why: "/work exists in the image and belongs to the job's user" },
  { job: "sandbox", re: /test\/container\.test\.ts/, why: "the container sandbox host needs a real Docker engine, which the job container has not: CI only" },
  { job: "test", re: /opa_linux_amd64_static/, why: "OPA is in the image, checked against the same sha256 when the image is built" },
  { job: "test", re: /docker run -d --name otel-collector/, why: "the collector is a compose service that scripts/docker-ci.sh starts before the job, with the commit's configuration; run-job.sh waits for its receiver" },
  { job: "test", re: /docker logs otel-collector/, why: "the script prints the collector's log when the job fails" },
  { job: "test", re: /^docker rm -f otel-collector$/, why: "the script removes the services when the job ends (a trap)" },
];
const used = new Set();
const normalise = (s) => s.trim().replace(/\s+/g, " ").replaceAll("${{ runner.temp }}", "$RUNNER_TEMP");
const codeLines = (text) => text.split("\n").map(normalise).filter((l) => l !== "" && !l.startsWith("#"));
/** Whether `line` holds `want` as a command: the whole line, or after/inside other words (an assignment before it, a subshell around it). */
const holds = (line, want) => {
  let from = 0;
  for (;;) {
    const i = line.indexOf(want, from);
    if (i < 0) return false;
    const before = i === 0 || /[\s(;&"'=|]/.test(line[i - 1]);
    const after = i + want.length === line.length || /[\s);&|]/.test(line[i + want.length]);
    if (before && after) return true;
    from = i + 1;
  }
};
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
    const name = raw.map((l) => l.match(/^(?: {6}- | {8})name:\s*(.*)$/)?.[1]).find((x) => x !== undefined);
    const at = raw.findIndex((l) => /^(?: {6}- | {8})run:/.test(l));
    if (at < 0) return { name, run: undefined };
    const value = raw[at].replace(/^(?: {6}- | {8})run:\s*/, "");
    if (/^[|>][+-]?$/.test(value)) {
      const body = [];
      for (const l of raw.slice(at + 1)) {
        if (l.trim() !== "" && l.match(/^\s*/)[0].length <= 8) break;
        body.push(l);
      }
      return { name, run: body.join("\n") };
    }
    return { name, run: value };
  });
}
for (const job of ["rust", "test", "parity", "sandbox"]) {
  const fn = runJob.match(new RegExp(`^job_${job}\\(\\) \\{\\n([\\s\\S]*?)\\n\\}$`, "m"))?.[1];
  if (fn === undefined || jobs[job] === undefined) {
    bad(`step parity: no job_${job} in docker/run-job.sh or no ${job} job in ci.yml`);
    continue;
  }
  const have = codeLines(fn);
  let cursor = 0;
  for (const step of steps(jobs[job])) {
    if (step.run === undefined) continue;
    const label = step.name ?? step.run.trim().split("\n")[0];
    const known = knownDifferences.find((k) => k.job === job && k.re.test(step.run.trim()));
    if (known) {
      used.add(known);
      continue;
    }
    for (const want of codeLines(step.run)) {
      let found = -1;
      for (let i = cursor; i < have.length; i++) {
        if (holds(have[i], want)) {
          found = i;
          break;
        }
      }
      if (found < 0) {
        bad(`step parity: the step "${label}" of the ${job} job of ci.yml has the command line \`${want}\`, which is not in job_${job} of docker/run-job.sh (after the line of the step before it); add it there, or to the known differences of docker/check.mjs with the reason`);
        break;
      }
      cursor = found;
    }
  }
}
for (const k of knownDifferences) if (!used.has(k)) bad(`step parity: the known difference ${k.re} of the ${k.job} job matches no step of ci.yml any more: remove it from docker/check.mjs`);

// ── the result: nothing is checked after this line ──────────────────────

for (const s of skipped) console.log(`docker/check.mjs: skipped: ${s}`);
if (problems.length > 0) {
  console.error(`docker/check.mjs: ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`docker/check.mjs: ok (Rust ${dockerArg("RUST_CHANNEL")}, Node ${dockerArg("NODE22_VERSION")} and ${dockerArg("NODE24_VERSION")}, OPA ${dockerArg("OPA_VERSION")}, the images of ci.yml, the steps of four jobs, no path from the host into a container${skipped.length ? `; skipped ${skipped.length}` : ""})`);
