// A workflow run, rebuilt from disk: the agent-link journal says who launched whom with which task, and each
// agent's transcript says what it did (messages, tokens, time per answer, skills). Nothing here needs the
// hub or the agents to still run.
import type { SessionRecord } from "agent-link-core";
import { treeOf } from "agent-link-core";
import {
	readTranscript,
	summarize,
	type Transcript,
	type TranscriptRoots,
	type TranscriptSummary,
} from "agent-transcripts";

export type Role = "planner" | "executor" | "worker" | "helper" | "root";

export interface RunAgent {
	record: SessionRecord;
	role: Role;
	/** T3 from "Task T3 of docs/plans/x.md: ..." in the brief. */
	taskId?: string;
	taskTitle?: string;
	/** Skills the brief told the agent to load ("Skills: a, b"). */
	assignedSkills: string[];
	transcript?: Transcript;
	summary?: TranscriptSummary;
	/** Why there is no transcript. */
	missing?: string;
}

export interface WorkflowRun {
	root: SessionRecord;
	/** The plan the executor ran, from its brief. */
	plan?: string;
	agents: RunAgent[];
}

const PLAN_PATH = /(docs\/plans\/[\w./-]+?\.md)\b/;
const TASK = /Task\s+(T\d+)\b[^:\n]*:\s*([^\n]+)/;
const SKILLS_LINE = /^\s*(?:Skills?|Load the skills?|Skills to load)\s*:\s*(.+)$/im;

export function isExecutor(r: SessionRecord): boolean {
	return (
		/^executor\b/.test(r.name) || /\/skill:executor\b|\bexecutor skill\b|skills\/build\/executor\b/i.test(r.task ?? "")
	);
}

function assigned(task: string | undefined): string[] {
	const m = task ? SKILLS_LINE.exec(task) : null;
	if (!m?.[1]) return [];
	return m[1]
		.split(/[,\s]+/)
		.map(
			(s) =>
				s
					.replace(/[`*()]/g, "")
					.replace(/\/SKILL\.md$/, "")
					.split("/")
					.pop() ?? "",
		)
		.filter((s) => /^[a-z0-9][a-z0-9-]+$/.test(s));
}

/** Roles from the tree's shape: the root plans, an executor child runs the plan, its descendants are workers. */
export function assignRoles(tree: readonly SessionRecord[]): Map<string, Role> {
	const roles = new Map<string, Role>();
	const root = tree[0];
	if (!root) return roles;
	const executors = new Set(tree.filter((r) => r.id !== root.id && isExecutor(r)).map((r) => r.id));
	const under = (r: SessionRecord, ids: Set<string>): boolean => {
		let p = r.parent;
		while (p) {
			if (ids.has(p)) return true;
			p = tree.find((x) => x.id === p)?.parent ?? null;
		}
		return false;
	};
	for (const r of tree) {
		if (r.id === root.id) roles.set(r.id, executors.size ? "planner" : "root");
		else if (executors.has(r.id)) roles.set(r.id, "executor");
		else if (under(r, executors)) roles.set(r.id, "worker");
		else roles.set(r.id, executors.size ? "helper" : "worker");
	}
	return roles;
}

/**
 * The run to review: the tree of the session asking (found by its pi session id or agent-link name), else
 * the newest tree that has an executor, else the newest tree with more than one agent.
 */
export function pickRoot(
	records: readonly SessionRecord[],
	current: { sessionId?: string; agent?: string },
): SessionRecord | undefined {
	const byId = (id: string) => records.find((r) => r.id === id);
	const mine =
		(current.sessionId ? records.find((r) => r.sessionId === current.sessionId) : undefined) ??
		(current.agent ? records.find((r) => r.name === current.agent) : undefined);
	if (mine) return byId(mine.root) ?? mine;
	const roots = records.filter((r) => r.parent === null);
	return (
		roots.find((r) => records.some((x) => x.root === r.id && isExecutor(x))) ??
		roots.find((r) => records.some((x) => x.root === r.id && x.id !== r.id))
	);
}

export function buildRun(records: readonly SessionRecord[], root: SessionRecord, roots?: TranscriptRoots): WorkflowRun {
	const tree = treeOf(records, root.id);
	const roles = assignRoles(tree);
	let plan: string | undefined;
	const agents = tree.map((record): RunAgent => {
		const task = record.task ? TASK.exec(record.task) : null;
		const agent: RunAgent = {
			record,
			role: roles.get(record.id) ?? "worker",
			taskId: task?.[1],
			taskTitle: task?.[2]?.trim(),
			assignedSkills: assigned(record.task),
		};
		if (agent.role === "executor") plan ??= record.task ? PLAN_PATH.exec(record.task)?.[1] : undefined;
		try {
			agent.transcript = readTranscript(
				{ harness: record.harness, sessionId: record.sessionId, transcript: record.transcript },
				roots,
			);
			agent.summary = summarize(agent.transcript);
		} catch (e) {
			agent.missing = e instanceof Error ? e.message : String(e);
		}
		return agent;
	});
	if (!plan) plan = agents.map((a) => (a.record.task ? PLAN_PATH.exec(a.record.task)?.[1] : undefined)).find(Boolean);
	return { root, plan, agents };
}
