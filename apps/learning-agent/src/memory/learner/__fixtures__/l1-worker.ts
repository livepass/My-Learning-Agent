/**
 * Test-only worker: a real second process against a real data directory.
 *
 * It is deliberately not a test file (no `.test.ts`) so vitest never collects
 * it. Tests spawn it with `node --import tsx <this file> <command> <dir> ...`.
 *
 * Commands:
 *   hold <dir>                  acquire writer ownership, print READY, wait
 *   record <dir> <key>          normal owner write
 *   crash-after-event <dir> <key>
 *                               commit the event, leave a half-written profile
 *                               temp file, then exit *without* projecting
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { appendEvent, ensureEventLog } from "../event-log.js";
import { createLearningEvidenceEvent } from "../evidence.js";
import { initializeLearnerStore, loadProfile, recordEventAndUpdateProfile, recoverMissingProfile } from "../profile-store.js";

const [, , command, dir, arg] = process.argv;

function event(key: string) {
	return createLearningEvidenceEvent("worker", {
		concept_id: "math.fraction",
		kind: "application",
		result: "correct",
		evaluator: "teacher",
		evaluator_confidence: 1,
		session_id: "session-1",
		dedupe_key: key,
	});
}

async function main(): Promise<void> {
	if (!command || !dir) throw new Error("missing arguments");

	if (command === "hold") {
		const status = await initializeLearnerStore(dir);
		process.stdout.write(`READY ${status.mode}\n`);
		setInterval(() => undefined, 1000);
		return;
	}

	if (command === "record") {
		const result = await recordEventAndUpdateProfile(dir, event(arg ?? "normal"));
		process.stdout.write(`DONE ${result.status} ${result.event.seq}\n`);
		return;
	}

	if (command === "read") {
		const profile = await loadProfile(dir);
		process.stdout.write(`READY ${profile.projection?.applied_seq ?? -1} ${profile.knowledge_states.length}\n`);
		return;
	}

	if (command === "recover") {
		const profile = await recoverMissingProfile(dir, {
			acceptManualLoss: true,
			reason: "worker recovery",
		});
		process.stdout.write(`RECOVERED ${profile.manual_fields_lost} ${profile.projection?.applied_seq}\n`);
		return;
	}

	if (command === "crash-after-event") {
		const status = await initializeLearnerStore(dir);
		if (status.mode !== "owner") throw new Error(`worker is not the owner: ${status.mode}`);
		const { manifest } = await ensureEventLog(dir, "strict");
		const appended = await appendEvent(dir, event(arg ?? "crash"), { maxBytes: 1024 * 1024 });
		// A profile write that reached its temp file but never replaced the real
		// file: the classic crash window between event commit and projection.
		await writeFile(
			join(dir, `profile.json.${process.pid}.deadbeef.tmp`),
			JSON.stringify({ broken: true, manifest: manifest.next_seq, seq: appended.event.seq }),
			"utf-8",
		);
		process.stdout.write(`CRASHED ${appended.event.seq}\n`);
		process.exit(0);
	}

	throw new Error(`unknown command: ${command}`);
}

main().catch((err) => {
	const code = (err as { code?: string } | undefined)?.code;
	process.stderr.write(`WORKER-ERROR ${code ?? "UNKNOWN"}\n${String(err?.stack ?? err)}\n`);
	process.exit(1);
});
