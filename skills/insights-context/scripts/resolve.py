#!/usr/bin/env python3
"""insights-context — build the RESOLVED + ENVIRONMENTAL ledger dynamically.

Usage: resolve.py <memory_dir> <repo_path> [ncode_repo_path]

Emits JSON on stdout: [{topic, source, citation, evidence_keywords,
                       fixed_at, why, is_environmental}]

Sources, in priority order:
  1. feedback_*.md and project_*.md memory files in <memory_dir>
  2. fix/hotfix/resolve/repair commits in <repo_path> (last 30 days)
  3. (optional) same commit filter in <ncode_repo_path>

Environmental entries (memory files documenting environmental conditions, not
code regressions) are flagged is_environmental=true so the renderer can route
them to a distinct section instead of the Resolved Friction ledger.
"""
import os, re, json, sys, subprocess
from pathlib import Path
from datetime import datetime

# --- Redaction (mirrors scan.py) --------------------------------------------
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
    (re.compile(r"gh[pousr]_[A-Za-z0-9]{36,}"), "<redacted-github-token>"),
    # GitHub identity: redact the noreply email form (numeric-id+handle) and the
    # /users/<numeric-id> profile URL so neither leaks via evidence_keywords in
    # --json output. Mirrors scan.py.
    (re.compile(r"\b\d+\+[\w-]+@users\.noreply\.github\.com\b", re.I),
     "<redacted-github-email>"),
    (re.compile(r"https?://github\.com/users/\d+", re.I),
     "<redacted-github-url>"),
]

# Per-user identity tokens (surname, handles, IDs) loaded from
# ~/.ncode/identity-redact.txt if present. Kept out of source so the script
# itself can be public without leaking the tokens it scrubs. Mirrors scan.py.
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
# Scrub any /Users/<name>/ — not just the current user's home. CI paths like
# /Users/runner/work/... also leak identity and machine details. Mirrors scan.py.
OTHER_USERS_RE = re.compile(r"/Users/[^/\s\"']+", re.I)

def redact(text):
    if not text:
        return text
    for pat, repl in REDACT_PATTERNS:
        text = pat.sub(repl, text)
    if HOME_RE:
        text = HOME_RE.sub("~", text)
    if USERNAME_RE:
        text = USERNAME_RE.sub("<redacted>", text)
    text = OTHER_USERS_RE.sub("~", text)
    for pat in _IDENTITY_TOKENS:
        text = pat.sub("<redacted>", text)
    return text

GENERIC = {
    "the","this","that","with","from","have","they","their","when","then",
    "than","will","would","should","could","must","may","can","for","not",
    "yet","new","old","code","case","line","file","side","work","here","call",
    "type","first","next","last","skipping","session","settings","without",
    "explicit","because","through","between","what","which","where","while",
    "after","before","make","made","used","using","user","users","your",
    "true","false","null","void","memory","files","just","only","also",
    "such","more","most","does","done","each","into","over","onto","upon",
}

ENV_MARKERS = [
    "environmental", "not a code regression", "not a regression",
    "known condition", "environmental condition",
    "data volume", "disk full", "apfs",
]

# PascalCase symbol regex (matches scan.py's IDENTIFIER_RE) — used to harvest
# code-symbol signal_keys from memory prose and commit subjects so the matcher
# can correlate friction items to resolved entries by shared code symbols, not
# just by file path or commit hash.
SYMBOL_RE = re.compile(r"\b([A-Z][a-zA-Z0-9]{4,40})\b")
PATH_IN_PROSE_RE = re.compile(r"[\w./\-]+/[\w./\-]+\.\w+")
COMMIT_HASH_RE = re.compile(r"\b([0-9a-f]{7,40})\b")

def parse_memory_file(path):
    with open(path) as f:
        content = f.read()
    fm = {}
    fm_match = re.match(r"^---\n(.*?)\n---\n(.*)$", content, re.DOTALL)
    if fm_match:
        for line in fm_match.group(1).split("\n"):
            if ":" in line:
                k, _, v = line.partition(":")
                fm[k.strip()] = v.strip()
    name = fm.get("name", path.stem)
    desc = fm.get("description", "")
    body = fm_match.group(2) if fm_match else content

    why_match = re.search(r"\*\*Why:\*\*\s*(.+?)(?=\n\*\*|\Z)", body, re.DOTALL)
    why = why_match.group(1).strip() if why_match else ""
    how_match = re.search(r"\*\*How to apply:\*\*\s*(.+?)(?=\n\*\*|\Z)", body, re.DOTALL)
    how = how_match.group(1).strip() if how_match else ""

    text = f"{name} {desc} {why} {how}"
    keywords = set()
    prose_paths = sorted({m.group().lower() for m in PATH_IN_PROSE_RE.finditer(text)})
    prose_commits = sorted({m.group().lower() for m in COMMIT_HASH_RE.finditer(text)})
    prose_symbols = sorted({m.group() for m in SYMBOL_RE.finditer(text)})
    for m in re.finditer(r"[\w./\-]+/[\w./\-]+\.\w+", text):
        keywords.add(m.group().lower())
    for m in re.finditer(r"\b([a-z][a-zA-Z0-9\-]{4,30})\b", text):
        kw = m.group(1).lower()
        if kw not in GENERIC and len(kw) >= 5 and re.search(r"[a-z]{3,}", kw):
            keywords.add(kw)
    for m in re.finditer(r"\b([0-9a-f]{7,40})\b", text):
        keywords.add(m.group().lower())
    for t in re.findall(r"`([^`]+)`", text):
        t = t.strip().lower()
        if 3 <= len(t) <= 50 and not t.startswith("$"):
            keywords.add(t.split()[0])

    is_env = any(marker in content.lower() for marker in ENV_MARKERS)

    citation = f"memory {path.name}"
    commits_in_text = re.findall(r"\b([0-9a-f]{7,40})\b", text)
    if commits_in_text:
        citation = f"commit(s) {', '.join(set(commits_in_text))} via memory {path.name}"

    # Use the LAST ISO date in text — memory files describe the problem first
    # (issue date) then the fix, so the last date is the most reliable proxy
    # for when the fix landed. However, when a date is explicitly tied to a
    # fix/resolve/patch keyword in nearby prose, prefer that over the naive
    # last-position heuristic — "originally seen 2023-12-15, fixed 2024-01-01"
    # would otherwise pick the seen-date when the prose order is reversed.
    all_dates = re.findall(r"\b(\d{4}-\d{2}-\d{2})\b", text)
    fixed_at = all_dates[-1] if all_dates else None
    if all_dates:
        fix_context_re = re.compile(
            r"(?i)(fixed|fixes|resolved|resolves|patched|repaired|landed|merged|shipped)"
            r"[^\d]{0,40}(\d{4}-\d{2}-\d{2})"
        )
        context_dates = [m.group(2) for m in fix_context_re.finditer(text)]
        if context_dates:
            # Latest date explicitly anchored to a fix-keyword wins.
            fixed_at = sorted(context_dates)[-1]

    # For project_* memories (non-feedback), these are context/condition notes,
    # not necessarily fixes. Mark them as contextual-unless-they-clearly-describe-a-fix.
    is_feedback = path.name.startswith("feedback_")
    if not is_feedback and not is_env:
        # project_* memory: only counts as a resolution if it explicitly references
        # a fix (commit hash or "fixed"/"resolved"/"stripped" language)
        has_fix_signal = bool(commits_in_text) or any(
            w in content.lower() for w in ["fixed", "resolved", "stripped", "removed", "patched", "disabled"]
        )
        if not has_fix_signal:
            return None

    return {
        "topic": redact(name),
        "source": f"memory {path.name}",
        "citation": redact(citation),
        "evidence_keywords": sorted(redact(k) for k in keywords)[:30],
        "signal_keys": {
            "paths": [redact(p) for p in prose_paths][:30],
            "commits": [redact(c) for c in prose_commits][:12],
            "symbols": [redact(s) for s in prose_symbols][:12],
        },
        "fixed_at": fixed_at,
        "is_environmental": is_env,
    }

def parse_git_log(repo, since="30 days ago"):
    try:
        out = subprocess.check_output(
            ["git", "-C", repo, "log", f"--since={since}", "--date=short",
             "--pretty=format:%H%x09%h%x09%ad%x09%s%x09%b%n---"],
            text=True, stderr=subprocess.DEVNULL, timeout=30
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return []
    commits = []
    for entry in out.split("---\n"):
        entry = entry.strip()
        if not entry: continue
        # Git pads the body separator with a newline when the body is empty,
        # so a 4-field split (no body) used to be skipped as "len < 5". Pad
        # the body to empty so fix commits with no body still classify.
        parts = entry.split("\t", 4)
        if len(parts) == 4:
            parts.append("")
        if len(parts) < 5: continue
        _full, short_hash, author_date, subject, body = parts
        if not re.match(r"^(fix|hotfix|patch|repair|resolve)", subject, re.I):
            continue
        text = f"{subject} {body}"
        keywords = set()
        for m in re.finditer(r"\b([a-z][a-zA-Z0-9\-_/.]{4,40})\b", text):
            kw = m.group(1).lower()
            if kw not in GENERIC:
                keywords.add(kw)
        # fixed_at = commit's author date (YYYY-MM-DD via --date=short). The
        # previous body-regex was unreliable — bodies rarely carry a bare date,
        # so commit-based resolved entries had fixed_at=None and the matcher
        # could never classify pre-fix vs post-fix friction.
        fixed_at = author_date if re.match(r"\d{4}-\d{2}-\d{2}$", author_date) else None
        # Harvest touched file paths for this commit so the matcher can correlate
        # friction items to fixes by shared file path — the highest-precision
        # signal (commit hash + path overlap catches the verification/cancellation
        # <-> OnDemandVerificationStore.swift case the bucket-label matcher missed).
        touched_paths = []
        try:
            show_out = subprocess.check_output(
                ["git", "-C", repo, "show", "--name-only",
                 "--pretty=format:", short_hash],
                text=True, stderr=subprocess.DEVNULL, timeout=15
            )
            touched_paths = [redact(p) for p in show_out.splitlines()
                             if p.strip() and not p.startswith("commit ")]
        except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
            pass
        commit_symbols = sorted({m.group() for m in SYMBOL_RE.finditer(text)})
        commits.append({
            "topic": redact(subject),
            "source": f"commit {short_hash}",
            "citation": redact(f"commit {short_hash} — {subject}"),
            "evidence_keywords": sorted(redact(k) for k in keywords)[:20],
            "signal_keys": {
                "commits": [short_hash],
                "paths": touched_paths[:30],
                "symbols": [redact(s) for s in commit_symbols][:12],
            },
            "fixed_at": fixed_at,
            "is_environmental": False,
        })
    return commits

def main():
    memory_dir = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / ".ncode" / "memory"
    repo_path = sys.argv[2] if len(sys.argv) > 2 else os.getcwd()
    ncode_repo = sys.argv[3] if len(sys.argv) > 3 else None

    resolved = []
    if memory_dir.exists():
        for pattern in ("feedback_*.md", "project_*.md"):
            for mf in sorted(memory_dir.glob(pattern)):
                try:
                    entry = parse_memory_file(mf)
                    if entry:
                        resolved.append(entry)
                except Exception:
                    pass
    for c in parse_git_log(repo_path):
        resolved.append(c)
    if ncode_repo and os.path.isdir(ncode_repo):
        for c in parse_git_log(ncode_repo):
            resolved.append(c)

    print(json.dumps(resolved, indent=2, default=str))

if __name__ == "__main__":
    main()