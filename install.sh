#!/usr/bin/env bash
# Faro installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Jero110/faro-agent/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/Jero110/faro-agent/main/install.sh | bash -s -- --backend tmux
#
# Options: --backend cmux|tmux skips the question. --deps first installs git, curl, tmux and Node.js 24 with apt
# (Ubuntu, Debian, WSL). --with-harnesses also installs Claude Code, Codex and opencode with npm into ~/.local.
# On Windows, use install.ps1: it sets up WSL2 and runs this script inside it.
#
# It puts the code in ~/.faro/src (or uses the checkout it runs from), installs its npm dependencies, links
# `faro` and `agent-link` into ~/.local/bin, asks whether you work in cmux or tmux, and registers the MCP
# servers for that choice with every harness it finds (Claude Code, Codex, opencode, pi, Faro).
# Environment: FARO_DIR (code), FARO_BIN_DIR (links), FARO_REPO (git URL), FARO_REF (branch or tag),
# FARO_HARNESS_PREFIX (npm prefix for --with-harnesses, default ~/.local).
set -euo pipefail

REPO="${FARO_REPO:-https://github.com/Jero110/faro-agent.git}"
REF="${FARO_REF:-main}"
BIN_DIR="${FARO_BIN_DIR:-$HOME/.local/bin}"
ORIG_PATH="$PATH"
BACKEND=""
DEPS=no
HARNESSES=no
HARNESS_PREFIX="${FARO_HARNESS_PREFIX:-$HOME/.local}"

while [ $# -gt 0 ]; do
	case "$1" in
	--backend) BACKEND="${2:-}"; shift 2 ;;
	--backend=*) BACKEND="${1#*=}"; shift ;;
	--deps) DEPS=yes; shift ;;
	--with-harnesses) HARNESSES=yes; shift ;;
	-h | --help) sed -n '2,17p' "$0" 2>/dev/null || true; exit 0 ;;
	*) echo "faro install: unknown option $1" >&2; exit 2 ;;
	esac
done

say() { printf '\033[1m%s\033[0m\n' "$*"; }
fail() { printf 'faro install: %s\n' "$*" >&2; exit 1; }

node_major() { node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }

# 0. System packages, with --deps (apt only).
if [ "$DEPS" = yes ]; then
	[ "$(uname -s)" = Linux ] && command -v apt-get >/dev/null ||
		fail "--deps installs packages with apt (Ubuntu, Debian, WSL). On macOS: brew install git node tmux"
	if [ "$(id -u)" -eq 0 ]; then root() { "$@"; }; else root() { sudo "$@"; }; fi
	say "Installing git, curl and tmux (apt may ask for your password)"
	root apt-get update -qq
	root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl tmux ca-certificates >/dev/null
	if ! command -v node >/dev/null || [ "$(node_major)" -lt 24 ]; then
		say "Installing Node.js 24 from NodeSource"
		curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
		root bash /tmp/nodesource_setup.sh >/dev/null
		root env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
		rm -f /tmp/nodesource_setup.sh
		hash -r
		[ "$(node_major)" -ge 24 ] ||
			fail "Node.js 24 is installed in /usr/bin, but an older node comes first on PATH: $(command -v node). Remove it or put /usr/bin first."
	fi
fi

# 1. Requirements.
command -v git >/dev/null || fail "git is required"
command -v node >/dev/null || fail "Node.js 24 or newer is required (https://nodejs.org)"
command -v npm >/dev/null || fail "npm is required"
NODE_MAJOR="$(node_major)"
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
(cd "$DIR" && npm ci --ignore-scripts --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)

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
if [ "$BACKEND" = tmux ] && [ "$HAS_TMUX" = no ]; then
	if [ "$(uname -s)" = Darwin ]; then HOW="brew install tmux"; else HOW="sudo apt install tmux, or run this script with --deps"; fi
	echo "note: tmux was not found; install it ($HOW) before you start Faro"
fi

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
export PATH="$BIN_DIR:$HARNESS_PREFIX/bin:$PATH"

# 5b. The harnesses, with --with-harnesses, before setup so it registers the MCP servers with them.
if [ "$HARNESSES" = yes ]; then
	say "Installing Claude Code, Codex and opencode into $HARNESS_PREFIX"
	npm install -g --prefix "$HARNESS_PREFIX" --no-audit --no-fund --no-update-notifier --loglevel=error \
		@anthropic-ai/claude-code @openai/codex opencode-ai
fi

# 6. MCP servers, Faro's settings and its agent-link profile.
say "Setting up Faro for $BACKEND"
node "$DIR/packages/faro/src/cli.ts" setup --backend "$BACKEND"

echo
say "Faro is installed."
case ":$ORIG_PATH:" in
*":$BIN_DIR:"*) ;;
*)
	RC="$HOME/.zshrc"
	[ "${SHELL##*/}" = bash ] && RC="$HOME/.bashrc"
	ADD="$BIN_DIR"
	[ "$HARNESSES" = yes ] && [ "$HARNESS_PREFIX/bin" != "$BIN_DIR" ] && ADD="$BIN_DIR:$HARNESS_PREFIX/bin"
	echo "Add $ADD to your PATH, e.g.: echo 'export PATH=\"$ADD:\$PATH\"' >> $RC"
	;;
esac
if [ "$BACKEND" = cmux ]; then
	echo "Open a terminal in cmux, cd into a project and run: faro"
else
	echo "Start tmux, cd into a project and run: faro"
fi
echo "Then try: /skill:planner <what you want to build>"
