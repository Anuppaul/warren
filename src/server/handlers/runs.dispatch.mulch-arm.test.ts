import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { BridgeRegistry, ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

/**
 * The per-run mulch experiment arm at the HTTP boundary: `mulch` is an
 * optional "on" | "off" enum folded onto the frozen frontmatter
 * (`renderedAgentJson.frontmatter.mulch`); omitted leaves the frontmatter
 * untouched; anything else is a 400.
 */
describe("POST /runs — mulch experiment arm", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: {},
			},
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: await mkdtemp(join(tmpdir(), "warren-handlers-mulch-proj-")),
			defaultBranch: "main",
		});
		projectId = project.id;
		const bridges: BridgeRegistry = { start: () => {}, stopAll: async () => {}, size: () => 0 };
		const sandboxClient = makeSandboxClient(
			{
				sandboxId: "bur_mulch0000000",
				sandboxRunId: "run_mulchrun00000",
				workspacePath: await mkdtemp(join(tmpdir(), "warren-handlers-mulch-ws-")),
			},
			[],
		);
		handle = startServer(await depsFor(repos, sandboxClient, bridges), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function post(extra: Record<string, unknown>): Promise<Response> {
		if (!handle) throw new Error("server not started");
		return fetch(`${tcpUrl(handle)}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: "refactor-bot", project: projectId, prompt: "go", ...extra }),
		});
	}

	async function frozenFrontmatter(res: Response): Promise<Record<string, unknown>> {
		const body = (await res.json()) as { run: { id: string } };
		const row = await repos.runs.require(body.run.id);
		return (row.renderedAgentJson as { frontmatter: Record<string, unknown> }).frontmatter;
	}

	test("an explicit arm is frozen onto the run's frontmatter", async () => {
		const off = await post({ mulch: "off" });
		expect(off.status).toBe(201);
		expect((await frozenFrontmatter(off)).mulch).toBe("off");
		const on = await post({ mulch: "on" });
		expect(on.status).toBe(201);
		expect((await frozenFrontmatter(on)).mulch).toBe("on");
	});

	test("an omitted arm leaves the frontmatter unchanged", async () => {
		const res = await post({});
		expect(res.status).toBe(201);
		expect(await frozenFrontmatter(res)).not.toHaveProperty("mulch");
	});

	test("an unknown arm is a 400", async () => {
		expect((await post({ mulch: "maybe" })).status).toBe(400);
		expect((await post({ mulch: true })).status).toBe(400);
	});
});
