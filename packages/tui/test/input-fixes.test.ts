import { describe, expect, test } from "bun:test";
import { Driver, KEY } from "./helpers.ts";

function session(): Driver {
  const d = new Driver();
  d.daemon(
    { type: "viewport", cols: 120, rows: 40 },
    { type: "conn", status: "online" },
    { type: "slash_loaded", slash: [{ name: "compact", desc: "", meta: "" }] },
    { type: "session_opened", sessionId: "s1" },
  );
  return d;
}

describe("a slash in a session", () => {
  test("a path-like prompt is sent as a prompt, not lost as a command", () => {
    const d = session();
    d.type("/etc/hosts has the wrong entry");
    d.send(KEY.enter);
    expect(d.last("slash_command")).toBeUndefined();
    expect(d.last("send_turn")).toMatchObject({ text: "/etc/hosts has the wrong entry" });
  });

  test("a known command with arguments still goes to the daemon", () => {
    const d = session();
    d.type("/compact keep the tests");
    d.send(KEY.enter);
    expect(d.last("slash_command")).toMatchObject({ sessionId: "s1", text: "/compact keep the tests" });
  });
});

describe("paste and backslash", () => {
  test("a pasted ! stays text and sends as a prompt", () => {
    const d = session();
    d.send("\x1b[200~!rm -rf build\x1b[201~");
    expect(d.state.composer).toMatchObject({ text: "!rm -rf build", shell: false });
    d.send(KEY.enter);
    expect(d.last("shell_run")).toBeUndefined();
    expect(d.last("send_turn")).toMatchObject({ text: "!rm -rf build" });
  });

  test("a shell command ending in a backslash runs", () => {
    const d = session();
    d.type("!dir C:\\");
    d.send(KEY.enter);
    expect(d.last("shell_run")).toMatchObject({ command: "dir C:\\" });
  });

  test("a prompt ending in a drive root sends; a plain trailing backslash continues", () => {
    const d = session();
    d.type("one\\");
    d.send(KEY.enter);
    expect(d.state.composer.text).toBe("one\n");
    expect(d.last("send_turn")).toBeUndefined();
    const p = session();
    p.type("list C:\\");
    p.send(KEY.enter);
    expect(p.last("send_turn")).toMatchObject({ text: "list C:\\" });
  });
});
