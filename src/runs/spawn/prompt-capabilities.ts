/**
 * Resolve the project's prompt-capability facts (warren-cb46, pl-a37b).
 *
 * The spawn path feeds these into `withGatedPromptFragments` so the
 * dispatched prompt only asserts tooling the project actually has:
 *
 *   tracker — the row's `hasSeeds` flag (the persisted `.seeds/` probe,
 *             refreshed with the clone) AND a boot-wired tracker whose
 *             `capabilities.isGitNative` holds. A project with no
 *             `.seeds/`, or a wired non-git-native tracker (e.g. GitHub
 *             Issues), gets no sd / `.seeds/` assertions.
 *   mulch   — a fresh on-disk probe for `.mulch/` at the host clone
 *             (no row column yet; `detectProjectFeatures` is the one
 *             probe site per the capabilities contract).
 */

import { detectProjectFeatures } from "../../projects/capabilities.ts";
import {
	type ProjectPromptCapabilities,
	withGatedPromptFragments,
} from "../../registry/prompt-gating.ts";
import type { AgentDefinition } from "../../registry/schema.ts";
import { type MulchArm, readMulchArm } from "../../runtime/adapters/mulch-arm.ts";
import type { IssueTracker } from "../../tracker/contract.ts";

export function resolvePromptCapabilities(input: {
	/** Persisted `.seeds/` flag off the projects row. */
	readonly hasSeeds: boolean;
	/** Host clone path probed for `.mulch/`. */
	readonly localPath: string;
	/** Boot-wired IssueTracker (warren-5819); absent in unwired tests. */
	readonly tracker?: IssueTracker;
	/** Injectable exists probe (tests). */
	readonly exists?: (path: string) => boolean;
}): ProjectPromptCapabilities {
	return {
		tracker: input.hasSeeds && (input.tracker?.capabilities.isGitNative ?? false),
		mulch: detectProjectFeatures(input.localPath, input.exists).hasMulch,
	};
}

/**
 * Gate the agent's tracker/mulch prompt fragments on the project's real
 * capabilities (warren-cb46). A foreign repo with no `.seeds/` /
 * `.mulch/` gets no false tooling assertions; the returned definition is
 * what gets frozen onto `rendered_agent_json`.
 */
export function gateAgentPrompts(
	agent: AgentDefinition,
	project: { readonly hasSeeds: boolean; readonly localPath: string },
	tracker?: IssueTracker,
): AgentDefinition {
	const caps = resolvePromptCapabilities({
		hasSeeds: project.hasSeeds,
		localPath: project.localPath,
		...(tracker !== undefined ? { tracker } : {}),
	});
	// Mulch arm "off" drops the mulch fragment even when `.mulch/` exists.
	const mulchOff = readMulchArm(agent.frontmatter) === "off";
	return withGatedPromptFragments(agent, mulchOff ? { ...caps, mulch: false } : caps);
}

/**
 * Fold the per-run mulch experiment arm onto `frontmatter.mulch` so it is
 * frozen on `rendered_agent_json` and reaches the adapter. `undefined`
 * leaves the agent's own frontmatter untouched.
 */
export function withMulchArm(agent: AgentDefinition, arm: MulchArm | undefined): AgentDefinition {
	if (arm === undefined) return agent;
	return { ...agent, frontmatter: { ...agent.frontmatter, mulch: arm } };
}
