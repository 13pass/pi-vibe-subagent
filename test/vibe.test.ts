import assert from "node:assert/strict";
import { test } from "node:test";
import {
	buildArgs,
	compareVersions,
	finalOutput,
	mapWithConcurrencyLimit,
	parseStreamLine,
	parseVibeVersion,
	type RunDefaults,
	type TaskSpec,
	toDisplayItems,
	truncateOutput,
	type VibeEntry,
	type VibeResult,
	resultOutput,
} from "../src/vibe.ts";

const defaults: RunDefaults = {
	defaultCwd: "/repo",
	approval: "auto",
	trust: true,
	worktree: false,
};

const spec: TaskSpec = { agent: "auto-approve", task: "do the thing" };

test("parseVibeVersion extracts a semver from common outputs", () => {
	assert.equal(parseVibeVersion("vibe 2.26.0"), "2.26.0");
	assert.equal(parseVibeVersion("2.26.0\n"), "2.26.0");
	assert.equal(parseVibeVersion("vibe version 3.1.4 (build abc)"), "3.1.4");
	assert.equal(parseVibeVersion("no version here"), undefined);
});

test("compareVersions orders numeric versions", () => {
	assert.ok(compareVersions("2.26.0", "2.25.9") > 0);
	assert.ok(compareVersions("2.26.0", "2.26.0") === 0);
	assert.ok(compareVersions("2.9.0", "2.10.0") < 0);
	assert.ok(compareVersions("2.26", "2.26.0") === 0);
});

test("buildArgs uses streaming output and the requested agent", () => {
	const args = buildArgs(defaults, spec);
	assert.ok(args.includes("--prompt=do the thing"));
	assert.deepEqual(args.slice(args.indexOf("--output"), args.indexOf("--output") + 2), ["--output", "streaming"]);
	assert.deepEqual(args.slice(args.indexOf("--agent"), args.indexOf("--agent") + 2), ["--agent", "auto-approve"]);
	assert.deepEqual(args.slice(args.indexOf("--max-turns"), args.indexOf("--max-turns") + 2), ["--max-turns", "30"]);
	assert.ok(args.includes("--auto-approve"));
	assert.ok(args.includes("--trust"));
	assert.ok(!args.includes("--worktree"));
});

test("buildArgs maps approval modes and optional limits", () => {
	const smart = buildArgs({ ...defaults, approval: "smart" }, spec);
	assert.ok(smart.includes("--smart-approve"));
	assert.ok(!smart.includes("--auto-approve"));

	const inherit = buildArgs({ ...defaults, approval: "inherit" }, spec);
	assert.ok(!inherit.includes("--smart-approve"));
	assert.ok(!inherit.includes("--auto-approve"));

	const limited = buildArgs({ ...defaults, maxPrice: 1.5, maxTokens: 5000, maxTurns: 5, worktree: true }, spec);
	assert.deepEqual(limited.slice(limited.indexOf("--max-price"), limited.indexOf("--max-price") + 2), ["--max-price", "1.5"]);
	assert.deepEqual(limited.slice(limited.indexOf("--max-tokens"), limited.indexOf("--max-tokens") + 2), ["--max-tokens", "5000"]);
	assert.deepEqual(limited.slice(limited.indexOf("--max-turns"), limited.indexOf("--max-turns") + 2), ["--max-turns", "5"]);
	assert.ok(limited.includes("--worktree"));
});

test("parseStreamLine ignores blank, malformed, and non-object lines", () => {
	assert.equal(parseStreamLine(""), undefined);
	assert.equal(parseStreamLine("not json"), undefined);
	assert.equal(parseStreamLine("[1,2,3]"), undefined);
	assert.deepEqual(parseStreamLine('{"type":"message","role":"assistant"}'), { type: "message", role: "assistant" });
});

test("toDisplayItems maps effects to tool rows and assistant messages to text", () => {
	const entries: VibeEntry[] = [
		{ type: "message", role: "user", content: [{ type: "text", text: "hi" }] },
		{
			type: "effect",
			title: "file_system.bash",
			detail: { toolName: "file_system.bash", display: { summary: "bash: echo hi" } },
			state: { status: "completed" },
		},
		{ type: "message", role: "assistant", content: [{ type: "text", text: "done" }] },
	];
	assert.deepEqual(toDisplayItems(entries), [
		{ kind: "tool", label: "bash: echo hi", status: "completed" },
		{ kind: "text", text: "done" },
	]);
});

test("toDisplayItems skips unfinished entries", () => {
	const entries: VibeEntry[] = [
		{ type: "effect", generationStatus: "in_progress", detail: { display: { summary: "running" } } },
	];
	assert.deepEqual(toDisplayItems(entries), []);
});

test("finalOutput returns the last assistant message", () => {
	const entries: VibeEntry[] = [
		{ type: "message", role: "assistant", content: [{ type: "text", text: "first" }] },
		{ type: "message", role: "assistant", content: [{ type: "text", text: "second" }] },
	];
	assert.equal(finalOutput(entries), "second");
});

test("resultOutput reports schema drift instead of an empty string", () => {
	const drifted: VibeResult = {
		agent: "auto-approve",
		task: "t",
		workdir: "/repo",
		status: "ok",
		exitCode: 0,
		entries: [{ type: "something_new" }],
		stderr: "",
	};
	assert.match(resultOutput(drifted), /format may have changed/);

	const empty: VibeResult = { ...drifted, entries: [] };
	assert.equal(resultOutput(empty), "(no output)");
});

test("truncateOutput caps large output and notes the omission", () => {
	const small = "hello";
	assert.equal(truncateOutput(small), small);

	const big = "x".repeat(60 * 1024);
	const truncated = truncateOutput(big);
	assert.ok(Buffer.byteLength(truncated, "utf8") < Buffer.byteLength(big, "utf8"));
	assert.match(truncated, /Output truncated:/);
});

test("mapWithConcurrencyLimit preserves order and respects the limit", async () => {
	let active = 0;
	let peak = 0;
	const results = await mapWithConcurrencyLimit([1, 2, 3, 4, 5, 6], 2, async (value) => {
		active++;
		peak = Math.max(peak, active);
		await new Promise((resolve) => setTimeout(resolve, 5));
		active--;
		return value * 2;
	});
	assert.deepEqual(results, [2, 4, 6, 8, 10, 12]);
	assert.ok(peak <= 2);
});
