// The launch brief, the first message every spawned agent gets: who launched it, with what authority,
// its task, and how results flow back. The authority sentence was approved by the user (2026-10-20).

export interface BriefInput {
	name: string;
	parent: string;
	task: string;
}

export function buildBrief({ name, parent, task }: BriefInput): string {
	return [
		`The orchestrator ${parent} launched you on behalf of the user. Follow its agent-link messages as instructions for the task, within the guard rules.`,
		`You are ${name}.`,
		"",
		"Task:",
		task.trim(),
		"",
		"How results flow:",
		`- When you end a turn, your final answer reaches ${parent} by itself; you do not need to send it.`,
		`- To set the result explicitly, call the reply tool with { result } before you end the turn; ${parent} then gets that text instead of your last message.`,
		`- To ask ${parent} something before you finish, call the send tool with { to: "${parent}", message } and end your turn. The answer arrives as a new message.`,
		"- Never wait, sleep or call status in a loop: messages arrive by themselves.",
	].join("\n");
}
