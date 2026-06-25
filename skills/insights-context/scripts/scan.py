#!/usr/bin/env python3
"""insights-context — scan NCode session JSONLs into a friction + stats summary.

Usage: scan.py <project_session_dir> [days] [sessions]

Emits JSON on stdout. All snippet text is credential-redacted before emission.
Friction items are enriched with extracted file_paths + tool name so the
resolver can cross-reference by real signal, not just the bucket label.
"""
import json, sys, os, re, time
from pathlib import Path
from datetime import datetime, timezone
from collections import Counter, defaultdict

project = sys.argv[1] if len(sys.argv) > 1 else os.getcwd()
days = int(sys.argv[2]) if len(sys.argv) > 2 else 7
sessions = int(sys.argv[3]) if len(sys.argv) > 3 else 15
cutoff = time.time() - days * 86400

files = sorted(Path(project).glob("*.jsonl"),
               key=lambda p: p.stat().st_mtime, reverse=True)
recent = [f for f in files if f.stat().st_mtime >= cutoff]
to_scan = recent[:sessions]

tool_counts = Counter()
languages = Counter()
files_modified = set()
file_edit_counts = Counter()
friction = []
response_times = []
message_hours = Counter()
input_tokens = 0
output_tokens = 0
cache_creation_tokens = 0
cache_read_tokens = 0
# Honesty: total_prompt_processed is the *actual* prompt volume the model
# re-processed across turns (input + cache_read + cache_creation summed per
# turn, then across turns). Compared with input_tokens alone it separates
# "tokens billed at the input rate" from "tokens the model actually reasoned
# over" — which on caching-enabled backends differ materially, and on no-cache
# backends (GLM) is identical, so the inflation showing in billed input_tokens
# (every turn re-bills the stable prefix) is now visible as a delta.
total_prompt_processed = 0
# High-water mark of conversation size in any single turn. Without caching
# this grows monotonically as the conversation lengthens; the inflation in
# `input_tokens` (the billed sum) is roughly N * unique_prompt_max for N turns
# — once caching is enabled, billed approaches unique_prompt_max per turn but
# processed_prompt_total is the denominator we want for "how big was my
# session really".
unique_prompt_max = 0
summary_messages_count = 0
summary_overhead_tokens_est = 0
git_commits = 0
git_pushes = 0
user_interruptions = 0
informational_interrupts = 0
# Backend detection: True if ANY usage block in the scan window carries
# cache_creation_input_tokens or cache_read_input_tokens keys. On no-cache
# backends (GLM) these keys are absent everywhere, so the Token Economics
# card renders a backend-aware message instead of "enable prompt caching" advice.
cache_tiers_present = False
sessions_seen = set()
tool_success = Counter()
tool_failure = Counter()
compaction_events = 0
parallel_tool_calls = 0
memory_calls = Counter()
per_session = []
tool_retries = Counter()
# Retry bursts: only same-tool runs of 3+ calls where at least one middle call
# returned is_error. Bare adjacency (Read x50 of different files) is NOT a
# retry — those are distinct operations. Each burst carries tool, count,
# session, ts so the renderer can list concrete stuck moments.
retry_bursts = []
unknown_tool_blocks = 0
# Cycle detection: keep a sliding window of recent tool names per session.
# When the last 4+ tools alternate between exactly two names (X Y X Y), the
# agent is stuck in a two-tool loop — the most expensive failure mode
# (10-turn Edit/Bash cycles eat context for nothing). The 3-in-a-row retry
# detector above stays for single-tool retries; this catches the harder case.
recent_tool_window = []  # [(name, ts), ...]
CYCLE_WINDOW = 6
agent_loops = []
loop_sessions = Counter()

def _cache_tiers(usage):
  # Anthropic-shaped usage blocks carry cache tiers as separate fields. GLM
  # and other no-cache backends omit them; absent keys read as 0.
  if not isinstance(usage, dict):
    return 0, 0
  cc = usage.get("cache_creation_input_tokens") or 0
  cr = usage.get("cache_read_input_tokens") or 0
  return cc, cr

EXT = {".ts":"TypeScript",".tsx":"TypeScript",".js":"JavaScript",".jsx":"JavaScript",
       ".swift":"Swift",".py":"Python",".rs":"Rust",".go":"Go",".rb":"Ruby",
       ".m":"Objective-C",".mm":"Objective-C++",".md":"Markdown",".html":"HTML",
       ".css":"CSS",".json":"JSON",".yaml":"YAML",".yml":"YAML",".sh":"Shell",
       ".toml":"TOML",".sql":"SQL"}

CORRECTION_RE = re.compile(
    r"^\s*(no|stop|don'?t|wrong|not right|try again|that'?s broken|this is broken|i give up|nope|nah)\b",
    re.I)
INTERRUPT_RE = re.compile(r"^\[Request interrupted", re.I)
# Match slash commands (start with /), HTML-ish tags (<...>), or markdown
# heading+slash like "# /foo". The "#\s*[A-Z]" alternative was removed — it
# false-positived on legitimate prose like "# Of issues to fix".
SLASH_OR_CMD_RE = re.compile(r"^(\s*/|#\s*/|\s*<)")

# --- Redaction --------------------------------------------------------------
# Credentials + identity scrubbing. Every path and snippet emitted by this
# scanner is passed through redact() so no username, home dir, or secret
# ever reaches the report.
HOME = os.path.expanduser("~")
USERNAME = os.path.basename(HOME) if HOME and HOME != "/" else ""

REDACT_PATTERNS = [
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "<redacted-api-key>"),
    (re.compile(r"AKIA[A-Z0-9]{16}"), "<redacted-aws-key>"),
    (re.compile(r"Bearer\s+[A-Za-z0-9._\-]+"), "Bearer <redacted>"),
    (re.compile(r"https?://[^\s]*artifactory[^\s]*", re.I), "<redacted-artifactory-url>"),
    (re.compile(r"https?://[^\s/@:]+:[^\s/@]+@[^\s]+"), "<redacted-basic-auth-url>"),
    (re.compile(r"xox[baprs]-[A-Za-z0-9\-]+", re.I), "<redacted-slack-token>"),
    (re.compile(r"(?i)(password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S+"),
     r"\1=<redacted>"),
    # Bare-token form in tracebacks / error strings: an identifier keyword
    # followed by whitespace and a long opaque value (no =/: separator).
    # Catches `ValueError: invalid api_key abc123def456` that the =/: form above
    # misses. Requires a 12+ char alnum value so ordinary prose doesn't match.
    (re.compile(r"(?i)\b(api[_-]?key|api[_-]?secret|access[_-]?token|"
                 r"auth[_-]?token|secret[_-]?key)\s+([A-Za-z0-9_\-]{12,})"),
     r"\1=<redacted>"),
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"), "<redacted-github-token>"),
    # GitHub identity: the noreply email form (numeric-id+handle@users.noreply.github.com)
    # links the public handle to a private numeric user ID and appears in git config
    # when commits are authored via the GitHub web flow. Redact the whole address so
    # neither the numeric ID nor the handle+domain pairing leaks in --json or HTML.
    (re.compile(r"\b\d+\+[\w-]+@users\.noreply\.github\.com\b", re.I),
     "<redacted-github-email>"),
    # /users/<numeric-id> profile URLs leak the same numeric ID.
    (re.compile(r"https?://github\.com/users/\d+", re.I),
     "<redacted-github-url>"),
]

# Optional per-user identity tokens (surname, handles, IDs the user wants scrubbed
# beyond the structured patterns above). One token per line. Loaded from
# ~/.ncode/identity-redact.txt if present; absent file = no-op. Keeping these out of
# the script source means the script itself can be public without leaking the
# very identity tokens it's meant to scrub.
_IDENTITY_TOKENS = []
_id_path = os.path.expanduser("~/.ncode/identity-redact.txt")
try:
    if os.path.isfile(_id_path):
        with open(_id_path) as _f:
            for _line in _f:
                _t = _line.strip()
                if _t and len(_t) >= 3:
                    _IDENTITY_TOKENS.append(re.compile(re.escape(_t), re.I))
except Exception:
    pass
HOME_RE = re.compile(re.escape(HOME), re.I) if HOME else None
USERNAME_RE = (re.compile(re.escape(USERNAME), re.I)
               if USERNAME and len(USERNAME) > 2 else None)
# Scrub any /Users/<name>/ path — not just the current user's home.
# CI paths like /Users/runner/work/... also leak identity and machine details.
# Also cover Linux home directories (/home/<name>, /root) so Linux CI runners
# and dev boxes don't leak identity either. /root is included unconditionally
# because it's the root user's home and is never a public path.
OTHER_USERS_RE = re.compile(r"/(?:Users|home)/[^/\s\"']+", re.I)
ROOT_HOME_RE = re.compile(r"/root(?=[/\s\"']|$)")

def redact(text):
    if not text:
        return text
    for pat, repl in REDACT_PATTERNS:
        text = pat.sub(repl, text)
    # Scrub home directory and bare username so neither appears in the report
    if HOME_RE:
        text = HOME_RE.sub("~", text)
    if USERNAME_RE:
        text = USERNAME_RE.sub("<redacted>", text)
    # Scrub any other /Users/<name> prefix (CI runners, other accounts)
    text = OTHER_USERS_RE.sub("~", text)
    # Scrub /root paths (root user's home, never public)
    text = ROOT_HOME_RE.sub("~", text)
    # Per-user identity tokens (surname, handles, IDs) loaded from
    # ~/.ncode/identity-redact.txt. Applied last so it sees the structured
    # redactions above; tokens are case-insensitive whole-substring matches.
    for pat in _IDENTITY_TOKENS:
        text = pat.sub("<redacted>", text)
    return text

PATH_RE = re.compile(
    r"(?:^|[\s'\"])([\w./][\w.-/]*?[\w-]+\.[A-Za-z]{1,6})(?=[\s'\":;(),]|$)"
)
IDENTIFIER_RE = re.compile(r"\b([A-Z][a-zA-Z0-9]{4,40})\b")

def parse_ts(s):
    if not s: return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        return None
    # Normalize to naive UTC so aware and naive timestamps are always
    # comparable via subtraction. Mixed-tz arithmetic raises TypeError on
    # Python 3.11+ and would abort the whole scan on a single aware timestamp
    # in an otherwise-naive stream.
    if d.tzinfo is not None:
        d = d.astimezone(timezone.utc).replace(tzinfo=None)
    return d

for f in to_scan:
    sessions_seen.add(f.name)
    pending_tool_calls = {}
    pending_interrupt = None
    task_prompt = ""
    sess_tokens_in = 0
    sess_tokens_out = 0
    sess_msg_count = 0
    sess_tool_count = 0
    sess_first_dt = None
    sess_last_dt = None
    tool_batch_count = 0
    # Reset per-session state for cycle/retry detection so tool patterns in
    # session N don't carry into session N+1.
    recent_tool_window = []
    last_loop_sig = None  # dedup key for consecutive cycle-window matches
    # Retry-burst state: burst_tool stays set across turns within a session
    # and closes when a different tool (or a different Read/Bash target) appears.
    # burst_has_error is set from the tool_result handler when a result for the
    # current burst_tool returns is_error — bursts without an error aren't retries.
    burst_tool = None
    burst_count = 0
    burst_has_error = False
    burst_first_ts = None
    burst_last_target = ""
    # last_user_prose: the most recent non-slash, non-interrupt user message
    # text — used as the loop's task_prompt so X-Y cycles attribute to the real
    # ask, not to an intervening interrupt marker.
    last_user_prose = ""
    # Active vs idle span: bucket inter-message gaps at 15min. Overnight resume
    # gaps (>15m) shouldn't inflate "session duration" into 30h figures.
    sess_prev_msg_dt = None
    sess_active_span = 0.0
    sess_idle_span = 0.0
    # For response-time honesty: subtract each tool_result's wall-clock span
    # (issued_at → resolved_at) from the user→assistant gap so multi-tool
    # turns waiting on I/O don't inflate "model reasoning latency".
    last_user_msg_ts = None
    with f.open() as fh:
      for line in fh:
        try: rec = json.loads(line)
        except (json.JSONDecodeError, ValueError): continue
        msg = rec.get("message", {})
        if not isinstance(msg, dict): continue
        role = msg.get("role")
        ts_str = rec.get("timestamp","") or ""
        dt = parse_ts(ts_str)
        if dt:
            message_hours[dt.hour] = message_hours.get(dt.hour, 0) + 1
            if sess_first_dt is None:
                sess_first_dt = dt
            sess_last_dt = dt
            # Active vs idle span: bucket inter-message gaps at 15min. Overnight
            # resume gaps (>15m) shouldn't inflate "session duration" into 30h
            # figures — only the active portion represents real working time.
            if sess_prev_msg_dt is not None:
                _gap = (dt - sess_prev_msg_dt).total_seconds()
                if _gap <= 15 * 60:
                    sess_active_span += _gap
                else:
                    sess_idle_span += _gap
            sess_prev_msg_dt = dt

        if role == "assistant" and isinstance(msg.get("content"), list):
            usage = msg.get("usage", {}) or {}
            _cc, _cr = _cache_tiers(usage)
            # Backend detection: flag cache_tiers_present so the Token Economics
            # card can render a backend-aware message instead of "enable caching"
            # advice on no-cache backends where the keys don't exist at all.
            if ("cache_creation_input_tokens" in usage
                    or "cache_read_input_tokens" in usage):
                cache_tiers_present = True
            input_tokens += usage.get("input_tokens", 0) or 0
            output_tokens += usage.get("output_tokens", 0) or 0
            cache_creation_tokens += _cc
            cache_read_tokens += _cr
            # Actual prompt volume the model re-processed this turn. Tracked as a
            # cumulative sum so total_prompt_processed (= sum over turns of
            # input + cache_creation + cache_read) surfaces the real reasoning
            # volume, not just the billed-input rate.
            _turn_total = (usage.get("input_tokens", 0) or 0) + _cc + _cr
            total_prompt_processed += _turn_total
            if _turn_total > unique_prompt_max:
                unique_prompt_max = _turn_total
            sess_tokens_in += usage.get("input_tokens", 0) or 0
            sess_tokens_out += usage.get("output_tokens", 0) or 0
            sess_msg_count += 1
            tool_batch_count = 0
            if last_user_msg_ts and dt:
                gap = (dt - last_user_msg_ts).total_seconds()
                # Subtract tool wall-clock from the user→assistant gap so
                # multi-tool turns waiting on I/O don't inflate "model
                # thinking" latency. Datetimes are cached on the pending
                # entry at issue/resolve time, so no re-parse per turn.
                tool_span = 0.0
                for info in pending_tool_calls.values():
                    i, r = info.get("_dt"), info.get("resolved_dt")
                    if i and r:
                        tool_span += (r - i).total_seconds()
                net = max(0.0, gap - tool_span)
                if 0 <= net < 3600:
                    response_times.append(net)
                last_user_msg_ts = None
                pending_tool_calls = {k: v for k, v in pending_tool_calls.items()
                                      if "resolved_dt" not in v}
            for block in msg["content"]:
                if not isinstance(block, dict): continue
                btype = block.get("type")
                if btype == "tool_use":
                    # Tool name extraction with fallback. Canonical Anthropic
                    # shape: content[*].name. Some backends route it through
                    # input.name or a function wrapper. Fall back before "?"
                    # so the Tool Effectiveness chart doesn't show an unknown
                    # tool row that's really a parse miss.
                    name = (block.get("name")
                            or (block.get("input") or {}).get("name")
                            or (block.get("function") or {}).get("name")
                            or "?")
                    if name == "?":
                        unknown_tool_blocks += 1
                    tool_counts[name] = tool_counts.get(name, 0) + 1
                    sess_tool_count += 1
                    tool_batch_count += 1
                    if name.startswith("mcp__codex-memory-fabric__") or name.startswith("mcp__codex-self-improvement__"):
                        memory_calls[name] = memory_calls.get(name, 0) + 1
                    if name == "Bash":
                        cmd = block.get("input",{}).get("command","") or ""
                        if "git commit" in cmd: git_commits += 1
                        if "git push" in cmd: git_pushes += 1
                    if name in ("Edit","Write","MultiEdit"):
                        path = block.get("input",{}).get("file_path","") or ""
                        if path:
                            path = redact(path)
                            files_modified.add(path)
                            file_edit_counts[path] = file_edit_counts.get(path, 0) + 1
                            ext = os.path.splitext(path)[1].lower()
                            lang = EXT.get(ext)
                            if lang: languages[lang] = languages.get(lang, 0) + 1
                    # Retry-burst detection: emit only when the same tool is
                    # called 3+ times AND at least one call in the run errored.
                    # Bare adjacency (Read x50 of different files) is NOT a
                    # retry. Bypass Read/Bash/Grep/Glob when the target differs.
                    burst_target = ""
                    if name in ("Read","Bash","Grep","Glob"):
                        burst_target = (block.get("input",{}).get("file_path")
                                        or block.get("input",{}).get("command")
                                        or block.get("input",{}).get("pattern")
                                        or "")[:80]
                    same_run = (name == burst_tool
                                and (not burst_target or burst_target == burst_last_target))
                    if same_run:
                        burst_count += 1
                    else:
                        # Close previous burst — emit if it was a real retry run.
                        if burst_tool and burst_count >= 3 and burst_has_error:
                            retry_bursts.append({
                                "tool": burst_tool, "count": burst_count,
                                "session": f.name,
                                "ts": burst_first_ts or ts_str,
                            })
                            tool_retries[burst_tool] = tool_retries.get(burst_tool, 0) + 1
                        burst_tool = name
                        burst_count = 1
                        burst_has_error = False
                        burst_first_ts = ts_str
                        burst_last_target = burst_target
                    # Cycle detection: X Y X Y alternation. task_prompt now
                    # sourced from last_user_prose (the real preceding user
                    # ask) rather than the first user message — so loops
                    # attribute to what the user actually requested, not to
                    # an intervening slash command or interrupt marker.
                    recent_tool_window.append(name)
                    if len(recent_tool_window) > CYCLE_WINDOW:
                        recent_tool_window.pop(0)
                    if len(recent_tool_window) >= 4:
                        w = recent_tool_window[-4:]
                        if w[0] == w[2] and w[1] == w[3] and w[0] != w[1]:
                            # Dedup: a single 6-tool cycle X Y X Y X Y produces
                            # 3 overlapping matches. Only append when the window
                            # has shifted past the previous match's 4-tool span.
                            sig = (w[0], w[1])
                            if sig != last_loop_sig:
                                agent_loops.append({
                                    "ts": ts_str,
                                    "tools": [w[0], w[1]],
                                    "session": f.name,
                                    "task_prompt": (last_user_prose or task_prompt)[:120],
                                })
                                loop_sessions[f"{w[0]}{w[1]}"] += 1
                            last_loop_sig = sig
                        else:
                            last_loop_sig = None
                    tid = block.get("id")
                    pending_tool_calls[tid] = {"name": name, "ts": ts_str, "_dt": dt}
            if tool_batch_count > 1:
                parallel_tool_calls += 1

        if role in ("system", "summary") or (role == "user" and isinstance(msg.get("content"), str)):
            content_str = msg.get("content", "") if isinstance(msg.get("content"), str) else ""
            if role == "summary":
                # A summary (=compact) message — count + rough token estimate
                # (~4 chars/token average across UTF-8 English). This is the
                # overhead the model will re-process on every subsequent turn
                # in place of the original conversation, so it's a real cost
                # worth surfacing in Token Economics on top of the inflated
                # input_tokens sum.
                summary_messages_count += 1
                summary_overhead_tokens_est += max(1, len(content_str) // 4)
            if "compact" in content_str.lower() or "compressed" in content_str.lower():
                compaction_events += 1

        if role == "user" and isinstance(msg.get("content"), list):
            for block in msg["content"]:
                if not isinstance(block, dict): continue
                btype = block.get("type")
                if btype == "tool_result":
                    tid = block.get("tool_use_id","")
                    # Store the resolved datetime so the assistant-block
                    # response-time calculation can subtract this tool's
                    # wall-clock from the user→assistant gap.
                    if tid and tid in pending_tool_calls:
                        pending_tool_calls[tid]["resolved_dt"] = dt
                    call_info = pending_tool_calls.get(tid, {})
                    tool = call_info.get("name", "?")
                    content = block.get("content","")
                    if isinstance(content, list):
                        content = " ".join(
                            (c.get("text","") if isinstance(c, dict) else str(c))
                            for c in content
                        )
                    content_str = str(content) if content else ""
                    # Avoid matching "no error", "error: none", "0 errors" that
                    # appear in successful tool results. Word-bound the "error:"
                    # marker and strip the negations first.
                    content_lower = content_str.lower()
                    negated = bool(re.search(
                        r"\b(no|0|zero|none)\s+errors?\b|^error:\s*none\b",
                        content_lower, re.MULTILINE))
                    err_indicator = (
                        "traceback" in content_lower
                        or "failed with code" in content_lower
                        or bool(re.search(r"(?m)^\s*error:", content_str))
                        or bool(re.search(r"\berror:\s*\S", content_str))
                    )
                    is_err = (block.get("is_error")
                              or (err_indicator and not negated))
                    if is_err:
                        tool_failure[tool] = tool_failure.get(tool, 0) + 1
                        if tool == burst_tool:
                            burst_has_error = True
                        snippet = redact(content_str[:240])
                        file_paths = sorted({redact(m.strip(" '\"")) for m in PATH_RE.findall(content_str)})[:6]
                        _commits = sorted({redact(c) for c in re.findall(r"\b[0-9a-f]{7,40}\b", content_str)})[:12]
                        _symbols = sorted({redact(s) for s in IDENTIFIER_RE.findall(content_str)})[:12]
                        friction.append({
                            "ts": ts_str,
                            "bucket": "tool_error",
                            "tool": tool,
                            "snippet": snippet,
                            "session": f.name,
                            "file_paths": file_paths,
                            "signal_keys": {"paths": file_paths, "commits": _commits, "symbols": _symbols},
                            "task_prompt": (last_user_prose or task_prompt)[:120],
                        })
                    else:
                        tool_success[tool] = tool_success.get(tool, 0) + 1
                    continue
                elif btype != "text":
                    continue
                txt = block.get("text","") or ""
                if not task_prompt and txt and not SLASH_OR_CMD_RE.match(txt) and len(txt) < 400:
                    task_prompt = redact(txt.strip()[:120])
                # Track the most recent real user prose for loop attribution —
                # excludes slash commands and interrupt markers so loops attribute
                # to the actual ask, not to an intervening command.
                if txt and not SLASH_OR_CMD_RE.match(txt) and not INTERRUPT_RE.search(txt) and len(txt) < 400:
                    last_user_prose = redact(txt.strip()[:120])
                short = len(txt) < 200
                is_slash_or_long = bool(SLASH_OR_CMD_RE.match(txt)) or len(txt) > 600

                if INTERRUPT_RE.search(txt):
                    # Defer — classify based on the next user message. If the
                    # follow-up is a correction, it's steering friction. If it's
                    # context/preference/instruction, the interrupt was informational
                    # (not friction). No follow-up = steering, no explanation.
                    pending_interrupt = {
                        "ts": ts_str, "session": f.name,
                        "task_prompt": (last_user_prose or task_prompt)[:120],
                    }
                # Corrections must be checked before the slash/long branch so a
                # long correction (>600 chars, or a slash-prefixed one) is not
                # silently swallowed as an informational interrupt. The spec says
                # "text starting with no/stop/wrong..." with no length limit.
                elif CORRECTION_RE.search(txt) and not SLASH_OR_CMD_RE.match(txt):
                    friction.append({
                        "ts": ts_str, "bucket": "user_correction",
                        "tool": "", "snippet": redact(txt[:200]), "session": f.name,
                        "file_paths": [],
                        "signal_keys": {"paths": [], "commits": [], "symbols": []},
                        "task_prompt": (last_user_prose or task_prompt)[:120],
                    })
                    user_interruptions += 1
                    pending_interrupt = None
                elif is_slash_or_long:
                    if pending_interrupt:
                        informational_interrupts += 1
                        pending_interrupt = None
                elif pending_interrupt:
                    # Follow-up after an interrupt that isn't a correction —
                    # the user is adding context or a preference, not steering.
                    informational_interrupts += 1
                    pending_interrupt = None
                if dt:
                    last_user_msg_ts = dt
                break
    # End of session: per-session rollup before the interrupt flush.
    # Close any open retry burst at session boundary.
    if burst_tool and burst_count >= 3 and burst_has_error:
        retry_bursts.append({
            "tool": burst_tool, "count": burst_count,
            "session": f.name,
            "ts": burst_first_ts or "",
        })
        tool_retries[burst_tool] = tool_retries.get(burst_tool, 0) + 1
    burst_tool = None
    burst_count = 0
    burst_has_error = False
    sess_duration = 0
    if sess_first_dt and sess_last_dt:
        sess_duration = (sess_last_dt - sess_first_dt).total_seconds()
    per_session.append({
        "name": f.name,
        "duration_sec": round(sess_duration),
        "active_span_sec": round(sess_active_span),
        "idle_span_sec": round(sess_idle_span),
        "tokens_in": sess_tokens_in,
        "tokens_out": sess_tokens_out,
        "messages": sess_msg_count,
        "tools": sess_tool_count,
    })
    # End of session: interrupt with no follow-up = steering friction
    if pending_interrupt:
        friction.append({
            "ts": pending_interrupt["ts"], "bucket": "user_interrupt",
            "tool": "",
            "snippet": "[Request interrupted by user — no follow-up]",
            "session": pending_interrupt["session"],
            "file_paths": [],
            "signal_keys": {"paths": [], "commits": [], "symbols": []},
            "task_prompt": pending_interrupt["task_prompt"],
        })
        user_interruptions += 1
        pending_interrupt = None

def bucket_of(item):
    bucket = item.get("bucket", "")
    s = (item.get("snippet","") + " " + item.get("tool","") + " "
         + " ".join(item.get("file_paths", []))).lower()
    for rule in BUCKET_RULES:
        # An item matches a bucket rule when ANY keyword/tool from the rule
        # appears in the item's signal text. Rules run in declared order;
        # first match wins (the legacy order is preserved via BUILTIN_BUCKET_RULES).
        sigs = [kw.lower() for kw in rule.get("keywords", [])]
        if any(sig and sig in s for sig in sigs):
            return rule["label"]
    if bucket == "user_interrupt":
        return "User interrupted agent"
    if bucket == "user_correction":
        return "User corrections"
    return "other"

# Built-in bucket rules — kept small and project-agnostic. The original list
# (~15 patterns keyed off one team's bug history) was not portable; users
# hitting project-specific friction can drop a JSON file at
# ~/.ncode/insights-buckets.json with the same shape:
#   [{"label": "my thing", "keywords": ["foo", "bar"]}, ...]
# Rules from the file PREPEND to this list so user rules win first match.
BUILTIN_BUCKET_RULES = [
    {"label": "build errors", "keywords": ["build", "compile", "tsc"]},
    {"label": "test failures", "keywords": ["assertion", "fail"]},
    {"label": "signing/sandbox", "keywords": ["signing", "entitlement", "codesign", "sandbox"]},
    {"label": "verification/cancellation", "keywords": ["cancel", "verification", "ondemand"]},
    {"label": "permission denials", "keywords": ["permission", "denied"]},
    {"label": "filesystem timeouts", "keywords": ["operation timed out", "timed out", "operation not permitted"]},
    {"label": "trash/filemanager", "keywords": ["trash", "filemanager"]},
    {"label": "ui hang/spinner", "keywords": ["spinner", "hang", "stuck", "freeze"]},
    {"label": "git workflow", "keywords": ["merge", "conflict", "push", "reject"]},
    {"label": "formatter", "keywords": ["format"]},
    {"label": "type errors", "keywords": ["type", "error"]},
]

def _load_bucket_rules():
    """Load user overrides from ~/.ncode/insights-buckets.json, prepend to
    built-in rules so user rules take first-match precedence. Bad files
    fall back to builtins; we never crash on a malformed user config."""
    rules = list(BUILTIN_BUCKET_RULES)
    path = os.path.expanduser("~/.ncode/insights-buckets.json")
    try:
        if os.path.isfile(path):
            import json as _json
            with open(path) as f:
                user_rules = _json.load(f)
            if isinstance(user_rules, list):
                # Validate shape before prepending.
                validated = [r for r in user_rules
                             if isinstance(r, dict)
                             and isinstance(r.get("label"), str)
                             and isinstance(r.get("keywords"), list)]
                rules = validated + rules
    except Exception:
        pass
    return rules

BUCKET_RULES = _load_bucket_rules()

by_topic = defaultdict(list)
for it in friction:
    it["label"] = bucket_of(it)
    by_topic[it["label"]].append(it)

# Response-time buckets
rbuckets = {"0-10s":0,"10-30s":0,"30s-1m":0,"1-2m":0,"2-5m":0,"5-15m":0,">15m":0}
for t in response_times:
    if t < 10: rbuckets["0-10s"] += 1
    elif t < 30: rbuckets["10-30s"] += 1
    elif t < 60: rbuckets["30s-1m"] += 1
    elif t < 120: rbuckets["1-2m"] += 1
    elif t < 300: rbuckets["2-5m"] += 1
    elif t < 900: rbuckets["5-15m"] += 1
    else: rbuckets[">15m"] += 1

out = {
    "scan_window_days": days,
    "sessions_requested": sessions,
    "sessions_in_time_window": len(recent),
    "sessions_scanned": len(to_scan),
    "session_names": sorted(sessions_seen),
    "tool_counts": dict(tool_counts.most_common(15)),
    "languages": dict(languages.most_common(8)),
    "files_modified_count": len(files_modified),
    "files_modified": sorted(files_modified)[:80],
    "input_tokens": input_tokens,
    "output_tokens": output_tokens,
    "cache_creation_tokens": cache_creation_tokens,
    "cache_read_tokens": cache_read_tokens,
    # Honesty: total_prompt_processed = sum per turn of (input + cache_read +
    # cache_creation). On no-cache backends (GLM) this equals input_tokens +
    # cache_* — useful for sanity-checking. On caching backends it exceeds
    # input_tokens by the cache tiers, surfacing the actual volume reasoned.
    "total_prompt_processed": total_prompt_processed,
    # High-water mark of conversation size. Without caching, billed
    # input_tokens grows ~N * unique_prompt_max over N turns — the inflation
    # becomes visible as a ratio. With caching it converges toward this max.
    "unique_prompt_max": unique_prompt_max,
    "summary_messages_count": summary_messages_count,
    "summary_overhead_tokens_est": summary_overhead_tokens_est,
    "git_commits": git_commits,
    "git_pushes": git_pushes,
    "user_interruptions": user_interruptions,
    "informational_interrupts": informational_interrupts,
    "tool_success": dict(tool_success.most_common(10)),
    "tool_failure": dict(tool_failure.most_common(10)),
    "compaction_events": compaction_events,
    "parallel_tool_calls": parallel_tool_calls,
    "memory_calls": dict(memory_calls.most_common(10)),
    "per_session": per_session[:20],
    "tool_retries": dict(tool_retries.most_common(10)),
    "agent_loops": agent_loops[:30],
    "loop_sessions": dict(loop_sessions.most_common(10)),
    "loop_total": len(agent_loops),
    "file_edit_counts": dict(file_edit_counts.most_common(15)),
    "response_time_buckets": rbuckets,
    "message_hours": {str(k): v for k,v in sorted(message_hours.items())},
    "friction_by_topic": {
        k: [{
            "ts": i["ts"],
            "snippet": i["snippet"][:180],
            "session": i["session"][:40],
            "tool": i.get("tool",""),
            "file_paths": i.get("file_paths", [])[:4],
            "signal_keys": i.get("signal_keys", {"paths": [], "commits": [], "symbols": []}),
            "task_prompt": i.get("task_prompt","")[:100],
        } for i in v]
        for k, v in by_topic.items()
    },
    "friction_total": len(friction),
    "cache_tiers_present": cache_tiers_present,
    "retry_bursts": retry_bursts[:30],
    "unknown_tool_blocks": unknown_tool_blocks,
}
if unique_prompt_max > 0 and total_prompt_processed < unique_prompt_max:
    import sys as _sys
    print("WARN: total_prompt_processed < unique_prompt_max — accumulation regressed",
          file=_sys.stderr)
print(json.dumps(out, indent=2, default=str))