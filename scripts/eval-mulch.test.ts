import { describe, expect, test } from "bun:test";
import type { DispatchRunInput, RunEvent, RunRow } from "../src/client/types.ts";
import {
	buildReport,
	dispatchInput,
	dispatchPairs,
	type EvalClient,
	type EvalManifest,
	main,
	parseTasks,
	renderMarkdown,
	reportManifest,
} from "./eval-mulch.ts";

const TASK = { id: "warren-1", project: "p1", prompt: "fix it", baseCommit: "a".repeat(40) };

function run(id: string, over: Partial<RunRow> = {}): RunRow {
	return {
		id,
		state: "succeeded",
		startedAt: "2026-09-01T00:00:00.000Z",
		endedAt: "2026-09-01T00:01:40.000Z",
		prUrl: "https://example.test/pr/1",
		prState: "open",
		costUsd: 1.5,
		tokensInput: 1000,
		tokensOutput: 500,
		...over,
	} as RunRow;
}

function usage(injections: number, records: Array<{ id: string; count: number }>): RunEvent {
	return { kind: "mulch.usage", payload: { injections, records } } as RunEvent;
}

/** Mock client: dispatch hands out r1, r2, ...; rows and events come from the fixture maps. */
function mockClient(rows: Record<string, RunRow>, events: Record<string, RunEvent[]> = {}) {
	const dispatched: DispatchRunInput[] = [];
	const client: EvalClient = {
		dispatch: async (input) => {
			dispatched.push(input);
			return { run: { id: `r${dispatched.length}` } };
		},
		getRun: async (id) => {
			const row = rows[id];
			if (row === undefined) throw new Error(`no run ${id}`);
			return row;
		},
		streamRunEvents: async function* (id) {
			yield* events[id] ?? [];
		},
	};
	return { client, dispatched };
}

describe("parseTasks", () => {
	test("accepts well-formed specs and rejects missing fields", () => {
		expect(parseTasks([TASK])).toEqual([TASK]);
		expect(() => parseTasks({})).toThrow(/array/);
		expect(() => parseTasks([{ id: "x", project: "p" }])).toThrow(/prompt/);
	});
});

describe("dispatchPairs", () => {
	test("dispatches one on + one off run per task and rep, alternating order", async () => {
		const { client, dispatched } = mockClient({});
		const manifest = await dispatchPairs(client, [TASK], {
			repeat: 2,
			now: () => new Date("2026-09-01T00:00:00Z"),
		});
		expect(dispatched.map((d) => d.mulch)).toEqual(["on", "off", "off", "on"]);
		expect(dispatched[0]).toMatchObject({ agent: "claude-code", baseCommit: TASK.baseCommit });
		expect(manifest.pairs).toEqual([
			{ taskId: "warren-1", rep: 0, runs: { on: "r1", off: "r2" } },
			{ taskId: "warren-1", rep: 1, runs: { off: "r3", on: "r4" } },
		]);
	});

	test("dispatchInput forwards optional task fields only when set", () => {
		const input = dispatchInput({ id: "t", project: "p", prompt: "x", agent: "pi" }, "off");
		expect(input).toEqual({
			agent: "pi",
			project: "p",
			prompt: "x",
			mulch: "off",
			trigger: "eval-mulch",
		});
	});
});

describe("reportManifest", () => {
	const manifest: EvalManifest = {
		version: 1,
		createdAt: "2026-09-01T00:00:00Z",
		pairs: [
			{ taskId: "t1", rep: 0, runs: { on: "on1", off: "off1" } },
			{ taskId: "t2", rep: 0, runs: { on: "on2", off: "off2" } },
		],
	};
	const rows = {
		on1: run("on1", { prState: "merged" }),
		off1: run("off1", { state: "failed", prUrl: null, prState: null, costUsd: 3 }),
		on2: run("on2", { state: "running", endedAt: null }),
		off2: run("off2"),
	};
	const events = {
		on1: [
			usage(3, [
				{ id: "mx-a", count: 2 },
				{ id: "mx-b", count: 1 },
			]),
		],
		off2: [usage(1, [{ id: "mx-a", count: 1 }])],
	};

	test("compares arms, attributes records, and flags contaminated off runs", async () => {
		const { client } = mockClient(rows, events);
		const report = await reportManifest(client, manifest);
		expect(report.arms.on).toMatchObject({
			runs: 1,
			pending: 1,
			successRate: 1,
			mergedRate: 1,
			meanCostUsd: 1.5,
			meanTokens: 1500,
			meanWallSeconds: 100,
			meanInjections: 3,
		});
		expect(report.arms.off).toMatchObject({
			runs: 2,
			successRate: 0.5,
			prRate: 0.5,
			meanCostUsd: 2.25,
		});
		expect(report.records).toEqual([
			{ id: "mx-a", injections: 2, runs: 1, succeeded: 1 },
			{ id: "mx-b", injections: 1, runs: 1, succeeded: 1 },
		]);
		expect(report.contaminated).toEqual(["off2"]);
		const md = renderMarkdown(report);
		expect(md).toContain("| on | 1 | 1 | 100% |");
		expect(md).toContain("| mx-a | 2 | 1 | 1 |");
		expect(md).toContain("Contaminated off-arm runs: off2");
	});

	test("empty outcomes render dashes instead of NaN", () => {
		const md = renderMarkdown(buildReport([]));
		expect(md).toContain("| on | 0 | 0 | - |");
		expect(md).not.toContain("NaN");
	});
});

describe("main", () => {
	test("dispatch --dry-run prints the plan without dispatching", async () => {
		const { client, dispatched } = mockClient({});
		const lines: string[] = [];
		const code = await main(["dispatch", "--tasks", "t.json", "--out", "m.json", "--dry-run"], {
			client: () => client,
			readJson: async () => [TASK],
			out: (l) => lines.push(l),
		});
		expect(code).toBe(0);
		expect(dispatched).toEqual([]);
		expect(lines.at(-1)).toBe("dry run: 2 runs would be dispatched");
	});

	test("dispatch writes the manifest; report renders JSON", async () => {
		const { client } = mockClient({ r1: run("r1"), r2: run("r2") });
		const written: Record<string, string> = {};
		const lines: string[] = [];
		const deps = {
			client: () => client,
			readJson: async (p: string) =>
				p === "t.json" ? [TASK] : JSON.parse(written["m.json"] ?? ""),
			writeFile: async (p: string, b: string) => {
				written[p] = b;
			},
			out: (l: string) => lines.push(l),
		};
		expect(await main(["dispatch", "--tasks", "t.json", "--out", "m.json"], deps)).toBe(0);
		expect(JSON.parse(written["m.json"] ?? "").pairs).toHaveLength(1);
		expect(await main(["report", "--manifest", "m.json", "--json"], deps)).toBe(0);
		expect(JSON.parse(lines.at(-1) ?? "").arms.on.runs).toBe(1);
	});

	test("usage errors exit 2", async () => {
		const out = () => {};
		expect(await main([], { out })).toBe(2);
		expect(await main(["dispatch"], { out })).toBe(2);
		expect(await main(["report"], { out })).toBe(2);
	});
});
