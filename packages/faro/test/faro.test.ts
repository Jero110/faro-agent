import assert from "node:assert/strict";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Journal, readJournal } from "agent-link-core";
import type { TranscriptRoots } from "agent-transcripts";
import { answersText } from "../src/extensions/ask.ts";
import { askContext, reviewInstructions } from "../src/extensions/workflow.ts";
import { piCommand, runFaro, withSkillsDir } from "../src/launcher.ts";
import { LOGO_WIDTH, logoLines } from "../src/logo.ts";
import { EXTENSIONS, faroPaths, PI_CLI, SKILL_GROUP_DIRS, SKILLS_DIR } from "../src/paths.ts";
import { ensureAgentDir, readConfig, setup, writeFaroProfile } from "../src/setup.ts";
import { catalogReadme, readCatalog, skillPath } from "../src/workflow/catalog.ts";
import { renderReport } from "../src/workflow/report.ts";
import { briefOf, buildRun, pickRoot } from "../src/workflow/run.ts";

function tempHome(t: { after: (fn: () => void) => void }): { home: string; env: NodeJS.ProcessEnv } {
	const home = mkdtempSync(join(tmpdir(), "faro-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return { home, env: { HOME: home, PATH: "", AGENT_LINK_HOME: join(home, ".al") } };
}

test("the logo is the lighthouse: 6 lines of the same width, colors from the image", () => {
	const lines = logoLines();
	assert.equal(lines.length, 6);
	for (const l of lines) assert.equal(visibleWidth(l), LOGO_WIDTH);
	assert.ok(lines.join("").includes("\u001b[38;2;238;238;238m"), "the light gray of the image");
});

test("the agent dir is made once from pi's login, with Sonnet, this checkout's skills and no stray extensions", (t) => {
	const { home, env } = tempHome(t);
	const pi = join(home, ".pi", "agent");
	mkdirSync(join(pi, "npm"), { recursive: true });
	writeFileSync(join(pi, "auth.json"), "{}");
	writeFileSync(join(pi, "settings.json"), JSON.stringify({ packages: ["npm:pi-claude-bridge"], theme: "x" }));
	const paths = faroPaths(env, home);
	assert.deepEqual(ensureAgentDir(paths), { wrote: true, copied: ["auth.json", "npm"] });
	const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, "claude-bridge");
	assert.equal(settings.defaultModel, "claude-sonnet-5-5");
	assert.deepEqual(settings.packages, ["npm:pi-claude-bridge"]);
	assert.deepEqual(settings.skills, SKILL_GROUP_DIRS);
	assert.deepEqual(settings.extensions, ["!extensions/**"]);

	settings.theme = "mine";
	settings.skills = ["/old/checkout/skills/build", "/home/me/my-skills"];
	writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify(settings));
	assert.equal(ensureAgentDir(paths).wrote, false);
	const again = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
	assert.equal(again.theme, "mine", "the user's settings stay");
	assert.deepEqual(again.skills, [...SKILL_GROUP_DIRS, "/home/me/my-skills"], "skills follow the checkout");
});

test("without pi's bridge Faro starts on Anthropic's Sonnet", (t) => {
	const { home, env } = tempHome(t);
	const paths = faroPaths(env, home);
	ensureAgentDir(paths);
	const settings = JSON.parse(readFileSync(join(paths.agentDir, "settings.json"), "utf8"));
	assert.equal(settings.defaultProvider, "anthropic");
	assert.deepEqual(settings.packages, []);
});

test("setup: cmux adds the cmux MCP to Faro and records the backend; tmux takes it out again", (t) => {
	const { home, env } = tempHome(t);
	const paths = faroPaths(env, home);
	const lines: string[] = [];
	setup({ paths, backend: "cmux", home, env, out: (l) => lines.push(l) });
	const mcp = JSON.parse(readFileSync(join(paths.agentDir, "mcp.json"), "utf8"));
	assert.equal(mcp.mcpServers.cmux.exposure, "direct");
	assert.match(mcp.mcpServers.cmux.args[0], /cmux-mcp\/src\/cli\.ts$/);
	assert.deepEqual(readConfig(paths), { backend: "cmux" });
	const profile = JSON.parse(readFileSync(join(home, ".al", "profiles", "faro.json"), "utf8"));
	assert.equal(profile.adapter, "pi");
	assert.match(profile.command[1], /faro\/src\/cli\.ts$/);
	assert.ok(lines.some((l) => /claude: not found on PATH, skipped/.test(l)));

	setup({ paths, backend: "tmux", home, env, out: () => {} });
	assert.deepEqual(JSON.parse(readFileSync(join(paths.agentDir, "mcp.json"), "utf8")).mcpServers, {});
	assert.deepEqual(readConfig(paths), { backend: "tmux" });
});

test("as an agent (AGENT_LINK_AGENT set) Faro runs pi with its config dir and extensions", async (t) => {
	const { home, env } = tempHome(t);
	const runs: string[][] = [];
	const code = await runFaro({
		argv: ["-e", "/x/agent-link-ext.ts", "--model", "m"],
		env: { ...env, AGENT_LINK_AGENT: "faro-2" },
		home,
		cwd: home,
		err: () => {},
		run: async (cmd) => {
			runs.push(cmd.argv);
			assert.equal(cmd.env.PI_CODING_AGENT_DIR, join(home, ".faro", "agent"));
			return 0;
		},
		root: async () => assert.fail("an agent never registers again"),
	});
	assert.equal(code, 0);
	assert.deepEqual(runs[0], [
		process.execPath,
		PI_CLI,
		...EXTENSIONS.flatMap((e) => ["-e", e]),
		"-e",
		"/x/agent-link-ext.ts",
		"--model",
		"m",
	]);
});

test("as a root Faro registers with agent-link; when the hub cannot take it, it runs without agent-link", async (t) => {
	const { home, env } = tempHome(t);
	const registered: string[][] = [];
	const ok = await runFaro({
		argv: ["hello"],
		env,
		home,
		cwd: home,
		err: () => {},
		run: async () => 3,
		root: async (o) => {
			registered.push([...o.argv]);
			return (o.run ?? (async () => 1))({ argv: ["faro-from-hub"], env: {}, cwd: home });
		},
	});
	assert.equal(ok, 3);
	assert.deepEqual(registered, [["faro", "hello"]]);
	assert.ok(existsSync(join(home, ".al", "profiles", "faro.json")), "the profile is there before the hub needs it");

	const errs: string[] = [];
	const ran: string[][] = [];
	const fallback = await runFaro({
		argv: ["hello"],
		env,
		home,
		cwd: home,
		err: (l) => errs.push(l),
		run: async (cmd) => {
			ran.push(cmd.argv);
			return 0;
		},
		root: async (o) => {
			o.err?.("agent-link open: the agent-link hub is not reachable: boom");
			return 1;
		},
	});
	assert.equal(fallback, 0);
	assert.equal(ran[0]?.[1], PI_CLI);
	assert.ok(errs.some((l) => /running without agent-link/.test(l)));
	assert.ok(errs.some((l) => /not reachable: boom/.test(l)));
});

test("Faro shares its skills folder with every worker, after any folders already shared", () => {
	assert.equal(withSkillsDir({}), SKILLS_DIR);
	assert.equal(withSkillsDir({ AGENT_LINK_READ_DIRS: "/refs" }), `/refs:${SKILLS_DIR}`);
	assert.equal(withSkillsDir({ AGENT_LINK_READ_DIRS: SKILLS_DIR }), SKILLS_DIR, "not added twice");
});

test("piCommand keeps the user's arguments last", () => {
	const paths = faroPaths({ HOME: "/h" }, "/h");
	const cmd = piCommand(paths, ["--continue"], {}, "/w");
	assert.equal(cmd.argv.at(-1), "--continue");
	assert.equal(cmd.cwd, "/w");
});

test("writeFaroProfile carries a non-default FARO_HOME, so the Faro workers the hub opens use it", (t) => {
	const { env } = tempHome(t);
	const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as { env?: Record<string, string> };
	assert.equal(read(writeFaroProfile(env)).env, undefined);
	assert.deepEqual(read(writeFaroProfile({ ...env, FARO_HOME: "/sandbox/faro" })).env, { FARO_HOME: "/sandbox/faro" });
});

test("writeFaroProfile only rewrites when it changed", (t) => {
	const { env } = tempHome(t);
	const file = writeFaroProfile(env);
	const before = statSync(file).mtimeMs;
	writeFaroProfile(env);
	assert.equal(statSync(file).mtimeMs, before);
});

// ---------------------------------------------------------------------------------------------- skills

function skillFiles(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir)) {
		const p = join(dir, e);
		if (statSync(p).isDirectory()) {
			if (existsSync(join(p, "SKILL.md"))) out.push(join(p, "SKILL.md"));
			else out.push(...skillFiles(p));
		}
	}
	return out;
}

test("the catalog and the skills on disk match, and skills/README.md is current", () => {
	const catalog = readCatalog();
	const onDisk = SKILL_GROUP_DIRS.flatMap(skillFiles).sort();
	const listed = catalog.skills
		.filter((s) => !s.external)
		.map((s) => skillPath(s))
		.sort();
	assert.deepEqual(listed, onDisk);
	for (const s of catalog.skills.filter((x) => !x.external)) {
		const text = readFileSync(skillPath(s), "utf8");
		assert.match(text, new RegExp(`^---\\nname: ${s.name}\\n`), `${s.name}: frontmatter name`);
		const manual = /^disable-model-invocation: true$/m.test(text);
		assert.equal(manual, s.author !== "Faro", `${s.name}: only Faro's own skills are model-invocable`);
	}
	assert.equal(readFileSync(join(SKILLS_DIR, "README.md"), "utf8"), `${catalogReadme(catalog)}\n`);
	const extras = catalog.skills.filter((s) => s.group === "extras").map((s) => `${s.name} (${s.author})`);
	assert.deepEqual(extras, [
		"api-and-interface-design (Addy)",
		"browser-testing-with-devtools (Addy)",
		"code-review-and-quality (Addy)",
		"debugging-and-error-recovery (Addy)",
		"code-simplification (Addy)",
		"impeccable (Paul Bakaus)",
	]);
	assert.ok(catalog.groups.filter((g) => g.manual).every((g) => g.id === "post-build" || g.id === "extras"));
});

test("Faro's own skills fix no model and ask only through ask_user_question", () => {
	for (const name of ["pre-build/planner", "build/executor"]) {
		const text = readFileSync(join(SKILLS_DIR, name, "SKILL.md"), "utf8");
		assert.doesNotMatch(text, /claude-(haiku|sonnet|opus)-\d|gpt-\d|glm-\d/, `${name} names a model`);
		assert.match(text, /ask_user_question/);
	}
});

// ---------------------------------------------------------------------------------------------- workflow

function fakeRun(t: { after: (fn: () => void) => void }) {
	const home = mkdtempSync(join(tmpdir(), "faro-run-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const roots: TranscriptRoots = {
		claude: join(home, "claude"),
		codex: join(home, "codex"),
		opencodeDb: join(home, "oc.db"),
		pi: join(home, "pi"),
		faro: join(home, "faro"),
	};
	const at = (s: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, s)).toISOString();
	const piSession = (id: string, skill: string, out: number) => {
		mkdirSync(join(roots.faro, "--w--"), { recursive: true });
		writeFileSync(
			join(roots.faro, "--w--", `x_${id}.jsonl`),
			[
				{ type: "session", id, cwd: "/w", timestamp: at(0) },
				{ type: "message", id: `${id}u`, timestamp: at(1), message: { role: "user", content: "go" } },
				{
					type: "message",
					id: `${id}a`,
					timestamp: at(11),
					message: {
						role: "assistant",
						model: "claude-sonnet-5-5",
						content: [{ type: "toolCall", id: "k", name: "read", arguments: { path: `/s/${skill}/SKILL.md` } }],
						usage: { input: 10, output: out, cacheRead: 100, cacheWrite: 0 },
					},
				},
			]
				.map((o) => JSON.stringify(o))
				.join("\n"),
		);
	};
	piSession("p-1", "planner", 50);
	piSession("e-1", "executor", 30);
	mkdirSync(join(roots.claude, "-w"), { recursive: true });
	writeFileSync(
		join(roots.claude, "-w", "c-1.jsonl"),
		[
			{
				type: "user",
				sessionId: "c-1",
				timestamp: at(20),
				message: { content: "Task T1 of docs/plans/todo.md: add the list" },
			},
			{
				type: "assistant",
				timestamp: at(50),
				message: {
					id: "m",
					model: "claude-haiku-5-5",
					content: [
						{ type: "tool_use", id: "u", name: "Read", input: { file_path: "/s/test-driven-development/SKILL.md" } },
					],
					usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
				},
			},
		]
			.map((o) => JSON.stringify(o))
			.join("\n"),
	);
	const dir = join(home, "journal");
	const j = new Journal(dir);
	const base = { model: null, cwd: "/w", state: "exited" as const };
	j.create({
		...base,
		id: "a",
		name: "faro",
		parent: null,
		parentName: null,
		root: "a",
		harness: "faro",
		depth: 0,
		sessionId: "p-1",
		startedAt: at(0),
	});
	j.create({
		...base,
		id: "b",
		name: "executor",
		parent: "a",
		parentName: "faro",
		root: "a",
		harness: "faro",
		depth: 1,
		task: "Read /repo/skills/build/executor/SKILL.md and follow it.\nRun the plan /w/docs/plans/todo.md end to end.",
		sessionId: "e-1",
		startedAt: at(5),
	});
	j.create({
		...base,
		id: "c",
		name: "t1-list",
		parent: "b",
		parentName: "executor",
		root: "a",
		harness: "claude",
		depth: 2,
		task: "Task T1 of /w/docs/plans/todo.md: add the list\nSkills: test-driven-development\nRead and follow: /s/test-driven-development/SKILL.md",
		sessionId: "c-1",
		startedAt: at(19),
	});
	j.create({
		...base,
		id: "d",
		name: "t2-search",
		parent: "b",
		parentName: "executor",
		root: "a",
		harness: "opencode",
		depth: 2,
		task: "Task T2 of /w/docs/plans/todo.md: search the docs",
		sessionId: "ses_missing",
		startedAt: at(19),
	});
	return { records: readJournal(dir), roots };
}

test("a brief written to a file counts: its Task and Skills lines are read from it", (t) => {
	const { home } = tempHome(t);
	const dir = join(home, "docs", "plans", "x-briefs");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "T2.md"), "Task T2 of docs/plans/x.md: load the CSV\nSkills: spec-driven-development\n");
	const brief = briefOf("Read and do the task in docs/plans/x-briefs/T2.md", home) ?? "";
	assert.match(brief, /Task T2 of docs\/plans\/x\.md: load the CSV/);
	assert.match(brief, /Skills: spec-driven-development/);
	assert.equal(briefOf("Task T1: inline", home), "Task T1: inline", "an inline brief is kept as it is");
	assert.equal(briefOf("Read docs/plans/gone-briefs/T9.md", home), "Read docs/plans/gone-briefs/T9.md");
});

test("a run is rebuilt from the journal and transcripts: roles, plan, tasks, skills, tokens, time", (t) => {
	const { records, roots } = fakeRun(t);
	const root = pickRoot(records, { sessionId: "c-1" });
	assert.equal(root?.id, "a", "any session of the tree finds its root");
	assert.equal(pickRoot(records, {})?.id, "a", "without a current session: the newest tree with an executor");
	if (!root) return;
	const run = buildRun(records, root, roots);
	assert.equal(run.plan, "docs/plans/todo.md");
	assert.deepEqual(
		run.agents.map((a) => [a.record.name, a.role]),
		[
			["faro", "planner"],
			["executor", "executor"],
			["t1-list", "worker"],
			["t2-search", "worker"],
		],
	);
	const t1 = run.agents[2];
	assert.equal(t1?.taskId, "T1");
	assert.deepEqual(t1?.assignedSkills, ["test-driven-development"]);
	assert.deepEqual(t1?.summary?.skills, ["test-driven-development"]);
	assert.equal(t1?.summary?.activeMs, 30_000);
	assert.match(run.agents[3]?.missing ?? "", /no transcript on disk/);

	const report = renderReport(run);
	assert.match(report, /^# Workflow review: docs\/plans\/todo\.md/);
	assert.match(report, /\| planner \| 1 \| faro \| 60 \| 10 \| 50 \| 0 \| 100 \| 1 \| 10s \|/, "new tokens first");
	assert.match(report, /New tokens \d+ \(.*\) · cache reads \d+/);
	assert.match(report, /\| worker \| 2 \| claude, opencode \|/);
	assert.match(report, /\| claude \| 1 \| claude-haiku-5-5 \|/);
	assert.match(
		report,
		/\| {5}t1-list \| worker \| claude · claude-haiku-5-5 \| T1: add the list \| test-driven-development \| test-driven-development \|/,
	);
	assert.match(report, /### t1-list \(worker, claude\)/);
	assert.match(report, /\| 1 \| 10:00:50 \| 30s \| 5 \| 7 \| 0 \| Read \| test-driven-development \|/);
	assert.match(reviewInstructions("/r.md", run.plan), /up to 5 recommendations/);
	assert.match(
		reviewInstructions("/r.md", run.plan),
		/Append both to \/r\.md as "## Summary" and "## Recommendations"/,
	);
});

test("/workflow ask carries the architecture, the catalog, this machine and the question", (t) => {
	const { home, env } = tempHome(t);
	const text = askContext("how are my skills organized?", { ...env, FARO_HOME: join(home, ".faro") });
	assert.match(text, /## How Faro works/);
	assert.match(text, /## Extras \(manual\)/);
	assert.match(text, /`grilling` \| Matt Pocock/);
	assert.match(text, /Backend: not set up/);
	assert.match(text, /# Question\n\nhow are my skills organized\?/);
	assert.match(text, /pi, which Faro runs on: .*pi-coding-agent \(README\.md, docs\/, examples\/extensions\/\)/);
	assert.match(text, /Search the pi package above for its name/);
});

test("answers read as one line per question", () => {
	assert.equal(
		answersText({
			cancelled: false,
			answers: [
				{ header: "Start", picked: ["I have an idea or a path"] },
				{ header: "Skills", picked: ["test-driven-development", "spec-driven-development"] },
				{ header: "Name", picked: ["todo"], typed: "todo" },
			],
		}),
		"Start: I have an idea or a path\nSkills: test-driven-development, spec-driven-development\nName: user wrote: todo",
	);
	assert.match(answersText({ cancelled: true, answers: [] }), /closed the questions/);
});
