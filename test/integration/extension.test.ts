import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { CONFIG_FILE_NAME } from "../../src/config.ts";
import taskLabelExtension, { baseTitle, MAX_LABEL_CHARS } from "../../src/index.ts";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface FakeModel {
	provider: string;
	id: string;
	reasoning: boolean;
}

interface Reply {
	text?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface Call {
	model: FakeModel;
	text: string;
	options: Record<string, unknown>;
	context: unknown;
}

interface HarnessOptions {
	hasUI?: boolean;
	sessionModel?: FakeModel | null;
	models?: FakeModel[];
	authed?: boolean;
	trusted?: boolean;
	respond?: (text: string, model: FakeModel) => Promise<Reply>;
}

interface Harness {
	emit(event: string, data: unknown): Promise<void>;
	command(name: string, args: string): Promise<void>;
	ctx: ExtensionContext;
	statuses: (string | undefined)[];
	titles: string[];
	notifications: string[];
	calls: Call[];
	branch: SessionEntry[];
}

function model(provider: string, id: string, reasoning = false): FakeModel {
	return { provider, id, reasoning };
}

/** The request text the extension put into the single user message. */
function requestText(context: unknown): string {
	const messages = (context as { messages?: unknown }).messages;
	if (!Array.isArray(messages)) return "";
	const first = messages[0] as { content?: unknown } | undefined;
	if (!Array.isArray(first?.content)) return "";
	const block = first.content[0] as { text?: unknown } | undefined;
	return typeof block?.text === "string" ? block.text : "";
}

function assistantReply(reply: Reply): unknown {
	return {
		role: "assistant",
		content: reply.text ? [{ type: "text", text: reply.text }] : [],
		stopReason: reply.stopReason ?? "stop",
		...(reply.errorMessage === undefined ? {} : { errorMessage: reply.errorMessage }),
	};
}

function harness(cwd: string, options: HarnessOptions = {}): Harness {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, (args: string, ctx: ExtensionContext) => unknown>();
	const statuses: (string | undefined)[] = [];
	const titles: string[] = [];
	const notifications: string[] = [];
	const calls: Call[] = [];
	const branch: SessionEntry[] = [];
	const sessionModel = options.sessionModel === null ? undefined : (options.sessionModel ?? model("session", "main"));
	const models = options.models ?? [sessionModel ?? model("session", "main")];
	const respond = options.respond ?? (async () => ({ text: "生成されたラベル" }));

	const registry = {
		getAll: () => models,
		hasConfiguredAuth: () => options.authed ?? true,
		streamSimple: (selected: FakeModel, context: unknown, opts: Record<string, unknown>) => {
			const text = requestText(context);
			calls.push({ model: selected, text, options: opts, context });
			return { result: async () => assistantReply(await respond(text, selected)) };
		},
	};

	const ctx = {
		cwd,
		hasUI: options.hasUI ?? true,
		isProjectTrusted: () => options.trusted ?? true,
		model: sessionModel,
		modelRegistry: registry,
		sessionManager: { getBranch: () => branch },
		ui: {
			setStatus: (_key: string, value: string | undefined) => {
				statuses.push(value);
			},
			setTitle: (value: string) => {
				titles.push(value);
			},
			notify: (message: string) => {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;

	const api = {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand(name: string, command: { handler: (args: string, ctx: ExtensionContext) => unknown }) {
			commands.set(name, command.handler);
		},
	} as unknown as ExtensionAPI;

	taskLabelExtension(api);

	return {
		ctx,
		statuses,
		titles,
		notifications,
		calls,
		branch,
		async emit(event: string, data: unknown) {
			for (const handler of handlers.get(event) ?? []) await handler(data, ctx);
		},
		async command(name: string, args: string) {
			const handler = commands.get(name);
			assert.ok(handler, `command ${name} must be registered`);
			await handler(args, ctx);
		},
	};
}

function settle(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

async function withProject<T>(config: unknown, fn: (cwd: string) => Promise<T> | T): Promise<T> {
	const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-label-flow-"));
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-label-home-"));
	const saved = process.env["PI_CODING_AGENT_DIR"];
	process.env["PI_CODING_AGENT_DIR"] = home;
	try {
		fs.mkdirSync(path.join(cwd, ".pi"), { recursive: true });
		fs.writeFileSync(path.join(cwd, ".pi", "task-label.json"), JSON.stringify(config));
		return await fn(cwd);
	} finally {
		if (saved === undefined) delete process.env["PI_CODING_AGENT_DIR"];
		else process.env["PI_CODING_AGENT_DIR"] = saved;
		fs.rmSync(cwd, { recursive: true, force: true });
		fs.rmSync(home, { recursive: true, force: true });
	}
}

async function start(h: Harness): Promise<void> {
	await h.emit("session_start", { type: "session_start", reason: "startup" });
}

async function input(h: Harness, text: string): Promise<void> {
	await h.emit("input", { type: "input", text, source: "interactive" });
	await settle();
}

function messageEntry(role: string, content: unknown): SessionEntry {
	return {
		type: "message",
		id: `entry-${role}`,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: { role, content, timestamp: 1 },
	} as unknown as SessionEntry;
}

test("input generates a label from the session tail and shows it on both surfaces", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd);
		h.branch.push(
			messageEntry("assistant", [{ type: "text", text: "次は middleware を直す" }]),
			messageEntry("user", "OK"),
		);
		await start(h);
		await input(h, "OK");

		assert.equal(h.statuses.at(-1), "生成されたラベル");
		assert.equal(h.titles.at(-1), `π - 生成されたラベル - ${path.basename(cwd)}`);
		const call = h.calls[0];
		assert.ok(call, "the model must be called");
		assert.match(call.text, /Assistant: 次は middleware を直す/);
		assert.match(call.text, /User: OK/);
		assert.match(call.text, /User \(current\): OK/);
		assert.equal(call.options["cacheRetention"], "none");
		assert.equal(typeof call.options["sessionId"], "string");
		const context = call.context as { messages?: unknown[] };
		assert.deepEqual(Object.keys(context), ["messages"], "the request must not carry a system prompt");
		assert.equal(context.messages?.length, 1);
		const [message] = context.messages ?? [];
		assert.equal((message as { role?: string }).role, "user");
		assert.equal((message as { content?: unknown[] }).content?.length, 1);
		assert.deepEqual(
			h.branch,
			[messageEntry("assistant", [{ type: "text", text: "次は middleware を直す" }]), messageEntry("user", "OK")],
			"the label must not be written back into the session",
		);
	});
});

test("the session model is the default and reasoning is capped to minimal", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const reasoning = model("test", "reasoning", true);
		const h = harness(cwd, { sessionModel: reasoning });
		await start(h);
		await input(h, "work");
		assert.equal(h.calls[0]?.model, reasoning);
		assert.equal(h.calls[0]?.options["reasoning"], "minimal");
	});

	await withProject({ enabled: true }, async (cwd) => {
		const plain = model("test", "plain", false);
		const h = harness(cwd, { sessionModel: plain });
		await start(h);
		await input(h, "work");
		assert.equal(h.calls[0]?.model, plain);
		assert.ok(
			!("reasoning" in (h.calls[0]?.options ?? {})),
			"non-reasoning models must not receive a reasoning option",
		);
	});
});

test("a configured model is preferred over the session model", async () => {
	await withProject({ enabled: true, model: "prov/cheap" }, async (cwd) => {
		const cheap = model("prov", "cheap");
		const main = model("session", "main");
		const h = harness(cwd, { models: [cheap, main], sessionModel: main });
		await start(h);
		await input(h, "work");
		assert.equal(h.calls[0]?.model, cheap);
		assert.deepEqual(h.notifications, []);
	});
});

test("an impossible configured model falls back once with a warning", async () => {
	await withProject({ enabled: true, model: "prov/missing" }, async (cwd) => {
		const main = model("session", "main");
		const h = harness(cwd, { models: [main], sessionModel: main });
		await start(h);
		await input(h, "one");
		await input(h, "two");
		assert.equal(h.calls.length, 2);
		assert.equal(h.calls[0]?.model, main);
		assert.equal(h.notifications.filter((message) => message.includes("was not found")).length, 1);
	});

	await withProject({ enabled: true, model: "prov/cheap" }, async (cwd) => {
		const cheap = model("prov", "cheap");
		const main = model("session", "main");
		const h = harness(cwd, { models: [cheap, main], sessionModel: main, authed: false });
		await start(h);
		await input(h, "one");
		assert.equal(h.calls[0]?.model, main);
		assert.equal(h.notifications.filter((message) => message.includes("no credentials")).length, 1);
	});
});

test("a session without a model is reported once and skips the request", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd, { sessionModel: null });
		await start(h);
		await input(h, "one");
		await input(h, "two");
		assert.equal(h.calls.length, 0);
		assert.equal(h.notifications.filter((message) => message.includes("no model is active")).length, 1);
	});
});

test("disabled and headless sessions never call the model", async () => {
	await withProject({ enabled: false }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await input(h, "work");
		assert.equal(h.calls.length, 0);
		assert.equal(h.statuses.at(-1), undefined);
		assert.equal(h.titles.at(-1), baseTitle(cwd), "a disabled extension must not keep a stale label in the title");
	});

	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd, { hasUI: false });
		await start(h);
		await input(h, "work");
		assert.equal(h.calls.length, 0);
	});
});

test("disabling the extension on the next session drops the label", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await input(h, "work");
		assert.equal(h.statuses.at(-1), "生成されたラベル");

		fs.writeFileSync(path.join(cwd, ".pi", "task-label.json"), JSON.stringify({ enabled: false }));
		await start(h);
		assert.equal(h.statuses.at(-1), undefined);
		assert.equal(h.titles.at(-1), baseTitle(cwd));
		await input(h, "more work");
		assert.equal(h.calls.length, 1, "the disabled session must not generate labels");
	});
});

test("the display target selects the surfaces", async () => {
	await withProject({ enabled: true, display: "title" }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await input(h, "work");
		assert.deepEqual(h.statuses, []);
		assert.equal(h.titles.at(-1), `π - 生成されたラベル - ${path.basename(cwd)}`);
	});

	await withProject({ enabled: true, display: "status" }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await input(h, "work");
		assert.deepEqual(h.titles, []);
		assert.equal(h.statuses.at(-1), "生成されたラベル");
	});
});

test("a failed request keeps the last label and warns once", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		let failing = false;
		const h = harness(cwd, {
			respond: async () => {
				if (failing) throw new Error("network down");
				return { text: "最初のラベル" };
			},
		});
		await start(h);
		await input(h, "one");
		assert.equal(h.statuses.at(-1), "最初のラベル");

		failing = true;
		await input(h, "two");
		await input(h, "three");
		assert.equal(h.statuses.at(-1), "最初のラベル");
		assert.equal(h.notifications.filter((message) => message.includes("label request failed")).length, 1);
	});

	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd, { respond: async () => ({ stopReason: "error", errorMessage: "boom" }) });
		await start(h);
		await input(h, "one");
		assert.equal(h.notifications.filter((message) => message.includes("boom")).length, 1);
		assert.equal(h.statuses.at(-1), undefined);
	});
});

test("an empty label leaves the display untouched", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd, { respond: async () => ({ text: "   " }) });
		await start(h);
		await input(h, "one");
		assert.equal(h.statuses.at(-1), undefined);
		assert.equal(h.titles.at(-1), baseTitle(cwd));
	});
});

test("session_tree clears the label back to the project title", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await input(h, "work");
		assert.equal(h.statuses.at(-1), "生成されたラベル");

		await h.emit("session_tree", { type: "session_tree", newLeafId: "a", oldLeafId: "b" });
		assert.equal(h.statuses.at(-1), undefined);
		assert.equal(h.titles.at(-1), baseTitle(cwd));
	});
});

test("a newer input wins over a slower earlier request", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const pending: Array<(reply: Reply) => void> = [];
		const h = harness(cwd, {
			respond: () =>
				new Promise<Reply>((resolve) => {
					pending.push(resolve);
				}),
		});
		await start(h);
		await input(h, "first");
		await input(h, "second");
		assert.equal(pending.length, 2);

		pending[1]?.({ text: "NEW" });
		await settle();
		assert.equal(h.statuses.at(-1), "NEW");

		pending[0]?.({ text: "OLD" });
		await settle();
		assert.equal(h.statuses.at(-1), "NEW");
	});
});

test("the label is sanitized and bounded before it is shown", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd, { respond: async () => ({ text: "\n  「整えたラベル」  \nextra" }) });
		await start(h);
		await input(h, "work");
		assert.equal(h.statuses.at(-1), "整えたラベル");
	});

	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd, { respond: async () => ({ text: "x".repeat(100) }) });
		await start(h);
		await input(h, "work");
		assert.equal(h.statuses.at(-1)?.length, MAX_LABEL_CHARS);
	});
});

test("the settings command reports the resolved configuration and the current label", async () => {
	await withProject({ enabled: true, model: "prov/cheap", assistantLookback: 2, display: "status" }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await h.command("task-label", "");
		const report = h.notifications.at(-1) ?? "";
		assert.match(report, /^pi-task-label: on$/m);
		assert.match(report, /^display: status$/m);
		assert.match(report, /^model: prov\/cheap$/m);
		assert.match(report, /^assistantLookback: 2$/m);
		assert.match(report, /^prompt: default \(\d+ chars\)$/m);
		assert.match(report, /^label: \(none\)$/m);
		assert.ok(report.includes(path.join(cwd, ".pi", CONFIG_FILE_NAME)), "the project config path must be shown");

		await input(h, "work");
		await h.command("task-label", "status");
		assert.match(h.notifications.at(-1) ?? "", /^label: 生成されたラベル$/m);
	});
});

test("the settings command rejects unknown actions and marks an untrusted project", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd, { trusted: false });
		await start(h);
		await h.command("task-label", "set");
		assert.match(h.notifications.at(-1) ?? "", /^usage: \/task-label/);

		await h.command("task-label", "status");
		assert.match(h.notifications.at(-1) ?? "", /warning: .*project is not trusted/);
	});
});

test("an input that cannot generate still invalidates the older request", async () => {
	await withProject({ enabled: true, model: "prov/cheap" }, async (cwd) => {
		const pending: Array<(reply: Reply) => void> = [];
		const options: HarnessOptions = {
			sessionModel: null,
			models: [model("prov", "cheap")],
			authed: true,
			respond: () =>
				new Promise<Reply>((resolve) => {
					pending.push(resolve);
				}),
		};
		const h = harness(cwd, options);
		await start(h);
		await input(h, "first");
		assert.equal(pending.length, 1);

		options.authed = false;
		await input(h, "second");
		assert.equal(h.calls.length, 1, "the newer input cannot generate without credentials");

		pending[0]?.({ text: "OLD" });
		await settle();
		assert.ok(!h.statuses.includes("OLD"), "the label from the superseded input must not appear");
	});
});

test("whitespace-only input is ignored", async () => {
	await withProject({ enabled: true }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await input(h, "   ");
		assert.equal(h.calls.length, 0);
	});
});

test("config warnings are announced once per session", async () => {
	await withProject({ enabled: true, display: "sometimes" }, async (cwd) => {
		const h = harness(cwd);
		await start(h);
		await start(h);
		assert.equal(h.notifications.length, 1);
		assert.match(h.notifications[0] ?? "", /display must be/);
	});
});
