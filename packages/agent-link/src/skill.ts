// The agent-link skill the installer writes: when to launch other agents and how their results come back.
// Short on purpose: the MCP server's own instructions carry the details for each agent.

export const SKILL_NAME = "agent-link";

export const SKILL_MD = `---
name: agent-link
description: Launch other coding agents (claude, codex, opencode, pi) in their own terminal panes and talk to them with the agent-link tools spawn, send, reply, status, cancel and inbox. Use when a task splits into parts that can run in parallel, needs a second opinion or review, or the user asks for another agent or model.
---

# agent-link

agent-link opens other harnesses next to you, each in its own pane with its own UI, where the user can watch it.

## When to spawn

- The task has parts that can run at the same time (one worker per part), or needs a reviewer.
- The user asks for another agent, harness or model. Pass the model they name on every spawn.
- Not for a small step you can do yourself in less time than writing the task.

Give each worker a self-contained task: what to do, where, and what to answer with.

## Names are exact

spawn returns the worker's name: the name you passed, else its harness, plus -2, -3 when taken.
Use that exact name with send and cancel; status lists the names around you.

## Results arrive by themselves

- spawn and send return at once. A worker's final answer reaches you later as a new message
  that starts with [agent-link] <name>. A root not opened with agent-link open reads them with inbox().
- After spawning or sending, tell the user what runs and end your turn.
- Never wait, sleep, or call status or inbox in a loop: they show state, not results.
- A worker that asks you something: answer with send({ to: "<worker>", message }).
- As a worker, your final answer reaches your parent by itself; call reply({ result }) only to set it
  explicitly, and send({ to: "<parent>", message }) to ask before you finish.
`;
