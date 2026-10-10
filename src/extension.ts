/**
 * pi-vibe-subagent - delegate tasks from pi to Mistral Vibe subagents.
 *
 * Spawns a separate `vibe -p` process per task, giving it an isolated context
 * window and Vibe's own harness (tools, skills, MCP, agents).
 *
 * Modes:
 *   - single:   { agent, task, workdir? }
 *   - parallel: { tasks: [{ agent, task, workdir? }, ...] }
 *
 * Output is read from `vibe --output streaming`, which emits one completed
 * history entry (message / reasoning / effect) per JSON line.
 */

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
	type Approval,
	COLLAPSED_ITEM_COUNT,
	compareVersions,
	DEFAULT_AGENT,
	type DisplayItem,
	finalOutput,
	isFailed,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	MIN_VIBE_VERSION,
	mapWithConcurrencyLimit,
	probeVibe,
	type RunDefaults,
	resultOutput,
	runSingle,
	shortenPath,
	type TaskSpec,
	toDisplayItems,
	truncateOutput,
	type VibeProbe,
	type VibeResult,
} from "./vibe.ts";

interface VibeDetails {
	mode: "single" | "parallel";
	approval: Approval;
	results: VibeResult[];
}

function defaultApproval(): Approval {
	const value = process.env.PI_VIBE_APPROVAL;
	return value === "auto" || value === "smart" || value === "inherit" ? value : "smart";
}

function defaultAgent(): string {
	return process.env.PI_VIBE_AGENT?.trim() || DEFAULT_AGENT;
}

let probePromise: Promise<VibeProbe> | undefined;
function ensureVibe(): Promise<VibeProbe> {
	probePromise ??= probeVibe();
	return probePromise;
}

const TaskItem = Type.Object({
	agent: Type.Optional(Type.String({ description: `Vibe agent profile. Default: "${DEFAULT_AGENT}".` })),
	task: Type.String({ description: "Self-contained task. The subagent cannot see this conversation." }),
	workdir: Type.Optional(Type.String({ description: "Working directory for this task." })),
});

const ApprovalSchema = StringEnum(["auto", "smart", "inherit"] as const, {
	description:
		'Tool approval policy. "auto" runs every tool, "smart" auto-runs only safe calls, "inherit" keeps the agent profile setting. Default: PI_VIBE_APPROVAL or "smart".',
	default: "smart",
});

const VibeParams = Type.Object({
	agent: Type.Optional(Type.String({ description: `Vibe agent profile for single mode. Default: "${DEFAULT_AGENT}".` })),
	task: Type.Optional(Type.String({ description: "Task for single mode. Must be self-contained." })),
	workdir: Type.Optional(Type.String({ description: "Working directory for single mode. Default: the session cwd." })),
	tasks: Type.Optional(Type.Array(TaskItem, { description: "Parallel tasks (max 8, 4 concurrent)." })),
	approval: Type.Optional(ApprovalSchema),
	model: Type.Optional(Type.String({ description: "Override the Vibe model via VIBE_ACTIVE_MODEL." })),
	maxTurns: Type.Optional(Type.Number({ description: "Max assistant turns per task. Default: 30." })),
	maxPrice: Type.Optional(Type.Number({ description: "Max cost in dollars per task." })),
	maxTokens: Type.Optional(Type.Number({ description: "Max total tokens per task." })),
	timeoutMs: Type.Optional(Type.Number({ description: "Kill a task after this many milliseconds." })),
	worktree: Type.Optional(
		Type.Boolean({ description: "Run each task in its own git worktree. Use for parallel edits.", default: false }),
	),
	trust: Type.Optional(
		Type.Boolean({ description: "Pass --trust so Vibe reads project config without prompting. Default: true." }),
	),
});

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "vibe",
		label: "Vibe Subagent",
		description: [
			"Delegate self-contained tasks to Mistral Vibe subagents with isolated context.",
			"Each subagent runs a separate `vibe -p` process with Vibe's own harness (tools, skills, MCP, agents).",
			`Modes: single (agent + task) or parallel (tasks array, max ${MAX_PARALLEL_TASKS}, ${MAX_CONCURRENCY} concurrent).`,
			`Default agent is "${DEFAULT_AGENT}" and default approval is "smart".`,
			"A subagent cannot see this conversation, so restate all context in the task.",
			"For parallel tasks that write files, set worktree: true to isolate each task.",
		].join(" "),
		promptSnippet: "Delegate a self-contained task to a Mistral Vibe subagent",
		promptGuidelines: [
			"Vibe subagents run in an isolated context and cannot see this conversation. Make every task self-contained: repo path, relevant files, constraints, and the exact output expected.",
			"For parallel vibe tasks that edit files, set worktree: true so each subagent works in its own git worktree.",
		],
		parameters: VibeParams,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const approval: Approval = params.approval ?? defaultApproval();
			const agentDefault = defaultAgent();
			const details = (mode: "single" | "parallel", results: VibeResult[]): VibeDetails => ({
				mode,
				approval,
				results,
			});

			const probe = await ensureVibe();
			if (!probe.ok) {
				const message = probe.version
					? `Vibe ${probe.version} is not usable: ${probe.reason ?? "unknown error"}.`
					: `Vibe is not available: ${probe.reason ?? "unknown error"}. Install it from https://github.com/mistralai/mistral-vibe.`;
				return fail(message, details("single", []));
			}
			if (compareVersions(probe.version ?? "0.0.0", MIN_VIBE_VERSION) < 0 && process.env.PI_VIBE_SKIP_VERSION_CHECK !== "1") {
				return fail(
					`Vibe ${probe.version} is older than the tested minimum ${MIN_VIBE_VERSION}. Upgrade vibe, or set PI_VIBE_SKIP_VERSION_CHECK=1 to try anyway.`,
					details("single", []),
				);
			}

			const defaults: RunDefaults = {
				defaultCwd: ctx.cwd,
				approval,
				model: params.model,
				maxTurns: params.maxTurns,
				maxPrice: params.maxPrice,
				maxTokens: params.maxTokens,
				trust: params.trust ?? true,
				worktree: params.worktree ?? false,
				timeoutMs: params.timeoutMs,
			};

			const hasSingle = Boolean(params.task);
			const hasParallel = (params.tasks?.length ?? 0) > 0;
			if (hasSingle === hasParallel) {
				return fail(
					"Invalid parameters: provide exactly one mode. Use { agent, task } for single, or { tasks } for parallel.",
					details(hasParallel ? "parallel" : "single", []),
				);
			}
			if (hasParallel && params.tasks && params.tasks.length > MAX_PARALLEL_TASKS) {
				return fail(
					`Too many parallel tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
					details("parallel", []),
				);
			}

			if (hasParallel && params.tasks) {
				const allResults: VibeResult[] = params.tasks.map((task) => ({
					agent: task.agent ?? agentDefault,
					task: task.task,
					workdir: task.workdir ?? ctx.cwd,
					status: "running",
					exitCode: -1,
					entries: [],
					stderr: "",
				}));

				const emitParallel = () => {
					if (!onUpdate) return;
					const done = allResults.filter((result) => result.status !== "running").length;
					onUpdate({
						content: [
							{ type: "text", text: `Parallel: ${done}/${allResults.length} done, ${allResults.length - done} running...` },
						],
						details: details("parallel", [...allResults]),
					});
				};
				emitParallel();

				const results = await mapWithConcurrencyLimit(params.tasks, MAX_CONCURRENCY, async (task, index) => {
					const spec: TaskSpec = { agent: task.agent ?? agentDefault, task: task.task, workdir: task.workdir };
					const result = await runSingle(defaults, spec, signal, (partial) => {
						allResults[index] = partial;
						emitParallel();
					});
					allResults[index] = result;
					emitParallel();
					return result;
				});

				const successCount = results.filter((result) => !isFailed(result)).length;
				const summaries = results.map((result) => {
					const status = isFailed(result) ? "failed" : "completed";
					const warning = result.warning ? `\n\n[warning: ${result.warning}]` : "";
					return `### [${result.agent}] ${status}${warning}\n\n${truncateOutput(resultOutput(result))}`;
				});
				return {
					content: [
						{
							type: "text",
							text: `Parallel: ${successCount}/${results.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
						},
					],
					details: details("parallel", results),
				};
			}

			const spec: TaskSpec = { agent: params.agent ?? agentDefault, task: params.task ?? "", workdir: params.workdir };
			const result = await runSingle(defaults, spec, signal, (partial) => {
				onUpdate?.({
					content: [{ type: "text", text: finalOutput(partial.entries) || "(running...)" }],
					details: details("single", [partial]),
				});
			});

			if (isFailed(result)) {
				return fail(`Vibe agent ${result.agent} failed: ${resultOutput(result)}`, details("single", [result]));
			}
			const output = finalOutput(result.entries) || "(no output)";
			const warning = result.warning ? `\n\n[warning: ${result.warning}]` : "";
			return {
				content: [{ type: "text", text: `${output}${warning}` }],
				details: details("single", [result]),
			};
		},

		renderCall(args, theme, _context) {
			const agentDefault = defaultAgent();
			if (args.tasks && args.tasks.length > 0) {
				let text =
					theme.fg("toolTitle", theme.bold("vibe ")) +
					theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
					theme.fg("muted", ` [${args.approval ?? defaultApproval()}]`);
				for (const task of args.tasks.slice(0, 3)) {
					const preview = task.task.length > 40 ? `${task.task.slice(0, 40)}...` : task.task;
					text += `\n  ${theme.fg("accent", task.agent ?? agentDefault)}${theme.fg("dim", ` ${preview}`)}`;
				}
				if (args.tasks.length > 3) text += `\n  ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
				return new Text(text, 0, 0);
			}
			const task = args.task ?? "";
			const preview = task.length > 60 ? `${task.slice(0, 60)}...` : task;
			let text =
				theme.fg("toolTitle", theme.bold("vibe ")) +
				theme.fg("accent", args.agent ?? agentDefault) +
				theme.fg("muted", ` [${args.approval ?? defaultApproval()}]`);
			text += `\n  ${theme.fg("dim", preview)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as VibeDetails | undefined;
			if (!details || details.results.length === 0) {
				const block = result.content[0];
				return new Text(block?.type === "text" ? block.text : "(no output)", 0, 0);
			}

			const mdTheme = getMarkdownTheme();
			const renderItems = (items: DisplayItem[]) => {
				const toShow = expanded ? items : items.slice(-COLLAPSED_ITEM_COUNT);
				const skipped = items.length - toShow.length;
				let text = "";
				if (skipped > 0) text += `${theme.fg("muted", `... ${skipped} earlier items`)}\n`;
				for (const item of toShow) {
					if (item.kind === "tool") {
						text += `${theme.fg("muted", "→ ")}${theme.fg("toolOutput", item.label)}\n`;
					} else {
						const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
						text += `${theme.fg("toolOutput", preview)}\n`;
					}
				}
				return text.trimEnd();
			};
			const icon = (value: VibeResult) =>
				value.status === "ok"
					? theme.fg("success", "✓")
					: value.status === "error"
						? theme.fg("error", "✗")
						: theme.fg("muted", ".");
			const header = (value: VibeResult) =>
				`${icon(value)} ${theme.fg("toolTitle", theme.bold(value.agent))}${theme.fg("muted", ` (${shortenPath(value.workdir)})`)}`;
			const renderOne = (value: VibeResult) => {
				const items = toDisplayItems(value.entries);
				if (expanded) {
					const container = new Container();
					container.addChild(new Text(header(value), 0, 0));
					if (isFailed(value) && value.errorMessage) {
						container.addChild(new Text(theme.fg("error", `Error: ${value.errorMessage}`), 0, 0));
					}
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
					container.addChild(new Text(theme.fg("dim", value.task), 0, 0));
					container.addChild(new Spacer(1));
					container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
					for (const item of items) {
						if (item.kind === "tool") {
							container.addChild(new Text(`${theme.fg("muted", "→ ")}${theme.fg("toolOutput", item.label)}`, 0, 0));
						}
					}
					const output = finalOutput(value.entries);
					if (output) {
						container.addChild(new Spacer(1));
						container.addChild(new Markdown(output, 0, 0, mdTheme));
					}
					return container;
				}
				let text = header(value);
				if (isFailed(value) && value.errorMessage) {
					text += `\n${theme.fg("error", `Error: ${value.errorMessage}`)}`;
				} else if (items.length === 0) {
					text += `\n${theme.fg("muted", "(no output)")}`;
				} else {
					text += `\n${renderItems(items)}`;
					if (!expanded && items.length > COLLAPSED_ITEM_COUNT) {
						text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
					}
				}
				return new Text(text, 0, 0);
			};

			if (details.mode === "single" && details.results.length === 1) {
				return renderOne(details.results[0]);
			}

			if (expanded) {
				const container = new Container();
				const done = details.results.filter((value) => value.status !== "running").length;
				container.addChild(
					new Text(
						`${theme.fg("toolTitle", theme.bold("vibe "))}${theme.fg("accent", `parallel ${done}/${details.results.length}`)}`,
						0,
						0,
					),
				);
				for (const value of details.results) {
					container.addChild(new Spacer(1));
					container.addChild(renderOne(value));
				}
				return container;
			}

			let text = theme.fg("toolTitle", theme.bold("vibe ")) + theme.fg("accent", "parallel");
			let truncated = false;
			for (const value of details.results) {
				const items = toDisplayItems(value.entries);
				if (items.length > COLLAPSED_ITEM_COUNT) truncated = true;
				const last = items[items.length - 1];
				const suffix = last?.kind === "tool" ? ` · ${last.label}` : "";
				text += `\n  ${icon(value)} ${theme.fg("accent", value.agent)}${theme.fg("dim", suffix)}`;
			}
			if (truncated) text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
			return new Text(text, 0, 0);
		},
	});
}

function fail(message: string, details: VibeDetails): AgentToolResult<VibeDetails> {
	return { content: [{ type: "text", text: message }], details, isError: true };
}
