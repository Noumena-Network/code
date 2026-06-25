# insights-context Scripts — Code Review

Thorough review of all Python files in
`skills/insights-context/scripts/` and the `insights-context.md` skill
definition. Each file was read in full; specific issues are reported with line
numbers and exact snippets.

## Overall Assessment

The skill is ambitious and well-documented, but the implementation has several
**correctness bugs in the friction classification logic** (the core feature), a
**sanitization inconsistency** between scripts that breaks `test_smoke.py`
defaults, multiple **subprocess calls without timeouts** that can hang
indefinitely, and a number of smaller redaction and rendering edge cases. The
friction classifier's branch ordering silently misclassifies long user
corrections as informational interrupts.

---

## 1. `scan.py`

### Bugs

**B1 — Long user corrections (>200 chars) are misclassified as informational
interrupts (HIGH)** — lines 449-479. The branch ordering is:

```python
short = len(txt) < 200
is_slash_or_long = bool(SLASH_OR_CMD_RE.match(txt)) or len(txt) > 600

if INTERRUPT_RE.search(txt): ...
elif is_slash_or_long:        # <-- fires for txt > 600 chars
    if pending_interrupt:
        informational_interrupts += 1
elif short and CORRECTION_RE.search(txt):   # <-- only checked when short
    friction.append({... "bucket": "user_correction" ...})
```

A correction like `"no stop, the path is wrong — " + 450 chars of detail` is
`> 600` chars, so it hits the `is_slash_or_long` branch (counted as
informational if a pending interrupt exists), and the `CORRECTION_RE` branch is
never reached. The `short and` guard also drops legitimate corrections that
happen to be 200-600 chars even without a pending interrupt — they fall through
to the `elif pending_interrupt` branch and are silently swallowed (no friction
recorded, no informational count incremented). Verified empirically.

**B2 — `SLASH_OR_CMD_RE` false-positives on `# ` comments and uppercase-starting
prose** — line 107:
`re.compile(r"^(\s*/|#\s*/|#\s*[A-Z]|\s*<)", re.I)`. The `#\s*[A-Z]` alternative
matches any line starting with `#` followed by an uppercase letter — e.g.
`"# Of issues to fix"` is treated as a slash command, suppressing
`task_prompt`/`last_user_prose` update and skipping the correction branch.
Verified: `"# of issues"` matches. The `re.I` flag is also pointless here
(already matches `[A-Z]` explicitly and lowercase via IGNORECASE is redundant
with the explicit pattern).

**B3 — Response times in `[0, 2]` seconds are silently dropped** — line 290:
`if 2 < net < 3600:`. A 1.5s or 2s response is excluded from `response_times`,
so the `response_time_buckets` "2-10s" bucket starts effectively at >2s. The
bucket label `"2-10s"` (line 589) is misleading — values exactly at 2.0s are
excluded (strict `<`). Fast responses vanish from the chart entirely.

**B4 — `task_prompt` only captured once per session, never refreshed for the
"first" message** — line 442:
`if not task_prompt and txt and not SLASH_OR_CMD_RE.match(txt) and len(txt) < 400:`.
`task_prompt` is set only on the *first* qualifying user message and never
updated. The comment and `last_user_prose` (line 447) were added to fix loop
attribution, but `task_prompt` is still used as the fallback in friction items
(lines 434, 471) and cycle detection (line 371). If the first user message is a
short greeting, all subsequent friction in that session attributes to the
greeting, not the real task.

**B5 — Cycle detection emits duplicate entries for the same X-Y-X-Y window** —
lines 361-373. The window check runs on *every* tool_use, and a 4-element window
`[X, Y, X, Y]` matches, appends to `agent_loops`, and then on the *next* tool
(if it's X again), the window `[Y, X, Y, X]` also matches and appends again. A
single 6-tool run `X Y X Y X Y` produces 3 loop entries.
`loop_total = len(agent_loops)` (line 637) over-counts by ~3×. No
de-duplication by `(session, ts, tool_pair)`.

**B6 — `pending_interrupt` with no follow-up at *session boundary* is flushed,
but interrupts followed by an assistant message (not user) are never classified**
— the interrupt classification only happens inside
`if role == "user" and isinstance(msg.get("content"), list)`. If an interrupt is
the last user message and is followed by an assistant message (e.g. a slash
command response), the `pending_interrupt` is only flushed at session end (line
509) as a steering friction — but if an assistant message intervenes, there's
no logic to clear `pending_interrupt` based on assistant content. This is
probably acceptable, but the classification is purely based on the *next user
message*, ignoring whether the assistant actually addressed the interrupt.

**B7 — `parallel_tool_calls` counter uses `tool_batch_count` reset logic that
misses parallel calls across content blocks** — line 277:
`tool_batch_count = 0` resets at the start of each assistant message, then
increments per `tool_use` block (line 312). Line 376:
`if tool_batch_count > 1: parallel_tool_calls += 1`. This counts
*sessions/messages* with parallel calls, not the number of parallel batches.
The variable name implies a count of parallel call *groups*, but it's actually
a count of *messages containing >1 tool call*. Misleading but not a crash.

### Security Issues

**S1 — `OTHER_USERS_RE` only scrubs `/Users/...`, missing `/home/...` and
`/root/...`** — line 158: `re.compile(r"/Users/[^/\s\"']+", re.I)`. On Linux
(the environment here, `/root`), home directories are under `/home/` or
`/root/`. The regex only catches macOS `/Users/` paths. A path like
`/home/alice/secrets` or `/root/.ssh/id_rsa` is *not* scrubbed by this pattern.
`HOME_RE` (line 153) catches the *current* user's home, but other users' homes
on Linux leak. The comment explicitly mentions CI runners, but Linux CI runners
use `/home/runner` or `/root`, not `/Users/runner`.

**S2 — Bare `USERNAME_RE` over-scrubs public GitHub handles, contradicting the
`.md` spec** — lines 154-155, 168-169. The skill doc (lines 156-160) explicitly
states: *"The public GitHub handle itself is **not** scrubbed — it's already on
the repo's public commits."* But `USERNAME_RE` replaces *every* occurrence of
the username string with `<redacted>`, including the bare public handle in
commit messages or prose. If a user's GitHub handle equals their local username
(common), the public handle is scrubbed, violating the documented behavior.
Verified: `"fixed by jane in PR #42"` → `"fixed by <redacted> in PR #42"`.

**S3 — Redaction patterns can be defeated by encoding/whitespace variations** —
the `password=secret` pattern (line 123) uses `\s*[:=]\s*\S+`. A value like
`password = "secret with spaces"` only redacts `"secret` (stops at whitespace).
JSON-encoded secrets with spaces or unicode quotes are partially leaked. Also,
`api_key` variants: `api[_-]?key` misses `apikey` (no separator), `API_KEY` is
covered by `re.I` but `ApiKey` (camelCase) is missed by the `[_-]?` separator
requirement.

**S4 — `redact()` applies `HOME_RE` substitution that can produce misleading
`~` in commit hashes** — if a home path is `/Users/a1b2c3d` (unlikely but
possible for short hex-like usernames), `HOME_RE.sub("~", ...)` could mangle a
commit hash that contains the home directory string. Low probability but the
substitution is unconditional on any match.

### Code Quality Issues

**Q1 — `to_scan` ternary is redundant** — line 23:
`to_scan = recent[:sessions] if len(recent) > sessions else recent`.
`recent[:sessions]` already returns `recent` if `len(recent) <= sessions`.
Simplify to `to_scan = recent[:sessions]`.

**Q2 — `message_hours` uses `.get()` on a `Counter` (unnecessary)** — line 238:
`message_hours[dt.hour] = message_hours.get(dt.hour, 0) + 1`. `Counter` returns
0 for missing keys, so `message_hours[dt.hour] += 1` suffices. Also inconsistent
with every other Counter usage in the file (which uses `+=` or
`.get(name, 0) + 1` on plain dicts).

**Q3 — `import sys as _sys` inside conditional (line 659)** — `sys` is already
imported at module top (line 10). The local `import sys as _sys` is
dead/unnecessary — just use `sys.stderr`.

**Q4 — Bare `except:` on line 231 swallows all exceptions including
`KeyboardInterrupt`** — `except: continue` on JSON parse failures. Should be
`except (json.JSONDecodeError, ValueError):` to avoid swallowing
`KeyboardInterrupt` / `SystemExit`.

**Q5 — `BUCKET_RULES` loaded at module level (line 581) but `bucket_of`
defined at line 522 references it before definition** — `bucket_of` (line 522)
references `BUCKET_RULES` (line 581). This works because `bucket_of` is only
*called* at line 585 (after `BUCKET_RULES` is defined), but it's fragile —
moving the call site above the assignment would crash. Forward-reference
coupling.

**Q6 — `_load_bucket_rules` re-imports `json as _json` (line 567)** — `json` is
already imported at module level (line 10). Redundant local import.

**Q7 — Friction `signal_keys` extraction duplicates effort** — lines 423-425:
`PATH_RE.findall`, `re.findall` for commits, `IDENTIFIER_RE.findall` all run on
every error snippet. For long error traces, this is O(n) per snippet with no
caching. Acceptable but the `sorted(set(...))` on each is wasteful.

**Q8 — `last_tool_name` and `consecutive_count` declared (lines 76-77) but
never used** — lines 76-77: `last_tool_name = None` and `consecutive_count = 0`
are module-level globals, reset per-session (lines 204-205), but *never read*
anywhere. Dead code left over from a refactor to the `burst_*` state machine.

### Performance Concerns

**P1 — `Path.stat()` called twice per file during sort** — lines 20-22:
`sorted(..., key=lambda p: p.stat().st_mtime, ...)` then
`recent = [f for f in files if f.stat().st_mtime >= cutoff]`. Each `stat()` is a
syscall; called once in sort key and once in the list comprehension. For
directories with many JSONL files, this doubles stat calls. Cache with a list
comprehension first.

**P2 — `recent_tool_window.pop(0)` is O(n)** — line 363:
`recent_tool_window.pop(0)` on a list is O(n) for the window size. With
`CYCLE_WINDOW = 6` this is negligible, but `collections.deque(maxlen=6)` would
be cleaner and O(1).

**P3 — `pending_tool_calls` dict rebuilt via comprehension on every assistant
message** — line 293-294:
`pending_tool_calls = {k: v for k, v in pending_tool_calls.items() if "resolved_dt" not in v}`.
For sessions with many pending tools, this rebuilds the dict on every assistant
turn. Mutation (`del pending_tool_calls[k]`) would be more efficient.

---

## 2. `resolve.py`

### Bugs

**B1 — Commit hash length inconsistency between `citation` and
`evidence_keywords`** — line 146:
`commits_in_text = re.findall(r"\b([0-9a-f]{7,8})\b", text)` (7-8 chars). Line
136: `re.finditer(r"\b([0-9a-f]{7,40})\b", text)` (7-40 chars). So a 9-40 char
commit hash appears in `evidence_keywords` but *not* in `commits_in_text`,
meaning the `citation` field won't reference it. A commit hash `abc12345a` (9
chars) is harvested as evidence but the citation says "no commits in text".
Verified empirically.

**B2 — Frontmatter regex fails on `\r\n` line endings** — line 110:
`re.match(r"^---\n(.*?)\n---\n(.*)$", content, re.DOTALL)`. If a memory file
uses CRLF (`\r\n`), the `\n` in the pattern won't match `\r\n`, so `fm_match`
is `None`, `fm = {}`, and `name`/`description` fall back to `path.stem`/`""`.
Silent data loss on Windows-authored memory files.

**B3 — `prose_paths` harvested twice with overlapping regexes** — lines 127 and
130-131:

```python
prose_paths = sorted({m.group().lower() for m in PATH_IN_PROSE_RE.finditer(text)})
...
for m in re.finditer(r"[\w./\-]+/[\w./\-]+\.\w+", text):
    keywords.add(m.group().lower())
```

`PATH_IN_PROSE_RE` (line 103) is `r"[\w./\-]+/[\w./\-]+\.\w+"` — identical
pattern to line 130. The first harvest goes into `prose_paths` (→
`signal_keys.paths`), the second into `keywords` (→ `evidence_keywords`).
Redundant work; the two should be unified.

**B4 — `fixed_at` uses "last ISO date in text" which may be the issue date, not
the fix date** — lines 150-154:
`all_dates = re.findall(r"\b(\d{4}-\d{2}-\d{2})\b", text)` then
`fixed_at = all_dates[-1]`. The comment claims memory files describe the problem
first then the fix. But if a file mentions a future date (e.g. a deadline)
after the fix date, `fixed_at` becomes that future date, and the renderer
classifies all friction as pre-fix (RESOLVED) even if it's actually a
regression. Fragile heuristic.

**B5 — `project_*` memory files with fix signals are treated as resolutions
even if they describe *unfixed* problems** — lines 158-166: a `project_*.md`
file containing `"fixed"` or `"resolved"` in *any* context (e.g. "this is NOT
fixed yet", "waiting for resolution") is treated as a resolution entry. The
word match is a substring check on the whole content:
`any(w in content.lower() for w in ["fixed", "resolved", ...])`.
`"not yet fixed"` contains `"fixed"` → treated as resolved. False positive.

### Security Issues

**S1 — Git `subprocess` calls have no timeout** — lines 184-188 (`git log`) and
217-221 (`git show`). If git prompts for credentials or hangs on a huge repo,
`subprocess.check_output` blocks forever. No `timeout=` parameter. The renderer
(render.py lines 383, 412) has the same issue. A hung git process exceeds the
`.md`'s "2 minute time-box" constraint silently.

**S2 — Git commands trust `repo_path` / `ncode_repo` from argv without
validation** — line 244: `repo_path = sys.argv[2]`. Passed directly to
`["git", "-C", repo, "log", ...]`. If `repo_path` contains shell
metacharacters, they're safe (no shell=True), but a malicious path could point
git at an arbitrary directory. Low risk for a local tool, but no path
validation.

**S3 — `evidence_keywords` redaction is applied per-keyword, not on the joined
string** — line 172: `sorted(redact(k) for k in keywords)[:30]`. Each keyword is
redacted individually. A token that spans two keywords (e.g. a URL split across
path and query) wouldn't be caught. Also, `redact()` on a single short keyword
like `"password"` (if it appears as a bare word) is fine, but a secret split as
`["pass", "word=secret"]` won't redact the value.

### Code Quality Issues

**Q1 — `parse_memory_file` swallows all exceptions at the call site (line 255)
but has no internal error handling** — lines 251-256:
`try: entry = parse_memory_file(mf); ... except Exception: pass`. If
`parse_memory_file` crashes (e.g. on a malformed file), the exception is
silently swallowed and the memory file is skipped with no log. The user has no
way to know why a memory file wasn't harvested.

**Q2 — Massive code duplication between `resolve.py` and `scan.py` redaction
logic** — lines 22-79 of `resolve.py` are a near-verbatim copy of scan.py lines
109-177. The `REDACT_PATTERNS`, `_IDENTITY_TOKENS` loading, `HOME_RE`,
`USERNAME_RE`, `OTHER_USERS_RE`, and `redact()` function are duplicated. If one
is updated and the other isn't, redaction diverges between scan and resolve
output. Should be a shared module.

**Q3 — `GENERIC` stopword set is hardcoded and not configurable** — lines 81-90:
a large set of stopwords. Not a bug, but inconsistent with the configurable
bucket rules (`~/.ncode/insights-buckets.json`). Keyword extraction quality
depends on this list with no way to extend it.

**Q4 — `why` and `how` extraction regexes assume Markdown `**bold:**` format**
— lines 120-123:
`re.search(r"\*\*Why:\*\*\s*(.+?)(?=\n\*\*|\Z)", body, re.DOTALL)`. If memory
files use a different format (e.g. `### Why` or plain `Why:`), extraction fails
silently and `why`/`how` are empty strings, reducing keyword yield.

### Performance Concerns

**P1 — `git show --name-only` called per commit (line 217)** — for each matching
fix commit, a separate `git show` subprocess is spawned. If a repo has 100 fix
commits in 30 days, that's 100 subprocess calls. Could be batched with
`git log --name-only` in a single call.

**P2 — `re.finditer` called 4+ times on the same `text`** — lines 127, 130,
132, 136, 138 — five separate regex passes over the same `text` string. Could
be consolidated into a single pass.

---

## 3. `render.py`

### Bugs

**B1 — `lstrip("~/")` strips a *character set*, not a prefix** — line 233:
`stripped = path.lstrip("~/")`. `str.lstrip` treats its argument as a set of
characters to strip, not a prefix. So `"~/foo/bar"` → `"foo/bar"` (correct by
accident), but `"~~/foo"` → `"foo"` (strips both `~`), and `"/~/foo"` →
`"foo"` (strips leading `/` and `~`). For paths that *don't* start with `~`
(the `else` branch handles those), this isn't reached, but for `~`-prefixed
paths the `parts[0]` derivation is wrong for edge cases. Should be
`path.removeprefix("~/")` (Python 3.9+) or
`path[2:] if path.startswith("~/") else path`.

**B2 — `whats_hindering` is referenced before assignment when `reg_count` is
truthy but `open_count` is falsy** — lines 273-283:

```python
if reg_count:
    whats_hindering = (...)   # set
if open_count:
    ...
    whats_hindering = ((whats_hindering if reg_count else "") + ...)  # references
if not open_count and not reg_count:
    whats_hindering = (...)   # set
```

The conditional `(whats_hindering if reg_count else "")` on line 281 is only
safe because Python's conditional expression short-circuits. But this is fragile
— if someone refactors the `if open_count:` to `elif:`, or if `reg_count` is
truthy-but-falsy (e.g. a list that becomes empty), it breaks. More importantly:
if `reg_count` is truthy and `open_count` is falsy, `whats_hindering` is set in
the first block but the `if not open_count and not reg_count` block is skipped
(correct), so it works. But the logic is convoluted and error-prone. Initialize
`whats_hindering = ""` at the top.

**B3 — `synthesize_glance` default top language is `"Swift"`** — line 253:
`top_lang = max(languages, key=languages.get) if languages else "Swift"`.
Hardcoded fallback to `"Swift"`. The skill is project-agnostic (per the `.md`),
but the default leaks an iOS-project assumption. Should be `"(unknown)"` or
`"(none)"`.

**B4 — Environmental items are displayed in BOTH the "OPEN" friction section AND
the environmental section** — lines 150-164 (in `cross_reference`): when
`matched.is_environmental` is true, the item is appended to *both*
`environmental_matched` AND `open_topics` (with a note). Then in rendering,
line 447 iterates `xref["open"]` and renders OPEN cards, and lines 477-491
render environmental cards. So environmental friction appears twice: once as an
OPEN card (with note "Keep OPEN") and once as an ENVIRONMENTAL card. The `.md`
says environmental should route to "a separate section" — double display
contradicts this.

**B5 — `derive_project_areas` uses `os.path.relpath` which raises `ValueError`
on different drives (Windows)** — line 238: `os.path.relpath(path, REPO_PATH)`.
On Windows, if `path` and `REPO_PATH` are on different drives, this raises
`ValueError`. Caught by `except (ValueError, TypeError)` on line 244, but only
for the `else` branch — the `if path.startswith("~")` branch has no such
protection and could fail if `path` is malformed.

**B6 — `hour_chart` parses keys with `int(k)` that can fail on non-numeric
keys** — line 406:
`{str(k): v for k, v in sorted([(int(k), v) for k, v in hours.items()])}`. If
`scan.get("message_hours", {})` contains non-numeric keys (e.g. from a
malformed scan JSON), `int(k)` raises `ValueError` and crashes `main()`. No
try/except. Scan.py always emits string-numeric keys, but `load_json` can load
arbitrary JSON.

**B7 — `recent_commits` count uses 30-day window but `wins_html` uses 7-day
window** — line 383: `git rev-list --since=30 days ago`. Line 413:
`git log --since=7 days ago`. The banner shows "X commits (30 days)" while
"Impressive Things You Did" shows 7-day commits. Not a bug per se, but the
inconsistent windows are confusing and undocumented in the output.

**B8 — `friction_card` for RESOLVED items passes `[]` for examples, hiding the
original friction** — line 450:
`friction_card(t["topic"], t["count"], [], "RESOLVED", t["citation"])`. Resolved
cards show *no examples* (empty list). The `.md` says resolved items should be
struck-through with a citation footer, but showing zero examples makes it
impossible to verify *which* friction was resolved. The `cross_reference`
function does have `pre_fix_items` available but discards them when building
`resolved_matched` (line 195-201 — no `examples` key is set).

### Security Issues

**S1 — CSS loaded from `/tmp/insights-context.css` is injected unescaped into
`<style>` tag** — line 1027: `<style>{css_block}</style>`.
`css_block = css` (from `load_css()`, line 46-50), which reads
`/tmp/insights-context.css` verbatim. `/tmp` is world-writable on multi-user
systems. A malicious or corrupted CSS file containing `</style><script>...`
would execute arbitrary JavaScript in the browser when the report is opened. The
`.md` workflow (line 121) writes this file via `awk` from `insights.ts`, but
any process on the machine can overwrite it. Should escape `</` → `<\/` or
validate the CSS.

**S2 — `html.escape()` is not applied to `loop_sessions` pair labels in all
cases** — line 923: `label = " ↔ ".join(parts) if len(parts) >= 2 else pair`.
If `pair` (from `loop_sessions` keys, which are concatenated tool names)
contains HTML-special characters (unlikely but possible with MCP tool names),
line 928 does `html.escape(label)` — OK, this one is escaped. But the
inconsistency between `label` (escaped) and raw `pair` usage elsewhere is worth
auditing.

**S3 — `out_path` is predictable and in world-writable `/tmp`** — line 1199:
`f"/tmp/insights-context-{ts}.html"`. The timestamp-based name is predictable; a
local attacker could pre-create a symlink at that path to overwrite an arbitrary
file when the script writes. Use `mkstemp` or a user-private directory.

### Code Quality Issues

**Q1 — `project_paths()` is called at module level (line 32), making testing
impossible** — `REPO_PATH, MEMORY_DIR = project_paths()` runs at import time,
reading `sys.argv`. Importing `render.py` as a module (e.g. for testing)
triggers argv parsing. Should be inside `main()` or a factory.

**Q2 — `main()` returns `out_path` but `if __name__` block assigns it and never
uses it** — line 1207: `path = main()`. The return value is discarded. Either
remove the `return` from `main()` or use `path` for something (e.g. open in
browser, as `compare.py` does).

**Q3 — `load_css()` returns `None` on missing file but comment says "embedded
stylesheet"** — line 50: `return None  # renderer uses fully embedded stylesheet
below`. But line 1018: `css_block = css if css else ""`. If `css` is `None`,
`css_block = ""`. The embedded stylesheet (lines 1028-1186) is *always* emitted
(it's in the f-string unconditionally). So the canonical CSS (if present) is
prepended via `css_block`, and the embedded CSS is *appended*. This means the
embedded CSS *overrides* canonical CSS rules of the same specificity (later in
the document wins). The comment on line 1017 says "if canonical CSS exists,
prepend it (keeps class hooks)" — but prepending means embedded wins on
conflicts, which may not be intended.

**Q4 — Massive inline HTML/CSS in a Python f-string (lines 1020-1196)** — the
entire HTML template with ~160 lines of CSS is embedded in a single f-string.
No templating engine, no separation of concerns. Any `{` in CSS must be escaped
as `{{`. Error-prone and hard to maintain. Should use a separate `.html`
template or `string.Template`.

**Q5 — `clean_tool_name` doesn't handle `mcp__` prefix consistently with
scan.py's detection** — line 589: `if t.startswith("mcp__")`. Scan.py (line 313)
checks `name.startswith("mcp__codex-memory-fabric__") or
name.startswith("mcp__codex-self-improvement__")` for memory calls. The
render-side cleaner is more generic (any `mcp__`), which is fine, but the split
heuristic `t.split("__")[-1]` produces `"readmemory"` for
`mcp__codex-memory-fabric__read_memory`, then
`.replace("_", " ").title()` → `"Readmemory"` (lost the underscore-to-space).
Inconsistent with the `op_counts` logic in memory_calls (line 891) which uses
`last.split("_")[-1]`.

**Q6 — `bar_chart` with `fixed_order` silently drops keys not in `data`** —
line 321:
`entries = [(k, data.get(k, 0)) for k in fixed_order if k in data and data[k]]`.
If a bucket has `0` count (`data[k]` is falsy), it's dropped. So the
response-time chart omits empty buckets, making the chart show non-contiguous
bars. The fixed_order intent was to show all buckets in order, but the
`if k in data and data[k]` filter defeats that.

### Performance Concerns

**P1 — `cross_reference` is O(topics × resolved) with no early termination on
weak signals** — lines 125-146: for each friction topic, iterates all resolved
entries. For weak-signal matching (shared symbols), it computes
`_resolved_signal(r)` (which calls `_norm_path` on every path) on *every*
resolved entry, even if a high-confidence match exists later. The `break` on
high-confidence matches (lines 134, 137) helps, but the `_resolved_signal(r)`
call is repeated for the same `r` across different topics. Should cache
`_resolved_signal` per `r`.

**P2 — `sorted([(int(k), v) for k, v in hours.items()])` creates intermediate
list** — line 406: creates a list of tuples just to sort. Could use
`sorted(hours.items(), key=lambda x: int(x[0]))`.

---

## 4. `compare.py`

### Bugs

**B1 — `delta()` returns `pct = None` when `b == 0`, but HTML formatting assumes
numeric** — line 113:
`pct_s = f" ({v['pct']:+.1f}%)" if v["pct"] is not None else ""`. This handles
`None` correctly for the HTML path. But in JSON mode (line 198), consumers get
`"pct": null` for "new" metrics, which is fine. No actual bug here, but the
`direction = "new" if a > 0 else "flat"` logic means a metric that went from 0
to 0 is "flat" with `pct=None`, which is inconsistent (flat should have
`pct=0`).

**B2 — `loops_html` direction is always "up" or "down", never "flat" or
"new"/"gone"** — lines 137, 143:
`arrow = _arrow("up" if lp["delta"]>0 else "down")`. Loop pairs with
`delta == 0` are filtered out (line 75), so this is correct, but the `_arrow` for
"new" (`""`) is never used for loops. A newly-appeared loop pair (prev=0, cur=5)
has `delta=5`, direction implicitly "up" via the `"up" if delta>0` check. Fine,
but the `direction` field in `loop_shift` (line 76) is never set — it's missing
entirely, unlike `topic_shift` (line 65) which has `direction`. Inconsistent
output schema.

**B3 — `out_path` default uses `int(time.time())` which is not human-readable**
— line 107: `f"/tmp/insights-delta-{int(time.time())}.html"`. Unlike
`render.py` (which uses `%Y%m%d-%H%M%S`), this produces an opaque Unix
timestamp. Minor inconsistency.

### Security Issues

**S1 — `compare.py` calls `subprocess.run(["open", out_path])` unconditionally
on macOS** — lines 191-195. On Linux, `open` is not the browser-opening command
(`xdg-open` is). `subprocess.run(["open", ...])` on Linux either fails (no such
command) or, worse, invokes `/usr/bin/open` which on some distros is a different
utility. The `check=False` and broad `except Exception` prevent crashes, but
this is platform-incorrect. Should detect platform.

**S2 — No input validation on JSON file paths** — lines 21-22:
`with open(sys.argv[1])`. If the file doesn't exist, uncaught `FileNotFoundError`
with a traceback. If it's not valid JSON, uncaught `json.JSONDecodeError`. No
friendly error message unlike `render.py`'s `load_json`.

### Code Quality Issues

**Q1 — `import html as _html` at line 90, after the JSON branch** — line 90:
`import html as _html` is inside the module but only needed for the HTML path.
Python's import caching makes this fine, but it's placed after the
`out = {...}` dict is built, making the code structure confusing. Move to top
with other imports.

**Q2 — `_color()` comment admits the coloring is wrong** — lines 98-104: the
comment says "up/down coloring is metric-aware... We don't know polarity
per-metric here, so we color by direction neutrally." This means friction *going
up* (bad) is colored red, but commits *going up* (good) is also colored red. The
function is known-wrong and shipped anyway. Should at least accept a
`good_when_up` flag.

**Q3 — `numeric` dict comprehension evaluates `delta()` 18 times** — line 47:
`{k: delta(k) for k in numeric_keys}`. Each `delta()` call does
`cur.get(key, 0)` and `prev.get(key, 0)`. Fine for 18 keys, but `delta` closes
over `cur`/`prev` — a closure-per-call pattern that's slightly less clear than
passing them as args.

### Performance Concerns

Minimal — `compare.py` is O(metrics + topics) and operates on already-aggregated
JSON. No significant performance concerns.

---

## 5. `test_smoke.py`

### Bugs

**B1 — Path sanitization in `MEMORY_DIR` default uses `lstrip("-")`, contradicting
`render.py` and the `.md`** — line 33:
`str(Path.cwd()).replace("/", "-").lstrip("-")`. This produces
`"root-code-..."` (no leading dash). But `render.py` line 26 uses
`cwd.replace("/", "-").rstrip("-")` → `"-root-code-..."` (leading dash kept). And
the `.md` (line 97) says `sanitized = "-" + cwd.replace("/", "-")` (leading
dash). So `test_smoke.py`'s default `MEMORY_DIR` points to
`~/.ncode/projects/root-code-.../memory` while `render.py` looks in
`~/.ncode/projects/-root-code-.../memory`. The paths don't match. With defaults,
the test's resolve step reads from the wrong directory. Verified empirically.

**B2 — The test is not self-contained: it requires `INSIGHTS_TEST_REPO` to contain
a fix commit touching `OnDemandVerificationStore.swift`** — lines 13-16, 100-107.
The assertion `has_ondemand` checks that `resolve.py`'s output contains
`OnDemandVerificationStore.swift` in `signal_keys.paths`. But `resolve.py` only
harvests paths from *memory files* and *git log commits*. The fixture
(sample.jsonl) contains the path, but `resolve.py` doesn't read session JSONL. So
unless the test repo's git log contains a fix commit touching that file, the
assertion fails. Running `python3 test_smoke.py` from the scripts directory
(where `REPO` defaults to `cwd` = the scripts dir, which is not a git repo) will
always fail assertion [2/4]. Not a true smoke test.

**B3 — `LEAK_TOKENS` includes `"users.noreply.github.com"` which is a substring
of the redacted output `"noreply.github.com"`** — line 42:
`LEAK_TOKENS = ["noreply.github.com", "users.noreply.github.com"]`. The redacted
email becomes `<redacted-github-email>`, which contains neither token. But
`"noreply.github.com"` as a leak token is overly broad — it would flag a
legitimate mention of the domain in prose (e.g. "see noreply.github.com docs")
as a leak even though only the `12345+handle@` form is sensitive.

**B4 — `html_path` is referenced on line 139 even if the render step failed** —
lines 116-130: `html_path` is set on line 116. If `r.returncode != 0` or
`html_path` is empty, the `else` branch (line 130) adds a failure but `html_path`
remains `""`. Then line 139: `print(f"HTML: {html_path}")` prints `HTML: `
(empty). Minor, but if `r.stdout` is empty and `returncode` is 0,
`html_path = "".splitlines()[-1]` on line 116 would `IndexError` on empty list.
Actually: `r.stdout.strip().splitlines()[-1] if r.stdout else ""` — the
`if r.stdout else ""` guard handles empty stdout, but `"".splitlines()` is `[]`,
and `[-1]` on `[]` raises `IndexError`. Wait: the guard is `if r.stdout` — if
`r.stdout` is `""` (falsy), `html_path = ""`. If `r.stdout` is non-empty but has
no newlines, `splitlines()` returns `[the_string]`, `[-1]` works. OK, no
IndexError. But if `r.stdout` contains only whitespace, `r.stdout` is truthy,
`strip()` gives `""`, `splitlines()` gives `[]`, `[-1]` → `IndexError`. Edge
case.

### Security Issues

**S1 — `tempfile.mktemp()` is insecure (race condition)** — lines 74-75:
`tempfile.mktemp(suffix=".json")`. The Python docs explicitly warn: *"THIS
FUNCTION IS UNSAFE AND SHOULD NOT BE USED."* A local attacker can predict the
filename and create a symlink at that path, causing the test to overwrite an
arbitrary file. Should use `tempfile.NamedTemporaryFile(delete=False,
suffix=".json")` or `tempfile.mkstemp()`.

### Code Quality Issues

**Q1 — `failures` list and `check()` function use module globals instead of a
class** — lines 50, 53-57. Functional style is fine for a test script, but the
global mutation makes it hard to reuse `check()` in a larger test harness.

**Q2 — Test exits with `sys.exit(1)` on scan failure (line 90), skipping the
summary** — lines 90, 110: `sys.exit(1)` on scan or resolve failure. This skips
the `[4/4] summary` block, so the user sees partial output without a final
pass/fail count.

---

## 6. Friction Classification Logic — Correctness Assessment

The `.md` spec (section 4) defines the classification:

| Type | Signal | Friction? |
|------|--------|-----------|
| Tool error | `is_error`, `Traceback`, `Error:`, `failed with code` | Yes |
| User correction | Text starting with `no`, `stop`, `wrong`, `don't`, `broken` | Yes |
| Steering interrupt | `[Request interrupted by user]` + correction or no follow-up | Yes |
| Informational interrupt | `[Request interrupted]` + non-correction | No |

**Implementation issues found:**

1. **The `CORRECTION_RE` is gated behind `short` (len < 200)** — corrections
   longer than 200 chars are never classified as friction. They either become
   informational (if `> 600` chars and a pending interrupt exists) or are
   silently dropped (200-600 chars, no pending interrupt). **Violates the spec**
   — the spec says "Text *starting with* `no`, `stop`..." with no length limit.

2. **The `is_slash_or_long` branch fires *before* `CORRECTION_RE`** — a long
   correction (601+ chars) starting with "no" is classified as `is_slash_or_long`
   → informational, not friction. **Wrong per spec.**

3. **The `SLASH_OR_CMD_RE` pattern `#\s*[A-Z]` false-positives on Markdown
   headings** — a user message `"# Fix the bug"` is treated as a slash command,
   so `task_prompt` and `last_user_prose` are not updated, and if it follows an
   interrupt, it's classified as informational. Not directly a friction
   misclassification, but it corrupts `task_prompt` attribution.

4. **The RESOLVED/REGRESSION/OPEN/ENVIRONMENTAL classification in `render.py`
   `cross_reference()` is mostly correct** (lines 165-209): pre-fix items →
   RESOLVED, post-fix → REGRESSION, undated → OPEN with note, environmental →
   ENVIRONMENTAL + OPEN. The undated→OPEN fallback correctly honors the `.md`
   invariant "if you can't determine resolution status, mark it OPEN with a note
   rather than guessing resolved." **However**, the environmental double-display
   (B4 in render.py) means environmental items appear in both the OPEN section
   and the environmental section, which partially violates "route to a separate
   section."

5. **The matcher's weak-signal path (shared symbols + bucket token overlap,
   lines 141-146) requires `>= 2` shared symbols AND bucket-label token overlap.**
   This is conservative (good — avoids false positives), but the `f_bucket_toks`
   comes from the *bucket label* (e.g. "build errors" → `{"build", "errors"}`),
   and `r_topic_toks` comes from the *resolved topic* (commit subject). A commit
   `"fix: resolve crash"` has tokens `{"resolve", "crash"}`, and a friction
   bucket `"build errors"` has `{"build", "errors"}` — no overlap, so no match
   even if they share code symbols. This is by design (corroboration required),
   but it means the matcher *under-matches* when bucket labels and commit
   subjects use different vocabulary, leaving legitimately-resolved friction as
   OPEN.

6. **`fixed_at` extraction in `resolve.py` (last ISO date in text) is
   unreliable** (B4 in resolve.py). If the "last date" is a future deadline or
   an unrelated reference, the REGRESSION vs RESOLVED split is wrong. Friction
   after the wrong date → false REGRESSION alert; friction before → false
   RESOLVED.

**Verdict:** The classification logic has the right *shape* but the branch
ordering in `scan.py` (the `short and` / `is_slash_or_long` gating) causes
silent misclassification of long corrections, which is the single most impactful
correctness bug. The cross-referencing in `render.py` is sound in principle but
undermined by unreliable `fixed_at` extraction and the environmental
double-display.

---

## Summary of Most Impactful Issues

| Severity | File | Issue |
|----------|------|-------|
| HIGH | scan.py:449-479 | Long corrections (>200 chars) misclassified as informational, not friction |
| HIGH | scan.py:158 | `OTHER_USERS_RE` misses `/home/` and `/root/` paths (Linux identity leak) |
| HIGH | scan.py:154-155 | `USERNAME_RE` scrubs public GitHub handle, contradicting `.md` spec |
| HIGH | render.py:1027 | CSS from `/tmp` injected unescaped into `<style>` — XSS via `/tmp` tampering |
| HIGH | test_smoke.py:33 | `lstrip("-")` vs `rstrip("-")` — sanitization mismatch, wrong `MEMORY_DIR` default |
| MED | scan.py:107 | `SLASH_OR_CMD_RE` false-positives on `# Uppercase` prose |
| MED | resolve.py:184,217 | Git subprocess calls have no timeout — can hang indefinitely |
| MED | render.py:233 | `lstrip("~/")` strips character set, not prefix |
| MED | render.py:150-164 | Environmental items displayed in both OPEN and ENVIRONMENTAL sections |
| MED | resolve.py:146 vs 136 | Commit hash length filter inconsistency (7-8 vs 7-40) |
| MED | scan.py:290 | Response times 0-2s silently dropped from buckets |
| LOW | scan.py:76-77 | `last_tool_name`, `consecutive_count` are dead code |
| LOW | scan.py:361-373 | Cycle detection over-counts loops (~3× per actual cycle) |
| LOW | compare.py:191 | `open` command is macOS-only; wrong on Linux |
| LOW | test_smoke.py:74 | `tempfile.mktemp()` is insecure (TOCTOU race) |
