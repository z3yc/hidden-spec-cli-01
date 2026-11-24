# mend

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/z3yc/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/z3yc/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

`mend` is one command-line tool that applies the edits AI models write, in four formats, to a tree of files. It is an entry for the [hidden-spec-cli-01 bounty on make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). `SPEC.md` is the whole specification.

## Usage

    node main.ts [options] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory; when absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).

## The formats

- **Unified diffs**, often with wrong line numbers: sections, hunks, create/delete/move/change, nearest-to-the-named-line occurrence.
- **SEARCH/REPLACE blocks**: each block replaces its old lines, which must occur exactly once.
- **V4A patches**: Add/Delete/Update File sections, `@@` anchors, a cursor, `*** End of File`.
- **JSON text-editor tool calls**: `create`, `str_replace`, `insert`, one object per line or one array.

Old lines are found at the first of three matching tiers where they occur: exact, trailing whitespace ignored, leading and trailing whitespace ignored (with re-indentation). Every file is changed or nothing is: a failed edit changes nothing, the edits after it still run, and when any edit failed no file is written.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone. Its last lines hand a trial over to `runner.ts` when `MAKEFUN_ENV_URL` is set.
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification.
- `LICENSE`: MIT.
