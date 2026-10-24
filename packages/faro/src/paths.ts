// Where Faro keeps its files, and where this checkout's pieces are.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The repository root of this checkout: packages/faro/src -> three levels up. */
export const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
/** The skills Faro ships, in four groups (see skills/README.md). */
export const SKILLS_DIR = join(REPO_ROOT, "skills");
/**
 * The folders pi loads skills from: one per group. Not skills/ itself, whose references/ and LICENSES/ hold
 * Markdown that is not a skill.
 */
export const SKILL_GROUP_DIRS = ["pre-build", "build", "post-build", "extras"].map((g) => join(SKILLS_DIR, g));
/** This package's CLI, which agent-link runs to open a Faro worker. */
export const FARO_CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
/** Faro's pi extensions, loaded with -e on every run. */
export const EXTENSIONS = ["brand.ts", "ask.ts", "workflow.ts", "claude-login.ts"].map((f) =>
	fileURLToPath(new URL(`./extensions/${f}`, import.meta.url)),
);

/** pi's own CLI, from the pinned dependency (never a global pi). */
/** The pi package Faro runs: its README, docs/ and examples/ (extensions, SDK) describe what pi can do. */
export const PI_PACKAGE = dirname(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))));
export const PI_CLI = join(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "cli.js");

export const FARO_VERSION: string = (
	JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
).version;

export interface FaroPaths {
	/** ~/.faro, or FARO_HOME. */
	home: string;
	/** <home>/agent: pi's config dir for Faro (PI_CODING_AGENT_DIR), separate from plain pi's ~/.pi/agent. */
	agentDir: string;
	/** <home>/reports: /workflow review reports. */
	reports: string;
	/** <home>/config.json: what setup chose (backend). */
	config: string;
	/** ~/.pi/agent: plain pi's config, the source of the login and providers Faro reuses. */
	piAgentDir: string;
}

export function faroPaths(env: NodeJS.ProcessEnv = process.env, home = env.HOME || homedir()): FaroPaths {
	const faroHome = env.FARO_HOME || join(home, ".faro");
	return {
		home: faroHome,
		agentDir: join(faroHome, "agent"),
		reports: join(faroHome, "reports"),
		config: join(faroHome, "config.json"),
		piAgentDir: join(home, ".pi", "agent"),
	};
}
