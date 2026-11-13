// What the tests of sandbox egress share: MXC's Bubblewrap backend as a fake SDK whose "processes" send their
// requests to the session's proxy port as a sandbox's would, and the adapter a host is planned with. The proxy is
// the in-process one of egress-world.ts; nothing here reaches the network.

import { PassThrough } from "node:stream";
import { MASK_CHECK, type MxcContainerRequest, type MxcHost, type MxcSdk } from "../src/mxc.js";
import type { WindowsMxcHost } from "../src/mxc-windows.js";
import { MxcAdapter, placeholderVariable } from "../src/sandbox.js";
import { http, portOf, send } from "./egress-world.js";

/** What a process in the fake sandbox does with the request MXC got: what it prints, and how it exits. */
export type Proc = (request: MxcContainerRequest) => Promise<{ stdout?: string; exitCode?: number }>;

/** A process that has already printed `stdout` and exited. */
export function finished(stdout: string, exitCode = 0) {
  const out = new PassThrough();
  const err = new PassThrough();
  out.end(stdout);
  err.end();
  return { standardInput: new PassThrough(), standardOutput: out, standardError: err, wait: async () => ({ exitCode, timedOut: false }), kill: () => {}, dispose: () => {} };
}

export const SUPPORTED = { isSupported: true, availableMethods: ["bubblewrap"], bubblewrapNetwork: { proxyEnforcement: "supported", warnings: [] } };

/** MXC's Bubblewrap backend as far as the host uses it. A process is the program its command's first word names. */
export class EgressSdk implements MxcSdk {
  readonly spawned: MxcContainerRequest[] = [];
  support: ReturnType<MxcSdk["getPlatformSupport"]> = SUPPORTED;
  readonly programs = new Map<string, Proc>([["fetch", fetcher]]);
  getPlatformSupport() {
    return this.support;
  }
  async spawn(request: MxcContainerRequest) {
    if (request.command === MASK_CHECK) return finished("end\n");
    this.spawned.push(structuredClone(request));
    const program = this.programs.get(request.command.split(" ")[0]!);
    const r = program ? await program(request) : { stdout: "ok\n" };
    return finished(r.stdout ?? "", r.exitCode ?? 0);
  }
}

/**
 * `fetch METHOD URL [METHOD URL …]`: sends each request to its sandbox's proxy, in absolute form, and prints each
 * one's status and denial reason. A request to api.github.com carries the GitHub credential's placeholder in its
 * header when the environment has one; a method written `+GET` sends it whatever the host. It reaches the proxy only
 * through the address the request names, as a proxied sandbox does.
 */
export const fetcher: Proc = async (request) => {
  const [, ...args] = request.command.split(" ");
  const proxy = request.network.runtimeConfig?.networkProxy;
  if (!proxy) return { stdout: "no proxy\n", exitCode: 7 };
  const ph = request.environment?.[placeholderVariable("github")];
  let out = "";
  for (let i = 0; i + 1 < args.length; i += 2) {
    const [written, url] = [args[i]!, args[i + 1]!];
    const method = written.replace(/^\+/, "");
    const host = new URL(url).host;
    const auth = ph && (host === "api.github.com" || written.startsWith("+")) ? [`authorization: Bearer ${ph}`] : [];
    const r = await send(portOf(proxy), http([`${method} ${url} HTTP/1.1`, `host: ${host}`, ...auth]));
    out += `${written} ${url} ${r.status} ${r.header("x-mandate-egress-denied") ?? r.body}\n`;
  }
  return { stdout: out };
};

/** The adapter a sandbox host is planned with, as the control plane builds it with its models in the control plane. */
export const adapter = (host: MxcHost | WindowsMxcHost) => new MxcAdapter({ host, schemaVersion: "0.9.0", modelEndpoints: {}, modelsInControlPlane: true });
