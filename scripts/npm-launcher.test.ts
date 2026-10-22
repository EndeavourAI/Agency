import { describe, expect, test } from "bun:test";
import { PLATFORMS, platformPackage } from "./npm-launcher.ts";

describe("platformPackage", () => {
  test("picks the package of each supported platform", () => {
    expect(platformPackage("win32", "x64", undefined)?.name).toBe("@endeavourai/agency-win32-x64");
    expect(platformPackage("darwin", "arm64", undefined)?.name).toBe("@endeavourai/agency-darwin-arm64");
    expect(platformPackage("darwin", "x64", undefined)?.name).toBe("@endeavourai/agency-darwin-x64");
    expect(platformPackage("linux", "x64", "glibc")?.name).toBe("@endeavourai/agency-linux-x64");
    expect(platformPackage("linux", "arm64", "glibc")?.name).toBe("@endeavourai/agency-linux-arm64");
  });
  test("linux splits on libc", () => {
    expect(platformPackage("linux", "x64", "musl")?.name).toBe("@endeavourai/agency-linux-x64-musl");
    expect(platformPackage("linux", "arm64", "musl")?.target).toBe("bun-linux-arm64-musl");
  });
  test("an unsupported platform has none", () => {
    expect(platformPackage("win32", "arm64", undefined)).toBeUndefined();
    expect(platformPackage("freebsd", "x64", undefined)).toBeUndefined();
    expect(platformPackage("linux", "ia32", "glibc")).toBeUndefined();
  });
  test("every package maps to a distinct build artifact", () => {
    expect(new Set(PLATFORMS.map((p) => p.artifact)).size).toBe(PLATFORMS.length);
    expect(PLATFORMS.find((p) => p.os === "win32")?.artifact).toBe("agency-windows-x64.exe");
  });
});
