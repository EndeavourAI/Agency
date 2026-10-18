import { describe, expect, test } from "bun:test";
import { FULL_CAPABILITIES, SandboxBoundary } from "@agency/guard";
import type { HttpClient } from "@agency/net";
import { createFetchTool } from "../../src/builtins/fetch.ts";
import type { ToolDeps } from "../../src/contract.ts";

function deps(capabilities = FULL_CAPABILITIES): ToolDeps {
  return { identity: { type: "user" }, capabilities, sandbox: new SandboxBoundary(".") };
}

const signal = new AbortController().signal;

describe("createFetchTool", () => {
  test("returns the response body as text", async () => {
    const http: HttpClient = { fetch: async () => new Response("hello world", { status: 200 }) };
    const tool = createFetchTool(deps(), http);

    const result = await tool.handler({ url: "https://example.com" }, { signal });

    expect(result.content).toBe("hello world");
    expect(result.isError).toBeFalsy();
  });

  test("reports a non-2xx response as an error with status and body", async () => {
    const http: HttpClient = {
      fetch: async () => new Response("not found", { status: 404, statusText: "Not Found" }),
    };
    const tool = createFetchTool(deps(), http);

    const result = await tool.handler({ url: "https://example.com/missing" }, { signal });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("404");
  });

  test("truncates a very large response body", async () => {
    const http: HttpClient = { fetch: async () => new Response("x".repeat(60_000), { status: 200 }) };
    const tool = createFetchTool(deps(), http);

    const result = await tool.handler({ url: "https://example.com" }, { signal });

    expect(result.content).toContain("[truncated");
    expect(result.content.length).toBeLessThan(51_000);
  });

  test("denies a host not covered by network capabilities", async () => {
    const http: HttpClient = { fetch: async () => new Response("should not be reached") };
    const scoped = deps({ ...FULL_CAPABILITIES, network: ["allowed.example.com"] });
    const tool = createFetchTool(scoped, http);

    // No one to ask: refused, and the host is not reached.
    const refused = await tool.handler({ url: "https://evil.example.com" }, { signal });
    expect(refused.isError).toBe(true);
    expect(refused.content).not.toContain("should not be reached");
  });

  test("past the network limit the user is asked for that host, as bash asks with network: true", async () => {
    const http: HttpClient = { fetch: async () => new Response("page") };
    const tool = createFetchTool(deps({ ...FULL_CAPABILITIES, network: "none" }), http);
    const asked: Array<{ source?: string; command?: string }> = [];
    const answer =
      (response: "once" | "reject") => async (request: { source?: string; command?: string }) => {
        asked.push(request);
        return response;
      };
    const no = await tool.handler(
      { url: "https://docs.example.com/a" },
      { signal, requestApproval: answer("reject") },
    );
    expect(no.isError).toBe(true);
    const yes = await tool.handler(
      { url: "https://docs.example.com/a" },
      { signal, requestApproval: answer("once") },
    );
    expect(yes.content).toBe("page");
    expect(asked).toEqual([
      expect.objectContaining({ source: "sandbox:network", command: "fetch docs.example.com" }),
      expect.objectContaining({ source: "sandbox:network", command: "fetch docs.example.com" }),
    ]);
  });
});

test("follows a redirect on the same host; a redirect to another host comes back as a note, not fetched", async () => {
  const asked: string[] = [];
  const http: HttpClient = {
    fetch: async (url) => {
      asked.push(url);
      if (url === "https://allowed.dev/a")
        return new Response(null, { status: 302, headers: { location: "/b" } });
      if (url === "https://allowed.dev/b")
        return new Response(null, { status: 301, headers: { location: "http://169.254.169.254/latest" } });
      return new Response("should not be read", { status: 200 });
    },
  };
  const tool = createFetchTool(deps(), http);
  const result = await tool.handler({ url: "https://allowed.dev/a" }, { signal });
  expect(asked).toEqual(["https://allowed.dev/a", "https://allowed.dev/b"]);
  expect(result.content).toContain("redirects to http://169.254.169.254/latest");
  expect(result.content).not.toContain("should not be read");
});
