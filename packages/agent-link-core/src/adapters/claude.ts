// Claude Code adapter: the native CLI runs in a pane; agent-link talks to it through its cross-session messaging
// socket, reads its status from ~/.claude/sessions/<pid>.json and its progress from the session transcript.
//
// Evidence (lab experiments/README.md, Experiment 7 V8 and V9, acp-panel README last section):
// - `--messaging-socket-path <path>` fixes the socket; its folder must be 0700 or Claude refuses it.
// - Frames are JSON lines: {"type":"auth","token"} then {"type":"user",...,"message":{"role":"user",...}}.
//   The token is `peerToken` in ~/.claude/sessions/<pid>.<hash>.key.
// - The session file's `status` goes idle -> busy -> idle, and busy -> waiting (`waitingFor`) on a permission.
// - The transcript (~/.claude/projects/<cwd slug>/<sessionId>.jsonl) shows the message as a `user` entry with
//   origin {kind: "peer", from: "agent-link"}, then the assistant's texts and tool calls.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	copyFileSync,
	existsSync,
	fstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	realpathSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { connect as connectSocket } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	AdapterDeps,
	AdapterFactory,
	AgentAdapter,
	LaunchSpec,
	PaneCommand,
	PaneHandle,
	PromptRequest,
	PromptResponse,
	SessionUpdate,
	StopReason,
} from "../types.ts";

/** The guard hook Claude runs before every Bash call (PreToolUse). */
export const CLAUDE_HOOK = fileURLToPath(new URL("./claude-hook.ts", import.meta.url));

/** macOS limits a Unix socket path to 104 bytes (sun_path); a longer one fails late and obscurely. */
const MAX_SOCKET_PATH = 103;

export interface ClaudeOptions {
	/** Claude's data folder (sessions/, projects/). Default ~/.claude; tests point it at a fake one. */
	claudeHome?: string;
	/** Claude's config with the folder-trust entries. Default ~/.claude.json. */
	claudeConfig?: string;
	/** Whether the agent-link MCP server is installed for the user. Default: asks `claude mcp get agent-link`. */
	mcpInstalled?: () => Promise<boolean>;
	/** The node binary the hook runs with. Default: this process's. */
	node?: string;
	pollMs?: number;
	connectTimeoutMs?: number;
	/** After cancel, how long an idle session may show no turn before prompt() resolves as cancelled anyway. */
	cancelGraceMs?: number;
}

/** The two frames that deliver one user message on Claude's messaging socket, one JSON object per line. */
export function claudeFrames(token: string, sessionId: string, text: string): string {
	const auth = { type: "auth", token };
	const user = { type: "user", from: "agent-link", session_id: sessionId, message: { role: "user", content: text } };
	return `${JSON.stringify(auth)}\n${JSON.stringify(user)}\n`;
}

/** Settings passed with --settings: the guard as a PreToolUse hook on Bash, with the agent's depth. */
export function claudeSettings(node: string, hook: string, depth: number): string {
	const command = `'${node}' '${hook}' ${depth}`;
	return JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command }] }] } });
}

/** Claude's folder for a project's transcripts: the cwd with every character but [a-zA-Z0-9] as "-". */
export function projectSlug(cwd: string): string {
	return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

async function claudeMcpInstalled(): Promise<boolean> {
	return new Promise((resolve) => {
		execFile("claude", ["mcp", "get", "agent-link"], { timeout: 20_000 }, (err, stdout) => {
			resolve(!err && /Scope:\s*User/i.test(String(stdout)));
		});
	});
}

/**
 * Pre-accepts Claude's folder-trust dialog for dir .
 * Trust is inherited from parent folders up to the git repo root, not above it: a trusted ~/Desktop
 * does not cover ~/Desktop/repo when repo has a .git. Paths are matched resolved (/tmp is /private/tmp).
 * Returns the folder that grants trust, or "added" when an entry was written.
 */
export function pretrustClaude(dir: string, configPath = join(homedir(), ".claude.json")): string {
	if (!existsSync(configPath)) return "no-config";
	const path = realpathSync(dir);
	if (!statSync(path).isDirectory()) throw new Error(`not a directory: ${dir}`);
	const data = JSON.parse(readFileSync(configPath, "utf8")) as {
		projects?: Record<string, { hasTrustDialogAccepted?: boolean }>;
	};
	data.projects ??= {};
	const projects = data.projects;
	for (let cur = path; ; cur = dirname(cur)) {
		if (projects[cur]?.hasTrustDialogAccepted) return cur;
		// Claude 2.1.x asks again for a git repo whose parent folder is trusted, so trust stops at the repo root.
		if (dirname(cur) === cur || existsSync(join(cur, ".git"))) break;
	}
	projects[path] = { ...projects[path], hasTrustDialogAccepted: true };
	copyFileSync(configPath, `${configPath}.bak`);
	const tmp = `${configPath}.agent-link-tmp`;
	writeFileSync(tmp, JSON.stringify(data, null, 2));
	renameSync(tmp, configPath);
	return "added";
}

/** The fields of ~/.claude/sessions/<pid>.json the adapter reads. */
interface SessionInfo {
	pid: number;
	sessionId: string;
	cwd: string;
	messagingSocketPath?: string;
	status?: string;
	waitingFor?: string;
}

interface ContentBlock {
	type: string;
	text?: string;
	name?: string;
	id?: string;
	tool_use_id?: string;
	is_error?: boolean;
}

/** One transcript line, the fields the adapter reads. */
interface TranscriptEntry {
	type?: string;
	subtype?: string;
	isMeta?: boolean;
	operation?: string;
	content?: string;
	origin?: { kind?: string; from?: string };
	message?: { role?: string; content?: string | ContentBlock[] };
}

/** A prompt() in flight. */
interface Pending {
	req: PromptRequest;
	sentAt: number;
	/** Index of the first transcript entry after the send. */
	from: number;
	/** Index of our `user` entry, once the transcript shows it. */
	entry: number;
	/** The status went busy after the send. */
	busy: boolean;
	/** The transcript wrote a turn_duration entry after our entry: the turn ended. */
	turnDone: boolean;
	cancelledAt: number;
	resolve: (r: PromptResponse) => void;
}

function isPeerEntry(e: TranscriptEntry): boolean {
	return e.type === "user" && e.origin?.kind === "peer" && e.origin.from === "agent-link";
}

/** A prompt the user typed in the pane: a plain user entry, not a tool result, not a peer message. */
function isTypedEntry(e: TranscriptEntry): boolean {
	if (e.type !== "user" || e.isMeta || e.origin?.kind === "peer") return false;
	const c = e.message?.content;
	return typeof c === "string" || (Array.isArray(c) && c.some((b) => b.type === "text"));
}

function assistantText(e: TranscriptEntry): string {
	const c = e.message?.content;
	if (e.type !== "assistant" || !Array.isArray(c)) return "";
	return c
		.filter((b) => b.type === "text" && b.text)
		.map((b) => b.text)
		.join("\n")
		.trim();
}

export function createClaudeAdapter(deps: AdapterDeps, opts: ClaudeOptions = {}): AgentAdapter {
	const claudeHome = opts.claudeHome ?? join(homedir(), ".claude");
	const sessionsDir = join(claudeHome, "sessions");
	const pollMs = opts.pollMs ?? 100;
	const listeners: Array<(u: SessionUpdate) => void> = [];
	const emit = (u: SessionUpdate) => {
		for (const l of listeners) l(u);
	};

	const sessionId = randomUUID();
	let pane: PaneHandle | undefined;
	let info: SessionInfo | undefined;
	let infoFile = "";
	let token = "";
	let transcript = "";
	let offset = 0;
	let partial = "";
	const entries: TranscriptEntry[] = [];
	const toolNames = new Map<string, string>();
	let status = "";
	let pending: Pending | undefined;
	/** A turn that prompt() did not start (typed in the pane): index of its first entry. */
	let paneTurn: number | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let gone = false;

	function findSession(): { file: string; info: SessionInfo } | undefined {
		if (!existsSync(sessionsDir)) return undefined;
		for (const f of readdirSync(sessionsDir)) {
			if (!f.endsWith(".json")) continue;
			try {
				const j = JSON.parse(readFileSync(join(sessionsDir, f), "utf8")) as SessionInfo;
				if (j.sessionId === sessionId) return { file: join(sessionsDir, f), info: j };
			} catch {
				// Claude rewrites the file in place; a half-written one is read again on the next poll.
			}
		}
		return undefined;
	}

	function readInfo(): SessionInfo | undefined | "gone" {
		if (!existsSync(infoFile)) return "gone";
		try {
			return JSON.parse(readFileSync(infoFile, "utf8")) as SessionInfo;
		} catch {
			return undefined;
		}
	}

	function pidAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (e) {
			// EPERM: the process exists but belongs to someone else.
			return (e as NodeJS.ErrnoException).code === "EPERM";
		}
	}

	/** Reads the transcript lines written since the last read and turns them into updates. */
	function readTranscript(): void {
		if (!transcript || !existsSync(transcript)) return;
		const fd = openSync(transcript, "r");
		try {
			const size = fstatSync(fd).size;
			if (size <= offset) return;
			const buf = Buffer.alloc(size - offset);
			readSync(fd, buf, 0, buf.length, offset);
			offset = size;
			partial += buf.toString("utf8");
		} finally {
			closeSync(fd);
		}
		const lines = partial.split("\n");
		partial = lines.pop() ?? "";
		for (const line of lines) {
			if (!line.trim()) continue;
			let e: TranscriptEntry;
			try {
				e = JSON.parse(line) as TranscriptEntry;
			} catch {
				continue;
			}
			entries.push(e);
			onEntry(e, entries.length - 1);
		}
	}

	function onEntry(e: TranscriptEntry, index: number): void {
		const p = pending;
		if (p && index >= p.from) {
			if (p.entry < 0 && e.type === "queue-operation" && e.operation === "enqueue" && e.content === p.req.text) {
				deps.log("delivered", { id: p.req.id, ms: Date.now() - p.sentAt, via: "queue" });
			}
			if (p.entry < 0 && isPeerEntry(e)) {
				const c = e.message?.content;
				if (typeof c !== "string" || c.includes(p.req.text)) {
					p.entry = index;
					deps.log("turn_start", { id: p.req.id, ms: Date.now() - p.sentAt });
				}
			}
			if (p.entry >= 0 && index > p.entry && e.type === "system" && e.subtype === "turn_duration") p.turnDone = true;
		}
		if (!p && paneTurn === undefined && isTypedEntry(e)) paneTurn = index;
		const text = assistantText(e);
		if (text) emit({ kind: "agent_message", text });
		const c = e.message?.content;
		if (!Array.isArray(c)) return;
		for (const b of c) {
			if (e.type === "assistant" && b.type === "tool_use" && b.name) {
				if (b.id) toolNames.set(b.id, b.name);
				emit({ kind: "tool_call", title: b.name, status: "in_progress" });
			} else if (e.type === "user" && b.type === "tool_result" && b.tool_use_id) {
				const title = toolNames.get(b.tool_use_id) ?? "tool";
				emit({ kind: "tool_call", title, status: b.is_error ? "failed" : "completed" });
			}
		}
	}

	function lastTextSince(from: number): string {
		for (let i = entries.length - 1; i >= Math.max(0, from); i--) {
			const entry = entries[i];
			const text = entry ? assistantText(entry) : "";
			if (text) return text;
		}
		return "";
	}

	function finish(stopReason: StopReason): void {
		const p = pending;
		if (!p) return;
		pending = undefined;
		const text = lastTextSince(p.entry >= 0 ? p.entry : p.from);
		deps.log("turn_end", { id: p.req.id, stopReason, ms: Date.now() - p.sentAt });
		p.resolve({ stopReason, text });
	}

	function exit(detail: string): void {
		if (gone) return;
		gone = true;
		stop();
		if (pending) {
			const p = pending;
			pending = undefined;
			p.resolve({ stopReason: "error", text: `claude exited: ${detail}` });
		}
		deps.log("exited", { detail });
		emit({ kind: "exited", detail });
	}

	function setStatus(next: string, waitingFor?: string): void {
		if (next === status) return;
		const prev = status;
		status = next;
		if (next === "busy") emit({ kind: "state", state: "busy" });
		else if (next === "idle") emit({ kind: "state", state: "idle" });
		else if (next === "waiting") emit({ kind: "state", state: "asking", detail: waitingFor ?? "waiting" });
		if (next === "busy" || next === "waiting") {
			if (pending) pending.busy = true;
			else if (paneTurn === undefined) paneTurn = entries.length;
		}
		if (next === "idle" && prev && !pending && paneTurn !== undefined) {
			const from = paneTurn;
			paneTurn = undefined;
			emit({ kind: "turn_end", stopReason: "end_turn", text: lastTextSince(from) });
		}
	}

	function poll(): void {
		if (gone) return;
		const next = readInfo();
		if (next === "gone") {
			exit("session file removed");
			return;
		}
		if (info && !pidAlive(info.pid)) {
			exit(`pid ${info.pid} is gone`);
			return;
		}
		readTranscript();
		if (next?.status) setStatus(next.status, next.waitingFor);
		const p = pending;
		if (!p || status !== "idle") return;
		// Race: right after the send the status may still read idle from before the turn. Only an idle that
		// follows busy, or a transcript that already shows the whole turn, ends it.
		if (p.busy || p.turnDone) finish(p.cancelledAt ? "cancelled" : "end_turn");
		else if (p.cancelledAt && Date.now() - p.cancelledAt > (opts.cancelGraceMs ?? 5000)) finish("cancelled");
	}

	function stop(): void {
		if (timer) clearInterval(timer);
		timer = undefined;
	}

	async function send(frames: string): Promise<void> {
		const path = info?.messagingSocketPath;
		if (!path) throw new Error("claude: no messaging socket in the session file");
		await new Promise<void>((resolve, reject) => {
			const sock = connectSocket(path);
			sock.on("error", reject);
			sock.on("connect", () => {
				// Problem: closing right after the write could drop the frames before Claude reads them.
				// Example: the lab probes kept the connection 200-300 ms and every message arrived.
				// Solution: write, then end once the data is flushed; Claude reads to the end of the stream.
				sock.end(frames);
			});
			sock.on("close", (hadError) => (hadError ? undefined : resolve()));
		});
	}

	return {
		async launch(spec: LaunchSpec): Promise<PaneCommand> {
			mkdirSync(spec.runDir, { recursive: true, mode: 0o700 });
			// Claude refuses a messaging socket in a folder others can read.
			chmodSync(spec.runDir, 0o700);
			const socket = join(spec.runDir, "claude.sock");
			if (Buffer.byteLength(socket) > MAX_SOCKET_PATH) {
				throw new Error(`claude: socket path too long for a Unix socket (${socket})`);
			}
			pretrustClaude(spec.cwd, opts.claudeConfig);
			const node = opts.node ?? process.execPath;
			const model = spec.model ?? spec.profile.defaultModel;
			const argv = [
				"claude",
				...(model ? ["--model", model] : []),
				"--messaging-socket-path",
				socket,
				"--session-id",
				sessionId,
				"-n",
				spec.name,
				"--settings",
				claudeSettings(node, CLAUDE_HOOK, deps.depth),
				// Folders outside cwd it may read without asking (READ_DIRS_ENV).
				...(spec.readDirs ?? []).flatMap((d) => ["--add-dir", d]),
			];
			const installed = await (opts.mcpInstalled ?? claudeMcpInstalled)();
			if (!installed) {
				const server = { command: spec.mcp.command, args: spec.mcp.args, env: spec.env };
				argv.push("--mcp-config", JSON.stringify({ mcpServers: { "agent-link": server } }));
			}
			deps.log("launch", { sessionId, mcp: installed ? "installed" : "flag" });
			return { argv, env: { ...spec.env }, cwd: spec.cwd };
		},

		async connect(handle?: PaneHandle): Promise<void> {
			pane = handle;
			const deadline = Date.now() + (opts.connectTimeoutMs ?? 60_000);
			for (;;) {
				const found = findSession();
				if (found?.info.status === "idle") {
					infoFile = found.file;
					info = found.info;
					break;
				}
				if (Date.now() > deadline) throw new Error(`claude: session ${sessionId} did not come up idle`);
				await new Promise((r) => setTimeout(r, pollMs));
			}
			const pid = info.pid;
			const keyFile = readdirSync(sessionsDir).find((f) => f.startsWith(`${pid}.`) && f.endsWith(".key"));
			if (!keyFile) throw new Error(`claude: no key file for pid ${pid}`);
			token = (JSON.parse(readFileSync(join(sessionsDir, keyFile), "utf8")) as { peerToken: string }).peerToken;
			transcript = join(claudeHome, "projects", projectSlug(info.cwd), `${sessionId}.jsonl`);
			status = "idle";
			emit({ kind: "session", sessionId, transcript });
			readTranscript();
			timer = setInterval(poll, pollMs);
			deps.log("connected", { pid, sessionId });
		},

		async prompt(req: PromptRequest): Promise<PromptResponse> {
			if (gone) return { stopReason: "error", text: "claude exited" };
			if (pending) throw new Error("claude: a prompt is already in flight");
			readTranscript();
			const result = new Promise<PromptResponse>((resolve) => {
				pending = {
					req,
					sentAt: Date.now(),
					from: entries.length,
					entry: -1,
					busy: false,
					turnDone: false,
					cancelledAt: 0,
					resolve,
				};
			});
			// A pane turn that had not ended is folded into this one.
			paneTurn = undefined;
			try {
				await send(claudeFrames(token, sessionId, req.text));
			} catch (e) {
				pending = undefined;
				throw e;
			}
			deps.log("sent", { id: req.id });
			return result;
		},

		idle: () => !gone && !pending && status === "idle",

		async cancel(): Promise<void> {
			// The messaging socket has no cancel: Escape in the pane interrupts the turn, as for the user.
			if (pending) pending.cancelledAt = Date.now();
			if (pane) await pane.backend.keys(pane.ref, ["escape"]);
			else deps.log("cancel_without_pane");
		},

		async close(): Promise<void> {
			stop();
			gone = true;
			if (pending) {
				const p = pending;
				pending = undefined;
				p.resolve({ stopReason: "cancelled", text: "" });
			}
		},

		onUpdate(listener) {
			listeners.push(listener);
		},
	};
}

export const claudeAdapter: AdapterFactory = (deps) => createClaudeAdapter(deps);
