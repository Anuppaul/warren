/**
 * Mulch usage attribution: which expertise records reached the agent during
 * a run.
 *
 * Mulch's Claude Code PreToolUse hook (`ml hook`, installed by
 * `ml setup claude` or by the claude-code adapter's `mulch: "on"` arm) appends
 * one line per injection to `<workspace>/.mulch/state/usage.jsonl`:
 *
 *   {"ts":"<ISO>","session":"<id>|null","tool":"Read","files":["src/a.ts"],"ids":["mx-1a2b3c"]}
 *
 * Both finalize paths (LocalProvider host-side, K8s in-pod) read that file
 * while the workspace is still live and emit ONE `mulch.usage` event, which
 * the domain re-emits onto the run's event stream (`GET /runs/:id/events`).
 *
 * Scope: the whole file belongs to the run. Every run gets a fresh workspace
 * (a new worktree or clone), and mulch self-gitignores `.mulch/state/`, so no
 * earlier run's lines can be inherited. The sandbox does not expose the host
 * clone's `.mulch/`, so mulch's worktree redirect falls back to the
 * workspace.
 *
 * Fail-open: an absent, unreadable, or malformed file never fails finalize.
 * A missing file yields no event, and malformed lines are counted and skipped.
 */

import { join } from "node:path";
import type { FinalizeEvent } from "./contract.ts";

/** Workspace-relative path of mulch's injection log. */
export const MULCH_USAGE_REL = ".mulch/state/usage.jsonl";

/** Event kind carrying the per-run summary. */
export const MULCH_USAGE_EVENT = "mulch.usage";

/** Cap on per-record rows in the event payload, keeping one event bounded. */
const MAX_RECORD_ROWS = 200;

export interface MulchUsageRecord {
	readonly id: string;
	/** Number of injections that carried this record. */
	readonly count: number;
}

export interface MulchUsageSummary {
	/** Hook injections (valid log lines). */
	readonly injections: number;
	/** Distinct record ids injected. */
	readonly uniqueRecords: number;
	/** Sum of ids across injections (a record injected twice counts twice). */
	readonly recordInjections: number;
	/** Distinct non-null agent session ids seen. */
	readonly sessions: number;
	/** Injections per tool (`Read`, `Edit`, ...). */
	readonly tools: Readonly<Record<string, number>>;
	/** Per-record counts, count desc then id asc, capped at {@link MAX_RECORD_ROWS}. */
	readonly records: readonly MulchUsageRecord[];
	/** Lines that were not a valid usage entry. */
	readonly malformedLines: number;
	/** First and last injection timestamps, `null` when there were none. */
	readonly firstTs: string | null;
	readonly lastTs: string | null;
}

interface UsageLine {
	ts: string;
	session: string | null;
	tool: string;
	ids: string[];
}

function parseUsageLine(line: string): UsageLine | null {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		return null;
	}
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const o = raw as Record<string, unknown>;
	if (!Array.isArray(o.ids) || o.ids.some((id) => typeof id !== "string")) return null;
	return {
		ts: typeof o.ts === "string" ? o.ts : "",
		session: typeof o.session === "string" && o.session !== "" ? o.session : null,
		tool: typeof o.tool === "string" && o.tool !== "" ? o.tool : "unknown",
		ids: o.ids as string[],
	};
}

/** Parsed usage lines plus the malformed-line count. */
function parseUsageBody(body: string): { entries: UsageLine[]; malformedLines: number } {
	const entries: UsageLine[] = [];
	let malformedLines = 0;
	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;
		const entry = parseUsageLine(line);
		if (entry === null) malformedLines += 1;
		else entries.push(entry);
	}
	return { entries, malformedLines };
}

/** Increment `key` in a counting map. */
function bump(map: Map<string, number>, key: string): void {
	map.set(key, (map.get(key) ?? 0) + 1);
}

/** Pure: summarize a `usage.jsonl` body. Blank lines are ignored. */
export function summarizeMulchUsage(body: string): MulchUsageSummary {
	const { entries, malformedLines } = parseUsageBody(body);
	const counts = new Map<string, number>();
	const tools = new Map<string, number>();
	const sessions = new Set<string>();
	for (const entry of entries) {
		bump(tools, entry.tool);
		if (entry.session !== null) sessions.add(entry.session);
		for (const id of entry.ids) bump(counts, id);
	}
	const stamps = entries
		.map((e) => e.ts)
		.filter((ts) => ts !== "")
		.sort();

	const records = [...counts.entries()]
		.map(([id, count]) => ({ id, count }))
		.sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
		.slice(0, MAX_RECORD_ROWS);

	return {
		injections: entries.length,
		uniqueRecords: counts.size,
		recordInjections: entries.reduce((n, e) => n + e.ids.length, 0),
		sessions: sessions.size,
		tools: Object.fromEntries(tools),
		records,
		malformedLines,
		firstTs: stamps[0] ?? null,
		lastTs: stamps.at(-1) ?? null,
	};
}

/**
 * Read the workspace's usage log and build the `mulch.usage` finalize event.
 * `null` when the file is absent, unreadable, or empty (fail-open).
 */
export async function collectMulchUsageEvent(
	workspacePath: string,
	readFile: (path: string) => Promise<string | null>,
): Promise<FinalizeEvent | null> {
	let body: string | null;
	try {
		body = await readFile(join(workspacePath, MULCH_USAGE_REL));
	} catch {
		return null;
	}
	if (body === null || body.trim() === "") return null;
	return { kind: MULCH_USAGE_EVENT, payload: summarizeMulchUsage(body) };
}
