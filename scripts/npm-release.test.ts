import { describe, expect, test } from "bun:test";
import { gate, npmTag, publishPlan } from "./npm-release.ts";

const base = {
  event: "push",
  refType: "branch",
  refName: "master",
  version: "1.2.3",
  onNpm: false,
  tagExists: false,
};

describe("gate", () => {
  test("a master push with a new version builds and publishes", () => {
    expect(gate(base)).toEqual({ build: true, publish: true });
  });
  test("a merge without a version bump does nothing", () => {
    expect(gate({ ...base, onNpm: true })).toEqual({ build: false, publish: false });
    expect(gate({ ...base, tagExists: true })).toEqual({ build: false, publish: false });
  });
  test("a dispatch builds and never publishes", () => {
    expect(gate({ ...base, event: "workflow_dispatch" })).toEqual({ build: true, publish: false });
  });
  test("a tag push does not publish twice, and must match the version", () => {
    const tag = { ...base, refType: "tag", refName: "v1.2.3", tagExists: true };
    expect(gate(tag)).toEqual({ build: true, publish: true });
    expect(gate({ ...tag, onNpm: true })).toEqual({ build: false, publish: false });
    expect(() => gate({ ...tag, refName: "v9.9.9" })).toThrow();
  });
});

test("prereleases go to next", () => {
  expect(npmTag("0.2.0-rc.0")).toBe("next");
  expect(npmTag("0.2.0")).toBe("latest");
});

test("the wrapper is published last", () => {
  const v = "1.2.3";
  const plan = publishPlan(
    [
      `endeavourai-agency-${v}.tgz`,
      `endeavourai-agency-linux-x64-musl-${v}.tgz`,
      `endeavourai-agency-win32-x64-${v}.tgz`,
    ],
    v,
  );
  expect(plan.map((p) => p.name)).toEqual([
    "@endeavourai/agency-linux-x64-musl",
    "@endeavourai/agency-win32-x64",
    "@endeavourai/agency",
  ]);
  expect(() => publishPlan(["other-1.0.0.tgz"], "1.0.0")).toThrow();
});
