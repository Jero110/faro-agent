// /workflow review and /workflow ask: Faro looking at its own workflow.
//
// review: rebuilds the last run from disk (agent-link journal + transcripts), writes a report of what ran,
//   with which skills, tokens and time by role, harness, agent and message, then asks the model in this
//   session for recommendations grounded in that report.
// ask: gives the model the architecture, the skills catalog and what is installed here, then the question.
// The report is computed, never guessed: the model only writes the recommendations and the answers.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { agentLinkHome, hubPaths, readJournal } from "agent-link-core";
import { faroPaths, PI_PACKAGE, REPO_ROOT, SKILLS_DIR } from "../paths.ts";
import { readConfig } from "../setup.ts";
import { catalogMarkdown, readCatalog } from "../workflow/catalog.ts";
import { renderReport } from "../workflow/report.ts";
import { buildRun, pickRoot } from "../workflow/run.ts";

export const MESSAGE_TYPE = "faro-workflow";

export const USAGE = "usage: /workflow review [--last] | /workflow ask <question>";

export function reviewInstructions(reportFile: string, plan: string | undefined): string {
	return [
		`The report above is computed from the transcripts (saved at ${reportFile}). Now:`,
		"1. Summarize in 3-5 lines what this run did: tasks, which agent and harness did each, the skills used.",
		"   When you give token counts, use new tokens; name cache reads separately, as context read again, never as one sum.",
		"2. Write up to 5 recommendations to improve the workflow. Look at: skills that helped, were assigned but not loaded, or were missing;",
		"   task split and parallelism; harness and model per task; brief quality (questions back, retries, tool errors); time and token waste",
		"   (slow answers, large inputs, idle waits). For each: the change, the evidence (agent name and message #), and where to change it",
		`   (a skill under ${SKILLS_DIR}, the plan${plan ? ` ${plan}` : ""}, or the executor's choices).`,
		`3. Append both to ${reportFile} as "## Summary" and "## Recommendations", so the saved report has them. Edit no other file.`,
		`The skills catalog is ${join(SKILLS_DIR, "catalog.json")}; read a skill or the plan when a recommendation depends on it.`,
	].join("\n");
}

export const ARCHITECTURE = `## How Faro works

- Faro is pi (unmodified) with three extensions: the header, ask_user_question (questions in a picker) and /workflow.
- agent-link lets any agent launch, message and stop other agents (claude, codex, opencode, faro, pi), each in its own
  pane with its native UI. A hub daemon routes messages; results reach the parent by themselves.
- The hub journals every agent to ~/.agent-link/sessions/<id>.json (parent, task, pane, session id, transcript path), so
  sessions can be found and read after the hub or the agent stops.
- The cmux MCP (cmux only) lists agent sessions and reads their transcripts, arranges surfaces, panes and workspaces,
  and drives cmux's browser.
- The workflow: the planner skill (pre-build) takes the user from an idea to a validated plan in docs/plans/<slug>.md,
  asking only through ask_user_question; the user picks the build skills; grilling stress-tests the idea. On approval the
  planner launches an executor (a Faro agent in its own pane) that runs the plan end to end with no questions to the user,
  dispatching tasks to workers on the harness and model the plan names. Post-build and Extras skills are manual.
- /workflow review reads a run back from the journal and transcripts: tokens, time per message, skills per agent.`;

function harnessesOnPath(env: NodeJS.ProcessEnv): string[] {
	const dirs = (env.PATH ?? "").split(":").filter(Boolean);
	return ["claude", "codex", "opencode", "pi", "tmux", "cmux"].filter((b) => dirs.some((d) => existsSync(join(d, b))));
}

function latestReport(dir: string): string | undefined {
	try {
		const files = readdirSync(dir)
			.filter((f) => f.endsWith(".md"))
			.sort();
		const last = files.at(-1);
		return last ? join(dir, last) : undefined;
	} catch {
		return undefined;
	}
}

export function askContext(question: string, env: NodeJS.ProcessEnv = process.env): string {
	const paths = faroPaths(env);
	const config = readConfig(paths);
	const report = latestReport(paths.reports);
	const reportHead = report ? readFileSync(report, "utf8").split("\n").slice(0, 40).join("\n") : undefined;
	return [
		"# Faro workflow context",
		"",
		ARCHITECTURE,
		"",
		"## This machine",
		"",
		`- Backend: ${config?.backend ?? "not set up (run faro setup)"}; MCP servers: agent-link${config?.backend === "cmux" ? ", cmux" : ""}`,
		`- On PATH: ${harnessesOnPath(env).join(", ") || "none found"}`,
		`- Repository: ${REPO_ROOT}`,
		`- pi, which Faro runs on: ${PI_PACKAGE} (README.md, docs/, examples/extensions/)`,
		report ? `- Last review report: ${report}` : "- No /workflow review report yet",
		"",
		"# Skills catalog",
		"",
		catalogMarkdown(readCatalog()),
		reportHead ? `# Last review (first lines)\n\n${reportHead}\n` : "",
		"# Question",
		"",
		question,
		"",
		"Answer from the context above and the files it names; say what you do not know. If the question names a tool, skill,",
		"repository or link you do not know, research it first. Search the pi package above for its name (grep -ril): Faro",
		"is pi, so a pi extension or example is the cheapest way to add a tool. Then launch an opencode agent with agent-link",
		"spawn to search the web, or fetch the link. Then give one verdict: we already have something better (name it, say",
		"why), it is about the same as one of ours (name it), or it is worth trying (say exactly what to add or change, and on",
		"which past task to test it).",
	].join("\n");
}

async function review(pi: ExtensionAPI, args: string[], ctx: ExtensionCommandContext): Promise<void> {
	const records = readJournal(hubPaths(agentLinkHome()).sessions);
	const current = args.includes("--last")
		? {}
		: { sessionId: ctx.sessionManager.getSessionId(), agent: process.env.AGENT_LINK_AGENT };
	const root = pickRoot(records, current);
	if (!root) {
		ctx.ui.notify("No workflow run found in the agent-link journal yet. Run the planner first.", "warning");
		return;
	}
	const run = buildRun(records, root);
	const report = renderReport(run);
	const paths = faroPaths();
	mkdirSync(paths.reports, { recursive: true });
	const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
	const slug = (run.plan?.split("/").pop()?.replace(/\.md$/, "") ?? root.name).replace(/[^\w-]+/g, "-");
	const file = join(paths.reports, `${stamp}-${slug}.md`);
	writeFileSync(file, `${report}\n`);
	pi.sendMessage(
		{ customType: MESSAGE_TYPE, content: `${report}\n\n---\n\n${reviewInstructions(file, run.plan)}`, display: true },
		{ triggerTurn: true },
	);
}

export default function workflow(pi: ExtensionAPI): void {
	pi.registerCommand("workflow", {
		description: "review: what the last run did and how to improve it · ask <question>: about your workflow and skills",
		getArgumentCompletions: (prefix) =>
			["review", "review --last", "ask "].filter((c) => c.startsWith(prefix)).map((c) => ({ value: c, label: c })),
		handler: async (raw, ctx) => {
			const [sub, ...rest] = raw.trim().split(/\s+/);
			if (sub === "review") return review(pi, rest, ctx);
			if (sub === "ask" && rest.join(" ").trim()) {
				pi.sendMessage(
					{ customType: MESSAGE_TYPE, content: askContext(rest.join(" ").trim()), display: false },
					{ triggerTurn: true },
				);
				return;
			}
			ctx.ui.notify(USAGE, "info");
		},
	});
}
