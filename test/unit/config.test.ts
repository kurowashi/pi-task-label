import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { CONFIG_FILE_NAME, DEFAULT_CONFIG, DEFAULT_PROMPT, loadConfig, resolveConfig } from "../../src/config.ts";

function withTempDir<T>(fn: (dir: string) => T): T {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-label-"));
	try {
		return fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

function withAgentDir<T>(dir: string, fn: () => T): T {
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = dir;
	try {
		return fn();
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
	}
}

function writeConfig(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value));
}

test("resolveConfig fills defaults and warns instead of throwing on bad values", () => {
	const warnings: string[] = [];
	assert.deepEqual(resolveConfig([], warnings), DEFAULT_CONFIG);
	assert.deepEqual(warnings, []);

	const resolved = resolveConfig(
		[{ enabled: "yes", assistantLookback: 0, display: "sometimes", model: 42, prompt: 42 }],
		warnings,
	);
	assert.deepEqual(resolved, DEFAULT_CONFIG);
	assert.equal(warnings.length, 5);
});

test("resolveConfig merges low precedence first and keeps valid values", () => {
	const resolved = resolveConfig(
		[
			{ assistantLookback: 3, model: "global/model", display: "title" },
			{ assistantLookback: 2, display: "status" },
		],
		[],
	);
	assert.equal(resolved.assistantLookback, 2);
	assert.equal(resolved.model, "global/model");
	assert.equal(resolved.display, "status");
});

test("resolveConfig treats blank strings as unset", () => {
	const warnings: string[] = [];
	const resolved = resolveConfig([{ prompt: "   ", model: "  " }], warnings);
	assert.equal(resolved.prompt, DEFAULT_PROMPT);
	assert.equal(resolved.model, "");
	assert.deepEqual(warnings, []);
});

test("resolveConfig treats null model and prompt as unset without a warning", () => {
	const warnings: string[] = [];
	const resolved = resolveConfig([{ prompt: null, model: null }], warnings);
	assert.equal(resolved.prompt, DEFAULT_PROMPT);
	assert.equal(resolved.model, "");
	assert.deepEqual(warnings, []);
});

test("resolveConfig accepts a fractional count by flooring it", () => {
	assert.equal(resolveConfig([{ assistantLookback: 2.9 }], []).assistantLookback, 2);
});

test("loadConfig reads the global file and ignores untrusted project config", () => {
	withTempDir((home) =>
		withTempDir((cwd) => {
			withAgentDir(home, () => {
				writeConfig(path.join(home, CONFIG_FILE_NAME), { assistantLookback: 3, model: "a/b" });
				writeConfig(path.join(cwd, ".pi", CONFIG_FILE_NAME), { model: "c/d" });

				const trusted = loadConfig(cwd, true);
				assert.equal(trusted.config.model, "c/d");
				assert.equal(trusted.config.assistantLookback, 3);
				assert.deepEqual(trusted.warnings, []);

				const untrusted = loadConfig(cwd, false);
				assert.equal(untrusted.config.model, "a/b");
				assert.match(untrusted.warnings.join("\n"), /not trusted/);
			});
		}),
	);
});

test("loadConfig reports unreadable files as warnings", () => {
	withTempDir((home) =>
		withTempDir((cwd) => {
			withAgentDir(home, () => {
				fs.writeFileSync(path.join(home, CONFIG_FILE_NAME), "{ not json");
				const loaded = loadConfig(cwd, true);
				assert.deepEqual(loaded.config, DEFAULT_CONFIG);
				assert.match(loaded.warnings.join("\n"), /not valid JSON/);
			});
		}),
	);
});
