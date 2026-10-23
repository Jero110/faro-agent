#!/usr/bin/env bash
# Faro installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Jero110/faro-agent/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Jero110/faro-agent/main/install.sh | bash -s -- --backend tmux
#
# It puts the code in ~/.faro/src (or uses the checkout it runs from), installs its npm dependencies, links
# `faro` and `agent-link` into ~/.local/bin, asks whether you work in cmux or tmux, and registers the MCP
# servers for that choice with every harness it finds (Claude Code, Codex, opencode, pi, Faro).
# Environment: FARO_DIR (code), FARO_BIN_DIR (links), FARO_REPO (git URL), FARO_REF (branch or tag).
set -euo pipefail

REPO="${FARO_REPO:-https://github.com/Jero110/faro-agent.git}"
REF="${FARO_REF:-main}"
BIN_DIR="${FARO_BIN_DIR:-$HOME/.local/bin}"
BACKEND=""

while [ $# -gt 0 ]; do
	case "$1" in
	--backend) BACKEND="${2:-}"; shift 2 ;;
	--backend=*) BACKEND="${1#*=}"; shift ;;
	-h | --help) sed -n '2,12p' "$0" 2>/dev/null || true; exit 0 ;;
	*) echo "faro install: unknown option $1" >&2; exit 2 ;;
	esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'faro install: %s\n' "$*" >&2; exit 1; }

# 1. Requirements.
command -v git >/dev/null || fail "git is required"
command -v node >/dev/null || fail "Node.js 24 or newer is required (https://nodejs.org)"
command -v npm >/dev/null || fail "npm is required"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 24 ] || fail "Node.js 24 or newer is required (found $(node -v))"

# 2. The code: the checkout this script lives in, else a clone in ~/.faro/src.
SELF_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
	SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi
if [ -n "$SELF_DIR" ] && [ -f "$SELF_DIR/packages/faro/src/cli.ts" ] && [ -z "${FARO_DIR:-}" ]; then
	DIR="$SELF_DIR"
	say "Using the checkout in $DIR"
else
	DIR="${FARO_DIR:-$HOME/.faro/src}"
	if [ -d "$DIR/.git" ]; then
		say "Updating $DIR"
		git -C "$DIR" fetch --quiet origin "$REF"
		git -C "$DIR" checkout --quiet "$REF"
		git -C "$DIR" pull --quiet --ff-only origin "$REF"
	else
		say "Downloading Faro into $DIR"
		mkdir -p "$(dirname "$DIR")"
		git clone --quiet --depth 1 --branch "$REF" "$REPO" "$DIR"
	fi
fi

# 3. Dependencies, exactly as locked, without install scripts.
say "Installing dependencies"
(cd "$DIR" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --loglevel=error)

# 4. cmux or tmux.
has() { command -v "$1" >/dev/null 2>&1; }
HAS_CMUX=no; { has cmux || [ -d /Applications/cmux.app ]; } && HAS_CMUX=yes
HAS_TMUX=no; has tmux && HAS_TMUX=yes
if [ -z "$BACKEND" ]; then
	DEFAULT=cmux
	[ "$HAS_CMUX" = no ] && [ "$HAS_TMUX" = yes ] && DEFAULT=tmux
	if [ -r /dev/tty ] && [ -w /dev/tty ]; then
		{
			echo
			echo "Where will you run your agents?"
			echo "  1) cmux  (recommended: agent sessions, panes, workspaces and a browser through the cmux MCP)$([ "$HAS_CMUX" = no ] && echo '  [not found]')"
			echo "  2) tmux$([ "$HAS_TMUX" = no ] && echo '  [not found]')"
			printf "Choose 1 or 2 [%s]: " "$([ "$DEFAULT" = cmux ] && echo 1 || echo 2)"
		} >/dev/tty
		read -r ANSWER </dev/tty || ANSWER=""
		case "$ANSWER" in
		1 | cmux) BACKEND=cmux ;;
		2 | tmux) BACKEND=tmux ;;
		*) BACKEND="$DEFAULT" ;;
		esac
	else
		BACKEND="$DEFAULT"
	fi
fi
case "$BACKEND" in cmux | tmux) ;; *) fail "--backend must be cmux or tmux" ;; esac
[ "$BACKEND" = cmux ] && [ "$HAS_CMUX" = no ] && echo "note: cmux was not found; install it from https://cmux.com before you start Faro"
[ "$BACKEND" = tmux ] && [ "$HAS_TMUX" = no ] && echo "note: tmux was not found; install it (e.g. brew install tmux) before you start Faro"

# 5. Commands on PATH.
mkdir -p "$BIN_DIR"
link() {
	cat >"$BIN_DIR/$1" <<EOF
#!/bin/sh
exec node "$DIR/$2" "\$@"
EOF
	chmod +x "$BIN_DIR/$1"
}
link faro packages/faro/src/cli.ts
link agent-link packages/agent-link/src/cli.ts

# 6. MCP servers, Faro's settings and its agent-link profile.
say "Setting up Faro for $BACKEND"
node "$DIR/packages/faro/src/cli.ts" setup --backend "$BACKEND"

echo
say "Faro is installed."
case ":$PATH:" in
*":$BIN_DIR:"*) ;;
*) echo "Add $BIN_DIR to your PATH, e.g.: echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
esac
if [ "$BACKEND" = cmux ]; then
	echo "Open a terminal in cmux, cd into a project and run: faro"
else
	echo "Start tmux, cd into a project and run: faro"
fi
echo "Then try: /skill:planner <what you want to build>"
