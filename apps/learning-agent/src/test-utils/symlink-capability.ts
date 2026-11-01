import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { isWithin, resolveContainedPath } from "../utils/path-safety.js";

// Windows directory junctions exercise real containment without the separate
// privilege required by ordinary file/directory symlinks.
export const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

interface FileSymlinkCapability {
	supported: boolean;
	reason?: string;
}

let cachedCapability: FileSymlinkCapability | undefined;

function probeFileSymlinks(): FileSymlinkCapability {
	const parent = resolve(tmpdir());
	const prefix = "inno-file-symlink-probe-";
	const root = mkdtempSync(join(parent, prefix));
	try {
		const target = resolveContainedPath(root, "target.txt");
		const link = resolveContainedPath(root, "link.txt");
		if (!target || !link) throw new Error("Unable to prepare the file symlink capability probe");
		writeFileSync(target, "file symlink capability");
		try {
			symlinkSync(target, link, "file");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code && ["EPERM", "EACCES", "ENOTSUP", "ENOSYS"].includes(code)) return { supported: false, reason: code };
			throw new Error(`File symlink capability probe failed (${code ?? "unknown error"})`);
		}
		if (readFileSync(link, "utf8") !== "file symlink capability") throw new Error("File symlink capability probe could not read the target");
		return { supported: true };
	} finally {
		// Only remove the exact freshly allocated probe directory, never a
		// computed ancestor or an external symlink target.
		const absoluteRoot = resolve(root);
		if (absoluteRoot === parent || !isWithin(parent, absoluteRoot) || !basename(absoluteRoot).startsWith(prefix)) {
			throw new Error("Unsafe file symlink probe cleanup target");
		}
		rmSync(absoluteRoot, { recursive: true, force: true });
	}
}

export function fileSymlinkCapability(): FileSymlinkCapability {
	const capability = cachedCapability ??= probeFileSymlinks();
	const ci = process.env.CI?.toLowerCase();
	const required = Boolean(ci && ci !== "false" && ci !== "0") || process.env.INNO_TEST_REQUIRE_FILE_SYMLINKS === "1";
	// Local non-elevated Windows runs must show these cases as unexecuted.
	// Release/CI runs require the real file-link safety coverage instead.
	if (!capability.supported && required) {
		throw new Error(`Real file symlinks are required for security tests but unavailable (${capability.reason}). Run in a file-symlink-capable environment.`);
	}
	return capability;
}

export function fileSymlinkTestName(title: string, capability: FileSymlinkCapability): string {
	return capability.supported ? title : `${title} [not run: file symlinks unavailable (${capability.reason})]`;
}
