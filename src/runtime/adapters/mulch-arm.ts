/**
 * Per-run mulch experiment arm (frontmatter `mulch: "on" | "off"`).
 *
 * The arm rides the frozen agent frontmatter, the same bag that carries the
 * provider/model overrides, so it reaches every backend's adapter
 * (LocalProvider via `spec.metadata.frontmatter`, K8s/Docker via
 * `WARREN_AGENT_METADATA`) and stays readable on the run row
 * (`renderedAgentJson.frontmatter.mulch`).
 *
 *   absent  default behavior, unchanged.
 *   "on"    the claude-code adapter installs mulch's Claude Code hooks into
 *           `.claude/settings.local.json`: SessionStart `ml prime` and
 *           PreToolUse `ml hook`, the same handlers `ml setup claude` writes.
 *           The mulch prompt fragment stays gated on the project's `.mulch/`.
 *   "off"   warren injects no mulch: no hooks, and dispatch drops the mulch
 *           prompt fragment. Hooks or instructions the target repo checks in
 *           (`.claude/settings.json`, AGENTS.md) still apply. The finalize
 *           `mulch.usage` event exposes that contamination.
 *
 * Only the claude-code adapter has a hook surface. Other harnesses honor
 * just the prompt-fragment half of "off".
 */

export const MULCH_ARM_VALUES = ["on", "off"] as const;
export type MulchArm = (typeof MULCH_ARM_VALUES)[number];

/** Read the arm off a frontmatter bag; anything unrecognized is `undefined`. */
export function readMulchArm(
	frontmatter: { readonly mulch?: unknown } | undefined,
): MulchArm | undefined {
	const value = frontmatter?.mulch;
	return value === "on" || value === "off" ? value : undefined;
}

/** PreToolUse matcher mulch's `ml setup claude` installs for `ml hook`. */
const MULCH_HOOK_MATCHER = "Read|Edit|Write|MultiEdit|NotebookEdit|Bash";

/**
 * The Claude Code `hooks` block for the "on" arm. It mirrors mulch's
 * `CLAUDE_HOOKS` spec (`mulch/src/utils/claude-hooks.ts`) so a warren-armed
 * run and an `ml setup claude` checkout behave the same.
 */
export function mulchClaudeHooks(): Record<string, unknown> {
	return {
		SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "ml prime" }] }],
		PreToolUse: [{ matcher: MULCH_HOOK_MATCHER, hooks: [{ type: "command", command: "ml hook" }] }],
	};
}
