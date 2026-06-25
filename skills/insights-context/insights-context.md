# /insights-context

Generate a context-aware insights report that mirrors the visual structure
of the bundled `/insights` command but cross-references friction signals
against git history + auto-memory so **resolved issues are not reported as
currently broken**.

The output is a full standalone HTML file saved to disk, styled identically
to `/insights` (same CSS classes, same At a Glance 4-part shape, same
sections), with these context-aware additions:

1. **Friction section items annotated `OPEN` / `RESOLVED` inline.** Each
   friction category card shows a small badge; resolved items are additionally
   struck-through with a `Resolved by <citation>` footer.
2. **At a Glance "What's hindering you"** omits resolved friction. Stale
   issues you already fixed do not appear as current problems.
3. **New section "Resolved Friction"** appears at the bottom listing
   everything that previously caused friction but since got fixed, with
   citations (commit hash, memory file, or deleted-path reference).
4. **Regression detection.** If friction re-appears *after* a matching fix's
   date, it's flagged as a REGRESSION in a distinct red alert section — not
   silently marked resolved.
5. **Informational interrupts excluded from friction.** Interrupts where the
   user adds context or a preference (rather than correcting course) are
   tracked separately and do not inflate the friction count.

## Usage

- `/insights-context` — last 7 days, top 15 sessions, HTML to disk
- `/insights-context --days 14` — wider window
- `/insights-context --sessions 30` — scan more sessions
- `/insights-context --json` — emit raw JSON bucket output instead of HTML
- `/insights-context --compare` — when given, also run a prior-window scan
  (last 2× days, interleaved sessions) and produce a delta view answering
  "did friction drop after the last fix, or just shift topic?"

## New fields surfaced (v2 scanner)

The scanner now emits the following metrics so the Token Economics card
isn't misleading on either caching-enabled or no-cache backends:

- `total_prompt_processed` — sum per turn of `(input + cache_read + cache_creation)`.
  Compared with `input_tokens` alone it separates "tokens billed at the input
  rate" from "tokens the model actually re-processed". On no-cache backends
  (GLM) the two are close; on caching backends they diverge materially.
- `unique_prompt_max` — high-water mark of conversation size in any single
  turn. The inflation in `input_tokens` (the billed sum) is ~N × this max
  over N turns on a no-cache backend.
- `summary_messages_count` / `summary_overhead_tokens_est` — compaction
  overhead broken out as its own tier (not buried in `input_tokens`).
- `agent_loops`, `loop_sessions`, `loop_total` — two-tool cycle detection
  (`X Y X Y` alternations). Catches stuck-in-a-loop behavior the existing
  `tool_retries` (which only catches `X X X` same-tool retried) misses. Each
  entry carries the two tool names, session + timestamp.
- `response_time_buckets` — now NET of tool wall-clock: the scanner
  subtracts each tool_result's `(issued_at → resolved_at)` span from the
  user→assistant gap, so multi-tool turns where the model waited 5min on a
  FileSystemScanner no longer inflate "model reasoning latency" charts.

## Custom bucket rules

The hardcoded `bucket_of` heuristic was refactored to be project-agnostic.
To extend with project-specific buckets, drop a JSON file at
`~/.ncode/insights-buckets.json` with shape:

```json
[
  {"label": "my-feature friction", "keywords": ["myfeature", "anchorError"]},
  {"label": "internal infrastructure", "keywords": ["infra-x", "infra-y"]}
]
```

Rules from the file prepend to the built-in list so custom rules win on
first-match precedence. Bad files fall back to builtins silently.

## Bundled scripts

Three Python scripts live alongside this skill in
`~/.ncode/commands/insights-context-scripts/`:

- `scan.py` — walks session JSONLs, emits friction + stats JSON
- `resolve.py` — builds the RESOLVED + ENVIRONMENTAL ledger from memory + git
- `render.py` — cross-references scan output against the resolved ledger,
  produces the standalone HTML

All three are project-agnostic: they take the project session dir, memory dir,
and repo path as arguments (derived from the current working directory). No
script contains hardcoded paths.

## Workflow

### 1. Path resolution

Compute the sanitized project session dir exactly like NCode does:

```
sanitized = "-" + cwd.replace("/", "-")
project_session_dir = ~/.ncode/projects/<sanitized>
```

Example: cwd `/path/to/project` →
`~/.ncode/projects/-path-to-project`.

If that directory doesn't exist, say so plainly and stop — no fabrication.

### 2. Run the three scripts in sequence

```sh
# Resolve the session dir + memory dir from cwd
CWD="$(pwd)"
SANITIZED="$(echo "$CWD" | tr '/' '-')"
# -> -Users-name-Documents-… (single leading dash)
SESSION_DIR="$HOME/.ncode/projects/$SANITIZED"
MEMORY_DIR="$SESSION_DIR/memory"
SCRIPTS="$HOME/.ncode/commands/insights-context-scripts"

# Optional: extract canonical CSS from the bundled /insights command.
# Set INSIGHTS_SRC to the path of insights.ts in your NCode source tree.
# INSIGHTS_SRC="$HOME/path/to/code/src/commands/insights.ts"
if [ -n "$INSIGHTS_SRC" ] && [ -f "$INSIGHTS_SRC" ]; then
  awk '/const css = `/,/^  `/' "$INSIGHTS_SRC" | sed '1d;$d' > /tmp/insights-context.css
fi

# Scan session logs → JSON
python3 "$SCRIPTS/scan.py" "$SESSION_DIR" 7 15 > /tmp/insights-context.json

# Build resolved + environmental ledger → JSON
python3 "$SCRIPTS/resolve.py" "$MEMORY_DIR" "$CWD" > /tmp/insights-resolved.json

# Render HTML report
python3 "$SCRIPTS/render.py" "$CWD" /tmp/insights-context.json /tmp/insights-resolved.json
```

Adjust the `7` (days) and `15` (sessions) args for `--days` / `--sessions`.

### 3. What the scanner captures

`scan.py` walks the JSONL files (ordered by mtime desc), takes the top N
within the time window, and emits:

- **Tool counts** — calls per tool, including git commit/push detection
- **Languages** — by file extension of edited/written files
- **Response times** — gaps from user message → first assistant reply
- **Activity by hour** — message timestamps bucketed to UTC hours
- **Friction events** — tool errors, user corrections, steering interrupts
- **Informational interrupts** — tracked separately, NOT counted as friction

All paths and snippets are **scrubbed** before emission:
- Home directory and any `/Users/<name>/` prefix → `~` (not just the current user — CI runners too)
- Bare username → `<redacted>`
- API keys, tokens, Artifactory URLs, basic-auth URLs → `<redacted-*>`
- GitHub noreply emails (`12345+handle@users.noreply.github.com`) → `<redacted-github-email>` (these pair a public handle with a private numeric user ID)
- GitHub `/users/<numeric-id>` profile URLs → `<redacted-github-url>`
- Per-user private identity tokens (surname, numeric user IDs) → `<redacted>`

The public GitHub handle itself is **not** scrubbed — it's already on the repo's
public commits. What gets scrubbed is anything that links that handle to a
private identity: the surname, the numeric user ID, and the noreply email form
that pairs the two. This keeps a report shareable with NCode developers without
exposing the user behind the handle.

If you want to scrub additional private tokens beyond the structured patterns,
list them one per line in `~/.ncode/identity-redact.txt`:

```
Surname
12345678
```

The file is optional, user-local, and never packaged with the skill. It loads
at scan/resolve time and case-insensitively replaces each token with
`<redacted>`. Both `scan.py` and `resolve.py` apply it as the final redaction
pass, so evidence arrays used for internal matching stay intact while emitted
output stays scrubbed.

**Before sending a report to NCode devs:** run `/insights-context`, then
`grep -iE 'surname|noreply.github|numeric-id' /tmp/insights-context-*.html`
(substituting your own tokens). Zero matches = safe to share. If you find a
leak, add the token to `~/.ncode/identity-redact.txt` and regenerate.

### 4. How friction is classified

The scanner distinguishes three kinds of user-initiated friction:

| Type | Signal | Friction? |
|------|--------|-----------|
| Tool error | `is_error`, `Traceback`, `Error:`, `failed with code` | Yes |
| User correction | Text starting with `no`, `stop`, `wrong`, `don't`, `broken` | Yes |
| Steering interrupt | `[Request interrupted by user]` followed by a correction or no follow-up | Yes |
| Informational interrupt | `[Request interrupted by user]` followed by non-correction text (preference, context) | **No** |

The informational distinction is the key fix: when you interrupt to add a
rule, a preference, or a heads-up ("never do X", "also remember Y"), that's
collaboration, not friction. Only steering corrections and unexplained
mid-tool stops count.

### 5. How the resolver cross-references

`resolve.py` builds a ledger of resolved + environmental entries from:

1. **Memory files** — `feedback_*.md` and `project_*.md` in the project
   memory dir. Environmental entries (containing markers like "environmental",
   "not a code regression", "disk full") are flagged `is_environmental`.
2. **Git log** — commits matching `^(fix|hotfix|patch|repair|resolve)` in the
   project repo (last 30 days).

`render.py` then cross-references each friction topic against this ledger:

- **Match + friction before fix date** → RESOLVED (suppressed from At a Glance)
- **Match + friction after fix date** → REGRESSION (flagged in red alert section)
- **Match + environmental** → ENVIRONMENTAL (routed to a separate section)
- **No match** → OPEN (shown as current friction)

If status can't be determined, the item stays OPEN with a note rather than
guessing resolved.

### 6. Deliver

The render script opens the HTML file in the user's default browser and
prints the output path.

Print a one-line confirmation with:

- File path
- Sessions scanned
- Open friction count
- Resolved friction count (suppressed from At a Glance)
- Informational interrupts (excluded from friction)

## Constraints

- **Never report resolved friction as currently broken.** This is the entire
  point of this command. If you can't determine resolution status for an
  item, mark it OPEN with a note rather than guessing resolved.
- **Never include credentials, API keys, auth tokens, or internal Artifactory
  URLs** — even if they appear in session logs or memory files. The scanner
  redacts these automatically.
- **Never include the user's name or home directory** in the report. All
  paths are scrubbed to `~` and bare usernames to `<redacted>` before
  emission.
- **Never fabricate friction.** Every entry must trace to a concrete log
  entry. If sessions are quiet (no errors, no corrections, no steering
  interrupts), say so.
- **Time-box:** if scan + render takes more than ~2 minutes, drop to fewer
  sessions and emit partial results with a note.
- **Output is an HTML file on disk plus a one-line stdout confirmation.** Do
  not attempt to print the full HTML to the chat.
- **For `--json` mode:** skip rendering, print only the aggregated JSON from
  the scan + resolve steps.

## Self-update

If the bundled `/insights` source file path changes (e.g., NCode moves
`src/commands/insights.ts` somewhere else, or the CSS variable name changes
from `css` to something else), or if the session-log JSON schema shifts
(tool_use blocks move, error format changes, timestamps relocate), use
`AskUserQuestion` to confirm and then `Edit` the relevant bundled script
(`scan.py` / `render.py`) with a minimal targeted fix. Do not broaden the
scope beyond the stale fact.