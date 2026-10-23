import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
	appendFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CLAUDE_HOOK, claudeFrames, createClaudeAdapter, pretrustClaude, projectSlug } from "../src/adapters/claude.ts";
import type { AgentAdapter, LaunchSpec, PaneBackend, SessionUpdate } from "../src/types.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(cond: () => boolean, what: string, ms = 3000): Promise<void> {
	for (const end = Date.now() + ms; !cond(); ) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(10);
	}
}

/** A fake Claude: its home (sessions, key, transcript), its messaging socket and the adapter driving it. */
async function fakeClaude(opts: { pid?: number; mcpInstalled?: boolean } = {}) {
	// Short root: the socket path must fit a Unix socket (104 bytes on macOS).
	const root = realpathSync(mkdtempSync(join(tmpdir(), "xlc-")));
	const home = join(root, "h");
	const cwd = join(root, "w");
	const runDir = join(root, "r");
	mkdirSync(join(home, "sessions"), { recursive: true });
	mkdirSync(cwd);
	const claudeConfig = join(root, "claude.json");
	writeFileSync(claudeConfig, JSON.stringify({ projects: {} }));
	const updates: SessionUpdate[] = [];
	const logs: Array<{ kind: string; data?: Record<string, unknown> }> = [];
	const adapter: AgentAdapter = createClaudeAdapter(
		{ log: (kind, data) => logs.push({ kind, data }), guard: () => ({ action: "allow" }), depth: 1 },
		{ claudeHome: home, claudeConfig, mcpInstalled: async () => opts.mcpInstalled ?? false, pollMs: 10 },
	);
	adapter.onUpdate((u) => updates.push(u));
	const spec: LaunchSpec = {
		name: "w1",
		parent: "root",
		model: null,
		cwd,
		runDir,
		env: { AGENT_LINK_AGENT: "w1", AGENT_LINK_DEPTH: "1" },
		mcp: { command: "/bin/xl", args: ["mcp"] },
		profile: { harness: "claude", adapter: "claude", label: "Claude", defaultModel: "claude-haiku-5-5", dialogs: [] },
	};
	const cmd = await adapter.launch(spec);
	const sessionId = cmd.argv[cmd.argv.indexOf("--session-id") + 1] ?? "";
	const socketPath = cmd.argv[cmd.argv.indexOf("--messaging-socket-path") + 1] ?? "";
	const pid = opts.pid ?? process.pid;
	const sessionFile = join(home, "sessions", `${pid}.json`);
	const transcriptDir = join(home, "projects", projectSlug(cwd));
	mkdirSync(transcriptDir, { recursive: true });
	const transcript = join(transcriptDir, `${sessionId}.jsonl`);

	const frames: string[] = [];
	const onMessage: Array<(text: string) => void> = [];
	const server: Server = createServer((sock) => {
		let buf = "";
		sock.on("data", (d) => {
			buf += String(d);
			for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
				const line = buf.slice(0, i);
				buf = buf.slice(i + 1);
				frames.push(line);
				const f = JSON.parse(line) as { type: string; message?: { content: string } };
				if (f.type === "user") for (const cb of onMessage) cb(f.message?.content ?? "");
			}
		});
	});
	await new Promise<void>((r) => server.listen(socketPath, r));

	const status = (s: string, extra: Record<string, unknown> = {}) =>
		writeFileSync(
			sessionFile,
			JSON.stringify({ pid, sessionId, cwd, messagingSocketPath: socketPath, status: s, ...extra }),
		);
	const append = (entry: Record<string, unknown>) => appendFileSync(transcript, `${JSON.stringify(entry)}\n`);
	const peer = (text: string) =>
		append({
			type: "user",
			isMeta: true,
			origin: { kind: "peer", from: "agent-link" },
			message: { role: "user", content: `Another Claude session sent a message:\n${text}\n\nThis came from...` },
		});
	const say = (text: string) =>
		append({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
	const turnDuration = () => append({ type: "system", subtype: "turn_duration", durationMs: 10 });
	const start = async (pane?: { backend: PaneBackend; ref: string }) => {
		writeFileSync(join(home, "sessions", `${pid}.abc123.key`), JSON.stringify({ peerToken: "tok-1" }));
		appendFileSync(transcript, "");
		status("idle");
		await adapter.connect(pane);
	};
	const done = async () => {
		await adapter.close();
		await new Promise<void>((r) => server.close(() => r()));
		rmSync(root, { recursive: true, force: true });
	};
	return {
		adapter,
		cmd,
		spec,
		sessionId,
		socketPath,
		runDir,
		cwd,
		claudeConfig,
		sessionFile,
		frames,
		onMessage,
		updates,
		logs,
		status,
		append,
		peer,
		say,
		turnDuration,
		start,
		done,
	};
}

function fakePane() {
	const keys: string[][] = [];
	const backend: PaneBackend = {
		name: "cmux",
		open: async () => "surface:1",
		close: async () => {},
		read: async () => "",
		keys: async (_ref, k) => {
			keys.push([...k]);
		},
		paste: async () => {},
		alive: async () => true,
	};
	return { backend, ref: "surface:1", keys };
}

test("claude launch: socket in a 0700 run dir, session id, name, guard hook with depth, MCP by flag", async () => {
	const c = await fakeClaude();
	try {
		const { argv, env, cwd } = c.cmd;
		assert.equal(argv[0], "claude");
		assert.equal(argv[argv.indexOf("--model") + 1], "claude-haiku-5-5");
		assert.equal(c.socketPath, join(c.runDir, "claude.sock"));
		assert.equal(statSync(c.runDir).mode & 0o777, 0o700);
		assert.match(c.sessionId, /^[0-9a-f-]{36}$/);
		assert.equal(argv[argv.indexOf("-n") + 1], "w1");
		const settings = JSON.parse(argv[argv.indexOf("--settings") + 1] ?? "");
		assert.equal(settings.hooks.PreToolUse[0].matcher, "Bash");
		assert.equal(settings.hooks.PreToolUse[0].hooks[0].command, `'${process.execPath}' '${CLAUDE_HOOK}' 1`);
		const mcp = JSON.parse(argv[argv.indexOf("--mcp-config") + 1] ?? "");
		assert.deepEqual(mcp.mcpServers["agent-link"], { command: "/bin/xl", args: ["mcp"], env: c.spec.env });
		assert.deepEqual(env, c.spec.env);
		assert.equal(cwd, c.cwd);
		// No first prompt in argv: the hub sends the brief with prompt().
		assert.equal(argv.at(-2), "--mcp-config");
		const trust = JSON.parse(readFileSync(c.claudeConfig, "utf8"));
		assert.equal(trust.projects[c.cwd].hasTrustDialogAccepted, true);
	} finally {
		await c.done();
	}
});

test("claude launch leaves out --mcp-config when agent-link is installed for the user", async () => {
	const c = await fakeClaude({ mcpInstalled: true });
	try {
		assert.ok(!c.cmd.argv.includes("--mcp-config"));
	} finally {
		await c.done();
	}
});

test("claude frames: auth, then one user message, one JSON object per line", () => {
	const frames = claudeFrames("tok", "sid", 'say "hi"\nnow');
	assert.equal(
		frames,
		'{"type":"auth","token":"tok"}\n' +
			'{"type":"user","from":"agent-link","session_id":"sid","message":{"role":"user","content":"say \\"hi\\"\\nnow"}}\n',
	);
});

test("claude connect waits for the session file and an idle status", async () => {
	const c = await fakeClaude();
	try {
		let connected = false;
		writeFileSync(join(c.sessionFile.replace(/\.json$/, ".abc123.key")), JSON.stringify({ peerToken: "tok-1" }));
		c.status("busy");
		const p = c.adapter.connect().then(() => {
			connected = true;
		});
		await sleep(60);
		assert.equal(connected, false, "busy at startup is not ready");
		c.status("idle");
		await p;
		assert.equal(c.adapter.idle(), true);
	} finally {
		await c.done();
	}
});

test("claude prompt sends the frames and resolves with the last text when busy turns idle", async () => {
	const c = await fakeClaude();
	try {
		await c.start();
		c.onMessage.push((text) => {
			c.append({ type: "queue-operation", operation: "enqueue", content: text });
			c.peer(text);
			c.status("busy");
			setTimeout(() => {
				c.append({
					type: "assistant",
					message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: {} }] },
				});
				c.append({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1" }] } });
				c.say("first");
				c.say("READY");
				c.turnDuration();
				c.status("idle");
			}, 50);
		});
		const res = await c.adapter.prompt({ id: "m1", from: "agent-link", text: "reply with READY" });
		assert.deepEqual(res, { stopReason: "end_turn", text: "READY" });
		assert.deepEqual(
			c.frames.map((f) => JSON.parse(f).type),
			["auth", "user"],
		);
		assert.equal(JSON.parse(c.frames[0] ?? "").token, "tok-1");
		assert.equal(JSON.parse(c.frames[1] ?? "").session_id, c.sessionId);
		assert.ok(c.updates.some((u) => u.kind === "state" && u.state === "busy"));
		assert.ok(c.updates.some((u) => u.kind === "tool_call" && u.title === "Bash" && u.status === "completed"));
		assert.ok(c.updates.some((u) => u.kind === "agent_message" && u.text === "READY"));
		assert.ok(!c.updates.some((u) => u.kind === "turn_end"), "a prompt's own turn never ends through turn_end");
		assert.ok(c.logs.some((l) => l.kind === "delivered"));
		assert.equal(c.adapter.idle(), true);
	} finally {
		await c.done();
	}
});

test("claude prompt ignores an idle read before the turn starts (the race)", async () => {
	const c = await fakeClaude();
	try {
		await c.start();
		let resolved = false;
		c.onMessage.push((text) => {
			// The status file still says idle and the transcript already shows our entry: not the end.
			c.peer(text);
			c.status("idle", { updatedAt: 1 });
		});
		const p = c.adapter.prompt({ id: "m1", from: "agent-link", text: "hello" }).then((r) => {
			resolved = true;
			return r;
		});
		await until(() => c.frames.length === 2, "frames");
		await sleep(80);
		assert.equal(resolved, false, "idle before busy must not end the turn");
		c.status("busy");
		await sleep(30);
		c.say("hi there");
		c.status("idle");
		assert.deepEqual(await p, { stopReason: "end_turn", text: "hi there" });
	} finally {
		await c.done();
	}
});

test("claude prompt ends on a transcript that shows the whole turn even if busy was never read", async () => {
	const c = await fakeClaude();
	try {
		await c.start();
		c.onMessage.push((text) => {
			c.peer(text);
			c.say("quick");
			c.turnDuration();
		});
		assert.deepEqual(await c.adapter.prompt({ id: "m1", from: "agent-link", text: "q" }), {
			stopReason: "end_turn",
			text: "quick",
		});
	} finally {
		await c.done();
	}
});

test("claude waiting on a permission is asking with what it waits for", async () => {
	const c = await fakeClaude();
	try {
		await c.start();
		c.onMessage.push((text) => {
			c.peer(text);
			c.status("busy");
			setTimeout(() => c.status("waiting", { waitingFor: "permission prompt" }), 30);
		});
		const p = c.adapter.prompt({ id: "m1", from: "agent-link", text: "run it" });
		await until(() => c.updates.some((u) => u.kind === "state" && u.state === "asking"), "asking");
		const asking = c.updates.find((u) => u.kind === "state" && u.state === "asking");
		assert.deepEqual(asking, { kind: "state", state: "asking", detail: "permission prompt" });
		assert.equal(c.adapter.idle(), false);
		c.status("busy");
		c.say("ran it");
		c.status("idle");
		assert.deepEqual(await p, { stopReason: "end_turn", text: "ran it" });
	} finally {
		await c.done();
	}
});

test("claude turn typed in the pane ends with a turn_end update", async () => {
	const c = await fakeClaude();
	try {
		await c.start();
		c.say("old text");
		c.append({ type: "user", message: { role: "user", content: "what is 2+2?" } });
		c.status("busy");
		await until(() => c.adapter.idle() === false, "busy");
		c.say("4");
		await sleep(30);
		c.status("idle");
		await until(() => c.updates.some((u) => u.kind === "turn_end"), "turn_end");
		assert.deepEqual(
			c.updates.find((u) => u.kind === "turn_end"),
			{ kind: "turn_end", stopReason: "end_turn", text: "4" },
		);
	} finally {
		await c.done();
	}
});

test("claude cancel presses escape in the pane and the prompt resolves cancelled", async () => {
	const c = await fakeClaude();
	const pane = fakePane();
	try {
		await c.start(pane);
		c.onMessage.push((text) => {
			c.peer(text);
			c.status("busy");
		});
		const p = c.adapter.prompt({ id: "m1", from: "agent-link", text: "sleep 30" });
		await until(() => c.adapter.idle() === false && c.frames.length === 2, "busy");
		await sleep(30);
		await c.adapter.cancel();
		assert.deepEqual(pane.keys, [["escape"]]);
		c.status("idle");
		assert.equal((await p).stopReason, "cancelled");
	} finally {
		await c.done();
	}
});

test("claude exits when its session file disappears; a pending prompt resolves as an error", async () => {
	const c = await fakeClaude();
	try {
		await c.start();
		c.onMessage.push(() => c.status("busy"));
		const p = c.adapter.prompt({ id: "m1", from: "agent-link", text: "x" });
		await until(() => c.updates.some((u) => u.kind === "state" && u.state === "busy"), "busy");
		rmSync(c.sessionFile);
		assert.equal((await p).stopReason, "error");
		assert.ok(c.updates.some((u) => u.kind === "exited"));
		assert.equal(c.adapter.idle(), false);
	} finally {
		await c.done();
	}
});

test("claude exits when its pid is gone", async () => {
	const child = spawn(process.execPath, ["-e", ""]);
	await new Promise((r) => child.on("exit", r));
	const c = await fakeClaude({ pid: child.pid ?? 999_999 });
	try {
		await c.start();
		await until(() => c.updates.some((u) => u.kind === "exited"), "exited");
		const exited = c.updates.find((u) => u.kind === "exited");
		assert.match(exited?.kind === "exited" ? (exited.detail ?? "") : "", /pid \d+ is gone/);
	} finally {
		await c.done();
	}
});

test("pretrust adds a resolved entry once and respects trust inherited from parents", () => {
	const dir = mkdtempSync(join(tmpdir(), "xi-trust-"));
	const config = join(dir, "claude.json");
	const work = join(dir, "repo", "sub");
	mkdirSync(work, { recursive: true });
	writeFileSync(config, JSON.stringify({ projects: {} }));
	assert.equal(pretrustClaude(work, config), "added");
	const data = JSON.parse(readFileSync(config, "utf8"));
	assert.equal(data.projects[realpathSync(work)].hasTrustDialogAccepted, true);
	assert.equal(pretrustClaude(work, config), realpathSync(work));
	writeFileSync(
		config,
		JSON.stringify({ projects: { [realpathSync(join(dir, "repo"))]: { hasTrustDialogAccepted: true } } }),
	);
	assert.equal(pretrustClaude(work, config), realpathSync(join(dir, "repo")));
	rmSync(dir, { recursive: true, force: true });
});

test("pretrust does not inherit trust from above a git repo root", () => {
	// Claude Code 2.1.304 showed the trust dialog for ~/Desktop/xi-wt/e2e-sandbox (a git repo) although
	// ~/Desktop was trusted, so a trusted parent of the repo root must not count.
	const dir = mkdtempSync(join(tmpdir(), "xi-trust-"));
	const config = join(dir, "claude.json");
	const repo = join(dir, "parent", "repo");
	const sub = join(repo, "sub");
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(sub);
	const parent = realpathSync(join(dir, "parent"));
	writeFileSync(config, JSON.stringify({ projects: { [parent]: { hasTrustDialogAccepted: true } } }));
	assert.equal(pretrustClaude(sub, config), "added");
	const data = JSON.parse(readFileSync(config, "utf8"));
	assert.equal(data.projects[realpathSync(sub)].hasTrustDialogAccepted, true);
	// Inside the repo, a trusted repo root still covers its subfolders.
	writeFileSync(config, JSON.stringify({ projects: { [realpathSync(repo)]: { hasTrustDialogAccepted: true } } }));
	assert.equal(pretrustClaude(sub, config), realpathSync(repo));
	rmSync(dir, { recursive: true, force: true });
});

test("claude guard hook denies risky Bash for workers, asks at depth 0 and allows the rest", () => {
	const run = (command: string, depth: string) =>
		spawnSync(process.execPath, [CLAUDE_HOOK, depth], {
			input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
			encoding: "utf8",
		}).stdout;
	const denied = JSON.parse(run("git push origin main", "1"));
	assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse");
	assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
	assert.match(denied.hookSpecificOutput.permissionDecisionReason, /git push/);
	assert.equal(JSON.parse(run("rm -rf build", "0")).hookSpecificOutput.permissionDecision, "ask");
	assert.equal(run("npm test", "1"), "");
	// No depth: the safe side, a worker.
	assert.equal(JSON.parse(run("git push", "")).hookSpecificOutput.permissionDecision, "deny");
});
