#!/usr/bin/env bash
# PostToolUse: format and auto-fix a TypeScript file right after Claude edits it.
#
# This exists as a hook rather than a CLAUDE.md line because formatting is not a
# judgement call — it should happen every time, with no exceptions, and hooks are
# the only deterministic layer. CLAUDE.md is advisory.
#
# The hook payload is parsed with node, not jq: this repo is cloned onto fresh
# machines where node is guaranteed by definition and jq often is not.
set -uo pipefail

input=$(cat)

file_path=$(node -e '
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", () => {
    try {
      process.stdout.write(String(JSON.parse(raw)?.tool_input?.file_path ?? ""));
    } catch {
      process.stdout.write("");
    }
  });
' <<<"$input" 2>/dev/null)

project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"

# Only TypeScript sources; everything else is none of this hook's business.
[[ "$file_path" == *.ts ]] || exit 0

cd "$project_dir" || exit 0
[[ -f "$file_path" ]] || exit 0

# A fresh clone with no install yet must not turn every edit into a hook failure.
[[ -x "./node_modules/.bin/eslint" ]] || exit 0

# Formatting first: prettier rewrites layout, eslint --fix then applies the
# semantic fixes on top. The reverse order lets prettier undo eslint's spacing.
./node_modules/.bin/prettier --write --log-level warn "$file_path" >/dev/null 2>&1

lint_output=$(./node_modules/.bin/eslint --fix "$file_path" 2>&1)
lint_status=$?

if [[ $lint_status -ne 0 ]]; then
  # Exit 2 surfaces stderr to Claude. The edit already happened — this is
  # feedback to fix what --fix could not, not a block.
  printf 'eslint found problems in %s that --fix could not resolve:\n\n%s\n' \
    "$file_path" "$lint_output" >&2
  exit 2
fi

exit 0
