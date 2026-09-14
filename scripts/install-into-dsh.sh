#!/usr/bin/env bash
# install-into-dsh.sh — mount dsh-memory into the local dsh profiles.
#
# Does exactly two things, idempotently:
#   1. links this repository into $DSH_HOME/profiles/node_modules/dsh-memory
#      (the shared installation closure every profile resolves through)
#   2. appends "dsh-memory" to dsh.profile.bundles of the target profiles
#      (skipped when already present; a .bak copy is written before each edit)
#
# It never touches a profile's cordis.patch.yml: `insert` is pure-append and the
# loader rejects duplicate entry ids, so the bundle's own patch owns `id: memory`.
#
# usage: install-into-dsh.sh [--dry-run] [--profiles nvim-tui,web,headless]
#
# POLICY — `tui` is the human's production profile and must never receive this
# working tree. It consumes a *released* build (see docs/RELEASE.md); the local
# link is for the test surfaces only. Passing tui therefore requires the
# explicit --allow-tui flag, which exists to make the mistake deliberate.
set -euo pipefail

DSH_HOME_DIR="${DSH_HOME:-$HOME/.dsh}"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILES="nvim-tui,web,headless"
DRY_RUN=0
ALLOW_TUI=0

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --profiles) PROFILES="${2:-}"; shift 2 ;;
    --allow-tui) ALLOW_TUI=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
run() {
  if [ "$DRY_RUN" = "1" ]; then say "  [dry-run] $*"; else "$@"; fi
}

if [ "$ALLOW_TUI" != "1" ]; then
  case ",$PROFILES," in
    *,tui,*)
      say "refusing: 'tui' is the production profile and takes a released build, not this working tree."
      say "          (local testing uses nvim-tui / web / headless — see docs/RELEASE.md)"
      exit 3
      ;;
  esac
fi

say "dsh home : $DSH_HOME_DIR"
say "plugin   : $REPO_DIR"
say "profiles : $PROFILES"
say ""

# --- 1. shared module link ---------------------------------------------------
LINK="$DSH_HOME_DIR/profiles/node_modules/dsh-memory"
say "[1/2] module link: $LINK"
if [ -L "$LINK" ] && [ "$(readlink "$LINK")" = "$REPO_DIR" ]; then
  say "  already linked"
else
  run mkdir -p "$DSH_HOME_DIR/profiles/node_modules"
  run ln -sfn "$REPO_DIR" "$LINK"
  say "  linked"
fi

# --- 2. bundle lists ---------------------------------------------------------
say "[2/2] bundle lists"
IFS=',' read -r -a names <<< "$PROFILES"
for name in "${names[@]}"; do
  manifest="$DSH_HOME_DIR/profiles/$name/package.json"
  if [ ! -f "$manifest" ]; then
    say "  $name: skipped (no package.json)"
    continue
  fi
  if [ "$DRY_RUN" = "1" ]; then
    python3 - "$manifest" <<'PY'
import json, sys
path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)
bundles = data.get("dsh", {}).get("profile", {}).get("bundles", [])
print(f"  {path}: bundles = {bundles}")
print("  would append: dsh-memory" if "dsh-memory" not in bundles else "  already present")
PY
    continue
  fi
  python3 - "$manifest" <<'PY'
import json, shutil, sys, time
path = sys.argv[1]
with open(path) as fh:
    data = json.load(fh)
profile = data.setdefault("dsh", {}).setdefault("profile", {})
bundles = profile.setdefault("bundles", [])
if "dsh-memory" in bundles:
    print(f"  {path}: already present")
    sys.exit(0)
shutil.copy2(path, f"{path}.bak.{time.strftime('%Y%m%d%H%M%S')}")
bundles.append("dsh-memory")
with open(path, "w") as fh:
    json.dump(data, fh, indent=2)
    fh.write("\n")
print(f"  {path}: appended dsh-memory -> {bundles}")
PY
done

say ""
say "done. restart the surfaces (nvim-tui / web / headless) to load the plugin."
say "verify: the plugin logs to \$DSH_HOME/memory-plugin.log and exposes memory_search."
