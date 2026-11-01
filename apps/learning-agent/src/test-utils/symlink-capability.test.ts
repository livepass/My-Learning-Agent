import { existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isWithin } from "../utils/path-safety.js";

vi.mock("node:fs", async (original) => {
	const actual = await original<typeof import("node:fs")>();
	return { ...actual, symlinkSync: vi.fn() };
});

beforeEach(() => {
	vi.resetModules();
	vi.stubEnv("CI", "");
	vi.stubEnv("INNO_TEST_REQUIRE_FILE_SYMLINKS", "");
	vi.mocked(symlinkSync).mockReset().mockImplementation(() => {
		throw Object.assign(new Error("simulated unavailable symlink privilege"), { code: "EPERM" });
	});
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("file symlink test capability", () => {
	it("reports an unsupported local capability and removes its real probe directory", async () => {
		const { fileSymlinkCapability, fileSymlinkTestName } = await import("./symlink-capability.js");
		const capability = fileSymlinkCapability();
		expect(capability).toEqual({ supported: false, reason: "EPERM" });
		expect(fileSymlinkTestName("file-link safety", capability)).toBe("file-link safety [not run: file symlinks unavailable (EPERM)]");
		expect(fileSymlinkCapability()).toBe(capability);
		expect(symlinkSync).toHaveBeenCalledTimes(1);
		const probeRoot = dirname(String(vi.mocked(symlinkSync).mock.calls[0][0]));
		expect(isWithin(resolve(tmpdir()), probeRoot)).toBe(true);
		expect(basename(probeRoot)).toMatch(/^inno-file-symlink-probe-/);
		expect(existsSync(probeRoot)).toBe(false);
	});

	it.each(["CI", "INNO_TEST_REQUIRE_FILE_SYMLINKS"])("requires real coverage when %s enables strict mode", async (name) => {
		vi.stubEnv(name, name === "CI" ? "true" : "1");
		const { fileSymlinkCapability } = await import("./symlink-capability.js");
		expect(() => fileSymlinkCapability()).toThrow("Real file symlinks are required for security tests but unavailable (EPERM)");
		const probeRoot = dirname(String(vi.mocked(symlinkSync).mock.calls[0][0]));
		expect(existsSync(probeRoot)).toBe(false);
	});

	it("treats CI=false as a local environment", async () => {
		vi.stubEnv("CI", "false");
		const { fileSymlinkCapability } = await import("./symlink-capability.js");
		expect(fileSymlinkCapability()).toEqual({ supported: false, reason: "EPERM" });
	});

	it("fails on an unexpected probe error instead of skipping security coverage", async () => {
		vi.mocked(symlinkSync).mockImplementationOnce(() => {
			throw Object.assign(new Error("simulated disk failure"), { code: "EIO" });
		});
		const { fileSymlinkCapability } = await import("./symlink-capability.js");
		expect(() => fileSymlinkCapability()).toThrow("File symlink capability probe failed (EIO)");
	});
});
