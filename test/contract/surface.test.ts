/**
 * Contract: the model-facing surface stays empty, and the documented events exist.
 *
 * pi-task-label is a display extension. A registered tool would be re-sent to
 * the model on every request for the rest of the session, and a command would
 * add user surface the README does not promise. The only model interaction is
 * the label request itself, which is sent outside the session transcript.
 *
 * The extension is loaded through Pi's own loader (jiti), the same path Pi
 * uses at runtime, so these assertions cover the shipped artifact rather than
 * a re-import of the modules under test. The loader also scans project and
 * global extension directories, so both are redirected to an empty sandbox.
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions, type Extension, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { PACKAGE_ROOT } from "../helpers/root.ts";

/** The behaviors the README documents, one registration each. */
const EXPECTED_EVENTS = ["input", "session_start", "session_tree"];

async function loadTaskLabelExtension(): Promise<Extension> {
	const sandbox = mkdtempSync(join(tmpdir(), "pi-task-label-surface-"));
	const result: LoadExtensionsResult = await discoverAndLoadExtensions(
		[join(PACKAGE_ROOT, "src", "index.ts")],
		sandbox,
		sandbox,
	);
	assert.deepEqual(result.errors, [], "the extension must load without errors");
	const extension = result.extensions[0];
	assert.ok(extension, "the loader must return the extension");
	assert.equal(result.extensions.length, 1, "the sandbox must load only this extension");
	return extension;
}

test("no tools are registered", async () => {
	const extension = await loadTaskLabelExtension();
	assert.deepEqual([...extension.tools.keys()], [], "a tool would tax every request; the label is display only");
});

test("no commands are registered", async () => {
	const extension = await loadTaskLabelExtension();
	assert.deepEqual([...extension.commands.keys()], [], "configuration is files only; the README promises no commands");
});

test("every documented event has exactly one handler", async () => {
	const extension = await loadTaskLabelExtension();
	assert.deepEqual([...extension.handlers.keys()].sort(), EXPECTED_EVENTS);
	for (const event of EXPECTED_EVENTS) {
		assert.equal(extension.handlers.get(event)?.length, 1, `${event} must have exactly one handler`);
	}
});
