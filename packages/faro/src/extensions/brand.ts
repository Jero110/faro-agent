// Faro's identity on top of pi: the lighthouse header and the terminal title. Nothing else of pi changes.
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { VERSION as PI_VERSION } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LOGO_WIDTH, logoLines } from "../logo.ts";
import { FARO_VERSION } from "../paths.ts";

export const TAGLINE = "Bring light to your agents.";

/** The header: the logo, with name, tagline and the few commands worth knowing beside it. */
export function headerLines(theme: Theme, width: number, linked: boolean): string[] {
	const logo = logoLines();
	const side = [
		`${theme.bold("Faro")} ${theme.fg("dim", `v${FARO_VERSION} · on pi v${PI_VERSION}`)}`,
		theme.fg("muted", TAGLINE),
		"",
		`${theme.fg("accent", "/skill:planner")} ${theme.fg("dim", "plan a project, then hand it to an executor")}`,
		`${theme.fg("accent", "/workflow review")} ${theme.fg("dim", "what the last run did")}  ${theme.fg("accent", "/workflow ask")} ${theme.fg("dim", "<question>")}`,
		theme.fg(
			"dim",
			linked ? "agent-link on: Faro can launch claude, codex, opencode and faro agents" : "agent-link off",
		),
	];
	const gap = "  ";
	const fits = width >= LOGO_WIDTH + gap.length + 30;
	const lines: string[] = [""];
	const rows = Math.max(logo.length, fits ? side.length : 0);
	for (let i = 0; i < rows; i++) {
		const l = logo[i] ?? " ".repeat(LOGO_WIDTH);
		const s = fits ? (side[i] ?? "") : "";
		const line = ` ${l}${s ? gap + s : ""}`;
		lines.push(visibleWidth(line) > width ? ` ${l}` : line);
	}
	if (!fits) lines.push(` ${theme.bold("Faro")} ${theme.fg("muted", TAGLINE)}`);
	lines.push("");
	return lines;
}

export default function brand(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setTitle(`Faro · ${ctx.cwd.split("/").pop() ?? ""}`);
		if (ctx.mode !== "tui") return;
		const linked = Boolean(process.env.AGENT_LINK_AGENT);
		ctx.ui.setHeader((_tui, theme) => ({
			render: (width: number) => headerLines(theme, width, linked),
			invalidate() {},
		}));
	});
}
