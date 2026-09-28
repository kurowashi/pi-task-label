import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
	baseTitle,
	buildRequest,
	collectContext,
	MAX_LABEL_CHARS,
	MAX_TOTAL_CHARS,
	messageText,
	sanitizeLabel,
	titleFor,
	windowText,
} from "../../src/index.ts";

let sequence = 0;

function messageEntry(role: string, content: unknown): SessionEntry {
	sequence += 1;
	return {
		type: "message",
		id: `entry-${sequence}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, timestamp: sequence },
	} as unknown as SessionEntry;
}

function assistantText(text: string): SessionEntry {
	return messageEntry("assistant", [{ type: "text", text }]);
}

function toolResultEntry(): SessionEntry {
	return messageEntry("toolResult", [{ type: "text", text: "command output" }]);
}

function customMessageEntry(): SessionEntry {
	sequence += 1;
	return {
		type: "custom_message",
		customType: "reminder",
		content: "injected reminder",
		display: false,
		id: `entry-${sequence}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
	} as unknown as SessionEntry;
}

test("messageText reads string content and text blocks only", () => {
	assert.equal(messageText({ role: "user", content: "hello" }), "hello");
	assert.equal(
		messageText({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "hidden" },
				{ type: "text", text: "first" },
				{ type: "toolCall", name: "read", arguments: { path: "x" } },
				{ type: "text", text: "second" },
			],
		}),
		"first\nsecond",
	);
	assert.equal(messageText({ role: "assistant", content: [{ type: "toolCall" }] }), "");
	assert.equal(messageText({ role: "assistant" }), "");
});

test("collectContext keeps user messages and counts only assistants with text", () => {
	const entries = [
		assistantText("計画を立てる"),
		messageEntry("user", "OK"),
		messageEntry("assistant", [{ type: "toolCall", name: "edit", arguments: {} }]),
		messageEntry("user", "steer"),
		assistantText("次は middleware を直す"),
		messageEntry("user", "OK"),
	];

	assert.deepEqual(collectContext(entries, 1), [
		{ role: "assistant", text: "次は middleware を直す" },
		{ role: "user", text: "OK" },
	]);
	assert.deepEqual(collectContext(entries, 2), [
		{ role: "assistant", text: "計画を立てる" },
		{ role: "user", text: "OK" },
		{ role: "user", text: "steer" },
		{ role: "assistant", text: "次は middleware を直す" },
		{ role: "user", text: "OK" },
	]);
	assert.deepEqual(
		collectContext(entries, 1).map((item) => item.role),
		["assistant", "user"],
	);
});

test("collectContext skips tool results, custom messages, and empty text", () => {
	const entries = [
		assistantText("start"),
		toolResultEntry(),
		customMessageEntry(),
		messageEntry("user", "   "),
		assistantText("   "),
		messageEntry("assistant", [{ type: "thinking", thinking: "only thinking" }]),
		messageEntry("user", " final "),
	];
	assert.deepEqual(collectContext(entries, 1), [
		{ role: "assistant", text: "start" },
		{ role: "user", text: "final" },
	]);
});

test("collectContext returns nothing for an empty branch", () => {
	assert.deepEqual(collectContext([], 1), []);
});

test("windowText marks truncation inside the limit", () => {
	assert.equal(windowText("short", 10), "short");
	assert.equal(windowText("0123456789", 10), "0123456789");
	assert.equal(windowText("0123456789", 5), "0123…");
	assert.equal(windowText("0123456789", 1), "0");
	assert.equal(windowText("0123456789", 0), "");
});

test("windowText counts an emoji as one character and never splits it", () => {
	assert.equal(windowText("abc🔍def", 5), "abc🔍…");
	assert.equal(windowText("🔍🔍🔍", 2), "🔍…");
	const cut = windowText("abc🔍def", 5);
	assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut), "no lone surrogate");
});

test("buildRequest marks the current input and keeps it first in the budget", () => {
	const prompt = buildRequest("DO THE THING", [
		{ role: "assistant", text: "plan" },
		{ role: "user", text: "OK" },
	]);
	assert.equal(prompt, "DO THE THING\n\n<context>\nAssistant: plan\nUser (current): OK\n</context>");

	const bounded = buildRequest(
		"P",
		[
			{ role: "assistant", text: "A".repeat(100) },
			{ role: "user", text: "current" },
		],
		50,
	);
	assert.match(bounded, /User \(current\): current\n<\/context>$/);
	assert.ok(bounded.includes(`Assistant: ${"A".repeat(42)}…`), "older messages must shrink first");
	assert.ok(!bounded.includes("A".repeat(43)));
});

test("buildRequest truncates a single oversized input to the total budget", () => {
	const request = buildRequest("P", [{ role: "user", text: "x".repeat(MAX_TOTAL_CHARS + 500) }]);
	assert.ok(request.includes(`User (current): ${"x".repeat(1_999)}…`));
	assert.ok(!request.includes("x".repeat(2_000)));
});

test("sanitizeLabel keeps one bounded, unquoted line", () => {
	assert.equal(sanitizeLabel("ログインの修正"), "ログインの修正");
	assert.equal(sanitizeLabel("\n\n  first line\nsecond\n"), "first line");
	assert.equal(sanitizeLabel('"quoted"'), "quoted");
	assert.equal(sanitizeLabel("「和風」"), "和風");
	assert.equal(sanitizeLabel("a   b\tc"), "a b c");
	assert.equal(sanitizeLabel("   "), "");
	assert.equal(sanitizeLabel('""'), "", "a label made only of quotes is no label");
	assert.equal(sanitizeLabel("「」"), "");
	assert.equal(sanitizeLabel("x".repeat(100)).length, MAX_LABEL_CHARS);
	assert.ok(sanitizeLabel("x".repeat(100)).endsWith("…"));
});

test("sanitizeLabel keeps an emoji whole at the limit", () => {
	const exact = `${"x".repeat(39)}🔍`;
	assert.equal(sanitizeLabel(exact), exact, "40 code points fit even with an emoji");
	const cut = sanitizeLabel(`${"x".repeat(38)}🔍yyy`);
	assert.equal([...cut].length, MAX_LABEL_CHARS);
	assert.ok(cut.endsWith("…"));
	assert.ok(cut.includes("🔍"), "the leading emoji survives");
});

test("titleFor puts the label first and falls back to the project name", () => {
	assert.equal(baseTitle("/home/user/project"), "π - project");
	assert.equal(titleFor("バグ修正", "/home/user/project"), "π - バグ修正 - project");
	assert.equal(titleFor("", "/home/user/project"), baseTitle("/home/user/project"));
});
