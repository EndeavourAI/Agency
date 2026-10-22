import { lookup } from "node:dns/promises";
import { BlockList, connect, createServer, isIP, type Socket } from "node:net";

/** Addresses off the internet: this machine, its networks, link-local (cloud metadata), multicast and reserved. */
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["224.0.0.0", 3],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [
  ["::", 127],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  PRIVATE.addSubnet(net, bits, "ipv6");

/** The 16 bytes of an IPv6 address. */
function ipv6Bytes(ip: string): number[] {
  let text = ip.replace(/%.*$/, "");
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number) as [number, number, number, number];
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const all =
    tail === undefined
      ? groups(head)
      : [...groups(head), ...Array(8 - groups(head).length - groups(tail).length).fill("0"), ...groups(tail)];
  return all.flatMap((group) => {
    const value = Number.parseInt(group, 16);
    return [value >> 8, value & 0xff];
  });
}

/** The IPv4 address that an IPv6 one carries: mapped, compatible, NAT64 (`64:ff9b::/96`) or 6to4 (`2002::/16`). */
function embeddedIPv4(ip: string): string | undefined {
  const bytes = ipv6Bytes(ip);
  const v4 = (at: number): string => bytes.slice(at, at + 4).join(".");
  const zero = (from: number, to: number): boolean => bytes.slice(from, to).every((byte) => byte === 0);
  if (zero(0, 10) && bytes[10] === bytes[11] && (bytes[10] === 0 || bytes[10] === 0xff)) return v4(12);
  if (bytes[0] === 0 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b && zero(4, 12))
    return v4(12);
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return v4(2);
  return undefined;
}

/** True for an address that is not a public one, and for text that is no address. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 4) return PRIVATE.check(address, "ipv4");
  const v4 = embeddedIPv4(address);
  return v4 === undefined ? PRIVATE.check(address, "ipv6") : PRIVATE.check(v4, "ipv4");
}

/** True when `host` is one of `allowed`: an exact name, or `*.example.com` for the names under it. No regard to case. */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  // A URL writes an IPv6 host in brackets: `[::1]`.
  const unbracket = (text: string): string => text.replace(/^\[(.*)\]$/, "$1");
  const name = unbracket(host.toLowerCase().replace(/\.$/, ""));
  // A NUL or another byte that no host name has could make `evil\0.github.com` end with `.github.com`.
  if (!/^[a-z0-9_.-]+$/.test(name) && isIP(name) === 0) return false;
  return allowed.some((pattern) => {
    const p = unbracket(pattern.toLowerCase());
    return p.startsWith("*.") ? name.endsWith(p.slice(1)) : name === p;
  });
}

/** The host, port and path of a proxy request: `host:port` for CONNECT, an absolute URL for plain HTTP. */
function targetOf(method: string, target: string): { host: string; port: number; path: string } | undefined {
  if (method === "CONNECT") {
    const m = /^\[?([^\]]+?)\]?:(\d+)$/.exec(target);
    return m?.[1] && m[2] ? { host: m[1], port: Number(m[2]), path: "" } : undefined;
  }
  try {
    const url = new URL(target);
    if (url.protocol !== "http:") return undefined;
    return {
      host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || 80),
      path: `${url.pathname}${url.search}`,
    };
  } catch {
    return undefined;
  }
}

const MAX_HEAD_BYTES = 64 * 1024;

/**
 * The address to connect to for an allowed host. A name that resolves to a private address is refused, as in Claude
 * Code: else an allowed name whose DNS points at 127.0.0.1 or 169.254.169.254 reaches this machine or the cloud
 * metadata. `localhost` and an address in the list itself pass. The connection goes to the checked address.
 */
async function addressOf(
  host: string,
  allowed: readonly string[],
  resolve: (host: string) => Promise<string[]>,
): Promise<string[] | { refused: string }> {
  if (host.toLowerCase() === "localhost" || (isIP(host) !== 0 && hostAllowed(host, allowed))) return [host];
  const addresses = await resolve(host).catch((): string[] => []);
  if (addresses.length === 0) return { refused: `${host} does not resolve` };
  const inside = addresses.find(isPrivateAddress);
  if (inside !== undefined) return { refused: `${host} resolves to the private address ${inside}` };
  return addresses;
}

const resolveAll = async (host: string): Promise<string[]> =>
  (await lookup(host, { all: true })).map((entry) => entry.address);

export interface DomainProxy {
  /** The TCP port, when it listens on one. */
  port?: number;
  close(): void;
}

/**
 * An HTTP proxy that passes only the hosts of `allowed`: CONNECT for HTTPS, an absolute URL for plain HTTP. The
 * sandbox lets a command reach this proxy and nothing else, so the list holds for every program that uses a proxy.
 */
export function startDomainProxy(
  allowed: readonly string[],
  listen: { path: string } | { host: string; port: number },
  resolveHost: (host: string) => Promise<string[]> = resolveAll,
): Promise<DomainProxy> {
  const server = createServer((client) => {
    let head = Buffer.alloc(0);
    client.on("error", () => {});
    const onData = (chunk: Buffer): void => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      const lineEnd = head.indexOf("\r\n");
      const [method = "", target = "", version = "HTTP/1.1"] = head
        .subarray(0, lineEnd)
        .toString("latin1")
        .split(" ");
      const dest = targetOf(method, target);
      const refuse = (why: string): void => {
        client.end(
          `HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nagency sandbox: ${why}\n`,
        );
      };
      if (!dest || !hostAllowed(dest.host, allowed)) {
        refuse(`${dest?.host ?? target} is not in sandbox.allowedDomains`);
        return;
      }
      // Before the lookup: a client that leaves while it runs must not leave a connection open.
      let upstream: Socket | undefined;
      let closed = false;
      client.on("close", () => {
        closed = true;
        upstream?.destroy();
      });
      void addressOf(dest.host, allowed, resolveHost).then((addresses) => {
        if (!Array.isArray(addresses)) return refuse(addresses.refused);
        // Each checked address in turn, as a connect by name would: the first can be IPv6 with no route.
        const attempt = (index: number): void => {
          if (closed) return;
          let open = false;
          const socket: Socket = connect(dest.port, addresses[index] as string, () => {
            open = true;
            if (method === "CONNECT") {
              client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
              socket.write(head.subarray(end + 4));
            } else {
              // The site gets the path, not the absolute URL; the rest of the head and the body go as they came.
              socket.write(
                Buffer.concat([
                  Buffer.from(`${method} ${dest.path} ${version}`, "latin1"),
                  head.subarray(lineEnd),
                ]),
              );
            }
            client.pipe(socket);
            socket.pipe(client);
            client.resume();
          });
          upstream = socket;
          socket.on("error", () => {
            if (open) client.destroy();
            else if (index + 1 < addresses.length) attempt(index + 1);
            else client.end("HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n");
          });
        };
        attempt(0);
      });
    };
    client.on("data", onData);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    const ready = (): void => {
      server.unref();
      const address = server.address();
      resolve({
        ...(typeof address === "object" && address ? { port: address.port } : {}),
        close: () => server.close(),
      });
    };
    if ("path" in listen) server.listen(listen.path, ready);
    else server.listen(listen.port, listen.host, ready);
  });
}
