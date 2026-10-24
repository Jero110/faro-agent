// "Claude sub" in /login: the Claude bridge, for Claude subscriptions, as one more way to connect next to pi's own Anthropic login.
//
// Problem: the bridge was either installed for everyone (and became what /model and /login led to) or not
// reachable at all. Solution: it stays out until the user picks "Claude sub" in /login; that installs
// the bridge into Faro's agent dir, and /reload then loads its Claude models. Pi's native Anthropic login is untouched.
import { spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { faroPaths } from "../paths.ts";
import { ensureBridge, type Run } from "../setup.ts";

export const PROVIDER_ID = "claude-code-login";
/** The bridge has no token of its own; this marks the login as done. */
const MARKER = "claude-code";
const A_YEAR = 365 * 24 * 60 * 60 * 1000;

/** pi install prints npm's progress; inside the TUI that would tear the screen, so its output is collected instead. */
const runQuiet: Run = (argv, env) => spawnSync(argv[0] ?? "", argv.slice(1), { env, stdio: "pipe" }).status ?? 1;

export interface LoginCallbacks {
	onProgress?(message: string): void;
}

export interface LoginDeps {
	env?: NodeJS.ProcessEnv;
	run?: Run;
}

/** Installs the bridge when it is missing; throws a readable reason when it cannot. */
export async function loginClaudeCode(callbacks: LoginCallbacks, deps: LoginDeps = {}) {
	const env = deps.env ?? process.env;
	const lines: string[] = [];
	callbacks.onProgress?.("Checking Claude Code and the Claude bridge");
	const result = ensureBridge(faroPaths(env), env, (l) => lines.push(l), deps.run ?? runQuiet);
	if (result === "skipped") {
		throw new Error("Claude Code (`claude`) is not on PATH. Install it, log in with `claude`, and try again.");
	}
	if (result === "failed") throw new Error(lines.join(" ") || "Could not install the Claude bridge.");
	callbacks.onProgress?.("Claude bridge ready: run /reload, then pick a [claude-bridge] model in /model");
	return { refresh: "", access: MARKER, expires: Date.now() + A_YEAR };
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider(PROVIDER_ID, {
		baseUrl: "claude-code-login",
		apiKey: "not-used",
		api: "anthropic-messages",
		models: [],
		oauth: {
			name: "Claude sub",
			login: (callbacks) => loginClaudeCode(callbacks),
			refreshToken: async (credentials) => ({ ...credentials, expires: Date.now() + A_YEAR }),
			getApiKey: (credentials) => credentials.access,
		},
	});
}
