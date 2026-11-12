// SPIKE, not for merge. One question, answered on a CI runner (ubuntu-latest):
//
//   Can the MXC SDK's Bubblewrap backend hold a sandboxed process to exactly
//   one loopback proxy endpoint, so that every other route out is closed?
//
// The script starts a tiny HTTP proxy and some decoy listeners on the host,
// creates sandboxes with `network.runtimeConfig.networkProxy` pointing at the
// proxy, and probes from inside. Every probe prints a line; the last line is
// `SPIKE RESULT: {...}`. The result is data, not a pass or fail: the script
// exits 0 whenever it could run, non-zero only when the script itself broke.
//
// Run it with: node runtime/test/spike/mxc-proxy-spike.mjs   (Linux, Node 24)

import { execFileSync } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join } from "node:path";

// SPIKE_DRYRUN=1 swaps the SDK for a fake that runs commands unsandboxed on this machine, to test the script itself.
const DRYRUN = process.env.SPIKE_DRYRUN === "1";
const log = (...a) => console.log("[spike]", ...a);
const result = {};
const details = {};

// ---------------------------------------------------------------- host side

/** Run a command on the host and return its trimmed output, or the error. */
function sh(cmd) {
  try {
    return execFileSync("sh", ["-c", cmd], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }).trim();
  } catch (e) {
    return `(failed: ${String(e.stderr || e.message).trim().split("\n")[0]})`;
  }
}

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

/** A proxy that answers an absolute-form GET itself and refuses CONNECT. */
async function startProxy(name) {
  const p = { name, requests: [], connections: [], port: 0, server: undefined };
  p.server = http.createServer((req, res) => {
    const line = `${req.method} ${req.url} HTTP/${req.httpVersion}`;
    p.requests.push(line);
    log(`proxy ${name}: request line: ${line} (host header ${req.headers.host}) from ${req.socket.remoteAddress}:${req.socket.remotePort}`);
    if (req.method === "GET" && /^http:\/\//.test(req.url ?? "")) {
      const body = `spike-proxy-${name}-ok:${new URL(req.url).pathname}`;
      res.writeHead(200, { "content-type": "text/plain", "content-length": Buffer.byteLength(body) });
      res.end(body);
    } else {
      res.writeHead(400);
      res.end("not an absolute-form GET");
    }
  });
  p.server.on("clientError", (e, socket) => {
    log(`proxy ${name}: client error ${e.code}`);
    socket.destroy();
  });
  p.server.on("connect", (req, socket) => {
    socket.on("error", () => {});
    const line = `CONNECT ${req.url} HTTP/${req.httpVersion}`;
    p.requests.push(line);
    log(`proxy ${name}: request line: ${line} from ${socket.remoteAddress}:${socket.remotePort} -> 403`);
    socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
  });
  p.server.on("connection", (s) => {
    s.on("error", (e) => log(`proxy ${name}: socket error ${e.code}`));
    p.connections.push(`${s.remoteAddress}:${s.remotePort}`);
    log(`proxy ${name}: TCP connection from ${s.remoteAddress}:${s.remotePort}`);
  });
  p.port = await listen(p.server, "127.0.0.1");
  log(`proxy ${name} listening on 127.0.0.1:${p.port}`);
  return p;
}

/** A listener the sandbox must NOT reach. It records every connection. */
async function startDecoy(name, bind) {
  const d = { name, hits: [], port: 0, server: undefined };
  d.server = net.createServer((s) => {
    s.on("error", () => {});
    d.hits.push(`${s.remoteAddress}:${s.remotePort}`);
    log(`DECOY ${name}: connection from ${s.remoteAddress}:${s.remotePort}`);
    s.end("DECOY\n");
  });
  d.port = await listen(d.server, bind);
  log(`decoy ${name} listening on ${bind}:${d.port}`);
  return d;
}

function nonLoopbackIPv4() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === "IPv4" && !a.internal) return a.address;
  }
  return undefined;
}

// ------------------------------------------------------- the probe, inside

const PROBE_SH = readFileSync(new URL("./probe.sh", import.meta.url), "utf8");

// ------------------------------------------------------------ SDK plumbing

async function collect(stream) {
  if (!stream) return "";
  const chunks = [];
  for await (const c of stream) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
  return Buffer.concat(chunks).toString("utf8");
}

/** Spawn through the SDK, wait, and return everything that came back. */
async function run(sdk, request) {
  const t0 = Date.now();
  let proc;
  try {
    proc = await sdk.spawn(request);
  } catch (e) {
    return { spawnError: `${e?.code ? `[${e.code}] ` : ""}${e?.message ?? e}`, ms: Date.now() - t0, stdout: "", stderr: "" };
  }
  const tSpawned = Date.now();
  try {
    // Take the streams before wait(), which drains any stream still untaken.
    const input = proc.standardInput;
    const out = collect(proc.standardOutput);
    const err = collect(proc.standardError);
    input?.end();
    const [status, stdout, stderr] = await Promise.all([proc.wait(), out, err]);
    return { exitCode: status.exitCode, timedOut: status.timedOut, stdout, stderr, warnings: proc.warnings ?? [], ms: Date.now() - t0, spawnMs: tSpawned - t0 };
  } catch (e) {
    return { waitError: `${e?.code ? `[${e.code}] ` : ""}${e?.message ?? e}`, ms: Date.now() - t0, stdout: "", stderr: "" };
  } finally {
    try {
      proc.dispose();
    } catch {
      /* already disposed */
    }
  }
}

function parseProbes(stdout) {
  const probes = {};
  const info = [];
  for (const line of stdout.split("\n")) {
    const m = /^PROBE (\S+) ?(.*)$/.exec(line);
    if (m) probes[m[1]] = m[2];
    else if (line.startsWith("INFO ")) info.push(line.slice(5));
  }
  return { probes, info };
}

/** "reached..." -> reached, "blocked..." -> blocked, anything else -> the text. */
function verdict(text) {
  if (text === undefined) return "error: probe did not print";
  if (/^reached/.test(text)) return "reached";
  if (/^blocked/.test(text)) return "blocked";
  if (/^n\/a/.test(text)) return text;
  return `error: ${text}`;
}

function fakeSdk() {
  return {
    getPlatformSupport: () => ({ isSupported: true, availableMethods: ["bubblewrap"], bubblewrapNetwork: { proxyEnforcement: "dry-run", warnings: [] } }),
    async spawn(req) {
      const px = req.network?.runtimeConfig?.networkProxy;
      const { spawn } = await import("node:child_process");
      const child = spawn("bash", ["-c", req.command], { env: { ...process.env, ...(px ? { HTTP_PROXY: px, http_proxy: px } : {}) } });
      const done = new Promise((r) => child.on("close", (code) => r({ exitCode: code ?? 1, timedOut: false })));
      return { standardInput: child.stdin, standardOutput: child.stdout, standardError: child.stderr, warnings: [], wait: () => done, dispose() {} };
    },
  };
}

// ---------------------------------------------------------------------- main

async function main() {
  if (process.platform !== "linux" && !DRYRUN) {
    log("not Linux; nothing to probe");
    result.skipped = `platform ${process.platform}`;
    return;
  }

  // -- host facts
  log("node", process.version, process.execPath);
  log("kernel:", sh("uname -sr"), "|", sh(". /etc/os-release; echo $PRETTY_NAME"));
  log("bwrap:", sh("bwrap --version"));
  for (const t of ["slirp4netns", "unshare", "nsenter", "iptables", "ip6tables", "iptables-restore", "ip6tables-restore", "ip", "curl"]) {
    log(`which ${t}:`, sh(`command -v ${t} || echo MISSING`), "|", sh(`${t} --version 2>&1 | head -1`));
  }
  log("sysctl:", sh("sysctl kernel.apparmor_restrict_unprivileged_userns kernel.unprivileged_userns_clone user.max_user_namespaces user.max_net_namespaces 2>&1 | tr '\\n' ' '"));
  log("unshare --user --net probe:", sh("unshare --user --net --map-current-user --keep-caps sh -c 'echo ok' 2>&1"));
  log("iptables backend:", sh("iptables --version 2>&1; update-alternatives --display iptables 2>&1 | head -2 | tr '\\n' ' '"));

  const sdk = DRYRUN ? fakeSdk() : await import("@microsoft/mxc-sdk/v1");

  // -- the platform probe, verbatim
  const support = sdk.getPlatformSupport();
  console.log(`PLATFORM SUPPORT: ${JSON.stringify(support)}`);
  console.log(`BUBBLEWRAP NETWORK: ${JSON.stringify(support.bubblewrapNetwork)}`);
  result.bubblewrapNetwork = support.bubblewrapNetwork ?? null;
  result.availableMethods = support.availableMethods;
  result.unavailableReasons = support.unavailableReasons ?? null;

  // -- host listeners
  const proxyA = await startProxy("A");
  const proxyB = await startProxy("B");
  const decoyLoop = await startDecoy("loopback-other-port", "127.0.0.1");
  const decoyAny = await startDecoy("0.0.0.0", "0.0.0.0");
  const nlip = nonLoopbackIPv4() ?? "192.0.2.1";
  log(`runner non-loopback IPv4: ${nlip}${nonLoopbackIPv4() ? "" : " (none found; using a TEST-NET address)"}`);
  log("host reaches the non-loopback decoy itself:", await new Promise((r) => { const s = net.connect(decoyAny.port, nlip, () => { s.destroy(); r("yes"); }); s.on("error", (e) => r(`no (${e.code})`)); }));

  // -- files the sandbox may read
  const dir = mkdtempSync(join(tmpdir(), "mxc-spike-"));
  const probePath = join(dir, "probe.sh");
  writeFileSync(probePath, PROBE_SH);
  chmodSync(probePath, 0o755);
  const nodeRoot = dirname(dirname(process.execPath));

  const request = (proxy, command, extra = {}) => ({
    command,
    filesystem: { readonlyPaths: [dir, nodeRoot], readwritePaths: [] },
    network: {
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
      ...(proxy ? { runtimeConfig: { networkProxy: `http://127.0.0.1:${proxy.port}` } } : {}),
    },
    containment: { type: "bubblewrap" },
    timeoutMs: 240000,
    ...extra,
  });
  const q = (x) => `'${String(x).replaceAll("'", "'\\''")}'`;
  const probeCmd = (proxy, tag, mode, other = 0) => ["bash", probePath, tag, mode, proxy.port, decoyLoop.port, nlip, decoyAny.port, process.execPath, other].map(q).join(" ");

  // -- 1. a proxied sandbox, full probe
  const req1 = request(proxyA, probeCmd(proxyA, "single", "full"));
  console.log(`REQUEST (proxied sandbox): ${JSON.stringify(req1)}`);
  const first = await run(sdk, req1);
  log(`proxied sandbox: ${first.spawnError ? `spawn failed: ${first.spawnError}` : `exit ${first.exitCode}${first.timedOut ? " (timed out)" : ""} in ${first.ms} ms`}`);
  console.log("--- proxied sandbox stdout ---\n" + first.stdout + "--- proxied sandbox stderr ---\n" + first.stderr + "--- end ---");
  if (first.warnings?.length) console.log("SDK warnings:", JSON.stringify(first.warnings));

  const failure = first.spawnError ?? first.waitError;
  const { probes, info } = parseProbes(first.stdout);
  const ran = Object.keys(probes).length > 0;
  result.proxiedSandbox = failure ? `error: ${failure}` : ran ? "created" : `error: no probe output (exit ${first.exitCode}) ${first.stderr.trim().slice(0, 500)}`;
  if (failure) result.sdkError = failure;
  details.info = info;
  details.probes = probes;

  if (ran) {
    const v = (k) => verdict(probes[k]);
    result.env_proxy = probes.env_proxy ?? "none";
    result.proxy_address_in_sandbox = probes.proxy_address_in_sandbox ?? null;
    const proxyLogged = proxyA.requests.some((r) => r.startsWith("GET http://spike.test/single"));
    result.proxy_get_raw = v("proxy_get_raw");
    result.proxy_get_curl = v("proxy_get_curl");
    result.proxy_logged_request = proxyLogged;
    result.proxy_connect_403 = /refused-403/.test(probes.proxy_connect ?? "") ? "reached-proxy-refused-403" : `error: ${probes.proxy_connect ?? "no probe"}`;
    result.noproxy_hostname = v("noproxy_hostname");
    result.decoy_loopback_own = v("decoy_loopback_own");
    result.decoy_loopback_gateway = v("decoy_loopback_gateway");
    result.decoy_loopback_gateway_node = v("decoy_loopback_gateway_node");
    result.proxy_port_via_gateway = v("proxy_port_via_gateway");
    result.decoy_nonloopback = v("decoy_nonloopback");
    result.decoy_nonloopback_node = v("decoy_nonloopback_node");
    result.external_tcp_1_1_1_1_443 = v("external_tcp_1_1_1_1_443");
    result.external_tcp_1_1_1_1_443_node = v("external_tcp_1_1_1_1_443_node");
    result.external_tcp_1_1_1_1_80 = v("external_tcp_1_1_1_1_80");
    result.external_tcp_ipv6 = v("external_tcp_ipv6");
    result.dns_gateway_tcp53 = v("dns_gateway_tcp53");
    result.dns_getent = v("dns_getent");
    result.dns_node = v("dns_node");
    result.external_https_curl_noproxy = v("external_https_curl_noproxy");
    result.decoy_hits = { loopback: decoyLoop.hits.length, any: decoyAny.hits.length };
    result.proxyA_connection_sources = proxyA.connections;
    result.proxyA_requests = proxyA.requests;
  }

  // -- 2. two sandboxes at once, each with its own proxy
  if (ran) {
    proxyA.requests.length = 0;
    proxyB.requests.length = 0;
    const [ra, rb] = await Promise.all([
      run(sdk, request(proxyA, probeCmd(proxyA, "sbxA", "hold", proxyB.port))),
      run(sdk, request(proxyB, probeCmd(proxyB, "sbxB", "hold", proxyA.port))),
    ]);
    const pa = parseProbes(ra.stdout);
    const pb = parseProbes(rb.stdout);
    console.log("--- sandbox A stdout ---\n" + ra.stdout + (ra.spawnError ?? ra.waitError ?? "") + ra.stderr + "--- sandbox B stdout ---\n" + rb.stdout + (rb.spawnError ?? rb.waitError ?? "") + rb.stderr + "--- end ---");
    const ownOk = (px, p, tag) => px.requests.some((r) => r.startsWith(`GET http://spike.test/${tag}`)) && /reached/.test(p.probes.proxy_get_raw ?? "");
    result.two_sandboxes = {
      a_reaches_own_proxy: ownOk(proxyA, pa, "sbxA"),
      b_reaches_own_proxy: ownOk(proxyB, pb, "sbxB"),
      a_body: pa.probes.proxy_get_raw ?? "no output",
      b_body: pb.probes.proxy_get_raw ?? "no output",
      a_to_b_loopback: verdict(pa.probes.other_proxy_loopback),
      a_to_b_gateway: verdict(pa.probes.other_proxy_gateway),
      b_to_a_loopback: verdict(pb.probes.other_proxy_loopback),
      b_to_a_gateway: verdict(pb.probes.other_proxy_gateway),
      a_address: pa.probes.proxy_address_in_sandbox ?? null,
      b_address: pb.probes.proxy_address_in_sandbox ?? null,
      a_env: pa.probes.env_proxy ?? null,
      b_env: pb.probes.env_proxy ?? null,
      proxyA_saw_only_A: proxyA.requests.every((r) => !r.includes("sbxB")),
      proxyB_saw_only_B: proxyB.requests.every((r) => !r.includes("sbxA")),
      proxyA_requests: proxyA.requests,
      proxyB_requests: proxyB.requests,
      errors: [ra.spawnError ?? ra.waitError, rb.spawnError ?? rb.waitError].filter(Boolean),
    };
  } else {
    result.two_sandboxes = "skipped: the first proxied sandbox did not run";
  }

  // -- 3. creation overhead: `true` with and without a proxy
  const timeIt = async (proxy) => {
    const ms = [];
    for (let i = 0; i < 4; i++) {
      const r = await run(sdk, request(proxy, "true", { timeoutMs: 60000 }));
      ms.push(r.spawnError || r.waitError || r.exitCode !== 0 ? `error: ${r.spawnError ?? r.waitError ?? `exit ${r.exitCode} ${r.stderr.trim().slice(0, 200)}`}` : r.ms);
    }
    return ms;
  };
  const noNet = await timeIt(undefined);
  const proxied = await timeIt(proxyA);
  result.timing_ms = { no_network: noNet, proxied };
  log("timing (first run is cold):", JSON.stringify(result.timing_ms));

  // -- done
  console.log(`INFO inside the sandbox: ${JSON.stringify(details.info ?? [])}`);
  console.log(`RAW PROBES: ${JSON.stringify(details.probes ?? {})}`);
}

try {
  await main();
  console.log(`SPIKE RESULT: ${JSON.stringify(result)}`);
  process.exit(0);
} catch (e) {
  console.error("the spike script itself broke:", e);
  console.log(`SPIKE RESULT: ${JSON.stringify({ ...result, script_error: String(e?.stack ?? e) })}`);
  process.exit(2);
}
