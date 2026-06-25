#!/usr/bin/env python3
"""insights-context — compare two scan JSON snapshots and surface deltas.

Usage: compare.py <current.json> <previous.json>

Both inputs are the JSON output of scan.py. Emits a delta JSON on stdout
showing direction (up/down/flat) and absolute change per metric, plus
shift-in-topic for friction buckets. Designed to be called by the parent
/insights-context --compare workflow; not intended for direct user use.

The goal is to turn the snapshot into a feedback loop: did friction drop
after the last round of fixes, or did it just shift to a different topic?
"""
import json, os, sys, time
from collections import Counter

if len(sys.argv) < 3:
    print("Usage: compare.py <current.json> <previous.json>", file=sys.stderr)
    sys.exit(1)

with open(sys.argv[1]) as f: cur = json.load(f)
with open(sys.argv[2]) as f: prev = json.load(f)

def delta(key):
    a = cur.get(key, 0) or 0
    b = prev.get(key, 0) or 0
    d = a - b
    if b == 0:
        direction = "new" if a > 0 else "flat"
        pct = None
    else:
        pct = round((d / b) * 100, 1)
        if d == 0: direction = "flat"
        elif d > 0: direction = "up"
        else: direction = "down"
    return {"cur": a, "prev": b, "delta": d, "pct": pct, "direction": direction}

# Numeric metrics — straight deltas
numeric_keys = [
    "friction_total", "user_interruptions", "informational_interrupts",
    "compaction_events", "summary_messages_count", "summary_overhead_tokens_est",
    "input_tokens", "output_tokens", "cache_creation_tokens",
    "cache_read_tokens", "total_prompt_processed", "unique_prompt_max",
    "git_commits", "git_pushes", "loop_total", "parallel_tool_calls",
    "sessions_in_time_window", "sessions_scanned",
]
numeric = {k: delta(k) for k in numeric_keys}

# Per-topic friction counts — cur vs prev topics with shift detection
cur_topics = Counter()
prev_topics = Counter()
for label, items in cur.get("friction_by_topic", {}).items():
    cur_topics[label] = len(items)
for label, items in prev.get("friction_by_topic", {}).items():
    prev_topics[label] = len(items)

all_topics = set(cur_topics) | set(prev_topics)
topic_shift = []
for t in all_topics:
    c = cur_topics.get(t, 0)
    p = prev_topics.get(t, 0)
    d = c - p
    if d == 0: continue
    direction = "new" if p == 0 and c > 0 else ("gone" if c == 0 else ("up" if d > 0 else "down"))
    topic_shift.append({"topic": t, "cur": c, "prev": p, "delta": d, "direction": direction})
topic_shift.sort(key=lambda x: abs(x["delta"]), reverse=True)

# Loop top pairs — most common A-B loop tools in each window
loops_cur = Counter(cur.get("loop_sessions", {}))
loops_prev = Counter(prev.get("loop_sessions", {}))
loop_shift = []
for k in set(loops_cur) | set(loops_prev):
    c = loops_cur.get(k, 0); p = loops_prev.get(k, 0)
    d = c - p
    if d == 0: continue
    loop_shift.append({"tools": k, "cur": c, "prev": p, "delta": d})

out = {
    "current_window_days": cur.get("scan_window_days"),
    "previous_window_days": prev.get("scan_window_days"),
    "numeric": numeric,
    "topics": topic_shift[:20],
    "loop_pairs": loop_shift,
}

# Output mode: default JSON to stdout. If invoked with `--html <path>` as
# the 3rd+ args, render a standalone HTML delta report to that path and
# print only the path. The HTML matches the main report's CSS vocabulary
# (.stats-row, .stat, .debug-card, .tabular) so it visually composes.
import html as _html

def _arrow(direction):
    return {"up":"▲","down":"▼","flat":"▬","new":"","gone":""}.get(direction, "·")

def _color(direction):
    # up/down coloring is metric-aware: for friction/loops/time "up" is bad
    # (red), for commits/wins "up" is good (green). We don't know polarity
    # per-metric here, so we color by direction neutrally and let the reader
    # interpret. Amber for flat-ish, green for down-bad-metrics is left to
    # the consumer.
    return {"up":"var(--red)","down":"var(--emerald)","flat":"var(--muted)",
            "new":"var(--emerald)","gone":"var(--muted)"}.get(direction, "var(--muted)")

if len(sys.argv) >= 4 and sys.argv[3] == "--html":
    out_path = sys.argv[4] if len(sys.argv) >= 5 else os.path.join(
        os.path.expanduser("~"), ".ncode", "insights-reports",
        f"insights-delta-{time.strftime('%Y%m%d-%H%M%S')}.html")
    rows_html = ""
    for k, v in numeric.items():
        if v["direction"] == "flat" and v["delta"] == 0:
            continue  # skip no-change metrics to keep the delta report tight
        arrow = _arrow(v["direction"])
        pct_s = f" ({v['pct']:+.1f}%)" if v["pct"] is not None else ""
        rows_html += (
            f'<tr>'
            f'<td style="padding:6px 10px">{_html.escape(k.replace("_"," "))}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right">{v["prev"]:,}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right">{v["cur"]:,}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right;color:{_color(v["direction"])}">'
            f'{arrow} {v["delta"]:+,}{pct_s}</td>'
            f'</tr>'
        )
    topics_html = ""
    for t in out["topics"]:
        arrow = _arrow(t["direction"])
        topics_html += (
            f'<tr>'
            f'<td style="padding:6px 10px">{_html.escape(t["topic"])}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right">{t["prev"]}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right">{t["cur"]}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right;color:{_color(t["direction"])}">'
            f'{arrow} {t["delta"]:+d}</td>'
            f'</tr>'
        )
    loops_html = ""
    for lp in out["loop_pairs"]:
        arrow = _arrow("up" if lp["delta"]>0 else "down")
        loops_html += (
            f'<tr>'
            f'<td style="padding:6px 10px">{_html.escape(lp["tools"])}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right">{lp["prev"]}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right">{lp["cur"]}</td>'
            f'<td class="tabular" style="padding:6px 10px;text-align:right;color:{_color("up" if lp["delta"]>0 else "down")}">'
            f'{arrow} {lp["delta"]:+d}</td>'
            f'</tr>'
        )
    cur_days = out["current_window_days"] or "?"
    prev_days = out["previous_window_days"] or "?"
    page = f"""<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Insights Delta — {cur_days}d vs {prev_days}d</title>
<style>
  :root {{ --bg:#0d1117; --fg:#c9d1d9; --muted:#8b949e; --border:#30363d;
           --emerald:#3fb950; --red:#f85149; --amber:#d29922; --card:#161b22; }}
  body {{ background:var(--bg); color:var(--fg); font-family:-apple-system,system-ui,sans-serif;
         margin:0 auto; max-width:900px; padding:24px; }}
  h1 {{ font-size:22px; margin:0 0 4px; }}
  h2 {{ font-size:17px; margin:28px 0 10px; border-bottom:1px solid var(--border); padding-bottom:6px; }}
  .intro {{ color:var(--muted); font-size:13px; margin:0 0 20px; }}
  table {{ width:100%; border-collapse:collapse; font-size:13px; }}
  th {{ text-align:left; padding:6px 10px; border-bottom:1px solid var(--border);
        color:var(--muted); font-weight:600; font-size:11px; text-transform:uppercase; letter-spacing:.04em; }}
  .tabular {{ font-variant-numeric: tabular-nums; font-family:ui-monospace,SFMono-Regular,monospace; }}
  .card {{ background:var(--card); border:1px solid var(--border); border-radius:8px; padding:16px; margin-bottom:16px; }}
  .empty {{ color:var(--muted); font-style:italic; padding:12px; }}
</style></head>
<body>
<h1>Insights Delta Report</h1>
<p class="intro">Comparing current {cur_days}-day window vs previous {prev_days}-day window.
▲ up · down · new topic · topic gone.</p>
<h2>Metric deltas</h2>
<div class="card"><table><thead><tr>
<th>Metric</th><th style="text-align:right">Previous</th>
<th style="text-align:right">Current</th><th style="text-align:right">Delta</th>
</tr></thead><tbody>{rows_html or '<tr><td colspan="4" class="empty">No metric changes.</td></tr>'}</tbody></table></div>
<h2>Friction topic shifts</h2>
<div class="card"><table><thead><tr>
<th>Topic</th><th style="text-align:right">Previous</th>
<th style="text-align:right">Current</th><th style="text-align:right">Shift</th>
</tr></thead><tbody>{topics_html or '<tr><td colspan="4" class="empty">No topic changes.</td></tr>'}</tbody></table></div>
<h2>Loop pair shifts</h2>
<div class="card"><table><thead><tr>
<th>Tool pair</th><th style="text-align:right">Previous</th>
<th style="text-align:right">Current</th><th style="text-align:right">Shift</th>
</tr></thead><tbody>{loops_html or '<tr><td colspan="4" class="empty">No loop-pair changes.</td></tr>'}</tbody></table></div>
</body></html>"""
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w") as f:
        f.write(page)
    # Try to open in default browser (best-effort, non-fatal). Platform-aware:
    # macOS uses `open`, Linux uses `xdg-open`.
    try:
        import subprocess, platform
        opener = "open" if platform.system() == "Darwin" else "xdg-open"
        subprocess.run([opener, out_path], check=False, timeout=5)
    except Exception:
        pass
    print(out_path)
else:
    print(json.dumps(out, indent=2, default=str))