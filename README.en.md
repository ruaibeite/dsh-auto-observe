# @ruaibeite/dsh-auto-observe

Removes the recurring `file has not been read — read the file, then retry` failure for files the
agent inspected with `bash` instead of the `read` tool.

## Why it keeps happening

`dsh-fs-observation-policy` requires a prior read, and only a few channels record an observation:
the `read` tool (including `offset`/`limit` windows), a successful `write`/`edit`, and image reads.
A `bash` call — `sed -n`, `awk 'NR>=…'`, `cat`, a `python3 - <<PY` script — **records nothing**,
and that is exactly how agents inspect code. In one real session: 1186 bash calls against 114
reads, with four rejected edits, all on files that had only ever been looked at through bash.

## What it does

A listener prepended to the `fs/edit-intent` / `fs/write-intent` waterfal (prepend is required: the
policy's listener never calls `next()`, so anything queued after it never runs):

1. it mirrors `fs/observed` into a ledger shaped exactly like the policy's. **If a record exists it
   does nothing** and hands control back — so `FS_STALE_VERSION` protection is untouched;
2. with **no** record it takes the file's real version via `ctx.fs.stat` and emits `fs/observed`
   the way the `read` tool does (`{kind:'present', version}`, or `{kind:'absent'}` when missing);
3. a non-regular file, a missing session owner, or a failed `stat` all fall through untouched.

## The trade-off, stated plainly

The record it writes is a fact about the *file* (its current version), not a claim that the model
saw the content. `edit` is on by default because an anchored replacement still has to match the
current text byte for byte. `write` — a blind full overwrite — is **off** by default (`writes:
true` to change that) because it has no such backstop. Every intervention logs one line.

### One known bound

The mirror starts recording when this plugin loads. That is harmless on the normal path — the
plugin needs a Harness restart, and a restart empties the policy's in-memory ledger too, so both
start from zero together. The one exception is hot-enabling this plugin mid-session, after files
have already been read: those earlier records are unknown to the mirror, so the plugin records
their current version once, which relaxes staleness for that single edit. A restart realigns them.

## Install

```sh
./install.sh        # desktop profile by default; PROFILE_NAME=web ./install.sh for another
```

Restart Harness afterwards (host plugins do not hot-reload).

## Development

```sh
node test/contract.mjs   # dependency-free contract tests
```

The tests replicate the real waterfall (queue-shift) and the policy's ledger logic verbatim, and
cover the baseline failure, unblocking, zero-intervention when a record exists, staleness
preservation, missing owners/targets, `prepend` placement and all three switches.

## License

MIT
