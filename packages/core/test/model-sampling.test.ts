import { expect, test } from "bun:test";
import { temperatureFor } from "../src/model-sampling.ts";

test("open models get their vendor's temperature, others the provider's default", () => {
  expect(temperatureFor("z-ai/glm-4.6")).toBe(1.0);
  expect(temperatureFor("minimax/minimax-m2")).toBe(1.0);
  expect(temperatureFor("moonshotai/kimi-k2-0905")).toBe(0.6);
  expect(temperatureFor("moonshotai/kimi-k2.5")).toBe(1.0);
  expect(temperatureFor("qwen/qwen3-coder:free")).toBe(0.7);
  expect(temperatureFor("claude-haiku-5-5")).toBeUndefined();
  expect(temperatureFor("gpt-5.1")).toBeUndefined();
});
