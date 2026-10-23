// Where agent-link keeps its files: one home folder per machine (or per test), private to the user.
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** The agent-link home: AGENT_LINK_HOME, else ~/.agent-link. */
export function agentLinkHome(env: NodeJS.ProcessEnv = process.env): string {
	const fromEnv = env.AGENT_LINK_HOME?.trim();
	return fromEnv ? resolve(fromEnv) : join(homedir(), ".agent-link");
}

export interface HubPaths {
	home: string;
	/** The hub's Unix socket (0600). */
	socket: string;
	/** The token every request carries in x-agent-link-token (0600). */
	token: string;
	/** The running daemon's pid, so a dev script or a test can stop it. */
	pid: string;
	/** What a detached daemon writes to stdout and stderr. */
	daemonLog: string;
	/** One private folder per agent: run/<name> (0700). */
	run: string;
	events: string;
	/** The session journal: one JSON file per agent, kept after the hub stops. */
	sessions: string;
}

export function hubPaths(home: string = agentLinkHome()): HubPaths {
	return {
		home,
		socket: join(home, "hub.sock"),
		token: join(home, "token"),
		pid: join(home, "hub.pid"),
		daemonLog: join(home, "hub.log"),
		run: join(home, "run"),
		events: join(home, "events.sqlite"),
		sessions: join(home, "sessions"),
	};
}
