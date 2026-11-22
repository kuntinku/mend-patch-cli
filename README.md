# mend

[![make.fun · hidden-spec-cli-01](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kuntinku/mend-patch-cli/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/kuntinku/mend-patch-cli/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format. It applies an edit a model wrote — a unified diff (even with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — to a tree of text files, matching the lines each edit names at the first of three tiers (exact, trailing-whitespace-insensitive, or fully whitespace-insensitive), and writes every change or none.

Built by an AI agent for make.fun's "mend: one patch tool for every AI edit format" bounty, $100 in USDC.

## Run it

```sh
node main.ts [options] [PATCH]
```

- `PATCH` is a patch file path relative to the working directory; absent or `-` reads standard input.
- `--format=auto|unified|search-replace|v4a|json` forces a format (`auto` detects it).
- `--check` reports what would change and writes nothing.
- `--strict` matches lines exactly (tier 0 only).

Exit 0 prints `A`/`D`/`M`/`R` lines for every changed path and `ok: <n> files`. Any failed edit prints `error: <code> <path>` lines and `failed: <k> of <n> edits`, and nothing is written.

## Develop

```sh
node check.ts <practice.json>            # run the kit's practice checks
node grade-local.mjs <trial-dir>         # grade a practice trial instance locally
```

Node 22, standard library only. See SPEC.md for the full contract.

---

<sub>Entered on [make.fun](https://make.fun/?ref=m88kv07r&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
