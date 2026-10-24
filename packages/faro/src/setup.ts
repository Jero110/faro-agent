// Faro's setup: its pi config dir, its agent-link profile, and the MCP servers for the backend the user chose.
//
// Faro keeps its own pi config dir (~/.faro/agent) so plain pi and Faro never share settings. It reuses pi's
// login: auth.json, the model store and provider packages are copied from ~/.pi/agent the first time, so the
// same models work. Nothing in either folder is ever deleted.
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentLinkServer, install, mcpCommand, type ServerSpec, uninstall, which } from "agent-link";
import { agentLinkHome, type BackendName, hubPaths, PLACE_ENV, stableNode } from "agent-link-core";
import { FARO_CLI, type FaroPaths, PI_CLI, SKILL_GROUP_DIRS, SKILLS_DIR } from "./paths.ts";

/** The mark Faro puts in settings.json, so it never rewrites settings it did not write. */
export const SETTINGS_VERSION = 1;
/** The pi package that serves Claude models through the Claude Code login, when the user has it. */
export const BRIDGE_PACKAGE = "pi-claude-bridge";

/** The bridge version setup installs when pi does not have it, pinned like every other dependency. */
export const BRIDGE_SOURCE = `npm:${BRIDGE_PACKAGE}@0.9.3`;

const IMPORTED_FILES = ["auth.json", "models-store.json", "claude-bridge.json"] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function writeJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, "\t")}\n`);
}

/** pi's package entry for the Claude bridge, if pi has one. */
export function bridgeEntry(piSettings: unknown): unknown {
	if (!isObj(piSettings) || !Array.isArray(piSettings.packages)) return undefined;
	return piSettings.packages.find((p: unknown) => {
		const source = typeof p === "string" ? p : isObj(p) && typeof p.source === "string" ? p.source : "";
		return source === `npm:${BRIDGE_PACKAGE}` || source.startsWith(`npm:${BRIDGE_PACKAGE}@`);
	});
}

/**
 * The settings Faro writes once: its mark, the skills of this checkout and the bridge package when pi has it.
 * No default provider or model: pi starts on whichever provider the user is logged in to, and the bridge's Claude
 * models are one /model away.
 * Problem: the bridge was the default provider whenever it was installed. Example: a user who logged in with
 * ChatGPT still started on Sonnet through the Claude Code login. Solution: the bridge is available, never the default.
 * Problem: pi loads every file in <agentDir>/extensions. Solution: "!extensions/**" keeps that folder out;
 * Faro's own extensions come in with -e.
 */
export function faroSettings(piSettings: unknown): Obj {
	const bridge = bridgeEntry(piSettings);
	return {
		faro: { version: SETTINGS_VERSION },
		packages: bridge === undefined ? [] : [bridge],
		skills: [...SKILL_GROUP_DIRS],
		// The header stays; the long list of loaded skills and extensions at startup goes.
		quietStartup: "header",
		extensions: ["!extensions/**"],
	};
}

export interface AgentDirReport {
	wrote: boolean;
	copied: string[];
}

/** Creates ~/.faro/agent on first run; afterwards only keeps the skills path pointing at this checkout. */
export function ensureAgentDir(paths: FaroPaths): AgentDirReport {
	const file = join(paths.agentDir, "settings.json");
	const current = readJson(file);
	if (isObj(current) && isObj(current.faro) && current.faro.version === SETTINGS_VERSION) {
		const skills = Array.isArray(current.skills)
			? current.skills.filter((x): x is string => typeof x === "string")
			: [];
		if (!SKILL_GROUP_DIRS.every((d) => skills.includes(d))) {
			// The checkout moved (or was reinstalled elsewhere): point at this one's skills, keep the user's own.
			const own = skills.filter(
				(x) => !x.startsWith(dirname(SKILLS_DIR)) && !x.endsWith("/skills") && !/\/skills\/[\w-]+$/.test(x),
			);
			current.skills = [...SKILL_GROUP_DIRS, ...own];
			writeJson(file, current);
		}
		return { wrote: false, copied: [] };
	}
	mkdirSync(paths.agentDir, { recursive: true });
	const report: AgentDirReport = { wrote: true, copied: [] };
	if (existsSync(file) && !existsSync(`${file}.bak`)) copyFileSync(file, `${file}.bak`);
	for (const name of IMPORTED_FILES) {
		const from = join(paths.piAgentDir, name);
		const to = join(paths.agentDir, name);
		if (existsSync(from) && !existsSync(to)) {
			copyFileSync(from, to);
			report.copied.push(name);
		}
	}
	// pi installs packages under <agentDir>/npm; copying pi's saves installing the bridge again.
	const npmFrom = join(paths.piAgentDir, "npm");
	const npmTo = join(paths.agentDir, "npm");
	if (existsSync(npmFrom) && !existsSync(npmTo)) {
		cpSync(npmFrom, npmTo, { recursive: true });
		report.copied.push("npm");
	}
	writeJson(file, faroSettings(readJson(join(paths.piAgentDir, "settings.json"))));
	return report;
}

/** Runs a command with the user's terminal (pi install prints npm's progress); returns its exit status. */
export type Run = (argv: string[], env: NodeJS.ProcessEnv) => number;

const runInherit: Run = (argv, env) => spawnSync(argv[0] ?? "", argv.slice(1), { env, stdio: "inherit" }).status ?? 1;

/**
 * Installs the Claude bridge into Faro's agent dir when Claude Code is there and the bridge is not. It stays an
 * option in /model; it is never made the default provider.
 * Problem: Faro got the bridge only by copying pi's packages. Example: on a machine where pi never had it, a fresh
 * install had no Claude models, though the user was logged in to Claude Code. Solution: setup runs `pi install` for the pinned bridge with PI_CODING_AGENT_DIR set to Faro's agent dir.
 */
export function ensureBridge(
	paths: FaroPaths,
	env: NodeJS.ProcessEnv,
	out: (line: string) => void,
	run: Run = runInherit,
): "present" | "installed" | "skipped" | "failed" {
	const file = join(paths.agentDir, "settings.json");
	const installed = () =>
		bridgeEntry(readJson(file)) !== undefined &&
		existsSync(join(paths.agentDir, "npm", "node_modules", BRIDGE_PACKAGE));
	if (installed()) return "present";
	if (!which("claude", env)) {
		out(
			"faro: Claude Code (claude) is not on PATH, so the Claude bridge was skipped. Install Claude Code and run `faro setup` again to use your Claude login.",
		);
		return "skipped";
	}
	out(`faro: installing the Claude bridge (${BRIDGE_SOURCE}), so Faro uses your Claude Code login`);
	const status = run([process.execPath, PI_CLI, "install", BRIDGE_SOURCE], {
		...env,
		PI_CODING_AGENT_DIR: paths.agentDir,
	});
	if (status !== 0 || !installed()) {
		out(`faro: could not install the Claude bridge (pi install exited ${status}); run \`faro setup\` again later`);
		return "failed";
	}
	return "installed";
}

/**
 * The profile that lets agent-link open Faro as a worker or a root: pi's adapter, running this checkout's
 * CLI with the node that runs Faro now (absolute paths, so it works whatever PATH the hub daemon has).
 */
export function writeFaroProfile(env: NodeJS.ProcessEnv): string {
	const dir = join(hubPaths(agentLinkHome(env)).home, "profiles");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "faro.json");
	const profile = {
		harness: "faro",
		adapter: "pi",
		label: "Faro",
		defaultModel: null,
		dialogs: [],
		command: [stableNode(env), FARO_CLI],
		// Problem: a Faro worker opened by the hub got the default ~/.faro. Example: a sandbox planner with
		// FARO_HOME=/tmp/fe/faro handed off to an executor that read and wrote the user's real ~/.faro.
		// Solution: a non-default home goes in the profile, so every Faro the hub opens uses it.
		...(env.FARO_HOME ? { env: { FARO_HOME: env.FARO_HOME } } : {}),
	};
	const text = `${JSON.stringify(profile, null, "\t")}\n`;
	if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text);
	return file;
}

export interface FaroConfig {
	backend: BackendName;
}

export function readConfig(paths: FaroPaths): FaroConfig | undefined {
	const c = readJson(paths.config);
	return isObj(c) && (c.backend === "cmux" || c.backend === "tmux") ? { backend: c.backend } : undefined;
}

/** How harnesses start the cmux MCP server: this node and the package's CLI. */
export function cmuxMcpCommand(): { command: string; args: string[] } {
	return { command: stableNode(), args: [fileURLToPath(import.meta.resolve("cmux-mcp/cli"))] };
}

export function cmuxServer(paths: FaroPaths): ServerSpec {
	return {
		name: "cmux",
		description: "Find and read agent sessions, arrange cmux, use its browser",
		envVars: [...PLACE_ENV],
		manifest: join(paths.home, "install-cmux.json"),
	};
}

/** Faro reads MCP servers from <agentDir>/mcp.json; the cmux server is added there with direct exposure. */
export function setFaroMcp(paths: FaroPaths, name: string, entry: Obj | undefined): void {
	const file = join(paths.agentDir, "mcp.json");
	const config = readJson(file);
	const root: Obj = isObj(config) ? config : {};
	const servers: Obj = isObj(root.mcpServers) ? root.mcpServers : {};
	if (entry) servers[name] = entry;
	else delete servers[name];
	root.mcpServers = servers;
	mkdirSync(paths.agentDir, { recursive: true });
	writeJson(file, root);
}

export interface SetupOptions {
	paths: FaroPaths;
	backend: BackendName;
	home: string;
	env: NodeJS.ProcessEnv;
	out: (line: string) => void;
	/** Runs pi install for the Claude bridge (tests pass a fake). */
	run?: Run;
}

/**
 * Everything one-command install needs after the code is in place: the agent dir, the Faro profile for
 * agent-link, agent-link's MCP server with every harness found, and for cmux also the cmux MCP server.
 */
export function setup(opts: SetupOptions): void {
	const { paths, backend, home, env, out } = opts;
	const dir = ensureAgentDir(paths);
	out(
		dir.wrote
			? `faro: wrote ${join(paths.agentDir, "settings.json")}${dir.copied.length ? ` (copied from ${paths.piAgentDir}: ${dir.copied.join(", ")})` : ""}`
			: `faro: ${paths.agentDir} already set up`,
	);
	ensureBridge(paths, env, out, opts.run);
	out(`faro: agent-link profile ${writeFaroProfile(env)}`);
	install({ home, env, backend, command: mcpCommand(backend), out });
	if (backend === "cmux") {
		const command = cmuxMcpCommand();
		install({ home, env, backend, command, server: cmuxServer(paths), out });
		setFaroMcp(paths, "cmux", { ...command, exposure: "direct", description: cmuxServer(paths).description });
		out(`faro: added the cmux MCP server to ${join(paths.agentDir, "mcp.json")}`);
	} else {
		uninstall({ home, env, server: cmuxServer(paths), out: () => {} });
		setFaroMcp(paths, "cmux", undefined);
	}
	mkdirSync(paths.home, { recursive: true });
	writeJson(paths.config, { backend } satisfies FaroConfig);
	out(`faro: backend ${backend} saved in ${paths.config}`);
}

/** Reverts setup's registrations. Faro's own folder (sessions, reports) stays. */
export function teardown(opts: Omit<SetupOptions, "backend">): void {
	const { paths, home, env, out } = opts;
	uninstall({ home, env, server: cmuxServer(paths), out });
	uninstall({ home, env, server: agentLinkServer(home, env), out });
	setFaroMcp(paths, "cmux", undefined);
	rmSync(join(hubPaths(agentLinkHome(env)).home, "profiles", "faro.json"), { force: true });
	out(`faro: kept ${paths.home} (sessions, reports, settings); delete it by hand if you want them gone`);
}
