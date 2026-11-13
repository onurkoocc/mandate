// `mandate egress serve --config mandate.egress.json` (spec/egress.md
// "Running the proxy"). The operator starts the proxy, in an environment that
// holds the secrets; the runtime does not, so it never inherits them. It needs
// no database and no runtime configuration. It reads the configuration and
// every secret at start and refuses to start when one is missing, prints one
// line when it is ready, and runs until it is signalled; then it closes its
// sessions and removes its socket.

import { readFileSync } from "node:fs";
import { Violation } from "../signals.js";
import { serveAdmin, type AdminServer } from "./admin.js";
import { EGRESS_FORMAT, readEgressConfig, readSecrets, type EgressConfig } from "./config.js";
import { EgressProxy, type Dialer, type Resolver } from "./proxy.js";

export interface EgressServer {
  config: EgressConfig;
  proxy: EgressProxy;
  admin: AdminServer;
  /** Closes every session, stops the admin channel and removes its socket. */
  stop(): Promise<void>;
}

export interface ServeOptions {
  /** The configuration file. */
  config: string;
  /** The environment the secrets are read from: the proxy's own. */
  env: NodeJS.ProcessEnv;
  resolve?: Resolver;
  dial?: Dialer;
  lingerMs?: number;
  /** For a test of the real dialer only: see `EgressProxyOptions.upstreamPort`. */
  upstreamPort?: number;
}

/** Starts the proxy: configuration, secrets, then the admin channel. Nothing listens until everything has been read. */
export async function serveEgress(o: ServeOptions): Promise<EgressServer> {
  const config = readEgressConfig(o.config);
  const secrets = readSecrets(config, o.env);
  let ca: string | undefined;
  if (config.ca !== undefined) {
    try {
      ca = readFileSync(config.ca, "utf8");
    } catch (e) {
      throw new Violation("bad_egress_config", `${o.config}: cannot read "ca" ${config.ca}: ${(e as Error).message}`);
    }
  }
  const proxy = new EgressProxy({ config, secrets, ...(ca !== undefined ? { ca } : {}), ...(o.resolve ? { resolve: o.resolve } : {}), ...(o.dial ? { dial: o.dial } : {}), ...(o.lingerMs !== undefined ? { lingerMs: o.lingerMs } : {}), ...(o.upstreamPort !== undefined ? { upstreamPort: o.upstreamPort } : {}) });
  const admin = await serveAdmin(proxy, config.admin);
  return {
    config,
    proxy,
    admin,
    async stop() {
      await proxy.close();
      await admin.close();
    },
  };
}

/** The ready line: what is served where, and the names of the credentials held. */
export function readyLine(s: EgressServer): string {
  const names = s.proxy.credentials();
  return `mandate egress: ready, ${EGRESS_FORMAT} on ${s.admin.path}, sessions on ${s.config.listen}, credentials ${names.length ? names.join(", ") : "none"}\n`;
}

/** Serves until SIGINT or SIGTERM, then stops cleanly. */
export async function serveUntilSignalled(o: ServeOptions, out: (s: string) => void): Promise<void> {
  const server = await serveEgress(o);
  out(readyLine(server));
  await new Promise<void>((ok) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      ok();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await server.stop();
}
