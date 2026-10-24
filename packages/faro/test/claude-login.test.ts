import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loginClaudeCode } from "../src/extensions/claude-login.ts";
import { faroPaths } from "../src/paths.ts";
import { BRIDGE_SOURCE, ensureAgentDir } from "../src/setup.ts";

function setupHome(t: { after: (fn: () => void) => void }, withClaude: boolean) {
	const home = mkdtempSync(join(tmpdir(), "faro-login-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const bin = join(home, "bin");
	mkdirSync(bin);
	if (withClaude) writeFileSync(join(bin, "claude"), "#!/bin/sh\n", { mode: 0o755 });
	const env = { HOME: home, PATH: bin, AGENT_LINK_HOME: join(home, ".al") };
	ensureAgentDir(faroPaths(env, home));
	return { home, env };
}

test("Claude sub in /login: without claude on PATH it says so and installs nothing", async (t) => {
	const { env } = setupHome(t, false);
	const runs: string[][] = [];
	await assert.rejects(
		loginClaudeCode(
			{},
			{
				env,
				run: (argv) => {
					runs.push(argv);
					return 0;
				},
			},
		),
		/Claude Code .* is not on PATH/,
	);
	assert.equal(runs.length, 0);
});

test("Claude sub in /login installs the bridge, never makes it the default, and returns a credential", async (t) => {
	const { home, env } = setupHome(t, true);
	const paths = faroPaths(env, home);
	const settingsFile = join(paths.agentDir, "settings.json");
	const progress: string[] = [];
	const credential = await loginClaudeCode(
		{ onProgress: (m) => progress.push(m) },
		{
			env,
			// What the real pi install leaves behind: the package folder and the settings entry.
			run: (argv) => {
				assert.deepEqual(argv.slice(2), ["install", BRIDGE_SOURCE]);
				mkdirSync(join(paths.agentDir, "npm", "node_modules", "pi-claude-bridge"), { recursive: true });
				const s = JSON.parse(readFileSync(settingsFile, "utf8"));
				writeFileSync(settingsFile, JSON.stringify({ ...s, packages: [...s.packages, BRIDGE_SOURCE] }));
				return 0;
			},
		},
	);
	assert.equal(credential.access, "claude-code");
	assert.ok(credential.expires > Date.now());
	const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
	assert.deepEqual(settings.packages, [BRIDGE_SOURCE]);
	assert.equal(settings.defaultProvider, undefined, "available, not the default");
	assert.match(progress.join("\n"), /\/reload/);
});

test("Claude sub in /login reports a failed install", async (t) => {
	const { env } = setupHome(t, true);
	await assert.rejects(loginClaudeCode({}, { env, run: () => 1 }), /could not install the Claude bridge/i);
});
