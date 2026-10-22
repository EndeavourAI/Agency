import { describe, expect, test } from "bun:test";
import { parseText } from "../src/state/index.ts";
import { Driver, KEY } from "./helpers.ts";

const open = (): Driver => {
  const d = new Driver();
  d.send(KEY.ctrlComma);
  return d;
};

/** Section 7 (Agents and budgets), first row. */
const budgets = (): Driver => {
  const d = open();
  for (let i = 0; i < 7; i++) d.send(KEY.down);
  d.send(KEY.right);
  return d;
};

describe("a text row of settings", () => {
  test("enter starts typing, text and backspace edit it, enter writes one number", () => {
    const d = budgets();
    d.send(KEY.enter);
    expect(d.state.settings.edit).toBe("");
    d.type("$20");
    d.send("0");
    d.send(KEY.backspace);
    expect(d.state.settings.edit).toBe("$20");
    d.send(KEY.enter);
    expect(d.last("config_write")).toEqual({ type: "config_write", key: "budgets.dailyUsd", value: 20 });
    expect(d.state.settings.edit).toBeNull();
  });

  test("esc leaves the row as it was and writes nothing", () => {
    const d = budgets();
    d.send(KEY.enter);
    d.type("5");
    d.send(KEY.esc);
    expect(d.state.settings.edit).toBeNull();
    expect(d.state.view).toBe("settings");
    expect(d.last("config_write")).toBeUndefined();
  });

  test("an empty value removes the key; a word where a number belongs is refused with a note", () => {
    const d = budgets();
    d.send(KEY.enter);
    d.send(KEY.enter);
    expect(d.last("config_write")).toMatchObject({ key: "budgets.dailyUsd", value: null });
    d.send(KEY.enter);
    d.type("lots");
    d.send(KEY.enter);
    expect(d.effects.filter((e) => e.type === "config_write")).toHaveLength(1);
    expect(d.state.flash).toMatchObject({ tone: "error", text: "lots is not an amount" });
  });

  test("keys typed in a text row are not commands of the screen", () => {
    const d = budgets();
    d.send(KEY.enter);
    d.type("y");
    d.send("n");
    expect(d.state.settings.edit).toBe("yn");
    expect(d.state.view).toBe("settings");
  });

  test("parseText", () => {
    expect(parseText("budgets.monthlyUsd", " $1,200 ")).toBe(1200);
    expect(parseText("compactionLimit", "90000")).toBe(90000);
    expect(parseText("small_model", " anthropic/haiku ")).toBe("anthropic/haiku");
    expect(parseText("budgets.dailyUsd", "")).toBeNull();
    expect(parseText("budgets.dailyUsd", "-3")).toBeInstanceOf(Error);
  });
});

describe("the effort row of the model picker", () => {
  test("left and right step through the levels and wrap; nothing happens with the palette open", () => {
    const d = new Driver();
    d.daemon({ type: "model_open" });
    d.send(KEY.right);
    expect(d.state.effort).toBe("xhigh");
    d.send(KEY.right);
    expect(d.state.effort).toBe("low");
    d.send(KEY.left);
    expect(d.state.effort).toBe("xhigh");
    d.daemon({ type: "model_close" });
    d.send(KEY.ctrl("p"));
    d.send(KEY.right);
    expect(d.state.effort).toBe("xhigh");
  });
});
