/**
 * Host-independent core for the pi-vibe-subagent extension.
 *
 * This module only uses Node builtins, so it can be unit tested with
 * `node --test` without the pi host packages installed.
 */

import { spawn } from "node:child_process";
import * as os from "node:os";

export const MIN_VIBE_VERSION = "2.26.0";
export const DEFAULT_AGENT = "auto-approve";
export const MAX_PARALLEL_TASKS = 8;
export const MAX_CONCURRENCY = 4;
export const COLLAPSED_ITEM_COUNT = 10;
export const PER_TASK_OUTPUT_CAP = 50 * 1024;
export const DEFAULT_MAX_TURNS = 30;

export type Approval = "auto" | "smart" | "inherit";

export interface VibeEntry {
	type?: string;
	role?: string;
	content?: Array<{ type?: string; text?: string }>;
	text?: string;
	title?: string;
	detail?: {
		toolName?: string;
		kind?: string;
		display?: { summary?: string; message?: string; verb?: string };
	};
	state?: { status?: string; outputText?: string };
	generationStatus?: string;
}

export interface VibeResult {
	agent: string;
	task: string;
	workdir: string;
	status: "running" | "ok" | "error";
	exitCode: number;
	entries: VibeEntry[];
	stderr: string;
	errorMessage?: string;
	warning?: string;
}

export interface RunDefaults {
	defaultCwd: string;
	approval: Approval;
	model?: string;
	maxTurns?: number;
	maxPrice?: number;
	maxTokens?: number;
	trust: boolean;
	worktree: boolean;
	timeoutMs?: number;
}

export interface TaskSpec {
	agent: string;
	task: string;
	workdir?: string;
}

export interface VibeProbe {
	ok: boolean;
	version?: string;
	reason?: string;
}

export type DisplayItem = { kind: "tool"; label: string; status: string } | { kind: "text"; text: string };

export function shortenPath(value: string): string {
	const home = os.homedir();
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

export function parseVibeVersion(output: string): string | undefined {
	const match = output.match(/(\d+\.\d+\.\d+)/);
	return match ? match[1] : undefined;
}

export function compareVersions(a: string, b: string): number {
	const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const left = parse(a);
	const right = parse(b);
	for (let index = 0; index < 3; index++) {
		const diff = (left[index] ?? 0) - (right[index] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

export function buildArgs(defaults: RunDefaults, spec: TaskSpec): string[] {
	const args = [
		`--prompt=${spec.task}`,
		"--output",
		"streaming",
		"--agent",
		spec.agent,
		"--max-turns",
		String(defaults.maxTurns ?? DEFAULT_MAX_TURNS),
	];
	if (defaults.approval === "auto") args.push("--auto-approve");
	else if (defaults.approval === "smart") args.push("--smart-approve");
	if (defaults.maxPrice !== undefined) args.push("--max-price", String(defaults.maxPrice));
	if (defaults.maxTokens !== undefined) args.push("--max-tokens", String(defaults.maxTokens));
	if (defaults.worktree) args.push("--worktree");
	if (defaults.trust) args.push("--trust");
	return args;
}

export function parseStreamLine(line: string): VibeEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const value = JSON.parse(trimmed) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		return value as VibeEntry;
	} catch {
		return undefined;
	}
}

export function textFromMessage(entry: VibeEntry): string {
	return (entry.content ?? [])
		.filter((part) => part.type === "text")
		.map((part) => part.text ?? "")
		.join("\n")
		.trim();
}

export function toDisplayItems(entries: VibeEntry[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const entry of entries) {
		if (entry.generationStatus && entry.generationStatus !== "completed") continue;
		if (entry.type === "effect") {
			const label = entry.detail?.display?.summary || entry.detail?.toolName || entry.title || "tool";
			items.push({ kind: "tool", label, status: entry.state?.status ?? "completed" });
		} else if (entry.type === "message" && entry.role === "assistant") {
			const text = textFromMessage(entry);
			if (text) items.push({ kind: "text", text });
		}
	}
	return items;
}

export function finalOutput(entries: VibeEntry[]): string {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type === "message" && entry.role === "assistant") {
			const text = textFromMessage(entry);
			if (text) return text;
		}
	}
	return "";
}

export function isFailed(result: VibeResult): boolean {
	return result.status === "error";
}

export function resultOutput(result: VibeResult): string {
	if (isFailed(result)) {
		return result.errorMessage || result.stderr.trim() || finalOutput(result.entries) || "(no output)";
	}
	const output = finalOutput(result.entries);
	if (output) return output;
	if (result.entries.length > 0) return "(no assistant message found; the Vibe output format may have changed)";
	return "(no output)";
}

export function truncateOutput(output: string): string {
	const total = Buffer.byteLength(output, "utf8");
	if (total <= PER_TASK_OUTPUT_CAP) return output;
	let truncated = output.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(truncated, "utf8") > PER_TASK_OUTPUT_CAP) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${total - Buffer.byteLength(truncated, "utf8")} bytes omitted.]`;
}

export async function mapWithConcurrencyLimit<TIn, TOut>(
	items: TIn[],
	concurrency: number,
	fn: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
	if (items.length === 0) return [];
	const limit = Math.max(1, Math.min(concurrency, items.length));
	const results: TOut[] = new Array(items.length);
	let nextIndex = 0;
	const workers = new Array(limit).fill(null).map(async () => {
		while (true) {
			const current = nextIndex++;
			if (current >= items.length) return;
			results[current] = await fn(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

export async function probeVibe(command = "vibe"): Promise<VibeProbe> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const done = (probe: VibeProbe) => {
			if (!settled) {
				settled = true;
				resolve(probe);
			}
		};

		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn(command, ["--version"], { shell: false, stdio: ["ignore", "pipe", "pipe"] });
		} catch (error) {
			done({ ok: false, reason: error instanceof Error ? error.message : String(error) });
			return;
		}

		proc.stdout?.on("data", (data: Buffer) => {
			stdout += data.toString();
		});
		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});
		proc.on("error", (error) => {
			done({ ok: false, reason: `\`${command}\` could not be started: ${error.message}` });
		});
		proc.on("close", (code) => {
			const version = parseVibeVersion(`${stdout}\n${stderr}`);
			if (code === 0 && version) done({ ok: true, version });
			else done({ ok: false, version, reason: `\`${command} --version\` exited with code ${code ?? "?"}` });
		});
	});
}

export async function runSingle(
	defaults: RunDefaults,
	spec: TaskSpec,
	signal: AbortSignal | undefined,
	onProgress: ((result: VibeResult) => void) | undefined,
): Promise<VibeResult> {
	const workdir = spec.workdir ?? defaults.defaultCwd;
	const result: VibeResult = {
		agent: spec.agent,
		task: spec.task,
		workdir,
		status: "running",
		exitCode: -1,
		entries: [],
		stderr: "",
	};

	const emit = () => onProgress?.({ ...result, entries: [...result.entries] });
	const env = { ...process.env };
	if (defaults.model) env.VIBE_ACTIVE_MODEL = defaults.model;

	let wasAborted = false;
	let forceKill: ReturnType<typeof setTimeout> | undefined;
	let timeoutTimer: ReturnType<typeof setTimeout> | undefined;

	const exitCode = await new Promise<number>((resolve) => {
		const proc = spawn("vibe", buildArgs(defaults, spec), {
			cwd: workdir,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			env,
		});

		let buffer = "";
		const consumeLine = (line: string) => {
			const entry = parseStreamLine(line);
			if (!entry) return;
			result.entries.push(entry);
			emit();
		};

		proc.stdout.on("data", (data: Buffer) => {
			buffer += data.toString();
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) consumeLine(line);
		});
		proc.stderr.on("data", (data: Buffer) => {
			result.stderr += data.toString();
		});
		proc.on("close", (code) => {
			if (buffer.trim()) consumeLine(buffer);
			resolve(code ?? 0);
		});
		proc.on("error", (error) => {
			result.errorMessage = error.message;
			resolve(1);
		});

		const kill = () => {
			proc.kill("SIGTERM");
			forceKill = setTimeout(() => {
				if (!proc.killed) proc.kill("SIGKILL");
			}, 5000);
			forceKill.unref?.();
		};

		if (signal) {
			const onAbort = () => {
				wasAborted = true;
				kill();
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}

		if (defaults.timeoutMs && defaults.timeoutMs > 0) {
			timeoutTimer = setTimeout(() => {
				result.errorMessage = `Timed out after ${defaults.timeoutMs} ms`;
				kill();
			}, defaults.timeoutMs);
			timeoutTimer.unref?.();
		}
	});

	if (forceKill) clearTimeout(forceKill);
	if (timeoutTimer) clearTimeout(timeoutTimer);
	if (wasAborted) throw new Error("Vibe subagent was aborted");

	result.exitCode = exitCode;
	result.status = exitCode === 0 ? "ok" : "error";
	if (exitCode !== 0 && !result.errorMessage) {
		result.errorMessage = result.stderr.trim() || `vibe exited with code ${exitCode}`;
	}
	if (exitCode === 0 && !finalOutput(result.entries)) {
		result.warning = "No assistant message found; the Vibe output format may have changed.";
	}
	emit();
	return result;
}
