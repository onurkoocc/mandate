// A proxy that does not take the admin connection (on a Unix socket, one whose backlog is full takes none) does not
// hold a caller for ever: the client gives up after its timeout, `egress_unavailable`. The socket that never connects
// is made here; nothing reaches the network.

import { describe, expect, it, vi } from "vitest";

vi.mock("node:net", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:net")>();
  return { ...real, connect: (o: { path: string }) => (o.path === "never-connects" ? new real.Socket() : real.connect(o as never)) };
});

const { EgressClient } = await import("../src/egress/client.js");
const { EgressLink } = await import("../src/gateway.js");

describe("the admin connection", () => {
  it("is given up on after the client's timeout, naming the proxy", async () => {
    const t = Date.now();
    await expect(EgressClient.connect("never-connects", { timeoutMs: 200 })).rejects.toMatchObject({ code: "egress_unavailable", message: expect.stringContaining("the egress proxy at never-connects did not take the connection within 200 ms") });
    expect(Date.now() - t).toBeLessThan(5000);
  });

  it("is given up on by a revoke, which says the proxy did not revoke", async () => {
    const link = new EgressLink({ admin: "never-connects", timeoutMs: 200 });
    await expect(link.revoke({ all: true })).rejects.toThrow(/^egress_unavailable: the egress proxy at never-connects did not revoke \{"all":true\}: .*did not take the connection within 200 ms/);
    await link.closeAll();
  });
});
