import { describe, expect, test } from "bun:test";
import { type Effort, effortNote, effortOf, type ModelRow, snapEffort } from "../src/state/index.ts";
import { Driver, KEY } from "./helpers.ts";

const row = (id: string, efforts: readonly Effort[]): ModelRow => ({
  ref: `p/${id}`,
  provider: "p",
  providerName: "P",
  id,
  name: id,
  contextWindow: 1000,
  inPerMTok: 1,
  outPerMTok: 1,
  tags: "",
  efforts,
});

const claude = row("claude", ["low", "medium", "high", "xhigh", "max"]);
const gpt = row("gpt", ["low", "medium", "high"]);
const plain = row("plain", ["off"]);

const driver = (): Driver => {
  const d = new Driver();
  d.daemon({
    type: "models_loaded",
    models: [claude, gpt, plain],
    connected: ["p"],
    defaultModel: claude.ref,
  });
  return d;
};

describe("snapEffort", () => {
  test("keeps a supported level", () => {
    expect(snapEffort("high", claude.efforts)).toBe("high");
  });
  test("takes the closest level below an unsupported one", () => {
    expect(snapEffort("xhigh", gpt.efforts)).toBe("high");
    expect(snapEffort("max", gpt.efforts)).toBe("high");
    expect(snapEffort("high", ["off", "medium"])).toBe("medium");
  });
  test("takes the lowest level above when none is below", () => {
    expect(snapEffort("off", gpt.efforts)).toBe("low");
    expect(snapEffort("minimal", ["medium", "high"])).toBe("medium");
  });
  test("a model without reasoning control runs at off", () => {
    expect(snapEffort("high", plain.efforts)).toBe("off");
  });
});

describe("the effort of a turn follows the model", () => {
  test("the preference survives a model that cannot take it, and returns with one that can", () => {
    const d = driver();
    d.daemon({ type: "effort_set", effort: "max" });
    expect(effortOf(d.state, claude.ref)).toBe("max");
    expect(effortOf(d.state, gpt.ref)).toBe("high");
    expect(effortOf(d.state, plain.ref)).toBe("off");
    expect(d.state.effort).toBe("max");
    d.daemon({ type: "model_applied", sessionId: null, ref: plain.ref });
    d.daemon({ type: "model_applied", sessionId: null, ref: claude.ref });
    expect(effortOf(d.state, d.state.defaultModel)).toBe("max");
  });

  test("a model the list does not know keeps the preference", () => {
    const d = driver();
    expect(effortOf(d.state, "other/model")).toBe("high");
    expect(effortOf(d.state, null)).toBe("high");
  });

  test("the turn sends the effective level, off for a model without reasoning", () => {
    const d = driver();
    d.daemon({ type: "session_opened", sessionId: "s1", title: "t" });
    d.daemon({ type: "model_applied", sessionId: "s1", ref: plain.ref });
    d.type("hi");
    d.send(KEY.enter);
    expect(d.last("send_turn")?.effort).toBe("off");
  });

  test("the picker cycles only the levels of the model under the cursor", () => {
    const d = driver();
    d.daemon({ type: "model_open" });
    d.type("gpt");
    d.send(KEY.right);
    expect(d.state.effort).toBe("low");
    d.send(KEY.left);
    expect(d.state.effort).toBe("high");
    d.apply([{ type: "model_query", q: "plain" }]);
    d.send(KEY.right);
    expect(d.state.effort).toBe("high");
  });

  test("the footer shows the effective level and nothing for a model without control", () => {
    const d = driver();
    d.daemon({ type: "session_opened", sessionId: "s1", title: "t" });
    d.daemon({ type: "model_applied", sessionId: "s1", ref: gpt.ref });
    d.daemon({ type: "effort_set", effort: "max" });
    expect(effortNote({ ...d.state, cols: 200 })).toBe(" · high");
    d.daemon({ type: "model_applied", sessionId: "s1", ref: plain.ref });
    expect(effortNote({ ...d.state, cols: 200 })).toBe("");
  });
});
