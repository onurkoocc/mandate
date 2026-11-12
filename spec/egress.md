# Egress (0.5)

**Status: the contract and a reference proxy are implemented in the
TypeScript implementation. Nothing in the runtime uses them yet.** The
runtime's adapters move behind the proxy in a later change, and sandboxes
are connected to it after that.

Outbound traffic goes through one **egress proxy**, and the proxy holds the
secrets. A sandbox, and the runtime's own HTTP clients, hold only
**placeholders**. The proxy swaps a placeholder for the real secret on the
way out, only in the header the secret belongs in, and only toward the hosts
that secret is bound to. A request outside what its session allows is
refused before anything is sent upstream, and the refusal is recorded.

This page is the contract. An organisation may put its own proxy in this
place; a proxy that does what this page says is conforming. The reference
proxy (`mandate egress serve`, `runtime/src/egress/`) implements it, and
is a reference implementation, not a hardened production proxy (see
[Limits](#limits)).

| Part | Where |
|---|---|
| Configuration | [Configuration](#configuration) |
| The admin channel: `hello`, `open_session`, `close_session`, `revoke`, `denials` | [Admin channel](#admin-channel) |
| Sessions: ports, placeholders, expiry, revocation | [Sessions](#sessions) |
| The data path: how a request is read, checked, sent and answered | [The data path](#the-data-path) |
| Denials and their reasons | [Denials](#denials) |
| What the proxy does not protect against | [Limits](#limits) |

## Where secrets live

Only in the proxy. The operator starts it, in an environment of its own; the
runtime does not start it, so the runtime never inherits a secret. The proxy
reads each secret from an environment variable its configuration names, once,
when it starts, and refuses to start when one is missing. A secret is never
logged, never returned on the admin channel, and never written to disk.

## Running the proxy

```sh
MANDATE_EGRESS_GITHUB=… mandate egress serve --config mandate.egress.json
```

`--config` defaults to `./mandate.egress.json`. The command reads no runtime
configuration and opens no database. It reads the configuration and every
secret first; only then does it listen. When it is ready it prints one line:

```
mandate egress: ready, mandate/egress/0.1 on /run/mandate/egress.sock, sessions on 127.0.0.1, credentials github
```

It runs until it receives SIGINT or SIGTERM. It then closes every session
and removes its socket, and exits with status 0. It exits with status 1 and
a message naming the problem when the configuration is malformed
(`bad_egress_config`), a secret's variable is missing or empty
(`egress_secret_missing`), a secret cannot be held (`egress_secret_invalid`,
below), or the admin socket cannot be served (`egress_admin_unavailable`).
A message names a variable, never its value.

## Configuration

```json
{
  "admin": "/run/mandate/egress.sock",
  "listen": "127.0.0.1",
  "credentials": {
    "github": { "env": "MANDATE_EGRESS_GITHUB", "hosts": ["api.github.com"], "header": "authorization", "template": "Bearer {secret}" }
  },
  "allow_private": false,
  "ca": "roots.pem"
}
```

The file is strict JSON: a duplicate key, or a field that is not listed
here, is an error, not a field ignored.

| Field | Meaning |
|---|---|
| `admin` | Required. Where the admin channel listens: a Unix socket path, or a named pipe `\\.\pipe\…` on Windows. A relative path is relative to the file |
| `listen` | A loopback IP address (`127.0.0.0/8` or `::1`), default `127.0.0.1`. Every session listens on its own port of it. A name such as `localhost` is refused |
| `credentials` | The secrets the proxy holds, by name. A name is lower case letters, digits, `_` and `-`, starting with a letter. Default none |
| `credentials.<name>.env` | The environment variable of the proxy's own process that holds the secret |
| `credentials.<name>.hosts` | The only hosts the secret may be sent to: a non-empty list of distinct host names in lower case, or IP addresses, without a port |
| `credentials.<name>.header` | The request header the secret is sent in, in lower case. It cannot be a header the proxy sets or removes itself: `host`, `content-length`, `transfer-encoding`, `connection`, `keep-alive`, `proxy-connection`, `proxy-authorization`, `proxy-authenticate`, `te`, `trailer`, `upgrade`, `expect`, `accept-encoding`, `http2-settings` |
| `credentials.<name>.template` | The header's value, with `{secret}` exactly once where the secret goes, such as `Bearer {secret}` or `{secret}`. Printable ASCII, without leading or trailing spaces |
| `allow_private` | Whether a destination may resolve to a private, loopback, link-local or metadata address ([Resolution](#resolution-and-pinning)). Default `false`. For tests and private upstreams only |
| `ca` | A PEM file of extra trust roots for upstream certificates, as a path relative to the file. The system's roots stay trusted |

A secret is held only when its value is 8 to 8192 bytes of printable ASCII
without spaces (`!` to `~`). A value outside that is refused at start
(`egress_secret_invalid`): it could not be sent as a header value, and a
shorter one would be scrubbed out of ordinary text in every response.

## Admin channel

The admin channel is a Unix socket, or a named pipe on Windows, at
`admin`. Each direction carries one JSON object per line, UTF-8, ended by
`\n`. A line is at most 1 MiB; a longer one is answered with
`line_too_long` and the connection is closed. A request carries an `id` (a
string of at most 128 characters, or a whole number) and an `op`; the
response carries the same `id`. Requests on one connection are answered in
order.

```json
{"id": 1, "op": "hello"}
{"id": 1, "ok": true, "result": {"format": "mandate/egress/0.1", "credentials": ["github"]}}
{"id": 2, "op": "close_session", "session": "nope"}
{"id": 2, "ok": false, "error": {"code": "unknown_session", "message": "no session nope"}}
```

A request is strict JSON. A field an operation does not take is
`bad_request`. A response that could not be matched to a request (the line
was not JSON, or had no valid `id`) carries `"id": null`. Nothing on this
channel ever carries a secret.

### `hello`

Takes no fields. Answers `{ "format": "mandate/egress/0.1", "credentials":
[names] }`: the protocol's version and the names of the credentials the
proxy holds, sorted. A client refuses a proxy that answers another format.

### `open_session`

```json
{
  "id": 3, "op": "open_session",
  "session": "run-17/delegate-3",
  "tenant": "acme", "run": "run-17", "command": "cmd-42",
  "kind": "forward",
  "destinations": [
    { "host": "api.github.com", "methods": ["GET", "POST"], "credential": "github" },
    { "host": "registry.npmjs.org", "methods": null, "credential": null }
  ],
  "ttl_ms": 900000
}
```

Every field is required.

| Field | Meaning |
|---|---|
| `session` | The session's id, chosen by the caller: 1 to 128 letters, digits and `.` `_` `:` `-`. An id already in use is `session_exists` |
| `tenant`, `run`, `command` | Who the session is for: non-empty strings of at most 256 characters without control characters. `revoke` selects by `tenant` and `run` |
| `kind` | `forward` (an HTTP/1.1 forward proxy, for a sandbox) or `gateway` (a base URL, for a client that takes one) |
| `destinations` | 1 to 256 destinations; a `gateway` session has exactly one. A host appears once |
| `destinations[].host` | A host name in lower case, or an IP address, without a port |
| `destinations[].methods` | A non-empty list of distinct method names, compared exactly; or `null`, any method |
| `destinations[].credential` | The name of a credential to send toward this host, or `null` |
| `ttl_ms` | How long the session lives, in milliseconds: 1 to 2147483647 |

The proxy refuses to open a session that binds a credential to a host its
own configuration does not list for that credential
(`credential_not_allowed`), and one that names a credential it does not
hold (`unknown_credential`). Which secret may go where is the proxy's
configuration to say, not the caller's.

A `forward` session answers `{ "proxy_url": "http://127.0.0.1:<port>",
"placeholders": { <name>: "mdt-ph-<32 hex digits>" } }`; a `gateway`
session answers `{ "base_url": "http://127.0.0.1:<port>", "placeholders":
{…} }`. The address is `listen`, in brackets when it is IPv6. `placeholders`
has one entry for each credential the session's destinations name.

### `close_session`

Takes `session`. Closes it ([Sessions](#sessions)) and answers `{ "closed":
<session> }`. An unknown session is `unknown_session`.

### `revoke`

Takes exactly one of `session`, `run`, `tenant` (each a string) or `all`
(`true`). Revokes every session open at that moment that matches, and
answers `{ "revoked": [ids] }`, sorted, with every matching session that is
still known, including one already revoked. A revocation does not prevent
new sessions; refusing new work is the runtime's part.

### `denials`

Takes `session`, and optionally `after` (a denial id, default 0) and
`limit` (1 to 1000, default 100). Answers `{ "denials": [...], "dropped": n
}`: the session's denials whose id is greater than `after`, oldest first, at
most `limit`. A caller pages by passing the last id it got as `after`.
`dropped` counts denials the proxy did not keep: it keeps at most 10 000 per
session. An unknown session is `unknown_session`. The fields of a denial are
under [Denials](#denials).

### Errors

| Code | When |
|---|---|
| `bad_request` | The line is not a JSON object, has no valid `id`, has a field the operation does not take, or a field's value is not what this page says |
| `unknown_op` | `op` is not one of the five |
| `unknown_session` | `close_session` or `denials` names a session the proxy does not know |
| `session_exists` | `open_session` names an id in use |
| `unknown_credential` | A destination names a credential the proxy does not hold |
| `credential_not_allowed` | A destination binds a credential to a host the configuration does not list for it |
| `listen_failed` | The session's port could not be opened |
| `proxy_closed` | The proxy is stopping |
| `line_too_long` | A line is longer than 1 MiB; the connection is closed |
| `internal_error` | Anything else; the message says no more |

### Who may use it

The admin socket is created owner-only: it is bound under a umask of `0177`,
so it is never more than owner read and write, and set to mode `0600`. A
socket file that is left by a proxy that is gone is replaced at start; one
that another process listens on, or a path that is not a socket, stops the
start. Put it in a directory only the operator can write, or another user
could remove it and listen in its place.

On Windows, the admin channel is a named pipe, and the reference proxy
sets no security descriptor of its own: the pipe has Windows' default one
for a named pipe, which grants full control to the creating user,
LocalSystem and Administrators, and read access to Everyone and Anonymous.
Read access does not let another user send a request, but the pipe is not
owner-only as the socket is, and the proxy does not ask Windows to refuse
remote clients. The first proxy to create a pipe name owns it; a second
start on the same name fails.

## Sessions

Each session listens on **its own ephemeral port** of `listen`. A sandbox
layer can open exactly one loopback endpoint into a sandbox, so a session is
one endpoint. A session's placeholders are its own: 128 random bits each,
fresh for every session.

A session is **open** until one of these happens:

- **It expires** `ttl_ms` after it opened. It is then **expired**.
- **It is revoked.** It is then **revoked**.
- **It is closed** (`close_session`, or the proxy stops).

When a session expires or is revoked, every connection it has, to clients
and upstream, is cut at once. Its port keeps answering for ten minutes:
every request on it is denied as `session_expired` or `session_revoked`, and
recorded, so `denials` still answers. After that, or at `close_session`, the
session is closed: its port stops listening (a connection is refused, and
nothing is recorded), its connections are cut, and it is forgotten, with
its denials.

## The data path

### Reading a request

The proxy reads **one request per connection**. It answers it, then closes
the connection; bytes the client sent after the first request are read and
dropped, never read as a second request. A response always says
`connection: close`.

The request head is read strictly, as bytes, and must arrive within 30
seconds; a head that does not is dropped without an answer. A request is
refused as `malformed_request`, with nothing sent upstream, when:

- a line of the head does not end in CRLF: a bare CR or LF anywhere in it;
- the head is longer than 64 KiB, or has more than 100 header lines;
- the request line is not a method, a target and a version separated by
  single spaces; the method is not a token of at most 32 characters; the
  target has a byte outside visible ASCII;
- the version is not `HTTP/1.1`;
- a header line starts with a space or a tab (obsolete line folding), has
  no name, or has white space before its colon;
- a header value has a control character other than tab;
- `Content-Length` appears together with `Transfer-Encoding`;
- `Content-Length` appears more than once, even with the same value, or is
  not a single decimal number;
- `Transfer-Encoding` appears more than once, or is anything other than
  `chunked` alone;
- `Host` appears more than once;
- `Expect` appears more than once, or is anything other than
  `100-continue`;
- the target is not of the form the session takes (below).

A request whose length is ambiguous is therefore never forwarded, and no
upstream connection is ever shared, so a request cannot be smuggled.

A request is refused as `upgrade_not_allowed` when it has an `Upgrade` or
`HTTP2-Settings` header, or a `Connection` header that names `upgrade`, or
when its request line is HTTP/2's preface (`PRI * HTTP/2.0`) or names
HTTP/2 or HTTP/3. The proxy speaks HTTP/1.1 only, and never upgrades a
connection.

The body is read as the head frames it: `Content-Length` bytes, or chunked
(chunk extensions and trailers are read and dropped), or none. With
`Expect: 100-continue`, the proxy answers `100 Continue` once the request
has been allowed and the upstream connection is open. Request bodies are
**not scanned**: a placeholder in a body is neither swapped nor refused. A
body whose chunked framing breaks after the request was allowed aborts it:
the upstream connection is cut, the client gets a 400 if no response has
started, and this is not a denial, since the head had been allowed.

### Forward sessions

A `forward` session is an HTTP/1.1 forward proxy. It takes:

- **absolute-form** requests, `GET http://host/path?query HTTP/1.1`, to any
  of its destinations. The scheme is `http`, in any case. The authority is a
  host name or IP address (IPv6 in brackets), with no user information, and
  optionally a port. The proxy sends the request on **over TLS** to port
  443 of the host. The port in the URL must be absent, 80 or 443; any other
  is `port_not_allowed`. A URL with no path has the path `/`. A fragment is
  `malformed_request`.
- **`CONNECT host:443`**, to a destination with **neither** a credential
  **nor** a method restriction (`methods: null` and `credential: null`).
  The proxy answers `200 Connection Established` and relays bytes both ways
  between the client and port 443 of the host. It does not see inside the
  tunnel, so a destination with a credential or a method restriction is
  reached through absolute-form `http://` only. `CONNECT` to such a
  destination, or to a port other than 443, is `connect_not_allowed`.

An origin-form request (`GET /path`) to a forward session is
`malformed_request`.

There is no TLS interception. A client reaches a credentialed or
method-restricted destination as `http://host/…` through the proxy; the
hop between the client and the proxy is local and in clear text, and the
hop upstream is TLS.

### Gateway sessions

A `gateway` session is for a client that takes a base URL instead of a
proxy, such as the runtime's own HTTP clients. It has exactly one
destination. It takes **origin-form** requests (`POST /v1/messages
HTTP/1.1`) at its `base_url`, and sends them on, over TLS, to port 443 of
its destination. An absolute-form request, or any target that does not
start with `/`, is `malformed_request`; `CONNECT` is `connect_not_allowed`.
Every other rule on this page holds for it as for a forward session.

### Hosts and methods

The target host comes from the request target: the absolute-form URL's
host, the `CONNECT` authority's host, or a gateway session's destination.
It is compared, in lower case, with the session's destinations exactly: no
wildcard, no trailing-dot or IDNA folding. A host that is not one of them
is `host_not_allowed`. A method that is not one of its destination's
`methods` is `method_not_allowed`; `null` allows every method.

A `Host` header the client sent is not used and not sent upstream: the
proxy sends the target host as `Host` (RFC 9112 §3.2.2 says a proxy
replaces it for absolute-form). Rewriting rather than refusing a `Host` that
disagrees leaves no way for the upstream to route on a host the proxy did
not check.

### Placeholders

A placeholder is `mdt-ph-` followed by 32 lower-case hexadecimal digits.

The proxy replaces a placeholder with its secret **only** when all of these
hold:

- the request is not a `CONNECT`;
- its target host is a destination of the session that names a credential;
- the request has that credential's configured `header` exactly once;
- that header's value is exactly the credential's `template` with **this
  session's** placeholder for that credential in place of `{secret}`.

The header is then sent upstream with the secret in the placeholder's
place. Any text of the placeholder's form seen anywhere else in the request
target or in a header name or value, whether this session's placeholder,
another session's, or one of no session, is `placeholder_misuse`. That
covers a placeholder in another header, in the URL or the host, in the
configured header with any other value, in a repeated configured header,
in a request to a destination with no credential or with another
credential, and in a `CONNECT`.

A request to a credentialed destination that carries no placeholder is
sent on without the credential.

### Resolution and pinning

For each upstream connection, so for each request, the proxy resolves the
target host once, and checks **every** address it resolves to. Unless
`allow_private` is true, the request is `resolved_private` when any of
them is in one of these ranges:

| IPv4 | IPv6 |
|---|---|
| `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10` (shared, holds `100.100.100.200`), `127.0.0.0/8`, `169.254.0.0/16` (link-local, holds `169.254.169.254`), `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.88.99.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4` | `::/96` (unspecified, loopback, IPv4-compatible), `64:ff9b:1::/48`, `100::/64`, `2001::/23`, `2001:db8::/32`, `3fff::/20`, `5f00::/16`, `fc00::/7` (unique-local, holds `fd00:ec2::254`), `fe80::/10`, `fec0::/10`, `ff00::/8`, and any address with a zone |

An IPv6 address that carries an IPv4 address is judged by the IPv4 address:
IPv4-mapped `::ffff:0:0/96`, NAT64 `64:ff9b::/96`, and 6to4 `2002::/16`. An
IP literal as host is not resolved, and is checked the same way. A name
that does not resolve is answered 502, and is not a denial.

The connection then goes to the **first** address, the one that was
checked, and to no other: a name that resolves differently by the time the
connection is made is not resolved again. The next request resolves anew.

### Upstream TLS

The proxy connects to port 443 of the checked address over TLS, with the
target host as SNI (none for an IP address), offering `http/1.1` by ALPN,
and verifies the upstream's certificate for the target host against the
system's trust roots and `ca`. A certificate that does not verify ends the
request with a 502 before anything is sent. A `CONNECT` tunnel is plain TCP
to port 443; its TLS is the client's own.

### What is sent upstream

One upstream connection per request, never shared, with `connection:
close`. The request line is the method and the path and query, in origin
form. The headers are the client's, in order, except:

- the hop-by-hop headers (RFC 9110 §7.6.1): `connection`, `keep-alive`,
  `proxy-connection`, `te`, `trailer`, `transfer-encoding`, `upgrade`, and
  every header the `Connection` header names;
- `proxy-authorization`, `proxy-authenticate` and `http2-settings`;
- `host`, `content-length`, `expect` and `accept-encoding`, which the proxy
  sets itself: `host` as the target host, `accept-encoding: identity`, and
  the body's framing as `content-length` or `transfer-encoding: chunked`.

The configured header carries the secret when the placeholder rule allows
it, and is otherwise sent as the client sent it.

### Responses

The proxy does not follow redirects: a 3xx goes back to the client as the
upstream sent it. It relays the status, the headers except the hop-by-hop
ones and `content-length`, and the body, framed as `transfer-encoding:
chunked` (none for `HEAD`, 1xx, 204 and 304). A body that is cut upstream
reaches the client without its last chunk, so the client sees the cut.

Every secret the proxy holds is **scrubbed** from the response: wherever
its exact bytes appear in the status line, a header name or value, or the
body, they are replaced by the session's placeholder for that credential,
or by `mdt-redacted` when the session has none. In the body this holds
across chunk boundaries: the proxy holds back the last bytes of what it has
read, fewer than the longest secret, until the next bytes show whether they
begin one.

The proxy asks for `accept-encoding: identity` so that it can see the
bytes. A response with a `content-encoding` other than `identity`, or a
transfer coding other than `chunked`, is not relayed: the client gets a 502.
Only the exact bytes are caught: a secret the upstream transformed or
encoded (base64, percent-encoding, split by markup, in a compressed body it
was sent despite the request) is not.

A request that was allowed but could not be carried out (a name that does
not resolve, an upstream that cannot be reached or whose certificate does
not verify, an upstream that fails) is answered 502 with `{"error":
"egress_upstream", "detail": …}`, and is not a denial.

## Denials

A request that a rule refuses is **denied**: nothing of it is sent
upstream, it is recorded for `denials`, and it is answered with:

```
HTTP/1.1 403 Forbidden
content-type: application/json
x-mandate-egress-denied: host_not_allowed
connection: close

{"error":"egress_denied","why":"host_not_allowed","detail":"evil.example is not one of the session's destinations"}
```

The status is 400 for `malformed_request`, a request that could not be
read in one way, and 403 for every other reason.

| Reason | When |
|---|---|
| `host_not_allowed` | The target host is not one of the session's destinations |
| `method_not_allowed` | The method is not one of the destination's methods |
| `placeholder_misuse` | A placeholder is anywhere but the one header it may be swapped in ([Placeholders](#placeholders)) |
| `connect_not_allowed` | `CONNECT` to a destination with a credential or a method restriction, to a port other than 443, or on a gateway session |
| `resolved_private` | The host resolves to, or is, an address the proxy does not connect to |
| `session_revoked` | The session was revoked |
| `session_expired` | The session expired |
| `port_not_allowed` | An absolute-form URL names a port other than 80 or 443 |
| `upgrade_not_allowed` | The request asks to upgrade the connection, or speaks HTTP/2 |
| `malformed_request` | The request could not be read in exactly one way ([Reading a request](#reading-a-request)), or its target is not of the form the session takes |

When more than one rule applies, the first in this order is the reason:
the session's state; a head that could not be read; an upgrade; the
target's form; a repeated `Host`; `Expect`; a placeholder; the host; the
`CONNECT` rules, or else the port; the method; and, after resolution, the
address.

A recorded denial is:

```json
{ "id": 41, "host": "evil.example", "method": "GET", "why": "host_not_allowed", "path_digest": "sha256:9f86…", "at": "2026-11-13T09:12:01.512Z" }
```

| Field | Meaning |
|---|---|
| `id` | A whole number; ids increase across all of the proxy's sessions |
| `host` | The target host, or `null` when there was none or it carried a placeholder |
| `method` | The method, or `null` when it could not be read |
| `why` | The reason |
| `path_digest` | `sha256:` and the hex SHA-256 of the request target's path and query as received (the whole target for origin-form); `null` for `CONNECT` or when there was none. Never the path itself |
| `at` | When, as an ISO 8601 time in UTC |

A denial never carries a header, a body, a path or a placeholder.

## Limits

These are what the contract does not protect against, stated rather than
hidden:

- **Any local process can connect to a session's port.** The port listens
  on loopback, not on something only the sandbox can reach. What protects a
  credential is the per-session placeholder: 128 random bits that only the
  session's holder has. A process without it can send requests only to
  that session's destinations, with that session's methods, and without
  the credential.
- **The admin channel is protected by file permissions** on POSIX, and by
  the default named pipe security descriptor on Windows, which is weaker
  ([Who may use it](#who-may-use-it)). Whoever can reach it can open
  sessions with any credential toward the hosts the configuration binds it
  to.
- **DNS can change between requests.** Each request is pinned to the
  address it checked, but a later request resolves again, and a host can
  resolve to different public addresses over time.
- **Request bodies are not scanned**, and a placeholder that is encoded in
  a URL (percent-encoded) is not recognised as one. Neither is ever swapped
  for the secret.
- **Only a secret's exact bytes are scrubbed** from a response; a secret
  the upstream transformed is not caught.
- **A `CONNECT` tunnel is opaque.** The proxy checks its host and port, and
  nothing inside it.
- **The reference proxy is a reference implementation**, not a hardened
  production proxy: it holds every session in one process's memory, keeps
  denials only in memory, has fixed timeouts (30 seconds for a request head
  and for connecting upstream, ten minutes idle), at most 128 connections
  per session, and no rate limit.

## The reference proxy

`runtime/src/egress/`:

| File | What it does |
|---|---|
| `config.ts` | Reads and checks the configuration strictly; reads the secrets from the environment |
| `admin.ts` | The admin channel: the socket or pipe, the line protocol, the five operations |
| `client.ts` | `EgressClient`, the client of the admin channel |
| `proxy.ts` | `EgressProxy`: sessions and the data path |
| `http1.ts` | The strict reading of a request head and body, and the scrubber |
| `addresses.ts` | Which addresses the proxy connects to |
| `main.ts` | `mandate egress serve` |

How an upstream connection is made (`Dialer`) and how a name is resolved
(`Resolver`) are passed in, so that tests use an in-process upstream and no
network, and no key is committed. A test of the real dialer makes a key and
certificate with `openssl` when it runs, on Linux.

```ts
class EgressClient {
  static connect(path: string, o?: { timeoutMs?: number }): Promise<EgressClient>;
  hello(): Promise<{ format: string; credentials: string[] }>;
  openSession(r: SessionRequest & { kind: "forward" }): Promise<{ proxy_url: string; placeholders: Record<string, string> }>;
  openSession(r: SessionRequest & { kind: "gateway" }): Promise<{ base_url: string; placeholders: Record<string, string> }>;
  closeSession(session: string): Promise<void>;
  revoke(scope: { session: string } | { run: string } | { tenant: string } | { all: true }): Promise<string[]>;
  denials(session: string, o?: { after?: number; limit?: number }): Promise<{ denials: Denial[]; dropped: number }>;
  close(): void;
}
```

A failed operation rejects with an `EgressError` whose `code` is the
error's code; a proxy that cannot be reached, closes the connection, or
does not answer within `timeoutMs` (default 10 seconds) is
`egress_unavailable`.
