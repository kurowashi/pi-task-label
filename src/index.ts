/**
 * pi-task-label - Show a one-line label of what each session is working on.
 *
 * While several Pi sessions run in parallel, the terminal title and the footer
 * status line say which one is doing what. The label is generated on every
 * user message from the tail of the current session branch:
 *
 *   - the last `assistantLookback` assistant messages that contain text,
 *   - every user message after the oldest of those.
 *
 * The request goes through `streamSimple` with a throwaway session id and
 * cache retention "none", so the session's prompt cache is never touched and
 * the label never enters the model context.
 *
 * Config files: `~/.pi/agent/task-label.json` (or `$PI_CODING_AGENT_DIR/task-label.json`)
 * and `<cwd>/.pi/task-label.json` for trusted projects. See README.md.
 */

import { randomUUID } from "node:crypto";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_CONFIG, loadConfig, type TaskLabelConfig } from "./config.ts";

/** Characters kept per message in the request. */
export const MAX_MESSAGE_CHARS = 2_000;
/** Characters kept across all messages in the request. */
export const MAX_TOTAL_CHARS = 6_000;
/** Characters kept in the displayed label. */
export const MAX_LABEL_CHARS = 40;

/** The status key this extension owns in the footer. */
export const STATUS_KEY = "task-label";

export interface ContextEntry {
	role: "assistant" | "user";
	text: string;
}

/** Text of one message. Non-text blocks (thinking, tool calls, images) are ignored. */
export function messageText(message: { role: string; content?: unknown }): string {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	const parts: string[] = [];
	for (const block of message.content) {
		if (!block || typeof block !== "object") continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") parts.push(candidate.text);
	}
	return parts.join("\n");
}

/** One branch entry as context, or undefined when it carries no readable text. */
function contextEntry(entry: SessionEntry | undefined): ContextEntry | undefined {
	if (entry?.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const text = messageText(message).trim();
	if (text.length === 0) return undefined;
	return { role: message.role, text };
}

/**
 * The tail the label is generated from, oldest first: every user message after
 * the oldest collected assistant message, and up to `lookback` assistant
 * messages that contain text. Tool results, custom messages, and metadata
 * entries are skipped and never counted.
 */
export function collectContext(entries: readonly SessionEntry[], lookback: number): ContextEntry[] {
	const items: ContextEntry[] = [];
	let assistants = 0;
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const item = contextEntry(entries[index]);
		if (!item) continue;
		items.unshift(item);
		if (item.role !== "assistant") continue;
		assistants += 1;
		if (assistants >= lookback) break;
	}
	return items;
}

/** Truncate to at most `max` characters, marking that something was cut. */
export function windowText(text: string, max: number): string {
	if (text.length <= max) return text;
	return max > 1 ? `${text.slice(0, max - 1)}…` : text.slice(0, max);
}

/**
 * One user message: the instruction, then the conversation tail inside a
 * `<context>` block. The last item is the current input and is always kept;
 * older items are dropped once the total budget is spent.
 */
export function buildRequest(prompt: string, items: readonly ContextEntry[], totalChars = MAX_TOTAL_CHARS): string {
	const lines: string[] = [];
	let budget = totalChars;
	for (const [position, item] of [...items].reverse().entries()) {
		const limit = Math.min(MAX_MESSAGE_CHARS, budget);
		if (limit <= 0) break;
		const text = windowText(item.text, limit);
		budget -= text.length;
		const name = item.role === "assistant" ? "Assistant" : position === 0 ? "User (今回)" : "User";
		lines.unshift(`${name}: ${text}`);
	}
	return `${prompt.trim()}\n\n<context>\n${lines.join("\n")}\n</context>`;
}

const LABEL_WRAPPERS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["「", "」"],
	["『", "』"],
];

/** The first non-empty line, whitespace collapsed, quotes stripped, bounded. */
export function sanitizeLabel(raw: string): string {
	const firstLine = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.find((line) => line.length > 0);
	if (firstLine === undefined) return "";
	let label = firstLine.replace(/\s+/g, " ");
	for (const [open, close] of LABEL_WRAPPERS) {
		if (label.length >= open.length + close.length && label.startsWith(open) && label.endsWith(close)) {
			label = label.slice(open.length, label.length - close.length).trim();
			break;
		}
	}
	return label.length > MAX_LABEL_CHARS ? `${label.slice(0, MAX_LABEL_CHARS - 1)}…` : label;
}

/** Title for a session without a label: the project and Pi. */
export function baseTitle(cwd: string): string {
	return `π - ${path.basename(cwd)}`;
}

/** Title for a labeled session: the label comes first so narrow tabs show it. */
export function titleFor(label: string, cwd: string): string {
	return label.length > 0 ? `π - ${label} - ${path.basename(cwd)}` : baseTitle(cwd);
}

type SessionModel = NonNullable<ExtensionContext["model"]>;

/** Message-only half of an unknown thrown value. */
function errorDetail(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

interface ModelChoice {
	model?: SessionModel;
	problem?: string;
}

/** The configured model, or the session model when it is unset or unusable. */
function chooseModel(ctx: ExtensionContext, configured: string): ModelChoice {
	const fallback = ctx.model;
	if (configured.length === 0) {
		return fallback ? { model: fallback } : { problem: "no model is active in this session" };
	}
	const found = ctx.modelRegistry.getAll().find((candidate) => `${candidate.provider}/${candidate.id}` === configured);
	if (found && ctx.modelRegistry.hasConfiguredAuth(found)) return { model: found };
	const problem = found
		? `no credentials for model "${configured}"; using the session model`
		: `model "${configured}" was not found; using the session model`;
	return fallback ? { model: fallback, problem } : { problem };
}

export default function taskLabelExtension(pi: ExtensionAPI): void {
	let config: TaskLabelConfig = DEFAULT_CONFIG;
	let warned = new Set<string>();
	let announced = false;
	let label: string | undefined;
	let generation = 0;
	let requestErrorWarned = false;

	const warnOnce = (ctx: ExtensionContext, message: string): void => {
		if (!ctx.hasUI || warned.has(message)) return;
		warned.add(message);
		ctx.ui.notify(`pi-task-label: ${message}`, "warning");
	};

	/** Place `value` on every configured display target; undefined clears the label. */
	const show = (ctx: ExtensionContext, value: string | undefined): void => {
		if (!ctx.hasUI) return;
		if (config.display !== "status") ctx.ui.setTitle(titleFor(value ?? "", ctx.cwd));
		if (config.display !== "title") ctx.ui.setStatus(STATUS_KEY, value);
	};

	const resetDisplay = (ctx: ExtensionContext): void => {
		label = undefined;
		show(ctx, undefined);
	};

	const warnRequestError = (ctx: ExtensionContext, detail: string): void => {
		if (requestErrorWarned) return;
		requestErrorWarned = true;
		warnOnce(ctx, `label request failed: ${detail}`);
	};

	const requestText = (ctx: ExtensionContext, trigger: string): string => {
		const items = collectContext(ctx.sessionManager.getBranch(), config.assistantLookback);
		items.push({ role: "user", text: trigger });
		return buildRequest(config.prompt, items);
	};

	const requestLabel = async (
		model: SessionModel,
		ctx: ExtensionContext,
		trigger: string,
	): Promise<string | undefined> => {
		const stream = ctx.modelRegistry.streamSimple(
			model,
			{
				messages: [
					{ role: "user", content: [{ type: "text", text: requestText(ctx, trigger) }], timestamp: Date.now() },
				],
			},
			{
				cacheRetention: "none",
				sessionId: randomUUID(),
				...(model.reasoning ? { reasoning: "minimal" as const } : {}),
			},
		);
		const message = await stream.result();
		if (message.stopReason === "error") throw new Error(message.errorMessage ?? "the model returned an error");
		const value = sanitizeLabel(messageText(message));
		return value.length > 0 ? value : undefined;
	};

	const applyLabel = async (ctx: ExtensionContext, model: SessionModel, trigger: string, id: number): Promise<void> => {
		try {
			const value = await requestLabel(model, ctx, trigger);
			if (id !== generation || value === undefined) return;
			label = value;
			show(ctx, label);
		} catch (error) {
			if (id === generation) warnRequestError(ctx, errorDetail(error));
		}
	};

	const generate = async (text: string, ctx: ExtensionContext): Promise<void> => {
		if (!config.enabled || !ctx.hasUI) return;
		const trigger = text.trim();
		if (trigger.length === 0) return;

		generation += 1;
		const id = generation;
		const choice = chooseModel(ctx, config.model);
		if (choice.problem) warnOnce(ctx, choice.problem);
		const model = choice.model;
		if (!model) return;

		await applyLabel(ctx, model, trigger, id);
	};

	pi.on("session_start", (_event, ctx) => {
		const loaded = loadConfig(ctx.cwd, ctx.isProjectTrusted());
		config = loaded.config;
		warned = new Set<string>();
		requestErrorWarned = false;
		generation += 1;
		if (!announced) {
			announced = true;
			for (const warning of loaded.warnings) warnOnce(ctx, warning);
		}
		resetDisplay(ctx);
	});

	pi.on("session_tree", (_event, ctx) => {
		generation += 1;
		resetDisplay(ctx);
	});

	pi.on("input", (event, ctx) => {
		void generate(event.text, ctx);
	});
}
