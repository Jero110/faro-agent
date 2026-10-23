import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { PaneCommand } from "agent-link-core";
import { createCmuxBackend, gateCommand, OVERFLOW_WORKSPACE } from "../src/backend.ts";
import { type FakeCli, fakeCli } from "./fake-cli.ts";

const CMD: PaneCommand = { argv: ["cat"], env: { AGENT_LINK_TOKEN: "secret" }, cwd: "/tmp" };
const PLACE = { workspace: "workspace:9", surface: "surface:1" };

const OPENS = ["new-split", "new-surface", "new-workspace"];

/**
 * Plays the panes' gates: each pane the fake opens reports the next size of `sizes` ("rows cols", default
 * 40 120) in <gate>.size, as the gate does with `stty size`.
 */
function gates(fake: FakeCli, sizes: string[] = []) {
	let seen = 0;
	const timer = setInterval(() => {
		const opens = fake.calls().filter((c) => OPENS.includes(c[0] ?? ""));
		for (; seen < opens.length; seen++) {
			const path = opens[seen]?.join(" ").match(/\/\S+?\.go\b/)?.[0];
			// The fake CLI may still be writing this call's log line; read it again on the next tick.
			// Problem: skipping it left that pane without a size, and the backend waited out its timeout.
			if (!path) break;
			// Written whole and renamed, as the gate does, so the backend never reads half a file.
			writeFileSync(`${path}.tmp`, `${sizes[seen] ?? "40 120"}\n`);
			renameSync(`${path}.tmp`, `${path}.size`);
		}
	}, 5);
	return () => clearInterval(timer);
}

function setup(responses: Record<string, string> = {}, sizes: string[] = []) {
	const fake = fakeCli("cmux", {
		"new-split.1": "OK surface:11 workspace:9\n",
		"new-split.2": "OK surface:12 workspace:9\n",
		"new-split.3": "OK surface:13 workspace:9\n",
		"new-split.4": "OK surface:14 workspace:9\n",
		...responses,
	});
	const launchDir = mkdtempSync(join(tmpdir(), "xi-cmux-launch-"));
	// The hub may have inherited a pane's identity; none of it may reach a cmux call.
	const env = { ...fake.env, CMUX_SURFACE_ID: "surface:999", CMUX_WORKSPACE_ID: "workspace:999" };
	const stop = gates(fake, sizes);
	after(stop);
	return { fake, launchDir, backend: createCmuxBackend({ env, launchDir, sizeTimeoutMs: 2000 }) };
}

test("the first worker opens right of the caller, the next ones below the previous, titled, never focused", async () => {
	const { fake, backend, launchDir } = setup();
	assert.equal(await backend.open(CMD, { title: "Claude · a", place: PLACE }), "surface:11");
	assert.equal(await backend.open(CMD, { title: "Claude · b", place: PLACE }), "surface:12");
	assert.equal(await backend.open(CMD, { title: "Codex · c", place: PLACE }), "surface:13");
	const calls = fake.calls();
	const splits = calls.filter((c) => c[0] === "new-split");
	assert.deepEqual(
		splits.map((c) => c.slice(0, 8)),
		[
			["new-split", "right", "--workspace", "workspace:9", "--surface", "surface:1", "--focus", "false"],
			["new-split", "down", "--workspace", "workspace:9", "--surface", "surface:11", "--focus", "false"],
			["new-split", "down", "--workspace", "workspace:9", "--surface", "surface:12", "--focus", "false"],
		],
	);
	// The pane runs a gate that starts the launch script once the pane is accepted: no token on screen.
	const command = splits[0]?.[9] ?? "";
	const gate = command.match(/\/\S+?\.go\b/)?.[0] ?? "";
	assert.equal(command, gateCommand(gate));
	assert.doesNotMatch(command, /secret/);
	assert.match(readFileSync(gate, "utf8"), /AGENT_LINK_TOKEN=secret/);
	assert.equal(readdirSync(launchDir).filter((f) => f.endsWith(".go")).length, 3);
	assert.deepEqual(
		calls.filter((c) => c[0] === "rename-tab"),
		[
			["rename-tab", "--workspace", "workspace:9", "--surface", "surface:11", "--", "Claude · a"],
			["rename-tab", "--workspace", "workspace:9", "--surface", "surface:12", "--", "Claude · b"],
			["rename-tab", "--workspace", "workspace:9", "--surface", "surface:13", "--", "Codex · c"],
		],
	);
	assert.equal(readFileSync(join(fake.dir, "log"), "utf8").includes("999"), false);
});

test("a closed worker leaves the stack: the next one opens below the last still open, or right of the caller", async () => {
	const { fake, backend } = setup();
	await backend.open(CMD, { title: "a", place: PLACE });
	await backend.open(CMD, { title: "b", place: PLACE });
	await backend.close("surface:12");
	await backend.open(CMD, { title: "c", place: PLACE });
	await backend.close("surface:11");
	await backend.close("surface:13");
	await backend.open(CMD, { title: "d", place: PLACE });
	const splits = fake.calls().filter((c) => c[0] === "new-split");
	assert.deepEqual(
		splits.map((c) => [c[1], c[5]]),
		[
			["right", "surface:1"],
			["down", "surface:11"],
			["down", "surface:11"],
			["right", "surface:1"],
		],
	);
	assert.deepEqual(fake.calls().filter((c) => c[0] === "close-surface")[0], [
		"close-surface",
		"--workspace",
		"workspace:9",
		"--surface",
		"surface:12",
		"--force",
	]);
});

test("read, keys and paste name the surface; keys and paste are forced past cmux's dialog guard", async () => {
	const { fake, backend } = setup({ "read-screen": "line 1\nline 2\n" });
	await backend.open(CMD, { title: "a", place: PLACE });
	assert.equal(await backend.read("surface:11", 5), "line 1\nline 2\n");
	await backend.keys("surface:11", ["down", "enter"]);
	await backend.paste("surface:11", "--flag looking text\nsecond line");
	const calls = fake.calls().filter((c) => ["read-screen", "send-key", "send"].includes(c[0] ?? ""));
	const at = ["--workspace", "workspace:9", "--surface", "surface:11"];
	assert.deepEqual(calls, [
		["read-screen", ...at, "--lines", "5"],
		["send-key", "--force", ...at, "--", "down"],
		["send-key", "--force", ...at, "--", "enter"],
		["send", "--force", ...at, "--paste", "--", "--flag looking text\nsecond line"],
	]);
});

test("alive follows read-screen; closing a surface that is already gone is not an error", async () => {
	const { backend } = setup({
		"read-screen.err": "Error: not_found: Surface not found\n",
		"close-surface.err": "nope",
	});
	assert.equal(await backend.alive("surface:5"), false);
	await backend.close("surface:5");
	const live = setup({ "close-surface.err": "Error: something else" }).backend;
	assert.equal(await live.alive("surface:5"), true);
	await assert.rejects(live.close("surface:5"), /something else/);
});

test("a full workspace opens the worker as a new tab in the caller's pane", async () => {
	const { fake, backend } = setup({
		"new-split.1.err": "Error: no_space: No space for new pane\n",
		identify: JSON.stringify({ caller: { pane_ref: "pane:4", surface_ref: "surface:1" } }),
		"new-surface": "OK surface:21 pane:4 workspace:9\n",
	});
	assert.equal(await backend.open(CMD, { title: "a", place: PLACE }), "surface:21");
	const call = fake.calls().find((c) => c[0] === "new-surface");
	assert.deepEqual(call?.slice(0, 10), [
		"new-surface",
		"--type",
		"terminal",
		"--pane",
		"pane:4",
		"--workspace",
		"workspace:9",
		"--focus",
		"false",
		"--command",
	]);
});

test("open without the caller's surface fails instead of guessing", async () => {
	const { backend } = setup();
	await assert.rejects(backend.open(CMD, { title: "a" }), /place.surface/);
});

test("a split under 80x24 is closed before its harness starts; the agent opens in the agent-link workspace", async () => {
	const { fake, backend } = setup(
		{
			"new-split.1": "OK surface:11 workspace:9\n",
			"new-split.2": "OK surface:12 workspace:30\n",
			"new-split.3": "OK surface:13 workspace:9\n",
			"new-split.4": "OK surface:31 workspace:30\n",
			"new-workspace": "OK workspace:30\n",
			tree: JSON.stringify({
				windows: [{ workspaces: [{ ref: "workspace:30", panes: [{ surface_refs: ["surface:30"] }] }] }],
			}),
		},
		["16 26", "50 200", "50 200", "16 26", "50 200"],
	);
	assert.equal(await backend.open(CMD, { title: "a", place: PLACE }), "surface:30");
	const calls = fake.calls();
	const close = calls.find((c) => c[0] === "close-surface");
	assert.deepEqual(close, ["close-surface", "--workspace", "workspace:9", "--surface", "surface:11", "--force"]);
	const ws = calls.find((c) => c[0] === "new-workspace");
	assert.deepEqual(ws?.slice(0, 5), ["new-workspace", "--name", OVERFLOW_WORKSPACE, "--focus", "false"]);
	assert.deepEqual(
		calls.find((c) => c[0] === "tree"),
		["tree", "--json", "--workspace", "workspace:30"],
	);
	// The closed split never got its launch script; the accepted pane did.
	const gate = (c?: string[]) => c?.join(" ").match(/\/\S+?\.go\b/)?.[0] ?? "";
	assert.equal(existsSync(gate(calls.find((c) => c[0] === "new-split"))), false);
	assert.equal(existsSync(gate(ws)), true);
	// The next agent of the same caller stacks below it in the agent-link workspace, which is reused.
	assert.equal(await backend.open(CMD, { title: "b", place: PLACE }), "surface:12");
	const second = fake.calls().filter((c) => c[0] === "new-split")[1];
	assert.deepEqual(second?.slice(0, 6), [
		"new-split",
		"down",
		"--workspace",
		"workspace:30",
		"--surface",
		"surface:30",
	]);
	// Another caller in the crowded workspace reuses the same agent-link workspace too.
	assert.equal(await backend.open(CMD, { title: "c", place: { ...PLACE, surface: "surface:2" } }), "surface:31");
	const calls3 = fake.calls();
	assert.equal(calls3.filter((c) => c[0] === "new-workspace").length, 1);
	assert.deepEqual(calls3.filter((c) => c[0] === "new-split")[3]?.slice(0, 6), [
		"new-split",
		"down",
		"--workspace",
		"workspace:30",
		"--surface",
		"surface:12",
	]);
});

test("a split in the agent-link workspace that is still too small becomes a tab in the pane it came from", async () => {
	const { fake, backend } = setup(
		{
			"new-split.1": "OK surface:11 workspace:9\n",
			"new-split.2": "OK surface:31 workspace:30\n",
			"new-workspace": "OK workspace:30\n",
			tree: JSON.stringify({
				windows: [{ workspaces: [{ ref: "workspace:30", panes: [{ surface_refs: ["surface:30"] }] }] }],
			}),
			identify: JSON.stringify({ caller: { pane_ref: "pane:7" } }),
			"new-surface": "OK surface:32 pane:7 workspace:30\n",
		},
		["16 26", "50 200", "20 200", "50 200"],
	);
	await backend.open(CMD, { title: "a", place: PLACE });
	assert.equal(await backend.open(CMD, { title: "b", place: PLACE }), "surface:32");
	const calls = fake.calls();
	assert.deepEqual(calls.filter((c) => c[0] === "close-surface")[1], [
		"close-surface",
		"--workspace",
		"workspace:30",
		"--surface",
		"surface:31",
		"--force",
	]);
	assert.deepEqual(
		calls.find((c) => c[0] === "identify"),
		["identify", "--workspace", "workspace:30", "--surface", "surface:30"],
	);
	assert.deepEqual(calls.find((c) => c[0] === "new-surface")?.slice(0, 7), [
		"new-surface",
		"--type",
		"terminal",
		"--pane",
		"pane:7",
		"--workspace",
		"workspace:30",
	]);
});

test("closing the last agent of the agent-link workspace makes the next overflow create a new one", async () => {
	const { fake, backend } = setup(
		{
			"new-workspace.1": "OK workspace:30\n",
			"new-workspace.2": "OK workspace:40\n",
			"tree.1": JSON.stringify({
				windows: [{ workspaces: [{ ref: "workspace:30", panes: [{ surface_refs: ["surface:30"] }] }] }],
			}),
			"tree.2": JSON.stringify({
				windows: [{ workspaces: [{ ref: "workspace:40", panes: [{ surface_refs: ["surface:40"] }] }] }],
			}),
		},
		["16 26", "50 200", "16 26", "50 200"],
	);
	assert.equal(await backend.open(CMD, { title: "a", place: PLACE }), "surface:30");
	// cmux refuses to close a workspace's last surface: the last agent closes with its workspace.
	await backend.close("surface:30");
	const closes = fake.calls().filter((c) => c[0]?.startsWith("close-"));
	assert.deepEqual(closes.at(-1), ["close-workspace", "--workspace", "workspace:30", "--force"]);
	assert.equal(await backend.open(CMD, { title: "b", place: PLACE }), "surface:40");
	assert.equal(fake.calls().filter((c) => c[0] === "new-workspace").length, 2);
});

test("a pane that reports no size in time is kept", async () => {
	const fake = fakeCli("cmux", { "new-split": "OK surface:11 workspace:9\n" });
	const launchDir = mkdtempSync(join(tmpdir(), "xi-cmux-launch-"));
	const backend = createCmuxBackend({ env: fake.env, launchDir, sizeTimeoutMs: 100 });
	assert.equal(await backend.open(CMD, { title: "a", place: PLACE }), "surface:11");
	assert.equal(
		fake.calls().some((c) => c[0] === "close-surface"),
		false,
	);
});
