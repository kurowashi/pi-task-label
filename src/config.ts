/**
 * Config discovery and resolution for pi-task-label.
 *
 * Files are merged nearest-last: the global config at
 * `~/.pi/agent/task-label.json` (or `$PI_CODING_AGENT_DIR/task-label.json`) is
 * read first and the project config at `<cwd>/.pi/task-label.json` overrides
 * it. Project configs are ignored when the project is not trusted.
 *
 * Unknown keys are ignored and invalid values fall back to the default with a
 * warning instead of throwing, so a broken config never breaks a session.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const CONFIG_FILE_NAME = "task-label.json";

/** Where the label is shown. */
export type DisplayTarget = "both" | "title" | "status";

export interface TaskLabelConfig {
	/** Master switch. When false no model call and no display happens. */
	enabled: boolean;
	/** Model as "<provider>/<id>". Empty means the model of the session. */
	model: string;
	/** How many assistant messages with text the label is generated from. */
	assistantLookback: number;
	/** Instruction sent together with the conversation tail. */
	prompt: string;
	/** Display targets: terminal title, footer status line, or both. */
	display: DisplayTarget;
}

/** Instruction rules; users can replace the whole text in their config. */
export const DEFAULT_PROMPT = [
	"あなたは Pi のコーディングセッションが今何をしているかを1行のラベルにする。",
	"出力はラベルの本文のみ。前置き・説明・引用符・コードフェンス・絵文字・箇条書きを付けない。",
	"規則:",
	"- 直近の Assistant の「次の一手」を最優先で表す。",
	"- 直近の Assistant と矛盾する場合は、それ以降の User の発言を優先する。",
	"- User の発言が承認・継続・雑談のみの場合は、作業内容を直前の Assistant から取る。",
	"- 作業が完了していれば「<内容> 完了」とする。",
	"- ユーザーの使用言語で書く。体言止め。40文字以内。改行しない。",
].join("\n");

export const DEFAULT_CONFIG: TaskLabelConfig = {
	enabled: true,
	model: "",
	assistantLookback: 1,
	prompt: DEFAULT_PROMPT,
	display: "both",
};

export interface LoadedTaskLabelConfig {
	config: TaskLabelConfig;
	warnings: string[];
	globalFile: string;
	projectFile: string;
}

export function agentDir(): string {
	const override = process.env["PI_CODING_AGENT_DIR"]?.trim();
	return override && override.length > 0 ? override : path.join(os.homedir(), ".pi", "agent");
}

export function globalConfigPath(): string {
	return path.join(agentDir(), CONFIG_FILE_NAME);
}

export function projectConfigPath(cwd: string): string {
	return path.join(cwd, ".pi", CONFIG_FILE_NAME);
}

function readConfigFile(file: string): { value?: Record<string, unknown>; warning?: string } {
	if (!fs.existsSync(file)) return {};
	let text: string;
	try {
		text = fs.readFileSync(file, "utf8");
	} catch (error) {
		return { warning: `cannot read ${file}: ${error instanceof Error ? error.message : String(error)}` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		return { warning: `${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { warning: `${file} must contain a JSON object` };
	}
	return { value: parsed as Record<string, unknown> };
}

function booleanOr(value: unknown, key: string, fallback: boolean, warnings: string[]): boolean {
	if (value === undefined) return fallback;
	if (typeof value === "boolean") return value;
	warnings.push(`task-label: ${key} must be a boolean; using ${fallback}`);
	return fallback;
}

/** A count of messages: an integer >= 1. */
function countOr(value: unknown, key: string, fallback: number, warnings: string[]): number {
	if (value === undefined) return fallback;
	if (typeof value === "number" && Number.isFinite(value) && value >= 1) return Math.floor(value);
	warnings.push(`task-label: ${key} must be a number >= 1; using ${fallback}`);
	return fallback;
}

function stringOr(value: unknown, key: string, fallback: string, warnings: string[]): string {
	if (value === undefined || value === null) return fallback;
	if (typeof value === "string") return value;
	warnings.push(`task-label: ${key} must be a string; using the default`);
	return fallback;
}

/** Validate raw configs (lowest precedence first) into a complete config. */
export function resolveConfig(raws: Record<string, unknown>[], warnings: string[]): TaskLabelConfig {
	const raw: Record<string, unknown> = Object.assign({}, ...raws);
	const rawDisplay = raw["display"];
	const display =
		rawDisplay === undefined || rawDisplay === "both" || rawDisplay === "title" || rawDisplay === "status"
			? rawDisplay
			: undefined;
	if (rawDisplay !== undefined && display === undefined) {
		warnings.push(`task-label: display must be "both", "title", or "status"; using ${DEFAULT_CONFIG.display}`);
	}
	const rawPrompt = stringOr(raw["prompt"], "prompt", DEFAULT_CONFIG.prompt, warnings);
	return {
		enabled: booleanOr(raw["enabled"], "enabled", DEFAULT_CONFIG.enabled, warnings),
		model: stringOr(raw["model"], "model", DEFAULT_CONFIG.model, warnings).trim(),
		assistantLookback: countOr(
			raw["assistantLookback"],
			"assistantLookback",
			DEFAULT_CONFIG.assistantLookback,
			warnings,
		),
		prompt: rawPrompt.trim().length > 0 ? rawPrompt : DEFAULT_CONFIG.prompt,
		display: (display as DisplayTarget | undefined) ?? DEFAULT_CONFIG.display,
	};
}

export function loadConfig(cwd: string, trusted: boolean): LoadedTaskLabelConfig {
	const globalFile = globalConfigPath();
	const projectFile = projectConfigPath(cwd);
	const warnings: string[] = [];
	const raws: Record<string, unknown>[] = [];

	const globalRead = readConfigFile(globalFile);
	if (globalRead.warning) warnings.push(globalRead.warning);
	if (globalRead.value) raws.push(globalRead.value);

	if (fs.existsSync(projectFile)) {
		if (trusted) {
			const projectRead = readConfigFile(projectFile);
			if (projectRead.warning) warnings.push(projectRead.warning);
			if (projectRead.value) raws.push(projectRead.value);
		} else {
			warnings.push(`ignoring ${projectFile}: project is not trusted (use /trust to enable project config)`);
		}
	}

	return { config: resolveConfig(raws, warnings), warnings, globalFile, projectFile };
}
