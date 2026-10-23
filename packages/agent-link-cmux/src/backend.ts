// cmux pane backend: each agent runs in a cmux split next to the agent that spawned it.
//
// The hub is a daemon outside any pane, so every call names its surface (and workspace when known) explicitly;
// cmux accepts that from a process outside cmux because surface refs are global (Experiment 7, C0).
//
// Problem: cmux fills a missing --surface from $CMUX_SURFACE_ID. Example: the hub was started on demand by an MCP
// server inside a pane, inherited that pane's CMUX_SURFACE_ID, and a close-surface without --surface would have
// closed the user's own pane. Solution: those variables are removed from the env of every cmux call, and every
// call passes its target.
//
// Problem: a split in a crowded workspace can be too small for a harness TUI. Example: in a workspace with four
// agent panes the right split was 26x16, and opencode 1.19.3 segfaults (Bun panic) below about 40x13.
// Solution: every pane first runs a gate that writes its own size (`stty size`) and waits for its launch script.
// cmux reports no pane size (`tree --json` has tty null for surfaces started with --command), so the pane's
// own terminal is the source. A pane under 80x24 is closed before the harness ever starts (a second start would
// reuse a Claude --session-id or an opencode port) and the agent opens where there is room: the caller
// workspace's "agent-link" workspace, created once without focus and reused, agents stacked down as in splits;
// a split there that is still too small becomes a tab in the pane it came from.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_LAUNCH_DIR,
	type PaneBackend,
	type PaneCommand,
	type PlaceHint,
	shellQuote,
	writeLaunchScript,
} from "agent-link-core";

export interface CmuxBackendOptions {
	/** The cmux executable, looked up on env.PATH. */
	bin?: string;
	env?: NodeJS.ProcessEnv;
	/** Where launch scripts go (tests). */
	launchDir?: string;
	timeoutMs?: number;
	/** Smallest pane an agent may run in. Default 80x24. */
	minSize?: { cols: number; rows: number };
	/** How long to wait for a new pane to report its size before keeping it as it is. */
	sizeTimeoutMs?: number;
}

/** The workspace agents move to when a split is too small. */
export const OVERFLOW_WORKSPACE = "agent-link";

interface Gate {
	/** Where the launch script goes once the pane is accepted; the pane runs it then. */
	path: string;
	/** The pane's command: report the size, wait for the script, exec it. */
	command: string;
}

/**
 * A pane command that writes the pane's size to <path>.size and waits (up to 60 s) for <path> to exist, then
 * execs it. `exec` replaces the pane's shell, so the surface closes when the harness exits and alive() says so.
 */
export function gateCommand(path: string): string {
	const p = shellQuote(path);
	const script = [
		`stty size > ${p}.tmp 2>/dev/null && mv ${p}.tmp ${p}.size`,
		"i=0",
		`while [ ! -e ${p} ]; do i=$((i+1)); [ "$i" -gt 1200 ] && exit 1; sleep 0.05; done`,
		`exec /bin/sh ${p}`,
	].join("; ");
	return `exec /bin/sh -c ${shellQuote(script)}`;
}

const DEFAULT_ENV_VARS = ["CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "CMUX_TAB_ID", "CMUX_PANEL_ID"];

export function createCmuxBackend(opts: CmuxBackendOptions = {}): PaneBackend {
	const bin = opts.bin ?? "cmux";
	const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), CMUX_QUIET: "1" };
	for (const k of DEFAULT_ENV_VARS) delete env[k];
	const timeout = opts.timeoutMs ?? 10_000;
	const launchDir = opts.launchDir ?? DEFAULT_LAUNCH_DIR;
	const min = opts.minSize ?? { cols: 80, rows: 24 };

	const cmux = (...args: string[]) =>
		new Promise<string>((resolve, reject) => {
			execFile(bin, args, { env, timeout }, (err, stdout, stderr) => {
				if (err) reject(new Error(`cmux ${args[0]} failed: ${(stderr || stdout || err.message).trim()}`));
				else resolve(stdout);
			});
		});

	/** Workspace of each pane this backend opened, so later calls can name it. */
	const workspaceOf = new Map<string, string>();
	/** Panes opened per caller surface, oldest first: the next worker opens below the last one still open. */
	const stacks = new Map<string, string[]>();
	/** The overflow workspace of each workspace agents were first tried in. */
	const overflowOf = new Map<string, string>();
	/** Agent surfaces in each overflow workspace, oldest first. */
	const overflow = new Map<string, string[]>();

	const newGate = (): Gate => {
		const path = join(launchDir, `${randomBytes(8).toString("hex")}.go`);
		return { path, command: gateCommand(path) };
	};
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

	/** The size the gate reported, or undefined when it reported none in time (the pane is then kept). */
	async function gateSize(gate: Gate): Promise<{ cols: number; rows: number } | undefined> {
		const file = `${gate.path}.size`;
		for (const end = Date.now() + (opts.sizeTimeoutMs ?? 5000); Date.now() < end; await sleep(50)) {
			if (!existsSync(file)) continue;
			const [rows, cols] = readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
			rmSync(file, { force: true });
			if (rows && cols) return { cols, rows };
			return undefined;
		}
		return undefined;
	}

	/** Lets the gate start the harness: the launch script appears at the path the gate waits for. */
	const release = (gate: Gate, cmd: PaneCommand) => renameSync(writeLaunchScript(cmd, launchDir), gate.path);

	async function paneOf(workspace: string | undefined, surface: string): Promise<string | undefined> {
		const ws = workspace ? ["--workspace", workspace] : [];
		const id = JSON.parse(await cmux("identify", ...ws, "--surface", surface)) as { caller?: { pane_ref?: string } };
		return id.caller?.pane_ref;
	}

	async function tab(workspace: string | undefined, from: string, command: string) {
		const pane = await paneOf(workspace, from);
		if (!pane) throw new Error(`cmux backend: no pane for ${from}`);
		const ws = workspace ? ["--workspace", workspace] : [];
		const args = ["new-surface", "--type", "terminal", "--pane", pane, ...ws, "--focus", "false", "--command", command];
		return parseSurface(await cmux(...args), "new-surface");
	}

	/** Opens the agent where there is room, after a pane in `tried` (split from `from`) was too small. */
	async function roomy(tried: string | undefined, from: string, gate: Gate) {
		// Already in an overflow workspace: a tab in the pane it came from has that whole pane.
		if (tried && overflow.has(tried)) return { ...(await tab(tried, from, gate.command)), workspace: tried };
		const key = tried ?? "";
		const existing = overflowOf.get(key);
		const last = existing ? overflow.get(existing)?.at(-1) : undefined;
		if (existing && last) {
			const made = await split("down", existing, last, gate.command);
			return { ...made, workspace: existing, from: last };
		}
		const out = await cmux(
			"new-workspace",
			"--name",
			OVERFLOW_WORKSPACE,
			"--focus",
			"false",
			"--command",
			gate.command,
		);
		const workspace = out.match(/workspace:\d+/)?.[0];
		if (!workspace) throw new Error(`cmux new-workspace returned no workspace: ${out.trim()}`);
		const tree = JSON.parse(await cmux("tree", "--json", "--workspace", workspace)) as {
			windows?: Array<{ workspaces?: Array<{ ref?: string; panes?: Array<{ surface_refs?: string[] }> }> }>;
		};
		const ref = tree.windows?.flatMap((w) => w.workspaces ?? []).find((w) => w.ref === workspace)?.panes?.[0]
			?.surface_refs?.[0];
		if (!ref) throw new Error(`cmux backend: no surface in the new workspace ${workspace}`);
		overflowOf.set(key, workspace);
		overflow.set(workspace, []);
		return { ref, workspace };
	}

	const where = (ref: string) => {
		const ws = workspaceOf.get(ref);
		return ws ? ["--workspace", ws, "--surface", ref] : ["--surface", ref];
	};

	const parseSurface = (out: string, what: string) => {
		const ref = out.match(/surface:\d+/)?.[0];
		if (!ref) throw new Error(`cmux ${what} returned no surface: ${out.trim()}`);
		return { ref, workspace: out.match(/workspace:\d+/)?.[0] };
	};

	async function split(direction: "right" | "down", workspace: string | undefined, from: string, command: string) {
		const ws = workspace ? ["--workspace", workspace] : [];
		const args = ["new-split", direction, ...ws, "--surface", from, "--focus", "false", "--command", command];
		try {
			return parseSurface(await cmux(...args), "new-split");
		} catch (err) {
			// Problem: a workspace with many panes refuses another split. Example: with seven panes open,
			// `cmux new-split right` answered "no_space: No space for new pane". Solution: open the agent as a
			// new tab in the pane that holds `from`, still without focus.
			if (!String(err).includes("no_space")) throw err;
			return tab(workspace, from, command);
		}
	}

	const small = (size: { cols: number; rows: number } | undefined) =>
		size !== undefined && (size.cols < min.cols || size.rows < min.rows);

	return {
		name: "cmux",
		async open(cmd: PaneCommand, o: { title: string; place?: PlaceHint }) {
			const caller = o.place?.surface;
			if (!caller) throw new Error("cmux backend: place.surface (the caller's surface) is required");
			const stack = stacks.get(caller) ?? [];
			const below = stack.at(-1);
			let gate = newGate();
			const from = below ?? caller;
			const triedWs = (below ? workspaceOf.get(below) : undefined) ?? o.place?.workspace;
			let made: { ref: string; workspace?: string } = await split(
				below ? "down" : "right",
				triedWs,
				from,
				gate.command,
			);
			let workspace = made.workspace ?? triedWs;
			// Up to two moves: to the overflow workspace, then to a tab in the pane the last split came from.
			let source = from;
			for (let moves = 0; moves < 2 && small(await gateSize(gate)); moves++) {
				await cmux("close-surface", ...(workspace ? ["--workspace", workspace] : []), "--surface", made.ref, "--force");
				gate = newGate();
				const next: { ref: string; workspace: string; from?: string } = await roomy(workspace, source, gate);
				made = next;
				workspace = next.workspace;
				source = next.from ?? source;
			}
			release(gate, cmd);
			if (workspace) workspaceOf.set(made.ref, workspace);
			if (workspace && overflow.has(workspace)) overflow.get(workspace)?.push(made.ref);
			stacks.set(caller, [...stack, made.ref]);
			await cmux("rename-tab", ...where(made.ref), "--", o.title);
			return made.ref;
		},
		async close(ref) {
			const ws = workspaceOf.get(ref);
			const alone = ws !== undefined && overflow.get(ws)?.length === 1 && overflow.get(ws)?.[0] === ref;
			try {
				// Problem: cmux refuses to close the last surface of a workspace. Example: closing the only agent
				// left in the agent-link workspace answered "invalid_state: Cannot close the last surface" and the
				// harness kept running. Solution: the last agent there closes with its workspace, which the
				// backend created for it (the caller's own workspace is never closed).
				if (alone) await cmux("close-workspace", "--workspace", ws, "--force");
				else await cmux("close-surface", ...where(ref), "--force");
			} catch (err) {
				// The harness may have exited first, which closes the surface itself.
				if (await this.alive(ref)) throw err;
			}
			workspaceOf.delete(ref);
			for (const [ws, refs] of overflow) {
				const rest = refs.filter((r) => r !== ref);
				overflow.set(ws, rest);
				// The workspace went with its last agent: the next overflow creates a new one.
				if (!rest.length) {
					overflow.delete(ws);
					for (const [k, v] of overflowOf) if (v === ws) overflowOf.delete(k);
				}
			}
			for (const [caller, stack] of stacks) {
				const rest = stack.filter((r) => r !== ref);
				if (rest.length) stacks.set(caller, rest);
				else stacks.delete(caller);
			}
		},
		read: (ref, lines = 40) => cmux("read-screen", ...where(ref), "--lines", String(lines)),
		async keys(ref, keys) {
			// cmux refuses keys to a pane it sees waiting on a question or dialog ("nothing was sent ... pass
			// --force"), and answering dialogs is what keys are for.
			for (const key of keys) await cmux("send-key", "--force", ...where(ref), "--", key);
		},
		async paste(ref, text) {
			// --paste must come before the text; --force because a pane with a draft or a dialog refuses it.
			await cmux("send", "--force", ...where(ref), "--paste", "--", text);
		},
		alive: (ref) =>
			cmux("read-screen", ...where(ref), "--lines", "1").then(
				() => true,
				() => false,
			),
	};
}
