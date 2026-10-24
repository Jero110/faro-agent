// "Claude sub" in /login: the Claude bridge, for Claude subscriptions, as one more way to connect next to pi's own Anthropic login.
//
// Problem: the bridge was either installed for everyone (and became what /model and /login led to) or not
// reachable at all. Solution: it stays out until the user picks "Claude sub" in /login; that installs
// the bridge into Faro's agent dir, and /reload then loads its Claude models. Pi's native Anthropic login is untouched.
//
// Problem: picking it only checked the files, so the user never got to sign in. Solution: the sign-in is Claude
// Code's own: when `claude` is not logged in (or the user asks to sign in again) it opens the browser with
// `claude auth login --claudeai` and waits for it.
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { faroPaths } from "../paths.ts";
import { ensureBridge, type Run } from "../setup.ts";

export const PROVIDER_ID = "claude-code-login";
/** The bridge has no token of its own; this marks the login as done. */
const MARKER = "claude-code";
const A_YEAR = 365 * 24 * 60 * 60 * 1000;

/** pi install prints npm's progress; inside the TUI that would tear the screen, so its output is collected instead. */
const runQuiet: Run = (argv, env) => spawnSync(argv[0] ?? "", argv.slice(1), { env, stdio: "pipe" }).status ?? 1;

/** Who Claude Code is logged in as, when it is. */
export interface ClaudeAccount {
	email?: string;
	plan?: string;
}

/** What the login needs from Claude Code: who is signed in, and a browser sign-in. */
export interface ClaudeAuth {
	status(env: NodeJS.ProcessEnv): ClaudeAccount | undefined;
	/** Opens the browser and resolves when the sign-in ends; false when it did not succeed. */
	signIn(env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<boolean>;
}

export const claudeAuth: ClaudeAuth = {
	status(env) {
		const r = spawnSync("claude", ["auth", "status", "--json"], { env, stdio: "pipe", encoding: "utf8" });
		if (r.status !== 0) return undefined;
		try {
			const s = JSON.parse(r.stdout) as { loggedIn?: boolean; email?: string; subscriptionType?: string };
			return s.loggedIn ? { email: s.email, plan: s.subscriptionType } : undefined;
		} catch {
			return undefined;
		}
	},
	signIn(env, signal) {
		return new Promise((resolve) => {
			// `claude auth login` opens the browser itself; its output is dropped so it cannot tear the TUI.
			const child = spawn("claude", ["auth", "login", "--claudeai"], { env, stdio: "ignore", signal });
			child.on("error", () => resolve(false));
			child.on("close", (code) => resolve(code === 0));
		});
	},
};

export interface LoginCallbacks {
	onProgress?(message: string): void;
	onSelect?(prompt: { message: string; options: { id: string; label: string }[] }): Promise<string | undefined>;
	signal?: AbortSignal;
}

export interface LoginDeps {
	env?: NodeJS.ProcessEnv;
	run?: Run;
	auth?: ClaudeAuth;
}

const describe = (a: ClaudeAccount) => [a.email, a.plan && `Claude ${a.plan}`].filter(Boolean).join(" · ");

/** Installs the bridge when it is missing and signs in to Claude Code; throws a readable reason when it cannot. */
export async function loginClaudeCode(callbacks: LoginCallbacks, deps: LoginDeps = {}) {
	const env = deps.env ?? process.env;
	const auth = deps.auth ?? claudeAuth;
	const lines: string[] = [];
	callbacks.onProgress?.("Checking Claude Code and the Claude bridge");
	const result = ensureBridge(faroPaths(env), env, (l) => lines.push(l), deps.run ?? runQuiet);
	if (result === "skipped") {
		throw new Error("Claude Code (`claude`) is not on PATH. Install it, then pick Claude sub again.");
	}
	if (result === "failed") throw new Error(lines.join(" ") || "Could not install the Claude bridge.");

	let account = auth.status(env);
	let signIn = account === undefined;
	if (account && callbacks.onSelect) {
		const choice = await callbacks.onSelect({
			message: `Claude Code is signed in as ${describe(account)}`,
			options: [
				{ id: "keep", label: "Use this account" },
				{ id: "again", label: "Sign in again in the browser" },
			],
		});
		if (choice === undefined) throw new Error("Login cancelled.");
		signIn = choice === "again";
	}
	if (signIn) {
		callbacks.onProgress?.("Opening the browser to sign in to Claude. Finish there, then come back.");
		if (!(await auth.signIn(env, callbacks.signal))) throw new Error("The Claude sign-in did not finish. Try again.");
		account = auth.status(env);
		if (!account) throw new Error("Claude Code is still not signed in. Try again.");
	}
	callbacks.onProgress?.("Claude sub ready: run /reload, then pick a [claude-bridge] model in /model");
	return { refresh: "", access: MARKER, expires: Date.now() + A_YEAR, email: account?.email };
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
