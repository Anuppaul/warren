#!/usr/bin/env bun
/**
 * Mulch A/B eval: does mulch make agent runs better, or only different?
 *
 * Dispatches PAIRED runs of the same task through warren's HTTP API, one
 * with the mulch arm "on" (warren installs mulch's Claude Code hooks:
 * SessionStart `ml prime` + PreToolUse `ml hook`) and one with "off" (no
 * hooks, no mulch prompt fragment). It then reports outcome, cost/tokens,
 * and wall time per arm from the recorded runs, plus which mulch records
 * were injected (the `mulch.usage` event finalize records on every run).
 *
 * Usage:
 *   bun run scripts/eval-mulch.ts dispatch --tasks tasks.json --out eval.json [--repeat N] [--dry-run]
 *   bun run scripts/eval-mulch.ts report --manifest eval.json [--json]
 *
 * `tasks.json` is an array of task specs. To replay a closed seeds issue, pin
 * `baseCommit` to the commit before its fix landed and reuse its prompt:
 *   [{ "id": "warren-1234", "project": "<projectId>", "prompt": "...",
 *      "agent": "claude-code", "baseCommit": "<40-hex>", "seedId": "warren-1234" }]
 *
 * `dispatch` spends real money: every task costs 2 x --repeat runs. Use
 * `--dry-run` to print the plan first. The arm order alternates per pair, so
 * neither arm always dispatches first. The manifest records every run id, and
 * `report` is read-only, so you can run it again while runs finish (runs that
 * are not terminal yet are listed as pending).
 *
 * Confounds to control: hooks the target repo checks in
 * (`.claude/settings.json`) or AGENTS.md text telling the agent to run
 * `ml prime` reach the "off" arm too. The report flags any "off" run that
 * still logged injections as contaminated. Hooks exist only on the
 * claude-code harness.
 *
 * Connection: WARREN_BASE_URL / WARREN_API_TOKEN, or `warren login` config.
 */

import { resolveClientConfig } from "../src/cli/client.ts";
import { WarrenClient } from "../src/client/client.ts";
import type { DispatchRunInput, RunEvent, RunRow } from "../src/client/types.ts";
import { isTerminalRunState } from "../src/core/wire.ts";

export const ARMS = ["on", "off"] as const;
export type Arm = (typeof ARMS)[number];

export interface EvalTask {
	readonly id: string;
	readonly project: string;
	readonly prompt: string;
	readonly agent?: string;
	readonly baseCommit?: string;
	readonly branch?: string;
	readonly seedId?: string;
	readonly maxCostUsd?: number;
}

export interface EvalPair {
	readonly taskId: string;
	readonly rep: number;
	readonly runs: Record<Arm, string>;
}

export interface EvalManifest {
	readonly version: 1;
	readonly createdAt: string;
	readonly pairs: EvalPair[];
}

/** The slice of `WarrenClient` the eval uses (mocked in tests). */
export interface EvalClient {
	dispatch(input: DispatchRunInput): Promise<{ run: { id: string } }>;
	getRun(runId: string): Promise<RunRow>;
	streamRunEvents(runId: string): AsyncIterable<RunEvent>;
}

export function parseTasks(raw: unknown): EvalTask[] {
	if (!Array.isArray(raw)) throw new Error("tasks file must be a JSON array");
	return raw.map((t, i) => {
		const o = (t ?? {}) as Record<string, unknown>;
		for (const key of ["id", "project", "prompt"]) {
			if (typeof o[key] !== "string" || o[key] === "") {
				throw new Error(`task[${i}].${key} must be a non-empty string`);
			}
		}
		return o as unknown as EvalTask;
	});
}

/** Dispatch input for one arm of a task. The default agent is claude-code, which has the hook surface. */
export function dispatchInput(task: EvalTask, arm: Arm): DispatchRunInput {
	return {
		agent: task.agent ?? "claude-code",
		project: task.project,
		prompt: task.prompt,
		mulch: arm,
		trigger: "eval-mulch",
		...(task.baseCommit !== undefined ? { baseCommit: task.baseCommit } : {}),
		...(task.branch !== undefined ? { branch: task.branch } : {}),
		...(task.seedId !== undefined ? { seedId: task.seedId } : {}),
		...(task.maxCostUsd !== undefined ? { maxCostUsd: task.maxCostUsd } : {}),
	};
}

export async function dispatchPairs(
	client: EvalClient,
	tasks: readonly EvalTask[],
	opts: { repeat: number; now?: () => Date; log?: (line: string) => void },
): Promise<EvalManifest> {
	const pairs: EvalPair[] = [];
	let n = 0;
	for (const task of tasks) {
		for (let rep = 0; rep < opts.repeat; rep++) {
			const order: Arm[] = n++ % 2 === 0 ? ["on", "off"] : ["off", "on"];
			const runs: Partial<Record<Arm, string>> = {};
			for (const arm of order) {
				const res = await client.dispatch(dispatchInput(task, arm));
				runs[arm] = res.run.id;
				opts.log?.(`${task.id} rep=${rep} arm=${arm} run=${res.run.id}`);
			}
			pairs.push({ taskId: task.id, rep, runs: runs as Record<Arm, string> });
		}
	}
	return { version: 1, createdAt: (opts.now?.() ?? new Date()).toISOString(), pairs };
}

/* ----------------------------------------------------------------------- */
/* Report                                                                   */
/* ----------------------------------------------------------------------- */

export interface RunOutcome {
	readonly runId: string;
	readonly taskId: string;
	readonly arm: Arm;
	readonly terminal: boolean;
	readonly state: string;
	readonly succeeded: boolean;
	readonly prOpened: boolean;
	readonly prMerged: boolean;
	readonly costUsd: number | null;
	readonly tokens: number | null;
	readonly wallSeconds: number | null;
	readonly injections: number;
	readonly records: ReadonlyArray<{ id: string; count: number }>;
}

interface UsagePayload {
	injections?: number;
	records?: Array<{ id: string; count: number }>;
}

export async function readOutcome(
	client: EvalClient,
	runId: string,
	taskId: string,
	arm: Arm,
): Promise<RunOutcome> {
	const run = await client.getRun(runId);
	let usage: UsagePayload = {};
	for await (const ev of client.streamRunEvents(runId)) {
		if (ev.kind === "mulch.usage") usage = (ev.payload ?? {}) as UsagePayload;
	}
	const wall =
		run.startedAt !== null && run.endedAt !== null
			? (Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000
			: null;
	const tokens =
		run.tokensInput === null && run.tokensOutput === null
			? null
			: (run.tokensInput ?? 0) + (run.tokensOutput ?? 0);
	return {
		runId,
		taskId,
		arm,
		terminal: isTerminalRunState(run.state),
		state: run.state,
		succeeded: run.state === "succeeded",
		prOpened: run.prUrl !== null,
		prMerged: run.prState === "merged",
		costUsd: run.costUsd,
		tokens,
		wallSeconds: wall !== null && Number.isFinite(wall) ? wall : null,
		injections: usage.injections ?? 0,
		records: usage.records ?? [],
	};
}

export interface ArmSummary {
	readonly runs: number;
	readonly pending: number;
	readonly successRate: number | null;
	readonly prRate: number | null;
	readonly mergedRate: number | null;
	readonly meanCostUsd: number | null;
	readonly meanTokens: number | null;
	readonly meanWallSeconds: number | null;
	readonly meanInjections: number | null;
}

export interface EvalReport {
	readonly arms: Record<Arm, ArmSummary>;
	/** Records injected in "on" runs: total injections, runs reached, and successful runs among those. */
	readonly records: ReadonlyArray<{
		id: string;
		injections: number;
		runs: number;
		succeeded: number;
	}>;
	/** "off" runs that still logged injections (target-repo hooks or instructions leaked in). */
	readonly contaminated: readonly string[];
	readonly outcomes: readonly RunOutcome[];
}

function mean(values: ReadonlyArray<number | null>): number | null {
	const xs = values.filter((v): v is number => v !== null);
	return xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function rate(done: readonly RunOutcome[], pick: (o: RunOutcome) => boolean): number | null {
	return done.length === 0 ? null : done.filter(pick).length / done.length;
}

function summarizeArm(outcomes: readonly RunOutcome[]): ArmSummary {
	const done = outcomes.filter((o) => o.terminal);
	return {
		runs: done.length,
		pending: outcomes.length - done.length,
		successRate: rate(done, (o) => o.succeeded),
		prRate: rate(done, (o) => o.prOpened),
		mergedRate: rate(done, (o) => o.prMerged),
		meanCostUsd: mean(done.map((o) => o.costUsd)),
		meanTokens: mean(done.map((o) => o.tokens)),
		meanWallSeconds: mean(done.map((o) => o.wallSeconds)),
		meanInjections: mean(done.map((o) => o.injections)),
	};
}

export function buildReport(outcomes: readonly RunOutcome[]): EvalReport {
	const records = new Map<string, { injections: number; runs: number; succeeded: number }>();
	for (const o of outcomes) {
		if (o.arm !== "on" || !o.terminal) continue;
		for (const r of o.records) {
			const acc = records.get(r.id) ?? { injections: 0, runs: 0, succeeded: 0 };
			acc.injections += r.count;
			acc.runs += 1;
			if (o.succeeded) acc.succeeded += 1;
			records.set(r.id, acc);
		}
	}
	return {
		arms: {
			on: summarizeArm(outcomes.filter((o) => o.arm === "on")),
			off: summarizeArm(outcomes.filter((o) => o.arm === "off")),
		},
		records: [...records.entries()]
			.map(([id, acc]) => ({ id, ...acc }))
			.sort((a, b) => b.injections - a.injections || a.id.localeCompare(b.id)),
		contaminated: outcomes.filter((o) => o.arm === "off" && o.injections > 0).map((o) => o.runId),
		outcomes,
	};
}

export async function reportManifest(
	client: EvalClient,
	manifest: EvalManifest,
): Promise<EvalReport> {
	const outcomes: RunOutcome[] = [];
	for (const pair of manifest.pairs) {
		for (const arm of ARMS) {
			outcomes.push(await readOutcome(client, pair.runs[arm], pair.taskId, arm));
		}
	}
	return buildReport(outcomes);
}

function fmt(v: number | null, digits = 2, pct = false): string {
	if (v === null) return "-";
	return pct ? `${(v * 100).toFixed(0)}%` : v.toFixed(digits);
}

export function renderMarkdown(report: EvalReport): string {
	const rows = ARMS.map((arm) => {
		const s = report.arms[arm];
		return `| ${arm} | ${s.runs} | ${s.pending} | ${fmt(s.successRate, 0, true)} | ${fmt(s.prRate, 0, true)} | ${fmt(s.mergedRate, 0, true)} | ${fmt(s.meanCostUsd, 4)} | ${fmt(s.meanTokens, 0)} | ${fmt(s.meanWallSeconds, 0)} | ${fmt(s.meanInjections, 1)} |`;
	});
	const lines = [
		"## Mulch eval",
		"",
		"| arm | runs | pending | success | PR | merged | mean $ | mean tokens | mean wall s | mean injections |",
		"|---|---|---|---|---|---|---|---|---|---|",
		...rows,
		"",
		"### Records injected (on arm)",
		"",
		"| record | injections | runs | succeeded |",
		"|---|---|---|---|",
		...report.records.map((r) => `| ${r.id} | ${r.injections} | ${r.runs} | ${r.succeeded} |`),
	];
	if (report.contaminated.length > 0) {
		lines.push("", `Contaminated off-arm runs: ${report.contaminated.join(", ")}`);
	}
	return `${lines.join("\n")}\n`;
}

/* ----------------------------------------------------------------------- */
/* CLI                                                                      */
/* ----------------------------------------------------------------------- */

function flag(args: readonly string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

function makeClient(): EvalClient {
	return new WarrenClient({ config: resolveClientConfig(process.env) });
}

interface MainDeps {
	client?: () => EvalClient;
	readJson?: (path: string) => Promise<unknown>;
	writeFile?: (path: string, body: string) => Promise<void>;
	out?: (line: string) => void;
}

type ResolvedDeps = Required<MainDeps>;

async function runDispatch(rest: readonly string[], deps: ResolvedDeps): Promise<number> {
	const tasksPath = flag(rest, "--tasks");
	const outPath = flag(rest, "--out");
	if (tasksPath === undefined || outPath === undefined) {
		deps.out("usage: eval-mulch.ts dispatch --tasks <tasks.json> --out <manifest.json>");
		return 2;
	}
	const tasks = parseTasks(await deps.readJson(tasksPath));
	const repeat = Number.parseInt(flag(rest, "--repeat") ?? "1", 10);
	if (!Number.isInteger(repeat) || repeat < 1) throw new Error("--repeat must be >= 1");
	if (rest.includes("--dry-run")) {
		for (const task of tasks) {
			for (const arm of ARMS) deps.out(JSON.stringify(dispatchInput(task, arm)));
		}
		deps.out(`dry run: ${tasks.length * repeat * ARMS.length} runs would be dispatched`);
		return 0;
	}
	const manifest = await dispatchPairs(deps.client(), tasks, { repeat, log: deps.out });
	await deps.writeFile(outPath, `${JSON.stringify(manifest, null, 2)}\n`);
	deps.out(`wrote ${outPath} (${manifest.pairs.length} pairs)`);
	return 0;
}

async function runReport(rest: readonly string[], deps: ResolvedDeps): Promise<number> {
	const manifestPath = flag(rest, "--manifest");
	if (manifestPath === undefined) {
		deps.out("usage: eval-mulch.ts report --manifest <manifest.json> [--json]");
		return 2;
	}
	const manifest = (await deps.readJson(manifestPath)) as EvalManifest;
	const report = await reportManifest(deps.client(), manifest);
	deps.out(rest.includes("--json") ? JSON.stringify(report, null, 2) : renderMarkdown(report));
	return 0;
}

export async function main(args: readonly string[], deps: MainDeps = {}): Promise<number> {
	const resolved: ResolvedDeps = {
		out: deps.out ?? ((line: string) => console.log(line)),
		readJson: deps.readJson ?? (async (p: string) => Bun.file(p).json()),
		writeFile:
			deps.writeFile ??
			(async (p: string, b: string) => {
				await Bun.write(p, b);
			}),
		client: deps.client ?? makeClient,
	};
	const [cmd, ...rest] = args;
	if (cmd === "dispatch") return runDispatch(rest, resolved);
	if (cmd === "report") return runReport(rest, resolved);
	resolved.out(
		"usage: eval-mulch.ts <dispatch|report> ... (see the header of scripts/eval-mulch.ts)",
	);
	return 2;
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
