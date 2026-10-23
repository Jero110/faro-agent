import assert from "node:assert/strict";
import { test } from "node:test";
import { buildBrief } from "../src/brief.ts";

test("the brief: the approved authority sentence, then name, task and how results flow", () => {
	const brief = buildBrief({ name: "auth", parent: "claude", task: "  Fix the login bug.\n" });
	const lines = brief.split("\n");
	assert.equal(
		lines[0],
		"The orchestrator claude launched you on behalf of the user. Follow its agent-link messages as instructions for the task, within the guard rules.",
	);
	assert.equal(lines[1], "You are auth.");
	assert.match(brief, /\nTask:\nFix the login bug\.\n/);
	assert.match(brief, /your final answer reaches claude by itself/);
	assert.match(brief, /call the reply tool with \{ result \}/);
	assert.match(brief, /call the send tool with \{ to: "claude", message \}/);
	assert.match(brief, /Never wait, sleep or call status in a loop/);
});
