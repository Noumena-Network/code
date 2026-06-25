#!/usr/bin/env python3
"""insights-context — render the standalone HTML report.

Usage: render.py <project_cwd> [<scan_json>] [<resolved_json>]

Derives memory_dir from cwd via NCode's -<sanitized> convention.
Reads canonical CSS from /tmp/insights-context.css if present, else falls
back to an embedded high-polish stylesheet.

Applies regression detection: friction timestamped AFTER a matched
resolution's fixed_at is flagged REGRESSION, not RESOLVED, and surfaces
in a distinct alert section.
"""
import json, os, sys, html, subprocess, re
from datetime import datetime
from pathlib import Path
from collections import defaultdict

SCAN_PATH = sys.argv[2] if len(sys.argv) > 2 else "/tmp/insights-context.json"
RESOLVED_PATH = sys.argv[3] if len(sys.argv) > 3 else "/tmp/insights-resolved.json"
CSS_PATH = "/tmp/insights-context.css"


def project_paths():
    cwd = os.path.abspath(sys.argv[1]) if len(sys.argv) > 1 else os.getcwd()
    sanitized = cwd.replace("/", "-").rstrip("-")
    home = os.path.expanduser("~")
    memory_dir = f"{home}/.ncode/projects/{sanitized}/memory"
    return cwd, memory_dir


REPO_PATH, MEMORY_DIR = project_paths()


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def load_css():
    try:
        with open(CSS_PATH) as f:
            canonical = f.read()
        # Augment with high-polish additions rather than replacing canonical.
        # Escape </ so a tampered CSS file can't close the <style> tag and
        # inject script (the CSS comes from a world-writable /tmp path).
        return canonical.replace("</", "<\\/")
    except FileNotFoundError:
        return None  # renderer uses fully embedded stylesheet below


def parse_date(s):
    if not s:
        return None
    try:
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).date()
    except Exception:
        return None


def _norm_path(p):
    """Normalize a file path to its last 3 segments lowercased so absolute
    vs relative paths match (e.g. Sources/.../Stores/Foo.swift → stores/foo.swift)
    while avoiding false-positive matches for same-named files in different
    subdirectories (e.g. Core/Views/ContentView.swift ≠ Feature/Views/ContentView.swift).
    """
    if not p:
        return ""
    parts = [seg for seg in p.split("/") if seg and seg != "."]
    if len(parts) >= 3:
        return "/".join(parts[-3:]).lower()
    if len(parts) >= 2:
        return "/".join(parts[-2:]).lower()
    return p.lower()

def _topic_aggregate_signal(items):
    """Union of paths/commits/symbols across a friction topic's items."""
    paths, commits, symbols = set(), set(), set()
    for it in items:
        sk = it.get("signal_keys") or {}
        for p in sk.get("paths", []) or []:
            n = _norm_path(p)
            if n: paths.add(n)
        for c in sk.get("commits", []) or []:
            if c: commits.add(c.lower())
        for s in sk.get("symbols", []) or []:
            if s: symbols.add(s.lower())
    return paths, commits, symbols

def _resolved_signal(r):
    """Pull signal_keys from a resolved entry, falling back to evidence_keywords."""
    paths, commits, symbols = set(), set(), set()
    sk = r.get("signal_keys") or {}
    for p in sk.get("paths", []) or []:
        n = _norm_path(p)
        if n: paths.add(n)
    for c in sk.get("commits", []) or []:
        if c: commits.add(c.lower())
    for s in sk.get("symbols", []) or []:
        if s: symbols.add(s.lower())
    # Fallback to evidence_keywords for entries without signal_keys (old shape)
    for kw in r.get("evidence_keywords", []) or []:
        kwl = kw.lower()
        if "/" in kwl:
            n = _norm_path(kwl)
            if n: paths.add(n)
        elif len(kwl) >= 7 and all(c in "0123456789abcdef" for c in kwl):
            commits.add(kwl)
    return paths, commits, symbols

def _bucket_tokens(topic_name):
    """Tokens of a bucket label for weak-signal corroboration."""
    return {t for t in re.sub(r"[^a-z0-9]+", " ", topic_name.lower()).split() if len(t) >= 4}

def cross_reference(scan, resolved):
    """Match friction topics against resolved entries using signal-based keys
    (file paths + commit hashes + code symbols). Returns dict with open,
    resolved_matched, environmental_matched, regressions."""
    open_topics = []
    resolved_matched = []
    environmental_matched = []
    regressions = []

    for topic_name, items in scan.get("friction_by_topic", {}).items():
        f_paths, f_commits, f_symbols = _topic_aggregate_signal(items)
        f_bucket_toks = _bucket_tokens(topic_name)

        # Collect ALL matching resolved entries before deciding — breaking on
        # the first match silently downgrades the classifier. If an early match
        # has fixed_at=None (common for memory files without ISO dates) the
        # loop would break before reaching a later entry with a real fix date
        # that would have classified the friction as RESOLVED. We prefer a
        # dated match; among equally-dated matches, the strongest signal wins.
        matched = None
        matched_rank = -1
        for r in resolved:
            r_paths, r_commits, r_symbols = _resolved_signal(r)
            rank = -1
            # Highest confidence: exact commit hash overlap
            if f_commits and r_commits and (f_commits & r_commits):
                rank = 3
            # High confidence: >=1 shared file path
            elif f_paths and r_paths and (f_paths & r_paths):
                rank = 2
            # Weak signal: >=2 shared symbols AND bucket shares a token with
            # the resolved topic — corroboration required so common code symbols
            # don't false-match unrelated fixes.
            elif f_symbols and r_symbols:
                shared_syms = f_symbols & r_symbols
                if len(shared_syms) >= 2:
                    r_topic_toks = _bucket_tokens(r.get("topic",""))
                    if f_bucket_toks and r_topic_toks and (f_bucket_toks & r_topic_toks):
                        rank = 1
            if rank < 0:
                continue
            # Prefer entries with a real fix date (so they can be classified
            # pre/post-fix). Among same-date-or-same-state entries prefer the
            # strongest signal rank.
            r_has_date = bool(parse_date(r.get("fixed_at")))
            key = (1 if r_has_date else 0, rank)
            if matched is None or key > matched_rank:
                matched = r
                matched_rank = key

        last_seen = items[-1]["ts"] if items else None

        if matched and matched.get("is_environmental"):
            environmental_matched.append({
                "topic": topic_name,
                "count": len(items),
                "citation": matched["citation"],
                "last_seen": last_seen,
                "examples": items[:4],
            })
            # Environmental items route to a separate section only — do NOT
            # also append to open_topics (the .md spec says they go to "a
            # separate section", not double-displayed as OPEN).
        elif matched:
            # Per the documented classifier: friction predating the matched
            # fix's fixed_at is RESOLVED (suppressed from At a Glance); friction
            # AFTER fixed_at is a REGRESSION. Items we can't date — or a matched
            # entry with no fix_date — stay OPEN with a note rather than guessing
            # resolved. The prior code bucketed pre-fix items into "open", which
            # meant a fully-fixed topic never reached resolved_matched and the
            # .md invariant ("Match + friction before fix date -> RESOLVED")
            # never held.
            fix_date = parse_date(matched.get("fixed_at"))
            reg_items = []
            pre_fix_items = []
            undated_items = []
            for it in items:
                it_date = parse_date(it.get("ts"))
                if fix_date and it_date and it_date > fix_date:
                    reg_items.append(it)
                elif fix_date and it_date:
                    pre_fix_items.append(it)
                else:
                    undated_items.append(it)
            if reg_items:
                regressions.append({
                    "topic": topic_name,
                    "count": len(reg_items),
                    "citation": matched["citation"],
                    "fixed_at": matched.get("fixed_at"),
                    "examples": reg_items[:4],
                    "last_seen": reg_items[-1]["ts"] if reg_items else None,
                })
            if pre_fix_items:
                resolved_matched.append({
                    "topic": topic_name,
                    "count": len(pre_fix_items),
                    "citation": matched["citation"],
                    "last_seen": pre_fix_items[-1]["ts"] if pre_fix_items else None,
                })
            if undated_items:
                open_topics.append({
                    "topic": topic_name,
                    "count": len(undated_items),
                    "examples": undated_items[:4],
                    "last_seen": undated_items[-1]["ts"] if undated_items else None,
                    "note": "Matched a resolution but couldn't classify before/after fix date.",
                })
        else:
            open_topics.append({
                "topic": topic_name,
                "count": len(items),
                "examples": items[:4],
                "last_seen": last_seen,
            })

    return {
        "open": open_topics,
        "resolved_matched": resolved_matched,
        "environmental": environmental_matched,
        "regressions": regressions,
    }


def derive_project_areas(scan):
    areas = defaultdict(list)
    for path in scan.get("files_modified", []):
        # Paths are already scrubbed by the scanner (home dir → ~).
        # External files (starting with ~) can't be relpath'd; derive
        # the top-level label from the directory after ~/.
        if path.startswith("~"):
            stripped = path.removeprefix("~/").strip("/") if path.startswith("~/") else path.strip("/")
            parts = stripped.split("/") if stripped else []
            top = parts[0] if parts and parts[0] else "(external)"
        else:
            try:
                rel = os.path.relpath(path, REPO_PATH)
                if rel.startswith(".."):
                    top = os.path.basename(os.path.dirname(path)) or "(external)"
                else:
                    parts = rel.split("/")
                    top = parts[0] if len(parts) > 1 and parts[0] else "(root)"
            except (ValueError, TypeError):
                top = "(external)"
        areas[top].append(path)
    ranked = sorted(areas.items(), key=lambda x: -len(x[1]))[:6]
    return [{"name": name, "files": len(items), "sample": items[0] if items else ""} for name, items in ranked]


def synthesize_glance(scan, xref):
    languages = scan.get("languages", {})
    top_lang = max(languages, key=languages.get) if languages else "(none)"
    commits = scan.get("git_commits", 0)
    pushes = scan.get("git_pushes", 0)
    sessions = scan.get("sessions_scanned", 0)
    files = scan.get("files_modified_count", 0)
    open_count = len(xref["open"])
    reg_count = len(xref["regressions"])
    resolved_count = len(xref["resolved_matched"])
    env_count = len(xref["environmental"])

    whats_working = (
        f"Iteration is in high gear — {commits} commits and {pushes} pushes across "
        f"{sessions} recent sessions, touching {files} files. Primary language: {top_lang}. "
    )
    if resolved_count:
        whats_working += (
            f"{resolved_count} historical friction pattern(s) are now resolved and "
            f"suppressed from the live view — that arc of fixes is the real momentum."
        )

    if reg_count:
        whats_hindering = (
            f"{reg_count} regression(s) detected — friction re-appeared AFTER a "
            f"matching fix was applied. See REGRESSION Alerts at the bottom. "
        )
    if open_count:
        open_list = "; ".join(f"{t['topic']} ({t['count']}x)" for t in xref["open"])
        whats_hindering = (
            (whats_hindering if reg_count else "")
            + f"{open_count} active friction signal(s): {open_list}. "
        )
    if not open_count and not reg_count:
        whats_hindering = (
            f"Nothing active. No tool errors, no corrections logged in the last "
            f"{scan.get('scan_window_days', 7)} days. "
        )
        interruptions = scan.get("user_interruptions", 0)
        if interruptions:
            whats_hindering += (
                f"{interruptions} steering interrupt(s) recorded, plus "
                f"{scan.get('informational_interrupts', 0)} informational "
                f"interrupts excluded from friction (preferences/context added mid-task). "
            )
        whats_hindering += "The only signals are user-initiated, not breakage."

    quick_wins = (
        "When an interrupt fires mid-task, run `/doctor` before spelunking source — "
        "most interrupts are course-corrections, not bugs. Save a memory entry for "
        "any non-obvious fix so future sessions skip the rabbit hole."
    )
    ambitious = (
        "Pick the next subsystem that swallows failures (audit passes, hash caches, "
        "preflights) and convert each swallow point to a classified, surfaced error. "
        "The recent error-surfacing PRs are a clean template. Use the subagent "
        "worktree-permission syntax to parallelize the sweep safely."
    )
    return {
        "whats_working": whats_working.strip(),
        "whats_hindering": whats_hindering.strip(),
        "quick_wins": quick_wins,
        "ambitious": ambitious,
    }


def bar_chart(data, color, max_items=8, fixed_order=None):
    if not data:
        return '<p class="empty">No data</p>'
    if fixed_order:
        entries = [(k, data.get(k, 0)) for k in fixed_order if k in data and data[k]]
    else:
        entries = sorted(data.items(), key=lambda x: x[1], reverse=True)[:max_items]
    if not entries:
        return '<p class="empty">No data</p>'
    max_val = max(v for _, v in entries)
    rows = []
    for i, (label, count) in enumerate(entries):
        pct = (count / max_val) * 100 if max_val else 0
        clean = label.replace("_", " ").title()
        delay = i * 60
        rows.append(
            f'<div class="bar-row" style="animation-delay:{delay}ms">'
            f'<div class="bar-label">{html.escape(clean)}</div>'
            f'<div class="bar-track"><div class="bar-fill" '
            f'style="width:0%;background:{color};--target:{pct:.1f}%"></div></div>'
            f'<div class="bar-value tabular">{count}</div></div>'
        )
    return "\n".join(rows)


def friction_card(topic, count, examples, status, citation=None, note=None):
    cls = status.lower()
    card = f'<div class="friction-category {cls}">'
    card += (f'<div class="friction-title">{html.escape(topic)} '
             f'<span class="status-badge {cls}">{status}</span></div>')
    card += f'<div class="friction-desc">{count} instance(s) in recent session logs.</div>'
    if note:
        card += f'<div class="friction-note">{html.escape(note)}</div>'
    if examples:
        items_html = "".join(
            f'<li><span class="snippet">{html.escape(ex.get("snippet","")[:140])}</span>'
            f'<span class="meta">{html.escape(ex.get("session","")[:24])} '
            f'<span class="ts">{html.escape(ex.get("ts","")[:19])}</span></span></li>'
            for ex in examples
        )
        card += f'<ul class="friction-examples">{items_html}</ul>'
    if citation:
        card += f'<div class="friction-citation">Resolved by {html.escape(citation)}</div>'
    card += '</div>'
    return card


def main():
    scan = load_json(SCAN_PATH, {})
    resolved = load_json(RESOLVED_PATH, [])
    css = load_css()
    xref = cross_reference(scan, resolved)
    glance = synthesize_glance(scan, xref)
    areas = derive_project_areas(scan)

    sessions_scanned = scan.get("sessions_scanned", 0)
    sessions_window = scan.get("sessions_in_time_window", 0)
    git_commits = scan.get("git_commits", 0)
    git_pushes = scan.get("git_pushes", 0)
    files_touched = scan.get("files_modified_count", 0)
    friction_total = scan.get("friction_total", 0)
    interruptions = scan.get("user_interruptions", 0)
    window_days = scan.get("scan_window_days", 7)

    # Banner counts
    try:
        out = subprocess.check_output(
            ["git", "-C", REPO_PATH, "rev-list", "--since=30 days ago", "--count", "HEAD"],
            text=True, stderr=subprocess.DEVNULL
        ).strip()
        recent_commits = int(out) if out.isdigit() else 0
    except Exception:
        recent_commits = 0
    mem_count = 0
    if os.path.isdir(MEMORY_DIR):
        mem_count = len([f for f in os.listdir(MEMORY_DIR) if f.endswith(".md")])

    resolved_count = len(xref["resolved_matched"])
    reg_count = len(xref["regressions"])

    # Charts
    tool_chart = bar_chart(dict(list(scan.get("tool_counts", {}).items())[:8]), "#6366f1")
    lang_chart = bar_chart(scan.get("languages", {}), "#8b5cf6")
    response_chart = bar_chart(
        scan.get("response_time_buckets", {}), "#10b981",
        fixed_order=["2-10s","10-30s","30s-1m","1-2m","2-5m","5-15m",">15m"]
    )
    hours = scan.get("message_hours", {})
    hour_chart = bar_chart(
        {str(k): v for k, v in sorted([(int(k), v) for k, v in hours.items()])},
        "#ec4899"
    )

    # Recent wins — top 8 commit subjects last 7 days
    try:
        log_lines = subprocess.check_output(
            ["git", "-C", REPO_PATH, "log", "--since=7 days ago", "--pretty=format:%s\t%h"],
            text=True, stderr=subprocess.DEVNULL
        ).strip().split("\n")[:8]
        wins_items = ""
        for line in log_lines:
            if not line:
                continue
            parts = line.split("\t")
            subject = parts[0] if parts else line
            hsh = parts[1] if len(parts) > 1 else ""
            wins_items += (
                f'<div class="big-win">'
                f'<div class="big-win-title">{html.escape(subject)}</div>'
                f'<div class="big-win-hash tabular">{html.escape(hsh)}</div></div>'
            )
        wins_html = f'<div class="big-wins">{wins_items}</div>' if wins_items else '<p class="empty">No recent commits.</p>'
    except Exception:
        wins_html = '<p class="empty">Could not read git log.</p>'

    # Project areas
    if areas:
        areas_items = "".join(
            f'<div class="area-card">'
            f'<div class="area-header"><span class="area-name">{html.escape(a["name"])}</span>'
            f'<span class="area-count tabular">{a["files"]} files</span></div>'
            f'<div class="area-sample">{html.escape(a["sample"])}</div></div>'
            for a in areas
        )
        areas_html = f'<div class="project-areas">{areas_items}</div>'
    else:
        areas_html = '<p class="empty">No modified files detected in scan window.</p>'

    # Friction section
    cards = ""
    for t in xref["open"]:
        cards += friction_card(t["topic"], t["count"], t.get("examples", []), "OPEN", note=t.get("note"))
    for t in xref["resolved_matched"]:
        cards += friction_card(t["topic"], t["count"], [], "RESOLVED", t["citation"])
    if not cards:
        cards = '<p class="empty">No friction items detected in recent sessions.</p>'

    # Regression section
    reg_html = ""
    if xref["regressions"]:
        reg_cards = ""
        for t in xref["regressions"]:
            reg_cards += (
                f'<div class="friction-category regression">'
                f'<div class="friction-title">{html.escape(t["topic"])} '
                f'<span class="status-badge regression">REGRESSION</span></div>'
                f'<div class="friction-desc">{t["count"]} occurrence(s) AFTER the matching fix '
                f'({html.escape(t.get("fixed_at","unknown date"))}).</div>'
                f'<div class="friction-citation">Fix: {html.escape(t["citation"])}</div></div>'
            )
        reg_html = (
            f'<div class="regression-section">'
            f'<h2>REGRESSION Alerts</h2>'
            f'<p class="section-intro">Friction re-appeared after a matching fix was applied. '
            f'These need attention — the fix did not hold.</p>'
            f'{reg_cards}</div>'
        )

    # Environmental section
    env_html = ""
    if xref["environmental"]:
        env_items = ""
        for t in xref["environmental"]:
            env_items += (
                f'<div class="friction-category environmental">'
                f'<div class="friction-title">{html.escape(t["topic"])} '
                f'<span class="status-badge environmental">ENVIRONMENTAL</span></div>'
                f'<div class="friction-citation">{html.escape(t["citation"])}</div></div>'
            )
        env_html = (
            f'<div class="env-section">'
            f'<h2>Known Environmental</h2>'
            f'<p class="section-intro">Documented conditions that may surface as friction but '
            f'are not code regressions.</p>{env_items}</div>'
        )

    # Resolved ledger — include ALL resolved entries from the ledger (not only session-matched)
    # Match by citation: resolved entries (commit subjects) and friction bucket labels have
    # different "topic" strings, but both sides share the same citation string from the
    # matched resolved entry.
    _matched_last_by_citation = {
        t.get("citation", ""): t.get("last_seen")
        for t in xref["resolved_matched"]
        if t.get("citation")
    }
    ledger_items = ""
    for r in resolved:
        if r.get("is_environmental"):
            continue
        last = _matched_last_by_citation.get(r.get("citation", ""))
        last_str = f'<span class="ts">last seen {html.escape(last[:19])}</span>' if last else '<span class="ts muted">not seen in window</span>'
        ledger_items += (
            f'<div class="ledger-item">'
            f'<div class="ledger-topic">{html.escape(r["topic"])}</div>'
            f'<div class="ledger-citation">{html.escape(r.get("citation",""))} {last_str}</div></div>'
        )
    ledger_html = (
        f'<div class="resolved-section">'
        f'<h2>Resolved Friction</h2>'
        f'<p class="section-intro">Previously active friction, now fixed. '
        f'Suppressed from At a Glance. Sources: last 30 days of git + auto-memory.</p>'
        f'{ledger_items}</div>'
    ) if ledger_items else ""

    # At a Glance
    glance_html = (
        '<div class="at-a-glance">'
        '<div class="glance-title">At a Glance</div>'
        '<div class="glance-sections">'
        f'<div class="glance-section"><strong>What\'s working:</strong> {html.escape(glance["whats_working"])}</div>'
        f'<div class="glance-section"><strong>What\'s hindering you:</strong> {html.escape(glance["whats_hindering"])} '
        '<a href="#section-friction" class="see-more">Where Things Go Wrong →</a></div>'
        f'<div class="glance-section"><strong>Quick wins to try:</strong> {html.escape(glance["quick_wins"])}</div>'
        f'<div class="glance-section"><strong>Ambitious workflows:</strong> {html.escape(glance["ambitious"])}</div>'
        '</div></div>'
    )

    # Stats row
    stats_html = (
        f'<div class="stats-row">'
        f'<div class="stat"><div class="stat-value tabular">{git_commits}</div><div class="stat-label">commits</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{git_pushes}</div><div class="stat-label">pushes</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{files_touched}</div><div class="stat-label">files</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{friction_total}</div><div class="stat-label">friction events</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{interruptions}</div><div class="stat-label">interrupts</div></div>'
        '</div>'
    )

    charts_html = (
        f'<div class="charts-row">'
        f'<div class="chart-card"><div class="chart-title">Top tools</div>{tool_chart}</div>'
        f'<div class="chart-card"><div class="chart-title">Languages</div>{lang_chart}</div></div>'
        f'<div class="charts-row">'
        f'<div class="chart-card"><div class="chart-title">Response time</div>{response_chart}</div>'
        f'<div class="chart-card"><div class="chart-title">Activity by hour (UTC)</div>{hour_chart}</div></div>'
    )

    # --- Debug info sections (Token Economics, Tool Effectiveness, etc.) ---
    input_tok = scan.get("input_tokens", 0)
    output_tok = scan.get("output_tokens", 0)
    cache_creation_tok = scan.get("cache_creation_tokens", 0)
    cache_read_tok = scan.get("cache_read_tokens", 0)
    total_tok = input_tok + output_tok + cache_creation_tok + cache_read_tok

    # Anthropic Sonnet 4 pricing (per MTok):
    #   new input: $3.00
    #   output: $15.00
    #   cache creation (5m or 1h): $3.75
    #   cache read: $0.30 (90% discount on new input)
    INPUT_PER_MTOK = 3.00
    OUTPUT_PER_MTOK = 15.00
    CACHE_CREATE_PER_MTOK = 3.75
    CACHE_READ_PER_MTOK = 0.30
    input_cost = (input_tok / 1_000_000) * INPUT_PER_MTOK
    output_cost = (output_tok / 1_000_000) * OUTPUT_PER_MTOK
    cache_create_cost = (cache_creation_tok / 1_000_000) * CACHE_CREATE_PER_MTOK
    cache_read_cost = (cache_read_tok / 1_000_000) * CACHE_READ_PER_MTOK
    total_cost = input_cost + output_cost + cache_create_cost + cache_read_cost
    avg_tok_per_sess = (total_tok / sessions_scanned) if sessions_scanned else 0
    cache_hit_rate = (cache_read_tok / (cache_read_tok + cache_creation_tok + input_tok) * 100) if (cache_read_tok + cache_creation_tok + input_tok) > 0 else 0.0

    def fmt_tok(n):
        if n >= 1_000_000: return f"{n/1_000_000:.2f}M"
        if n >= 1_000: return f"{n/1_000:.1f}K"
        return str(int(n))

    def fmt_dur(sec):
        if sec < 60: return f"{int(sec)}s"
        if sec < 3600: return f"{int(sec/60)}m"
        return f"{sec/3600:.1f}h"

    def clean_tool_name(t):
        if t.startswith("mcp__"):
            tail = t.split("__")[-1]
            return tail.replace("_", " ").title()
        return t.replace("_", " ").title()

    # Optional cards: cache hit rate (only when caching is producing reads),
    # and a prompt-caching not-in-use note (only when nothing is cached).
    hit_rate_stat = (
        f'<div class="stat"><div class="stat-value tabular">{cache_hit_rate:.1f}%</div>'
        f'<div class="stat-label">cache hit rate</div></div>'
        if cache_read_tok > 0 else ''
    )
    cache_note_html = ""
    # Backend-aware three-branch logic. scan.py emits cache_tiers_present=True
    # only when at least one usage block carried cache_*_input_tokens keys.
    #   - keys absent everywhere (no-cache backend): structural inflation,
    #     no "enable caching" advice (it can't be toggled here)
    #   - keys present but all zero (caching available, not active): keep the
    #     "enable prompt caching" advice — the user can flip it on
    #   - keys present and nonzero: caching active, show hit rate
    cache_tiers_present = bool(scan.get("cache_tiers_present"))
    cache_active = (cache_read_tok > 0 or cache_creation_tok > 0)
    if not cache_tiers_present:
        cache_note_html = (
            '<div class="debug-card" style="font-family:inherit;">'
            '<strong>No cache tiers in usage payload.</strong> '
            'Backend does not support prompt caching — the N× inflation shown '
            'is inherent to this backend. Switching to a caching-capable backend '
            'would collapse billed input toward unique_prompt_max per turn.</div>'
        )
    elif not cache_active:
        cache_note_html = (
            '<div class="debug-card" style="font-family:inherit;">'
            '<strong>Prompt caching not in use.</strong> '
            'Enabling cache reads would reduce input cost by up to 90%.</div>'
        )
    # Honesty metrics: separate billed sum from actual conversation size.
    # On no-cache backends (e.g. GLM) the stable prefix is re-billed every
    # turn, so input_tokens inflated ~N * unique_prompt_max. Surfacing the
    # ratio makes the inflation visible instead of reporting an opaque
    # hundreds-of-millions figure as if it were unique tokens processed.
    unique_prompt_max = scan.get("unique_prompt_max", 0) or 0
    total_prompt_processed = scan.get("total_prompt_processed", 0) or 0
    summary_overhead = scan.get("summary_overhead_tokens_est", 0) or 0
    summary_count = scan.get("summary_messages_count", 0) or 0
    inflation_ratio = (
        round(input_tok / unique_prompt_max, 1)
        if unique_prompt_max > 0 and input_tok > 0 else None
    )

    def fmt_ratio(r):
        if r is None: return "—"
        if r >= 100: return f"{r:.0f}×"
        return f"{r:.1f}×"

    # Inflation note — surfaces when the ratio is meaningfully > 1. The
    # closing advice is backend-aware: on a no-cache backend the user can't
    # "enable prompt caching" (the backend doesn't expose it), so we point
    # at the backend switch instead of giving category-confused advice.
    inflation_note_html = ""
    if inflation_ratio is not None and inflation_ratio >= 2.0:
        if cache_tiers_present:
            advice = (
                "Enable prompt caching to collapse this toward 1×."
            )
        else:
            advice = (
                "Switching to a caching-capable backend would collapse this "
                "toward 1× — this backend does not expose cache tiers."
            )
        inflation_note_html = (
            '<div class="debug-card" style="border-left:3px solid var(--amber);">'
            f'<strong>Billed input inflated {fmt_ratio(inflation_ratio)}.</strong> '
            f'Unique conversation max is {fmt_tok(unique_prompt_max)} tokens, but '
            f'{fmt_tok(input_tok)} were billed as fresh input across turns — the '
            f'stable prefix (system prompt + tools + early turns) was re-billed '
            f'every turn instead of being cached. {advice}</div>'
        )

    # Compaction overhead card — only when summary messages present
    compaction_note_html = ""
    if summary_count > 0 and summary_overhead > 0:
        compaction_cost = (summary_overhead / 1_000_000) * INPUT_PER_MTOK
        compaction_note_html = (
            '<div class="debug-card">'
            f'<strong>Compaction overhead: {fmt_tok(summary_overhead)} tokens</strong> '
            f'across {summary_count} summary message(s), ${compaction_cost:.2f} at input rate. '
            f'This is re-processed every turn after compaction in place of the '
            f'original conversation — visible above as part of input_tokens.</div>'
        )

    token_economics_html = (
        '<h2>Token Economics</h2>'
        '<p class="section-intro">Multi-tier cost at Anthropic Sonnet 4 pricing — '
        'per MTok: input $3.00, output $15.00, cache create $3.75, cache read $0.30 '
        '(cache reads are 90% cheaper than new input).</p>'
        # Row 1: token tiers
        '<div class="stats-row">'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(input_tok)}</div><div class="stat-label">input tok (billed)</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(output_tok)}</div><div class="stat-label">output tok</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(cache_creation_tok)}</div><div class="stat-label">cache create tok</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(cache_read_tok)}</div><div class="stat-label">cache read tok</div></div>'
        '</div>'
        # Row 2: cost breakdown (total cost emphasized with emerald accent border)
        '<div class="stats-row">'
        f'<div class="stat"><div class="stat-value tabular">${input_cost:.2f}</div><div class="stat-label">input cost</div></div>'
        f'<div class="stat"><div class="stat-value tabular">${output_cost:.2f}</div><div class="stat-label">output cost</div></div>'
        f'<div class="stat"><div class="stat-value tabular">${cache_create_cost:.2f}</div><div class="stat-label">cache create cost</div></div>'
        f'<div class="stat"><div class="stat-value tabular">${cache_read_cost:.2f}</div><div class="stat-label">cache read cost</div></div>'
        f'<div class="stat" style="border-left:3px solid var(--emerald);"><div class="stat-value tabular">${total_cost:.2f}</div><div class="stat-label">total cost</div></div>'
        '</div>'
        # Row 3: total tokens + per-session + cache hit rate (if any)
        '<div class="stats-row">'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(total_tok)}</div><div class="stat-label">total tokens</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(avg_tok_per_sess)}</div><div class="stat-label">tok / session</div></div>'
        f'{hit_rate_stat}'
        '</div>'
        # Row 4: honesty metrics — unique max + inflation ratio
        '<div class="stats-row">'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(unique_prompt_max)}</div><div class="stat-label">unique prompt max (1 turn)</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{fmt_tok(total_prompt_processed)}</div><div class="stat-label">total processed (sum)</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{fmt_ratio(inflation_ratio)}</div><div class="stat-label">billed / unique ratio</div></div>'
        '</div>'
        f'{cache_note_html}'
        f'{inflation_note_html}'
        f'{compaction_note_html}'
    )

    tool_success = scan.get("tool_success", {})
    tool_failure = scan.get("tool_failure", {})
    all_tools_set = set(tool_success) | set(tool_failure)
    total_success = sum(tool_success.values())
    total_failure = sum(tool_failure.values())
    total_calls = total_success + total_failure
    success_rate = (total_success / total_calls * 100) if total_calls > 0 else 100.0
    failure_rate_data = {}
    for t in all_tools_set:
        f_ = tool_failure.get(t, 0)
        s_ = tool_success.get(t, 0)
        tot = f_ + s_
        if f_ > 0 and tot > 0:
            failure_rate_data[t] = f_ / tot * 100

    if failure_rate_data:
        sorted_failures = sorted(failure_rate_data.items(), key=lambda x: -x[1])[:8]
        fail_chart = ""
        for i, (tool, rate) in enumerate(sorted_failures):
            clean = clean_tool_name(tool)
            delay = i * 60
            fail_chart += (
                f'<div class="bar-row" style="animation-delay:{delay}ms">'
                f'<div class="bar-label">{html.escape(clean)}</div>'
                f'<div class="bar-track"><div class="bar-fill" '
                f'style="width:0%;background:var(--red);--target:{rate:.1f}%"></div></div>'
                f'<div class="bar-value tabular">{rate:.1f}%</div></div>'
            )
        effectiveness_body = (
            '<div class="chart-card"><div class="chart-title">Failure rate per tool '
            '(tools with failures &gt; 0)</div>'
            f'{fail_chart}</div>'
            f'<div class="stats-row">'
            f'<div class="stat"><div class="stat-value tabular">{success_rate:.1f}%</div>'
            f'<div class="stat-label">overall success</div></div>'
            f'<div class="stat"><div class="stat-value tabular">{total_calls}</div>'
            f'<div class="stat-label">total calls</div></div></div>'
        )
    else:
        effectiveness_body = (
            '<div class="debug-card">'
            '<span class="health-badge healthy">All tools healthy</span>'
            'No tool failures detected in this scan window.</div>'
        )
        if total_calls > 0:
            effectiveness_body += (
                f'<p class="section-intro">{total_calls} tool calls, {total_success} successful, '
                f'{total_failure} failed — overall success rate {success_rate:.1f}%.</p>'
            )

    tool_effectiveness_html = (
        '<h2>Tool Effectiveness</h2>'
        '<p class="section-intro">Failure rate = failures / (successes + failures) per tool.</p>'
        f'{effectiveness_body}'
    )

    file_edit_counts = scan.get("file_edit_counts", {})
    if file_edit_counts:
        hotspots_rows = ""
        for i, (path, count) in enumerate(file_edit_counts.items()):
            if i >= 10: break
            hotspots_rows += (
                f'<div class="hotspot-row">'
                f'<span class="hotspot-rank">{i+1}</span>'
                f'<span class="hotspot-path">{html.escape(path)}</span>'
                f'<span class="hotspot-count tabular">{count}×</span></div>'
            )
        hotspots_html = f'<div class="hotspot-list">{hotspots_rows}</div>'
    else:
        hotspots_html = '<p class="empty">No file edits detected in scan window.</p>'
    file_hotspots_html = (
        '<h2>File Hotspots</h2>'
        '<p class="section-intro">Top edited files — paths already redacted by scanner.</p>'
        f'{hotspots_html}'
    )

    per_session = scan.get("per_session", [])
    if per_session:
        # Active span (excludes gaps > 15 min) is the real working-time signal;
        # fall back to duration_sec for scans predating the active/idle split.
        def _active(s):
            a = s.get("active_span_sec")
            return a if a is not None else s.get("duration_sec", 0)
        def _idle(s):
            i = s.get("idle_span_sec")
            return i if i is not None else 0
        actives = sorted([_active(s) for s in per_session])
        n = len(actives)
        median_dur = actives[n // 2] if n % 2 == 1 else (actives[n//2 - 1] + actives[n//2]) / 2
        longest = max(per_session, key=lambda s: _active(s))
        shortest = min(per_session, key=lambda s: _active(s))
        total_msgs = sum(s.get("messages", 0) for s in per_session)
        avg_msgs = total_msgs / n if n else 0
        idle_total = sum(_idle(s) for s in per_session)
        session_stats_html = (
            '<div class="kv-grid">'
            f'<div class="kv-item"><div class="kv-label">sessions</div><div class="kv-value tabular">{n}</div></div>'
            f'<div class="kv-item"><div class="kv-label">median active</div><div class="kv-value tabular">{fmt_dur(median_dur)}</div></div>'
            f'<div class="kv-item"><div class="kv-label">longest active</div><div class="kv-value tabular">{fmt_dur(_active(longest))}</div></div>'
            f'<div class="kv-item"><div class="kv-label">shortest active</div><div class="kv-value tabular">{fmt_dur(_active(shortest))}</div></div>'
            f'<div class="kv-item"><div class="kv-label">avg msgs/sess</div><div class="kv-value tabular">{avg_msgs:.0f}</div></div>'
            '</div>'
            f'<p class="section-intro">Active span excludes gaps &gt; 15 min (overnight resume). '
            f'Idle across all sessions: {fmt_dur(idle_total)}.</p>'
        )
        top_sessions = sorted(per_session, key=lambda s: -_active(s))[:10]
        max_dur = max((_active(s) for s in top_sessions), default=1) or 1
        mini_chart = ""
        for i, s in enumerate(top_sessions):
            dur = _active(s)
            pct = (dur / max_dur) * 100 if max_dur else 0
            delay = i * 60
            name = (s.get("name", "") or "").split(".")[0][:8]
            mini_chart += (
                f'<div class="bar-row" style="animation-delay:{delay}ms">'
                f'<div class="bar-label">{html.escape(name)}</div>'
                f'<div class="bar-track"><div class="bar-fill" '
                f'style="width:0%;background:#0ea5e9;--target:{pct:.1f}%"></div></div>'
                f'<div class="bar-value tabular">{fmt_dur(dur)}</div></div>'
            )
        session_anatomy_html = (
            f'<h2>Session Anatomy</h2>{session_stats_html}'
            f'<div class="chart-card"><div class="chart-title">Top sessions by active span</div>{mini_chart}</div>'
        )
    else:
        session_anatomy_html = '<h2>Session Anatomy</h2><p class="empty">No session duration data available.</p>'

    parallel_tc = scan.get("parallel_tool_calls", 0)
    compaction = scan.get("compaction_events", 0)
    retry_bursts = scan.get("retry_bursts", []) or []
    behavior_stats = (
        '<div class="stats-row">'
        f'<div class="stat"><div class="stat-value tabular">{parallel_tc}</div><div class="stat-label">parallel calls</div></div>'
        f'<div class="stat"><div class="stat-value tabular">{compaction}</div><div class="stat-label">compactions</div></div>'
        '</div>'
    )
    compaction_note = (
        f'<p class="section-intro">Context pressure — context window compressed {compaction} time(s).</p>'
        if compaction > 0 else ''
    )
    # Retry bursts: same-tool runs of 3+ calls where at least one errored. Each
    # burst carries tool, count, session, ts so the reader sees concrete stuck
    # moments — not a raw adjacency count that conflates 50 distinct Reads with
    # a 50-call retry.
    if retry_bursts:
        top_bursts = sorted(retry_bursts, key=lambda b: -b.get("count", 0))[:5]
        retries_rows = ""
        for b in top_bursts:
            clean = clean_tool_name(b.get("tool","?"))
            ts_short = (b.get("ts","") or "")[:19]
            sess = (b.get("session","") or "").split(".")[0][:8]
            retries_rows += (
                f'<li><span class="retry-tool">{html.escape(clean)}</span> '
                f'<span class="retry-count tabular">{b.get("count",0)} calls</span> '
                f'<span style="color:var(--muted);font-size:11px;">first {html.escape(ts_short)} · {html.escape(sess)}</span></li>'
            )
        retries_html = (
            '<div class="debug-card"><div class="chart-title">'
            'Retry bursts (3+ same-tool calls with an error)</div>'
            f'<ul class="retry-list">{retries_rows}</ul></div>'
        )
    else:
        retries_html = '<p class="empty">No retry patterns detected.</p>'
    agent_behavior_html = (
        f'<h2>Agent Behavior</h2>{compaction_note}{behavior_stats}{retries_html}'
    )

    memory_calls = scan.get("memory_calls", {})
    total_mem = sum(memory_calls.values())
    if memory_calls:
        op_counts = defaultdict(int)
        for tool, count in memory_calls.items():
            parts = tool.split("__")
            last = parts[-1] if parts else tool
            op = last.split("_")[-1] if "_" in last else last
            op_counts[op] += count
        memory_chart = bar_chart(dict(op_counts), "#8b5cf6")
        memory_html = (
            '<h2>Memory &amp; Learning</h2>'
            f'<p class="section-intro">{total_mem} memory fabric call(s) across '
            f'{len(op_counts)} operation type(s).</p>'
            f'<div class="chart-card"><div class="chart-title">Memory operations (by type)</div>{memory_chart}</div>'
        )
    else:
        memory_html = (
            '<h2>Memory &amp; Learning</h2>'
            '<div class="debug-card"><p class="empty">No memory fabric activity in this scan window.</p></div>'
        )

    # Agent Loops section — cycles where two tools alternate (X Y X Y).
    # Generated from scan.py's recent_tool_window detection. Each entry has
    # the two tool names + session + ts. loop_sessions aggregates the pairs.
    agent_loops = scan.get("agent_loops", []) or []
    loop_sessions = scan.get("loop_sessions", {}) or {}
    loop_total = scan.get("loop_total", 0) or 0
    if loop_total > 0 and loop_sessions:
        # Build a bar chart of the top loop pairs, sorted by count.
        sorted_loops = sorted(loop_sessions.items(), key=lambda x: -x[1])[:8]
        max_loop_count = sorted_loops[0][1] if sorted_loops else 1
        loop_chart = ""
        for i, (pair, count) in enumerate(sorted_loops):
            # Split the concatenated tool names for readability.
            # The pair key is two tool names concatenated (e.g. "ReadEdit").
            # Heuristic: split at the second capital. Falls back to the raw
            # string if the split is ambiguous.
            parts = re.findall(r'[A-Z][a-z]+', pair)
            label = " ↔ ".join(parts) if len(parts) >= 2 else pair
            pct = (count / max_loop_count) * 100
            delay = i * 60
            loop_chart += (
                f'<div class="bar-row" style="animation-delay:{delay}ms">'
                f'<div class="bar-label">{html.escape(label)}</div>'
                f'<div class="bar-track"><div class="bar-fill" '
                f'style="width:0%;background:var(--amber);--target:{pct:.1f}%"></div></div>'
                f'<div class="bar-value tabular">{count}</div></div>'
            )
        # Show a few example loops with timestamps for reproducibility.
        sample_loops = agent_loops[:5]
        sample_html = ""
        if sample_loops:
            sample_rows = ""
            for sl in sample_loops:
                ts = html.escape(sl.get("ts", "")[:19] or "—")
                tools = sl.get("tools", [])
                tools_str = html.escape(" ↔ ".join(tools) if len(tools) >= 2 else "—")
                task = html.escape(sl.get("task_prompt", "")[:60] or "—")
                sample_rows += (
                    f'<tr><td class="tabular">{ts}</td>'
                    f'<td>{tools_str}</td>'
                    f'<td>{task}</td></tr>'
                )
            sample_html = (
                '<div class="chart-card" style="margin-top:12px">'
                '<div class="chart-title">Sample loops (first 5)</div>'
                '<table style="width:100%;border-collapse:collapse;font-size:13px">'
                '<thead><tr style="text-align:left;border-bottom:1px solid var(--border)">'
                '<th style="padding:4px 8px">Timestamp</th>'
                '<th style="padding:4px 8px">Tools</th>'
                '<th style="padding:4px 8px">Task prompt</th>'
                '</tr></thead>'
                f'<tbody>{sample_rows}</tbody></table></div>'
            )
        agent_loops_html = (
            '<h2>Agent Loops</h2>'
            '<p class="section-intro">Two-tool alternations (X Y X Y) detected '
            f'in the scan window — {loop_total} total. These are the most expensive '
            'failure mode (the agent thrashes between two tools without progress). '
            'Some are legitimate read-edit-verify cycles; sustained counts signal '
            'a stuck loop.</p>'
            f'<div class="stats-row">'
            f'<div class="stat"><div class="stat-value tabular">{loop_total}</div><div class="stat-label">total cycles</div></div>'
            f'<div class="stat"><div class="stat-value tabular">{len(loop_sessions)}</div><div class="stat-label">distinct pairs</div></div>'
            '</div>'
            f'<div class="chart-card"><div class="chart-title">Most frequent loop pairs</div>{loop_chart}</div>'
            f'{sample_html}'
        )
    else:
        agent_loops_html = (
            '<h2>Agent Loops</h2>'
            '<div class="debug-card">'
            '<span class="health-badge healthy">No two-tool cycles</span>'
            'No XY alternation loops detected in this scan window.</div>'
        )

    body_sections = [
        glance_html,
        f'<h2>Usage Overview</h2><p class="section-intro">Last {window_days} days, {sessions_scanned} sessions scanned ({sessions_window} in time window).</p>{stats_html}{charts_html}',
        f'<h2>Project Areas</h2>{areas_html}',
        f'<h2>Impressive Things You Did</h2>{wins_html}',
        token_economics_html,
        tool_effectiveness_html,
        agent_loops_html,
        file_hotspots_html,
        session_anatomy_html,
        agent_behavior_html,
        memory_html,
        f'<h2 id="section-friction">Where Things Go Wrong</h2>'
        '<p class="section-intro">'
        '<span class="status-badge open">OPEN</span> currently active · '
        '<span class="status-badge resolved">RESOLVED</span> previously friction, now fixed</p>'
        f'<div class="friction-categories">{cards}</div>',
        env_html,
        reg_html,
        ledger_html,
    ]

    sections_html = "".join(
        f'<section class="reveal" style="animation-delay:{i*80}ms">{s}</section>'
        for i, s in enumerate(body_sections) if s
    )

    banner = (
        f'<div class="context-banner">'
        f'Cross-referenced against <strong class="tabular">{recent_commits}</strong> commits (30 days) '
        f'and <strong class="tabular">{mem_count}</strong> auto-memory entries. '
        f'<strong class="tabular">{resolved_count}</strong> resolved item(s) suppressed from At a Glance'
        + (f', <strong class="tabular">{reg_count}</strong> regression(s) flagged.' if reg_count else '.')
        + '</div>'
    )

    # Use embedded polish stylesheet; if canonical CSS exists, prepend it (keeps class hooks)
    css_block = css if css else ""

    html_out = f'''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code Insights (Context-Aware)</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>{css_block}</style>
<style>
:root {{
  --bg: #f8fafc; --surface: #ffffff; --ink: #0f172a; --ink-2: #475569; --muted: #64748b;
  --line: rgba(0,0,0,0.06);
  --amber: #f59e0b; --amber-bg: #fef3c7; --amber-ink: #78350f;
  --emerald: #10b981; --emerald-bg: #d1fae5; --emerald-ink: #065f46;
  --blue: #3b82f6; --blue-bg: #dbeafe; --blue-ink: #1e40af;
  --violet: #8b5cf6; --violet-bg: #ede9fe; --violet-ink: #5b21b6;
  --red: #ef4444; --red-bg: #fee2e2; --red-ink: #991b1b;
  --radius-outer: 12px; --radius-inner: 6px; --radius-pill: 6px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,0.04), 0 1px 1px rgba(0,0,0,0.02);
  --shadow-md: 0 4px 12px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
}}
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
html {{ -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; text-rendering: optimizeLegibility; }}
body {{ font-family: 'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
  background: var(--bg); color: #334155; line-height: 1.65; padding: 48px 24px 80px; }}
.container {{ max-width: 820px; margin: 0 auto; }}
h1 {{ font-size: 32px; font-weight: 700; color: var(--ink); margin-bottom: 4px; text-wrap: balance; letter-spacing: -0.01em; }}
h2 {{ font-size: 20px; font-weight: 600; color: var(--ink); margin-top: 48px; margin-bottom: 16px; text-wrap: balance; letter-spacing: -0.005em; }}
.subtitle {{ color: var(--muted); font-size: 15px; margin-bottom: 32px; }}
.tabular {{ font-variant-numeric: tabular-nums; font-feature-settings: "tnum"; }}
p, .glance-section, .friction-desc, .section-intro, .area-sample {{ text-wrap: pretty; }}

.reveal {{ opacity: 0; transform: translateY(8px); animation: reveal 0.5s cubic-bezier(0.2,0,0,1) forwards; }}
@keyframes reveal {{ to {{ opacity: 1; transform: translateY(0); }} }}

.context-banner {{ background: var(--blue-bg); color: var(--blue-ink);
  border-radius: var(--radius-outer); padding: 14px 18px; margin-bottom: 28px;
  font-size: 13.5px; box-shadow: var(--shadow-sm); }}
.context-banner strong {{ font-weight: 600; }}

.at-a-glance {{ background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
  border-radius: var(--radius-outer); padding: 22px 26px; margin-bottom: 32px;
  box-shadow: var(--shadow-md); }}
.glance-title {{ font-size: 12px; font-weight: 700; color: var(--amber-ink);
  text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 14px; }}
.glance-sections {{ display: flex; flex-direction: column; gap: 12px; }}
.glance-section {{ font-size: 14px; color: var(--amber-ink); line-height: 1.6; }}
.glance-section strong {{ color: #78350f; font-weight: 600; }}
.see-more {{ color: #b45309; text-decoration: none; font-size: 13px; margin-left: 6px; }}
.see-more:hover {{ text-decoration: underline; }}

.stats-row {{ display: flex; gap: 14px; margin: 20px 0 28px; flex-wrap: wrap; }}
.stat {{ background: var(--surface); border-radius: var(--radius-outer); padding: 14px 18px;
  min-width: 92px; text-align: center; box-shadow: var(--shadow-sm); }}
.stat-value {{ font-size: 24px; font-weight: 700; color: var(--ink); letter-spacing: -0.02em; }}
.stat-label {{ font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }}

.charts-row {{ display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0 28px; }}
.chart-card {{ background: var(--surface); border-radius: var(--radius-outer); padding: 18px; box-shadow: var(--shadow-sm); }}
.chart-title {{ font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase;
  letter-spacing: 0.04em; margin-bottom: 14px; }}
.bar-row {{ display: flex; align-items: center; margin-bottom: 8px;
  opacity: 0; animation: reveal 0.4s cubic-bezier(0.2,0,0,1) forwards; }}
.bar-label {{ width: 96px; font-size: 11.5px; color: var(--ink-2); flex-shrink: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
.bar-track {{ flex: 1; height: 7px; background: #f1f5f9; border-radius: 4px; margin: 0 10px; overflow: hidden; }}
.bar-fill {{ height: 100%; border-radius: 4px; will-change: width;
  animation: grow 0.7s cubic-bezier(0.2,0,0,1) forwards; animation-delay: inherit; }}
@keyframes grow {{ from {{ width: 0; }} to {{ width: var(--target); }} }}
.bar-value {{ width: 32px; font-size: 11.5px; font-weight: 500; color: var(--muted); text-align: right; }}

.project-areas {{ display: flex; flex-direction: column; gap: 10px; margin-bottom: 24px; }}
.area-card {{ background: var(--surface); border-radius: var(--radius-outer); padding: 14px 18px;
  box-shadow: var(--shadow-sm); }}
.area-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }}
.area-name {{ font-weight: 600; font-size: 14px; color: var(--ink); }}
.area-count {{ font-size: 11px; color: var(--muted); background: #f1f5f9; padding: 3px 9px; border-radius: var(--radius-pill); }}
.area-sample {{ font-size: 12px; color: var(--muted); font-family: 'SF Mono', ui-monospace, monospace; }}

.big-wins {{ display: flex; flex-direction: column; gap: 8px; margin-bottom: 24px; }}
.big-win {{ background: var(--surface); border-radius: var(--radius-outer); padding: 12px 16px;
  box-shadow: var(--shadow-sm); border-left: 3px solid var(--emerald); }}
.big-win-title {{ font-weight: 500; color: var(--ink); font-size: 14px; line-height: 1.5; }}
.big-win-hash {{ font-size: 11px; color: var(--muted); margin-top: 3px; font-family: 'SF Mono', ui-monospace, monospace; }}

.friction-categories {{ display: flex; flex-direction: column; gap: 12px; margin-bottom: 24px; }}
.friction-category {{ background: var(--surface); border-radius: var(--radius-outer);
  padding: 16px 18px; box-shadow: var(--shadow-sm); }}
.friction-category.open {{ border-left: 3px solid var(--amber); }}
.friction-category.resolved {{ opacity: 0.72; border-left: 3px solid var(--emerald); }}
.friction-category.resolved .friction-title {{ text-decoration: line-through; }}
.friction-category.regression {{ border-left: 3px solid var(--red); }}
.friction-category.environmental {{ border-left: 3px solid var(--violet); }}
.friction-title {{ font-weight: 600; font-size: 15px; color: var(--ink); margin-bottom: 6px; display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }}
.friction-desc {{ font-size: 13px; color: var(--ink-2); margin-bottom: 10px; }}
.friction-note {{ font-size: 12px; color: #92400e; background: #fffbeb; padding: 8px 12px; border-radius: var(--radius-inner); margin-bottom: 10px; }}
.friction-examples {{ margin: 0 0 0 18px; font-size: 12.5px; color: var(--ink-2); list-style: none; }}
.friction-examples li {{ padding: 7px 0; border-top: 1px solid var(--line); }}
.friction-examples li:first-child {{ border-top: none; }}
.snippet {{ display: block; font-family: 'SF Mono', ui-monospace, monospace; font-size: 11.5px; color: var(--ink-2); word-break: break-word; }}
.meta {{ font-size: 10.5px; color: var(--muted); margin-top: 3px; display: block; }}
.ts {{ font-family: 'SF Mono', ui-monospace, monospace; }}
.ts.muted {{ opacity: 0.6; }}
.friction-citation {{ font-size: 11.5px; color: var(--muted); margin-top: 10px; font-style: italic; }}

.status-badge {{ display: inline-flex; align-items: center; font-size: 10px; font-weight: 700;
  padding: 3px 9px; border-radius: var(--radius-pill); letter-spacing: 0.05em;
  text-transform: uppercase; margin-left: 8px; flex-shrink: 0;
  animation: pop 0.3s cubic-bezier(0.2,0,0,1); }}
@keyframes pop {{ from {{ opacity: 0; transform: scale(0.25); }} to {{ opacity: 1; transform: scale(1); }} }}
.status-badge.open {{ background: var(--amber-bg); color: #92400e; }}
.status-badge.resolved {{ background: var(--emerald-bg); color: var(--emerald-ink); }}
.status-badge.regression {{ background: var(--red-bg); color: var(--red-ink); }}
.status-badge.environmental {{ background: var(--violet-bg); color: var(--violet-ink); }}

.env-section {{ background: #faf5ff; border-radius: var(--radius-outer); padding: 18px 22px; margin-top: 32px; box-shadow: var(--shadow-sm); }}
.regression-section {{ background: var(--red-bg); border-radius: var(--radius-outer); padding: 18px 22px; margin-top: 32px; box-shadow: var(--shadow-md); }}
.resolved-section {{ background: #f0fdf4; border-radius: var(--radius-outer); padding: 18px 22px; margin-top: 32px; box-shadow: var(--shadow-sm); }}
.ledger-item {{ padding: 10px 0; border-top: 1px solid rgba(16,185,129,0.2); }}
.ledger-item:first-child {{ border-top: none; }}
.ledger-topic {{ font-weight: 500; font-size: 13.5px; color: var(--ink); }}
.ledger-citation {{ font-size: 11.5px; color: var(--muted); margin-top: 3px; font-style: italic; }}

.section-intro {{ font-size: 13.5px; color: var(--muted); margin-bottom: 16px; }}
.empty {{ color: #94a3b8; font-size: 13px; }}

.debug-card {{ background: var(--surface); border-radius: var(--radius-outer); padding: 16px 18px;
  box-shadow: var(--shadow-sm); font-family: 'SF Mono', ui-monospace, 'Cascadia Mono', monospace;
  font-size: 12.5px; margin-bottom: 16px; line-height: 1.6; }}
.debug-card .chart-title {{ font-family: inherit; margin-bottom: 10px; }}
.health-badge {{ display: inline-flex; align-items: center; padding: 3px 9px; border-radius: var(--radius-pill);
  font-size: 10px; font-weight: 700; letter-spacing: 0.05em; text-transform: uppercase; margin-right: 8px;
  flex-shrink: 0; }}
.health-badge.healthy {{ background: var(--emerald-bg); color: var(--emerald-ink); }}
.health-badge.failing {{ background: var(--red-bg); color: var(--red-ink); }}
.hotspot-list {{ display: flex; flex-direction: column; gap: 6px; margin-bottom: 24px; }}
.hotspot-row {{ display: flex; align-items: center; background: var(--surface); border-radius: var(--radius-inner);
  padding: 10px 14px; box-shadow: var(--shadow-sm); gap: 12px; }}
.hotspot-rank {{ width: 26px; height: 26px; flex-shrink: 0; border-radius: 50%; background: var(--violet-bg);
  color: var(--violet-ink); display: inline-flex; align-items: center; justify-content: center;
  font-size: 11px; font-weight: 700; font-family: 'SF Mono', ui-monospace, monospace; }}
.hotspot-path {{ flex: 1; font-size: 12px; color: var(--ink-2); font-family: 'SF Mono', ui-monospace, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
.hotspot-count {{ background: #f1f5f9; color: var(--muted); padding: 3px 9px; border-radius: var(--radius-pill);
  font-size: 11px; font-weight: 500; flex-shrink: 0; }}
.kv-grid {{ display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; margin: 16px 0 24px; }}
.kv-item {{ background: var(--surface); border-radius: var(--radius-outer); padding: 14px 16px;
  box-shadow: var(--shadow-sm); }}
.kv-label {{ font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }}
.kv-value {{ font-size: 22px; font-weight: 700; color: var(--ink); margin-top: 4px; letter-spacing: -0.02em; }}
.retry-list {{ list-style: none; margin: 0; }}
.retry-list li {{ padding: 8px 0; border-top: 1px solid var(--line); display: flex;
  justify-content: space-between; align-items: center; font-size: 12.5px; gap: 12px; }}
.retry-list li:first-child {{ border-top: none; }}
.retry-tool {{ color: var(--ink); font-weight: 500; font-family: 'SF Mono', ui-monospace, monospace; }}
.retry-count {{ color: var(--muted); flex-shrink: 0; }}

@media (max-width: 640px) {{
  .charts-row {{ grid-template-columns: 1fr; }}
  .stats-row {{ justify-content: center; }}
  .kv-grid {{ grid-template-columns: 1fr; }}
}}

@media (prefers-reduced-motion: reduce) {{
  .reveal, .bar-row, .bar-fill, .status-badge {{ animation: none !important; opacity: 1 !important; transform: none !important; width: var(--target, auto) !important; }}
}}
</style>
</head>
<body>
<div class="container">
<h1>Code Insights <span style="font-size:14px;font-weight:400;color:var(--muted);">(Context-Aware)</span></h1>
<div class="subtitle">Cross-referenced friction report — resolved issues stay suppressed.</div>
{banner}
{sections_html}
</div>
</body>
</html>'''

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    # Write to a user-private dir to avoid /tmp symlink races on shared hosts.
    out_dir = os.path.join(os.path.expanduser("~"), ".ncode", "insights-reports")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, f"insights-context-{ts}.html")
    with open(out_path, "w") as f:
        f.write(html_out)
    print(out_path)
    return out_path


if __name__ == "__main__":
    path = main()
    # Best-effort browser open (platform-aware: macOS uses `open`, Linux uses
    # `xdg-open`). Non-fatal — the path is already printed by main().
    try:
        import platform
        opener = "open" if platform.system() == "Darwin" else "xdg-open"
        subprocess.run([opener, path], check=False, timeout=5)
    except Exception:
        pass