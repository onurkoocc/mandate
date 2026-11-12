// Which addresses the egress proxy may connect to (spec/egress.md "Resolution
// and pinning"). A name is resolved once per upstream connection, and every
// address it resolves to must be a public unicast address, unless the
// configuration says `allow_private`. Refused are the private, loopback,
// link-local, unique-local, multicast, reserved and documentation ranges of
// IPv4 and IPv6, which hold the cloud metadata addresses (169.254.169.254,
// 100.100.100.200, fd00:ec2::254); an IPv6 address that carries an IPv4
// address (IPv4-mapped, IPv4-compatible, NAT64, 6to4) is judged by the IPv4
// address it carries.

import { isIP } from "node:net";

type Range = [bytes: number[], bits: number];

const V4: Range[] = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // shared address space (carrier NAT; 100.100.100.200 is a metadata address)
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local (169.254.169.254 is the metadata address of most clouds)
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, and the broadcast address
];

const V6: Range[] = [
  [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96], // unspecified, loopback, IPv4-compatible
  [[0, 0x64, 0xff, 0x9b, 0, 1], 48], // local-use NAT64
  [[1, 0, 0, 0, 0, 0, 0, 0], 64], // discard-only
  [[0x20, 0x01, 0, 0], 23], // IETF protocol assignments: Teredo, benchmarking, ORCHID
  [[0x20, 0x01, 0x0d, 0xb8], 32], // documentation
  [[0x3f, 0xff], 20], // documentation
  [[0x5f, 0x00], 16], // segment routing
  [[0xfc], 7], // unique-local (fd00:ec2::254 is a metadata address)
  [[0xfe, 0x80], 10], // link-local
  [[0xfe, 0xc0], 10], // site-local, deprecated
  [[0xff], 8], // multicast
];

/** Whether the proxy may connect to `address` when private addresses are not allowed. Anything it cannot read is not. */
export function isPublicAddress(address: string): boolean {
  const kind = isIP(address);
  if (kind === 4) return !V4.some((r) => inRange(v4Bytes(address), r));
  if (kind !== 6 || address.includes("%")) return false;
  const b = v6Bytes(address);
  if (!b) return false;
  // The IPv4 address an IPv6 address carries: IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16.
  if (prefixIs(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96) || prefixIs(b, [0, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96)) return isPublicAddress(b.slice(12).join("."));
  if (prefixIs(b, [0x20, 0x02], 16)) return isPublicAddress(b.slice(2, 6).join("."));
  return !V6.some((r) => inRange(b, r));
}

function inRange(b: number[], [prefix, bits]: Range): boolean {
  return prefixIs(b, prefix, bits);
}

function prefixIs(b: number[], prefix: number[], bits: number): boolean {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if (((b[byte] ?? 0) & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
}

function v4Bytes(a: string): number[] {
  return a.split(".").map(Number);
}

/** The sixteen bytes of an IPv6 address `isIP` accepted, including one that ends in a dotted IPv4 address. */
export function v6Bytes(a: string): number[] | undefined {
  let text = a.toLowerCase();
  const tail: number[] = [];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    tail.push(...v4Bytes(dotted[2]!));
    text = dotted[1]!.endsWith("::") ? dotted[1]! : dotted[1]!.slice(0, -1);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const groups = (s: string): number[] => (s === "" ? [] : s.split(":").map((g) => parseInt(g, 16)));
  const head = groups(halves[0]!);
  const rest = halves.length === 2 ? groups(halves[1]!) : [];
  const words = tail.length / 2;
  const missing = 8 - words - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return undefined;
  const all = [...head, ...Array<number>(halves.length === 2 ? missing : 0).fill(0), ...rest];
  const bytes = all.flatMap((w) => [(w >> 8) & 0xff, w & 0xff]);
  return [...bytes, ...tail];
}
