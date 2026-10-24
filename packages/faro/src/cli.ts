#!/usr/bin/env node
// faro: the Faro agent. `faro setup --backend cmux|tmux` is what install.sh runs once the code is in place.
import { homedir } from "node:os";
import { runFaro } from "./launcher.ts";
import { FARO_VERSION, faroPaths } from "./paths.ts";
import { setup, teardown } from "./setup.ts";

export const USAGE = `usage: faro [pi options] [message]       start Faro (all pi options work)
       faro setup --backend cmux|tmux [--claude-bridge]
                                        register Faro's MCP servers and profile (install.sh runs this);
                                        --claude-bridge also adds the Claude models on your Claude Code login
       faro uninstall                   undo setup's registrations (keeps ~/.faro)
       faro --version`;

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
	const out = (l: string) => process.stdout.write(`${l}\n`);
	const err = (l: string) => process.stderr.write(`${l}\n`);
	const home = env.HOME || homedir();
	const [cmd, ...rest] = argv;
	if (cmd === "--version" || cmd === "-v") {
		out(`faro ${FARO_VERSION}`);
		return 0;
	}
	if (cmd === "help" || cmd === "--help" || cmd === "-h") {
		out(USAGE);
		return 0;
	}
	if (cmd === "setup") {
		const i = rest.indexOf("--backend");
		const backend = i >= 0 ? rest[i + 1] : undefined;
		if (backend !== "cmux" && backend !== "tmux") {
			err("faro setup: --backend must be cmux or tmux");
			return 2;
		}
		setup({ paths: faroPaths(env, home), backend, home, env, out, claudeBridge: rest.includes("--claude-bridge") });
		return 0;
	}
	if (cmd === "uninstall") {
		teardown({ paths: faroPaths(env, home), home, env, out });
		return 0;
	}
	return runFaro({ argv, env, home, err });
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
