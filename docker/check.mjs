#!/usr/bin/env node
// Fails unless the Docker environment of docker/ is what the repository pins and what its secret boundary allows:
//
//   node docker/check.mjs
//
// 1. The Rust channel, components, target and profile of the Dockerfile are those of rust-toolchain.toml.
// 2. The Node releases, the OPA version and its sha256, the PostgreSQL image and the OpenTelemetry Collector image of
//    docker/ are those of .github/workflows/ci.yml (parsed from the two files: no value is repeated here), and each
//    job of the runner uses the Node release the job of the same name uses in ci.yml.
// 3. docker/compose.yml, docker/Dockerfile and scripts/docker-ci.sh contain no env_file, no mount of a `.env` or of the
//    Docker socket, no `privileged`, no host network or PID namespace, no published port, no bind mount but the
//    read-only git directory, no variable of the host passed through; the build context is docker/.
//
// No dependency; Node 22 or later. CI runs it in the rust job (.github/workflows/ci.yml).

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (p) => readFileSync(join(root, p), "utf8");
const problems = [];
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

const composeCode = yamlCode(compose);
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
  if (!m[1].startsWith("mandate-ci-runner:") && !/@sha256:[0-9a-f]{64}$/.test(m[1])) bad(`the image ${m[1]} in compose.yml is not pinned by digest`);
}

// ── 3. the secret boundary ──────────────────────────────────────────────

const files = { "docker/compose.yml": composeCode, "docker/Dockerfile": yamlCode(dockerfile), "scripts/docker-ci.sh": shellCode(script) };
const forbidden = [
  [/\benv_file\b/, "an env_file"],
  [/docker[.]sock|\/var\/run\/docker|\/run\/docker/, "the Docker socket"],
  [/\bprivileged\s*:\s*true\b|--privileged\b/, "privileged"],
  [/network_mode\s*:\s*["']?host|--net(work)?[= ]host\b|\bpid\s*:\s*["']?host|--pid[= ]host\b|\bipc\s*:\s*["']?host|--ipc[= ]host\b|\buserns_mode\s*:\s*["']?host/, "the host network, PID, IPC or user namespace"],
  [/^\s*ports\s*:/m, "published ports (ports:)"],
  [/--publish\b|(^|\s)-p\s+[0-9[]|\bhost_ip\b|\bpublished\s*:/, "a published port"],
  [/\bdocker\s+build\b|\bdocker\s+run\b|\bdocker\s+buildx\b/, "a docker command outside compose (the build context and mounts are compose.yml's)"],
  [/\bextra_hosts\b|--device\b/, "a host device or host entry"],
  [/additional_contexts/, "another build context"],
];
for (const [file, code] of Object.entries(files)) {
  for (const [re, what] of forbidden) if (re.test(code)) bad(`${file} contains ${what}`);
}

// A `.env`: nowhere in the compose file or the Dockerfile; in the script only as empty.env (the file that stops compose
// from reading one) and as the decoy of the selfcheck, which is made in a temporary directory.
for (const file of ["docker/compose.yml", "docker/Dockerfile"]) if (/\.env\b/.test(files[file])) bad(`${file} mentions a .env file`);
for (const line of files["scripts/docker-ci.sh"].split("\n")) {
  if (/\.env\b/.test(line.replaceAll("empty.env", "").replaceAll('"$tmp/.env"', ""))) bad(`scripts/docker-ci.sh mentions a .env file: ${line.trim()}`);
}
const emptyEnv = "docker/empty.env";
if (!existsSync(join(root, emptyEnv))) bad("docker/empty.env is missing");
else if (statSync(join(root, emptyEnv)).size !== 0) bad("docker/empty.env is not empty");
if (!/--project-directory\s+"\$\(native "\$docker_dir"\)"\s+--env-file\s+"\$\(native "\$docker_dir"\)\/empty\.env"/.test(script)) bad("scripts/docker-ci.sh does not call compose with --project-directory docker and --env-file docker/empty.env");

// The script's own mounts: it has none (the git directory is mounted by compose.yml, read-only).
// (`down -v` of the clean command removes volumes and `command -v` looks a program up; neither mounts one.)
if (/(^|\s)(-v|--volume|--mount)(\s|=)/.test(files["scripts/docker-ci.sh"].replaceAll("down -v", "down").replaceAll("command -v", "command"))) bad("scripts/docker-ci.sh mounts a volume (-v, --volume, --mount)");

// The compose file: the context, the variables, the environment of a service, the mounts.
if (!/^\s*context:\s*\.\s*$/m.test(composeCode)) bad("the build context in compose.yml is not `.` (docker/)");
for (const m of composeCode.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) {
  if (m[1] !== "MANDATE_CI_GIT_DIR") bad(`compose.yml interpolates \${${m[1]}}: the only variable it may read is MANDATE_CI_GIT_DIR`);
}
for (const m of dockerfile.matchAll(/^(COPY|ADD)\s+(.*)$/gm)) {
  const args = m[2].split(/\s+/).filter((a) => !a.startsWith("--"));
  for (const src of args.slice(0, -1)) if (src.startsWith("/") || src.includes("..") || src.startsWith("~") || /^https?:/.test(src)) bad(`the Dockerfile's ${m[1]} takes ${src}: only files of docker/ may be copied`);
}

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

// The one device a container may be given is /dev/net/tun (slirp4netns, in the sandbox service).
for (const m of composeCode.matchAll(/\bdevices\s*:\s*\[([^\]]*)\]/g)) {
  for (const d of m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)) if (!/^\/dev\/net\/tun(:\/dev\/net\/tun)?$/.test(d)) bad(`compose.yml gives a container the device ${d}: only /dev/net/tun is allowed`);
}
if (/^\s*devices\s*:\s*$/m.test(composeCode)) bad("compose.yml has a devices list in a form this check cannot read: write it as a flow list");

// No variable of the host is passed through: an `environment` entry has a value, written there.
for (const { body } of blocks(composeCode, /^\s*environment\s*:\s*$/)) {
  for (const l of body) {
    const t = l.trim().replace(/^-\s*/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*\s*[:=]\s*\S/.test(t)) bad(`compose.yml passes a variable of the host through: ${l.trim()}`);
  }
}

// Mounts: named volumes and tmpfs, and the one bind mount, the git directory, read-only.
let binds = 0;
for (const { body } of blocks(composeCode, /^\s*volumes\s*:\s*$/)) {
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    const entry = l.match(/^(\s*)-\s*(.*)$/);
    if (!entry) continue;
    const [, dashIndent, rest] = entry;
    const short = rest.match(/^([^\s:][^\s]*?):(\/[^:\s]*)(?::(\w+))?$/);
    if (short) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(short[1])) bad(`compose.yml mounts ${short[1]}: a bind mount in the short form`);
      continue;
    }
    // The long form: the attributes are on the dash line and the lines under it.
    const attrs = { [rest.split(":")[0].trim()]: rest.slice(rest.indexOf(":") + 1).trim() };
    for (let j = i + 1; j < body.length && body[j].match(/^\s*/)[0].length > dashIndent.length; j++) {
      const kv = body[j].trim().match(/^([A-Za-z_]+)\s*:\s*(.*)$/);
      if (kv) attrs[kv[1]] = kv[2].trim();
    }
    if (attrs["type"] === "bind") {
      binds++;
      if (!/^\$\{MANDATE_CI_GIT_DIR:\?[^}]*\}$/.test(attrs["source"] ?? "")) bad(`compose.yml bind-mounts ${attrs["source"]}: only the git directory (\${MANDATE_CI_GIT_DIR}) may be mounted`);
      if (attrs["target"] !== "/git") bad(`compose.yml mounts the git directory at ${attrs["target"]}, not /git`);
      if (attrs["read_only"] !== "true") bad("compose.yml mounts the git directory read-write");
    } else if (attrs["type"] !== undefined && attrs["type"] !== "volume" && attrs["type"] !== "tmpfs") bad(`compose.yml has a mount of type ${attrs["type"]}`);
    else if (attrs["type"] === undefined) bad(`compose.yml has a volumes entry this check cannot read: ${rest}`);
  }
}
if (binds !== 1) bad(`compose.yml has ${binds} bind mounts, not exactly the one of the git directory`);

if (problems.length > 0) {
  console.error(`docker/check.mjs: ${problems.length} problem${problems.length === 1 ? "" : "s"}:`);
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`docker/check.mjs: ok (Rust ${dockerArg("RUST_CHANNEL")}, Node ${dockerArg("NODE22_VERSION")} and ${dockerArg("NODE24_VERSION")}, OPA ${dockerArg("OPA_VERSION")}, the images of ci.yml, no secret path into a container)`);
for (const m of composeCode.matchAll(/\bdevices\s*:\s*\[([^\]]*)\]/g)) {
  for (const d of m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)) if (!/^\/dev\/net\/tun(:\/dev\/net\/tun)?$/.test(d)) bad(`compose.yml gives a container the device ${d}: only /dev/net/tun is allowed`);
}
for (const m of composeCode.matchAll(/\bdevices\s*:\s*\[([^\]]*)\]/g)) {
  for (const d of m[1].split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean)) if (!/^\/dev\/net\/tun(:\/dev\/net\/tun)?$/.test(d)) bad(`compose.yml gives a container the device ${d}: only /dev/net/tun is allowed`);
}
if (/^\s*devices\s*:\s*$/m.test(composeCode)) bad("compose.yml has a devices list in a form this check cannot read: write it as a flow list");