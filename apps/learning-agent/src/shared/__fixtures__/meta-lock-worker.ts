import { acquireWriterLock } from "../../storage/writer-lock.js";

/**
 * Test fixture: take the single-writer lock for a data directory and hold it
 * until the parent kills the process. Prints LOCKED once owned so the test can
 * prove a second process is refused instead of racing on the file.
 */
const dataDir = process.argv[2];
if (!dataDir) {
	process.stderr.write("missing data dir\n");
	process.exit(2);
}

const lock = await acquireWriterLock(dataDir);
process.stdout.write("LOCKED\n");

const finish = async (): Promise<void> => {
	await lock.release().catch(() => undefined);
	process.exit(0);
};

process.stdin.on("data", (chunk) => {
	if (String(chunk).includes("exit")) void finish();
});
setTimeout(() => void finish(), 60_000);
