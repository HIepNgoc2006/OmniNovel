#!/usr/bin/env python3
"""
TruffleHog Fail-Closed Secret Scan Wrapper & Regression Gate (P0 + P1 Scoped Detection)

Pass 1 (P0):
  Runs TruffleHog `--only-verified` across all built-in detectors with strict git
  ref resolution (`pull_request`, `push`, `workflow_dispatch`, `schedule`) and
  fail-closed invariants (crash/error logs/missing summary/0-chunk/0-byte blocking).

Pass 2 (P1 Scoped Secret Detection):
  Runs TruffleHog `--no-verification --results=verified,unverified` scoped to:
    - PrivateKey (including Verified=false)
    - CustomRegex:OmniNovelJwtSecret (JWT_SECRET, JWT_REFRESH_SECRET)
    - CustomRegex:OmniNovelAiWorkerSecret (AI_WORKER_SECRET)
    - CustomRegex:OmniNovelRedisPassword (REDIS_PASSWORD, redis:// URI, CLI auth)
    - CustomRegex:OmniNovelDatabaseUrl + Postgres (DATABASE_URL with credentials)
    - CustomRegex:OmniNovelS3R2Credentials + AWS + Cloudflare* (R2 / S3 credentials)

  Enforces:
    1. No blanket exclusions for tests/, docs/, or plans/ (exact POSIX paths only).
    2. No prefix-based exemption for dummy_, fake_, or mock_ strings.
    3. Cryptographic salted PBKDF2-SHA256 (>= 100k iterations) matching against
       explicit controlled-fixture (`dummy`) or `approved_false_positive` entries
       requiring path, detector, fingerprint, owner, rationale, and unexpired expiry.
    4. Auditable classification (`verified`, `unverified`, `approved_false_positive`, `dummy`).
    5. Strict zero-leakage log/exception sanitization (no raw secrets or weak hashes).
    6. Fail-closed handling on scanner errors, parse errors, missing summary, or 0-byte scans.
"""

import argparse
import base64
from dataclasses import dataclass, field
import datetime
import hashlib
import hmac
import json
import os
import re
import secrets
import shutil
import struct
import subprocess
import sys
import tempfile
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

TRUFFLEHOG_IMAGE = (
    "ghcr.io/trufflesecurity/trufflehog:3.88.16"
    "@sha256:7c7ff780dcd224cbb1da6005986a18e40da541fb4a75c5b05967840ae60c2e85"
)
PASS2_INCLUDE_DETECTORS = (
    "PrivateKey,Postgres,AWS,"
    "CloudflareApiToken,CloudflareGlobalApiKey,CloudflareCaKey,CustomRegex"
)
DEFAULT_PASS2_CONFIG_REL = os.path.join("deploy", "security", "trufflehog-p1-detectors.yaml")
DEFAULT_ALLOWLIST_REL = os.path.join("deploy", "security", "secret-scan-allowlist.json")
SCRIPT_REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))

ZERO_SHA = "0" * 40
SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")
DUMMY_CANARY_PREFIX = "OMNINOVEL_DUMMY_" + "CANARY_"

DOMAIN_TAG = "omninovel-p1"
MIN_PBKDF2_ITERATIONS = 100_000
VALID_CLASSIFICATIONS = frozenset({"dummy", "approved_false_positive"})
DISALLOWED_GLOB_CHARS = frozenset({"*", "?", "[", "]", "{", "}", "\\"})
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
FINGERPRINT_RE = re.compile(
    r"^pbkdf2_sha256\$([0-9]+)\$([0-9a-fA-F]{32,128})\$([0-9a-fA-F]{64})$"
)

# Defensive regex patterns for scrubbing sensitive material out of logs & exceptions.
_SCRUB_PATTERNS = (
    re.compile(r'("(?:Raw|RawV2|Redacted)"\s*:\s*")((?:[^"\\]|\\.)*)(")', re.IGNORECASE),
    re.compile(r'("SecretParts"\s*:\s*)\{[^}]*\}', re.IGNORECASE),
    re.compile(r"-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----"),
    re.compile(r"pbkdf2_sha256\$\d+\$[0-9a-fA-F]+\$[0-9a-fA-F]+"),
    re.compile(r"\b(?:postgres(?:ql)?|rediss?|mysql|mongodb(?:\+srv)?)://[^:\s\"'`<>\]\[]+:[^@\s\"'`<>\]\[]+@[^\s\"'`<>\r\n]+", re.IGNORECASE),
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    re.compile(r'(?i)\b(?:jwt_secret|jwt_refresh_secret|ai_worker_secret|redis_password|password|passwd|secret_key|secret_access_key|api_token|api_key|access_token|refresh_token|private_key|token)\b[ \t]*[:=][ \t]*["\']?[^\s"\'`,;()<>\r\n]{3,}["\']?'),
    re.compile(r'(?i)\b(?:sha256|sha1|md5|sha512)[$:][0-9a-fA-F]{32,128}\b'),
)


class ScanGateError(RuntimeError):
    """Raised when git ref resolution, config/allowlist validation, or preflight fails."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ScanRange:
    event: str
    since_commit: Optional[str]
    branch: str
    commit_count: int
    changed_files: List[str]
    require_nonzero_input: bool = True


@dataclass(frozen=True)
class AllowlistEntry:
    id: str
    classification: str
    path: str
    detector: str
    iterations: int
    salt_bytes: bytes
    digest_bytes: bytes
    owner: str
    rationale: str
    expiry: datetime.date


@dataclass
class AllowlistStore:
    entries: List[AllowlistEntry]
    by_path_detector: Dict[Tuple[str, str], List[AllowlistEntry]]
    audit_date: datetime.date


@dataclass(frozen=True)
class ScanEvaluation:
    passed: bool
    errors: List[str]
    chunks: int
    bytes_scanned: int
    verified_secrets: int
    unverified_secrets: int
    scan_duration: str
    findings_redacted: List[Dict[str, Any]]
    verified_count: int = 0
    unverified_count: int = 0
    approved_false_positive_count: int = 0
    dummy_count: int = 0


def compute_salted_fingerprint(
    path: str,
    detector: str,
    raw_secret: str,
    salt: Optional[bytes] = None,
    iterations: int = 120_000,
) -> str:
    """Compute a non-reversible, salted PBKDF2-SHA256 allowlist fingerprint."""
    if iterations < MIN_PBKDF2_ITERATIONS:
        raise ValueError(f"iterations must be >= {MIN_PBKDF2_ITERATIONS}")
    salt_bytes = salt if salt is not None else os.urandom(16)
    norm_path = path.replace("\\", "/").strip()
    payload = f"{DOMAIN_TAG}\x00{norm_path}\x00{detector}\x00{raw_secret}".encode("utf-8")
    digest = hashlib.pbkdf2_hmac("sha256", payload, salt_bytes, iterations).hex()
    return f"pbkdf2_sha256${iterations}${salt_bytes.hex()}${digest}"


def _extract_raw_strings(obj: Dict[str, Any]) -> List[str]:
    """Collect all sensitive secret strings present inside a raw TruffleHog JSON finding."""
    vals: List[str] = []
    for key in ("Raw", "RawV2", "Redacted"):
        val = obj.get(key)
        if isinstance(val, str) and val:
            vals.append(val)

    def _collect_nested(node: Any) -> None:
        if isinstance(node, str) and node:
            vals.append(node)
        elif isinstance(node, dict):
            for v in node.values():
                _collect_nested(v)
        elif isinstance(node, list):
            for v in node:
                _collect_nested(v)

    if "SecretParts" in obj:
        _collect_nested(obj.get("SecretParts"))
    return vals


def _canonical_secret_value(obj: Dict[str, Any]) -> str:
    """Return canonical secret payload for allowlist verification (`RawV2` preferred)."""
    raw_v2 = obj.get("RawV2")
    if isinstance(raw_v2, str) and raw_v2:
        return raw_v2
    raw = obj.get("Raw")
    if isinstance(raw, str):
        return raw
    return ""


def _canonical_detector_name(obj: Dict[str, Any]) -> str:
    det = str(obj.get("DetectorName") or "unknown")
    if det == "CustomRegex":
        extra = obj.get("ExtraData") or {}
        if isinstance(extra, dict) and extra.get("name"):
            return f"CustomRegex:{extra['name']}"
    return det


def _scrub_sensitive_text(text: str, extra_secrets: Iterable[str] = ()) -> str:
    """Remove any known secret values, raw JSON payload fields, PEMs, or fingerprints."""
    scrubbed = text or ""
    # Replace longest secrets first so partial shorter overlaps cannot expose suffixes
    unique_secrets = sorted(
        {s for s in extra_secrets if isinstance(s, str) and len(s) >= 4},
        key=len,
        reverse=True,
    )
    for sec in unique_secrets:
        if sec in scrubbed:
            scrubbed = scrubbed.replace(sec, "[REDACTED_SECRET]")

    for idx, pat in enumerate(_SCRUB_PATTERNS):
        if idx == 0:
            scrubbed = pat.sub(r"\1[REDACTED_SECRET]\3", scrubbed)
        elif idx == 1:
            scrubbed = pat.sub(r'\1{"redacted":"[REDACTED_SECRET]"}', scrubbed)
        else:
            scrubbed = pat.sub("[REDACTED_SECRET]", scrubbed)
    return scrubbed


def _safe_error_summary(exc: BaseException, extra_secrets: Iterable[str] = ()) -> str:
    """Format an exception safely without stack-frame locals or secret leaks."""
    return f"{type(exc).__name__}: {_scrub_sensitive_text(str(exc), extra_secrets)}"


def _validate_exact_posix_path(raw_path: Any, entry_id: str) -> str:
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise ScanGateError(
            "INVALID_ALLOWLIST_PATH",
            f"Allowlist entry '{entry_id}' has empty or non-string path.",
        )
    path = raw_path.strip().replace("\\", "/")
    if raw_path != path:
        raise ScanGateError(
            "INVALID_ALLOWLIST_PATH",
            f"Allowlist entry '{entry_id}' must use normalized POSIX paths without backslashes/whitespace.",
        )
    if any(ch in DISALLOWED_GLOB_CHARS for ch in path):
        raise ScanGateError(
            "INVALID_ALLOWLIST_PATH",
            f"Allowlist entry '{entry_id}' path '{path}' contains disallowed glob/wildcard syntax.",
        )
    if path.startswith("/") or path.endswith("/") or "//" in path:
        raise ScanGateError(
            "INVALID_ALLOWLIST_PATH",
            f"Allowlist entry '{entry_id}' path '{path}' must be an exact repo-relative file path, not a root/directory pattern.",
        )
    parts = path.split("/")
    if any(part in ("", ".", "..") for part in parts):
        raise ScanGateError(
            "INVALID_ALLOWLIST_PATH",
            f"Allowlist entry '{entry_id}' path '{path}' contains invalid path segments.",
        )
    return path


def load_and_validate_allowlist(
    allowlist_path: str,
    audit_date: Optional[datetime.date] = None,
) -> AllowlistStore:
    """Load, validate schema/lifecycle/constraints, and index the P1 allowlist fail-closed."""
    eff_date = audit_date or datetime.date.today()
    if not os.path.isfile(allowlist_path):
        raise ScanGateError(
            "ALLOWLIST_MISSING",
            f"Required P1 allowlist file not found at '{allowlist_path}'.",
        )

    try:
        with open(allowlist_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except Exception as exc:
        raise ScanGateError(
            "ALLOWLIST_CORRUPT",
            f"Failed to parse P1 allowlist JSON at '{allowlist_path}': {_safe_error_summary(exc)}",
        ) from exc

    if not isinstance(data, dict):
        raise ScanGateError("ALLOWLIST_INVALID", "Allowlist root must be a JSON object.")
    if data.get("schema_version") != 1:
        raise ScanGateError(
            "ALLOWLIST_INVALID",
            f"Unsupported allowlist schema_version: {data.get('schema_version')!r}.",
        )
    if data.get("kdf") != "pbkdf2_sha256":
        raise ScanGateError(
            "ALLOWLIST_INVALID",
            f"Unsupported allowlist KDF '{data.get('kdf')!r}'; expected 'pbkdf2_sha256'.",
        )
    raw_min_iter = data.get("min_iterations")
    if not isinstance(raw_min_iter, int) or raw_min_iter < MIN_PBKDF2_ITERATIONS:
        raise ScanGateError(
            "ALLOWLIST_INVALID",
            f"Allowlist min_iterations must be >= {MIN_PBKDF2_ITERATIONS}.",
        )
    raw_entries = data.get("entries")
    if not isinstance(raw_entries, list):
        raise ScanGateError("ALLOWLIST_INVALID", "Allowlist 'entries' must be a list.")

    seen_ids: Set[str] = set()
    entries: List[AllowlistEntry] = []
    by_path_detector: Dict[Tuple[str, str], List[AllowlistEntry]] = {}

    for idx, item in enumerate(raw_entries):
        if not isinstance(item, dict):
            raise ScanGateError("ALLOWLIST_INVALID", f"Allowlist entry at index {idx} is not an object.")

        entry_id = str(item.get("id") or "").strip()
        if not entry_id:
            raise ScanGateError("ALLOWLIST_INVALID", f"Allowlist entry at index {idx} missing 'id'.")
        if entry_id in seen_ids:
            raise ScanGateError("ALLOWLIST_DUPLICATE_ID", f"Duplicate allowlist entry id '{entry_id}'.")
        seen_ids.add(entry_id)

        cls = str(item.get("classification") or "").strip()
        if cls not in VALID_CLASSIFICATIONS:
            raise ScanGateError(
                "INVALID_ALLOWLIST_CLASSIFICATION",
                f"Entry '{entry_id}' has invalid classification '{cls}'; expected dummy or approved_false_positive.",
            )

        path = _validate_exact_posix_path(item.get("path"), entry_id)

        detector = str(item.get("detector") or "").strip()
        if not detector or "*" in detector or "?" in detector:
            raise ScanGateError(
                "INVALID_ALLOWLIST_DETECTOR",
                f"Entry '{entry_id}' has invalid/wildcard detector '{detector}'.",
            )

        fp_str = str(item.get("fingerprint") or "").strip()
        fp_match = FINGERPRINT_RE.match(fp_str)
        if not fp_match:
            raise ScanGateError(
                "INVALID_ALLOWLIST_FINGERPRINT",
                f"Entry '{entry_id}' fingerprint must be salted pbkdf2_sha256 format (plaintext/unsalted hashes forbidden).",
            )
        iters = int(fp_match.group(1))
        if iters < max(MIN_PBKDF2_ITERATIONS, raw_min_iter):
            raise ScanGateError(
                "INVALID_ALLOWLIST_FINGERPRINT",
                f"Entry '{entry_id}' PBKDF2 iteration count {iters} below required minimum.",
            )
        salt_bytes = bytes.fromhex(fp_match.group(2))
        digest_bytes = bytes.fromhex(fp_match.group(3))

        owner = str(item.get("owner") or "").strip()
        if not owner or owner.lower() in {"todo", "unknown", "tbd", "none"}:
            raise ScanGateError(
                "INVALID_ALLOWLIST_ENTRY",
                f"Entry '{entry_id}' missing valid non-placeholder 'owner'.",
            )

        rationale = str(item.get("rationale") or "").strip()
        if len(rationale) < 10:
            raise ScanGateError(
                "INVALID_ALLOWLIST_ENTRY",
                f"Entry '{entry_id}' missing meaningful 'rationale' (>= 10 chars).",
            )

        expiry_str = str(item.get("expiry") or "").strip()
        if not DATE_RE.match(expiry_str):
            raise ScanGateError(
                "INVALID_ALLOWLIST_ENTRY",
                f"Entry '{entry_id}' has invalid expiry date '{expiry_str}' (expected YYYY-MM-DD).",
            )
        try:
            expiry_date = datetime.datetime.strptime(expiry_str, "%Y-%m-%d").date()
        except ValueError as exc:
            raise ScanGateError(
                "INVALID_ALLOWLIST_ENTRY",
                f"Entry '{entry_id}' has unparseable expiry date '{expiry_str}'.",
            ) from exc

        if expiry_date < eff_date:
            raise ScanGateError(
                "EXPIRED_ALLOWLIST_ENTRY",
                f"Allowlist entry '{entry_id}' for '{path}' ({detector}) expired on {expiry_date.isoformat()} "
                f"(audit date {eff_date.isoformat()}).",
            )

        entry = AllowlistEntry(
            id=entry_id,
            classification=cls,
            path=path,
            detector=detector,
            iterations=iters,
            salt_bytes=salt_bytes,
            digest_bytes=digest_bytes,
            owner=owner,
            rationale=rationale,
            expiry=expiry_date,
        )
        entries.append(entry)
        by_path_detector.setdefault((path, detector), []).append(entry)

    return AllowlistStore(entries=entries, by_path_detector=by_path_detector, audit_date=eff_date)


def _match_allowlist_entry(
    allowlist: AllowlistStore,
    path: str,
    detector: str,
    raw_secret: str,
    cache: Dict[Tuple[str, str, str], Optional[AllowlistEntry]],
) -> Optional[AllowlistEntry]:
    """Cryptographically match a finding against exact (path, detector, value) allowlist entries."""
    if not raw_secret:
        return None
    cache_key = (path, detector, raw_secret)
    if cache_key in cache:
        return cache[cache_key]

    candidates = allowlist.by_path_detector.get((path, detector), [])
    matched: Optional[AllowlistEntry] = None
    if candidates:
        payload = f"{DOMAIN_TAG}\x00{path}\x00{detector}\x00{raw_secret}".encode("utf-8")
        for entry in candidates:
            if entry.expiry < allowlist.audit_date:
                continue
            computed = hashlib.pbkdf2_hmac("sha256", payload, entry.salt_bytes, entry.iterations)
            if hmac.compare_digest(computed, entry.digest_bytes):
                matched = entry
                break

    cache[cache_key] = matched
    return matched


def _run_git(repo_dir: str, args: List[str]) -> str:
    cmd = ["git", "-C", repo_dir] + args
    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False
    )
    if proc.returncode != 0:
        stderr = _scrub_sensitive_text((proc.stderr or proc.stdout or "").strip())
        raise ScanGateError("GIT_COMMAND_FAILED", f"`git {' '.join(args)}` failed: {stderr}")
    return (proc.stdout or "").strip()


def _validate_ref_syntax(ref: Optional[str], role: str) -> str:
    cleaned = (ref or "").strip()
    if not cleaned:
        raise ScanGateError(f"INVALID_{role}_REF", f"{role} ref is empty.")
    if cleaned.startswith("-"):
        raise ScanGateError(f"INVALID_{role}_REF", f"{role} ref must not start with '-': {cleaned}")
    if cleaned == ZERO_SHA:
        raise ScanGateError(
            "ZERO_SHA_NOT_ALLOWED",
            f"{role} ref is all-zeros ({ZERO_SHA}), which is not a valid commit.",
        )
    return cleaned


def _rev_parse_commit(repo_dir: str, ref: Optional[str], role: str) -> str:
    cleaned = _validate_ref_syntax(ref, role)
    try:
        sha = _run_git(repo_dir, ["rev-parse", "--verify", "--quiet", f"{cleaned}^{{commit}}"])
    except ScanGateError as exc:
        raise ScanGateError(
            f"INVALID_{role}_REF",
            f"Unable to resolve {role} ref '{cleaned}' to a reachable commit: {exc.message}",
        ) from exc
    if not SHA_PATTERN.match(sha):
        raise ScanGateError(
            f"INVALID_{role}_REF",
            f"Resolved {role} ref '{cleaned}' produced invalid SHA '{sha}'.",
        )
    return sha


def resolve_scan_range(
    repo_dir: str,
    event_name: str,
    base_ref: Optional[str],
    head_ref: Optional[str],
) -> ScanRange:
    """Resolve and validate git commit range strictly (fail-closed)."""
    event = (event_name or "").strip().lower()
    if event not in {"pull_request", "push", "workflow_dispatch", "schedule"}:
        raise ScanGateError("UNSUPPORTED_EVENT", f"Unsupported GitHub event: '{event_name}'")

    if event == "pull_request":
        base_sha = _rev_parse_commit(repo_dir, base_ref, "BASE")
        head_sha = _rev_parse_commit(repo_dir, head_ref, "HEAD")
        if base_sha == head_sha:
            raise ScanGateError(
                "IDENTICAL_BASE_AND_HEAD",
                f"PR base and head resolve to identical commit {head_sha}.",
            )
        try:
            merge_base = _run_git(repo_dir, ["merge-base", base_sha, head_sha])
        except ScanGateError as exc:
            raise ScanGateError(
                "NO_MERGE_BASE",
                f"Unable to compute merge-base between {base_sha} and {head_sha}: {exc.message}",
            ) from exc
        if merge_base == head_sha:
            raise ScanGateError(
                "NO_PR_COMMITS",
                f"PR head {head_sha} has no commits ahead of merge-base {merge_base}.",
            )
        commit_count = int(_run_git(repo_dir, ["rev-list", "--count", f"{merge_base}..{head_sha}"]))
        if commit_count <= 0:
            raise ScanGateError(
                "NO_PR_COMMITS",
                f"Commit count in {merge_base}..{head_sha} is {commit_count}.",
            )
        diff_raw = _run_git(repo_dir, ["diff", "--name-only", f"{merge_base}..{head_sha}"])
        changed_files = [line.strip() for line in diff_raw.splitlines() if line.strip()]
        return ScanRange(
            event="pull_request",
            since_commit=merge_base,
            branch=head_sha,
            commit_count=commit_count,
            changed_files=changed_files,
            require_nonzero_input=True,
        )

    if event == "push":
        head_sha = _rev_parse_commit(repo_dir, head_ref, "HEAD")
        base_clean = (base_ref or "").strip()
        if not base_clean or base_clean == ZERO_SHA:
            commit_count = int(_run_git(repo_dir, ["rev-list", "--count", head_sha]))
            if commit_count <= 0:
                raise ScanGateError("NO_COMMITS", f"Branch head {head_sha} has 0 reachable commits.")
            return ScanRange(
                event="push",
                since_commit=None,
                branch=head_sha,
                commit_count=commit_count,
                changed_files=[],
                require_nonzero_input=True,
            )

        base_sha = _rev_parse_commit(repo_dir, base_clean, "BASE")
        if base_sha == head_sha:
            raise ScanGateError(
                "IDENTICAL_BASE_AND_HEAD",
                f"Push before and head resolve to identical commit {head_sha}.",
            )
        try:
            merge_base = _run_git(repo_dir, ["merge-base", base_sha, head_sha])
        except ScanGateError as exc:
            raise ScanGateError(
                "NO_MERGE_BASE",
                f"Unable to compute merge-base for push {base_sha}..{head_sha}: {exc.message}",
            ) from exc
        commit_count = int(_run_git(repo_dir, ["rev-list", "--count", f"{merge_base}..{head_sha}"]))
        if commit_count <= 0:
            raise ScanGateError(
                "NO_NEW_COMMITS",
                f"Push range {merge_base}..{head_sha} contains {commit_count} commits.",
            )
        diff_raw = _run_git(repo_dir, ["diff", "--name-only", f"{merge_base}..{head_sha}"])
        changed_files = [line.strip() for line in diff_raw.splitlines() if line.strip()]
        return ScanRange(
            event="push",
            since_commit=merge_base,
            branch=head_sha,
            commit_count=commit_count,
            changed_files=changed_files,
            require_nonzero_input=True,
        )

    # workflow_dispatch / schedule
    head_sha = _rev_parse_commit(repo_dir, head_ref or "HEAD", "HEAD")
    commit_count = int(_run_git(repo_dir, ["rev-list", "--count", head_sha]))
    if commit_count <= 0:
        raise ScanGateError("NO_COMMITS", f"Ref {head_sha} has 0 reachable commits.")
    return ScanRange(
        event=event,
        since_commit=None,
        branch=head_sha,
        commit_count=commit_count,
        changed_files=[],
        require_nonzero_input=True,
    )


def _redact_finding(
    obj: Dict[str, Any],
    classification: str = "unverified",
    allowlist_entry: Optional[AllowlistEntry] = None,
) -> Dict[str, Any]:
    """Strip ALL raw secret payloads and unsafe ExtraData before logging or serialization."""
    git_meta = (
        obj.get("SourceMetadata", {})
        .get("Data", {})
        .get("Git", {})
    )
    extra = obj.get("ExtraData") or {}
    safe_extra: Dict[str, Any] = {}
    if isinstance(extra, dict) and isinstance(extra.get("name"), str):
        safe_extra["name"] = extra["name"]

    raw_detector = str(obj.get("DetectorName", "unknown"))
    canonical_det = _canonical_detector_name(obj)
    file_path = str(git_meta.get("file", "unknown")).replace("\\", "/")

    rec: Dict[str, Any] = {
        "detector": raw_detector,
        "canonical_detector": canonical_det,
        "verified": bool(obj.get("Verified", False)),
        "classification": classification,
        "file": file_path,
        "line": int(git_meta.get("line", 0) or 0),
        "commit": str(git_meta.get("commit", "unknown")),
        "extra": safe_extra,
    }
    if allowlist_entry is not None:
        rec["allowlist_id"] = allowlist_entry.id
        rec["owner"] = allowlist_entry.owner
        rec["expiry"] = allowlist_entry.expiry.isoformat()
    return rec


def evaluate_trufflehog_output(
    raw_output: str,
    exit_code: int,
    scan_range: ScanRange,
    fail_on_unverified: bool = False,
    allowlist: Optional[AllowlistStore] = None,
) -> ScanEvaluation:
    """Parse TruffleHog -j NDJSON output and enforce strict P0/P1 fail-closed invariants."""
    errors: List[str] = []
    scanner_errors: List[str] = []
    findings_redacted: List[Dict[str, Any]] = []
    summary: Optional[Dict[str, Any]] = None
    observed_secrets: Set[str] = set()
    allowlist_cache: Dict[Tuple[str, str, str], Optional[AllowlistEntry]] = {}

    if exit_code not in (0, 183):
        errors.append(f"SCANNER_CRASH: TruffleHog exited with unexpected status code {exit_code}.")

    counts = {
        "verified": 0,
        "unverified": 0,
        "approved_false_positive": 0,
        "dummy": 0,
    }

    lines = (raw_output or "").splitlines()
    in_pem_block = False
    for line_num, raw_line in enumerate(lines, 1):
        line = raw_line.strip()
        if not line:
            continue

        if in_pem_block:
            if "-----END " in line:
                in_pem_block = False
            continue

        if "-----BEGIN " in line and "-----END " not in line:
            in_pem_block = True
            if not line.startswith("{"):
                scanner_errors.append(f"SCANNER_RAW_ERROR line {line_num}: [REDACTED_PEM_BLOCK]")
                continue

        if not line.startswith("{"):
            # Plain-text line from scanner, container runtime, git, or os
            lower_line = line.lower()
            if any(term in lower_line for term in ("error", "fatal", "panic", "failed", "failure", "cannot", "denied", "exception", "level=error", "level=fatal")):
                scanner_errors.append(f"SCANNER_RAW_ERROR line {line_num}: {line}")
            else:
                scanner_errors.append(f"SCANNER_NON_JSON_OUTPUT line {line_num}: {line}")
            continue

        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            errors.append(
                f"SCANNER_PARSE_ERROR: Malformed JSON telemetry line {line_num} (payload redacted)."
            )
            continue

        if not isinstance(obj, dict):
            errors.append(
                f"SCANNER_PARSE_ERROR: Non-object JSON telemetry line {line_num} (payload redacted)."
            )
            continue

        level = str(obj.get("level", "")).lower()
        msg = str(obj.get("msg", ""))
        has_error_key = bool(obj.get("error") or obj.get("errors"))
        is_error_level = level in {"error", "fatal", "panic"}
        has_error_msg = "encountered errors" in msg.lower() or "error" in msg.lower()

        if is_error_level or has_error_msg or (has_error_key and msg != "finished scanning"):
            detail = obj.get("errors") or obj.get("error") or msg
            scanner_errors.append(f"{msg}: {detail}")
        elif "DetectorName" in obj or "SourceMetadata" in obj:
            for s in _extract_raw_strings(obj):
                observed_secrets.add(s)

            is_verified = bool(obj.get("Verified", False))
            matched_entry: Optional[AllowlistEntry] = None
            if is_verified:
                classification = "verified"
            elif allowlist is not None:
                git_meta = obj.get("SourceMetadata", {}).get("Data", {}).get("Git", {})
                f_path = str(git_meta.get("file") or "").replace("\\", "/")
                c_det = _canonical_detector_name(obj)
                c_raw = _canonical_secret_value(obj)
                matched_entry = _match_allowlist_entry(
                    allowlist, f_path, c_det, c_raw, allowlist_cache
                )
                if matched_entry is not None:
                    classification = matched_entry.classification
                else:
                    classification = "unverified"
            else:
                classification = "unverified"

            counts[classification] += 1
            findings_redacted.append(
                _redact_finding(obj, classification=classification, allowlist_entry=matched_entry)
            )
        elif msg == "finished scanning":
            if summary is not None:
                first_sig = (summary.get("chunks"), summary.get("bytes"), summary.get("verified_secrets"), summary.get("unverified_secrets"))
                second_sig = (obj.get("chunks"), obj.get("bytes"), obj.get("verified_secrets"), obj.get("unverified_secrets"))
                if first_sig == second_sig:
                    errors.append(
                        f"DUPLICATE_SCAN_SUMMARY: Duplicate 'finished scanning' telemetry record at line {line_num}."
                    )
                else:
                    errors.append(
                        f"CONFLICTING_SCAN_SUMMARY: Conflicting 'finished scanning' telemetry record at line {line_num} "
                        f"(first: chunks={summary.get('chunks')}, bytes={summary.get('bytes')}; "
                        f"second: chunks={obj.get('chunks')}, bytes={obj.get('bytes')})."
                    )
            else:
                summary = obj

    for err_detail in scanner_errors:
        errors.append(f"SCANNER_ERROR: {_scrub_sensitive_text(err_detail, observed_secrets)}")

    if summary is None:
        errors.append(
            "MISSING_SCAN_SUMMARY: TruffleHog 'finished scanning' JSON telemetry record is missing."
        )
        return ScanEvaluation(
            passed=False,
            errors=[_scrub_sensitive_text(e, observed_secrets) for e in errors],
            chunks=0,
            bytes_scanned=0,
            verified_secrets=0,
            unverified_secrets=0,
            scan_duration="unknown",
            findings_redacted=findings_redacted,
            verified_count=counts["verified"],
            unverified_count=counts["unverified"],
            approved_false_positive_count=counts["approved_false_positive"],
            dummy_count=counts["dummy"],
        )

    try:
        chunks = int(summary["chunks"])
        bytes_scanned = int(summary["bytes"])
        verified_secrets = int(summary.get("verified_secrets", 0))
        unverified_secrets = int(summary.get("unverified_secrets", 0))
    except (KeyError, TypeError, ValueError) as exc:
        errors.append(f"INVALID_SCAN_METRICS: Malformed summary metrics ({_safe_error_summary(exc, observed_secrets)}).")
        return ScanEvaluation(
            passed=False,
            errors=[_scrub_sensitive_text(e, observed_secrets) for e in errors],
            chunks=0,
            bytes_scanned=0,
            verified_secrets=0,
            unverified_secrets=0,
            scan_duration=str(summary.get("scan_duration", "unknown")),
            findings_redacted=findings_redacted,
            verified_count=counts["verified"],
            unverified_count=counts["unverified"],
            approved_false_positive_count=counts["approved_false_positive"],
            dummy_count=counts["dummy"],
        )

    scan_duration = str(summary.get("scan_duration", "unknown"))

    if chunks < 0 or bytes_scanned < 0:
        errors.append(
            f"INVALID_SCAN_METRICS: Negative counters reported (chunks={chunks}, bytes={bytes_scanned})."
        )

    has_input_changes = scan_range.commit_count > 0 or len(scan_range.changed_files) > 0
    if scan_range.require_nonzero_input and has_input_changes and (chunks <= 0 or bytes_scanned <= 0):
        errors.append(
            "ZERO_INPUT_SCANNED: Repository range has "
            f"{scan_range.commit_count} commit(s) and {len(scan_range.changed_files)} changed file(s), "
            f"but TruffleHog scanned chunks={chunks}, bytes={bytes_scanned}."
        )

    # Reconcile structured finding count with summary metrics
    total_expected_findings = verified_secrets + unverified_secrets
    if len(findings_redacted) != total_expected_findings:
        errors.append(
            f"UNACCOUNTED_SCAN_FINDINGS: Scanner summary reported {verified_secrets} verified and "
            f"{unverified_secrets} unverified secret(s) (total {total_expected_findings}), "
            f"but emitted {len(findings_redacted)} structured finding record(s)."
        )

    if verified_secrets > 0 or counts["verified"] > 0:
        errors.append(
            f"SECRETS_DETECTED: TruffleHog detected {max(verified_secrets, counts['verified'])} verified secret(s)."
        )

    if fail_on_unverified:
        if allowlist is not None:
            accounted_exempt = counts["approved_false_positive"] + counts["dummy"]
            if counts["unverified"] > 0:
                errors.append(
                    f"SECRETS_DETECTED: Detected {counts['unverified']} unapproved unverified/custom secret(s) "
                    "with no matching allowlist entry."
                )
            elif exit_code == 183 and accounted_exempt == 0 and len(findings_redacted) == 0:
                errors.append(
                    "UNACCOUNTED_SCAN_FINDINGS: Scanner exited with code 183 without accountable allowlisted findings."
                )
        else:
            if unverified_secrets > 0 or len(findings_redacted) > 0:
                errors.append(
                    f"SECRETS_DETECTED: TruffleHog detected {max(unverified_secrets, len(findings_redacted))} unverified/custom secret(s)."
                )

    if exit_code == 183:
        if len(findings_redacted) == 0 and total_expected_findings == 0:
            errors.append("UNACCOUNTED_SCAN_FINDINGS: Scanner exited with code 183 without any detected secrets or findings.")
        elif allowlist is None or not fail_on_unverified:
            if not any(e.startswith("SECRETS_DETECTED:") for e in errors):
                errors.append("SECRETS_DETECTED: TruffleHog exited with finding exit code 183.")

    if exit_code == 0 and (verified_secrets > 0 or unverified_secrets > 0 or len(findings_redacted) > 0):
        errors.append(
            f"INVALID_EXIT_CODE: Scanner detected {max(total_expected_findings, len(findings_redacted))} secret(s) "
            "but exited with code 0 instead of 183."
        )

    scrubbed_errors = [_scrub_sensitive_text(e, observed_secrets) for e in errors]
    return ScanEvaluation(
        passed=len(scrubbed_errors) == 0,
        errors=scrubbed_errors,
        chunks=chunks,
        bytes_scanned=bytes_scanned,
        verified_secrets=verified_secrets,
        unverified_secrets=unverified_secrets,
        scan_duration=scan_duration,
        findings_redacted=findings_redacted,
        verified_count=counts["verified"],
        unverified_count=counts["unverified"],
        approved_false_positive_count=counts["approved_false_positive"],
        dummy_count=counts["dummy"],
    )


def run_trufflehog_docker(
    repo_dir: str,
    since_commit: Optional[str],
    branch_ref: str,
    only_verified: bool = True,
    config_path: Optional[str] = None,
    include_detectors: Optional[str] = None,
) -> Tuple[int, str]:
    """Execute pinned TruffleHog Docker container against a standalone git repository."""
    abs_repo = os.path.abspath(repo_dir)
    git_entry = os.path.join(abs_repo, ".git")
    if os.path.isfile(git_entry):
        raise ScanGateError(
            "LINKED_WORKTREE_MOUNT_UNSUPPORTED",
            f"'{abs_repo}' is a linked git worktree whose .git file points outside the mount. "
            "Run against a standalone clone/checkout directory or the primary git repository.",
        )

    cmd = ["docker", "run", "--rm", "-v", f"{abs_repo}:/repo:ro", "-w", "/repo"]
    if config_path:
        abs_cfg = os.path.abspath(config_path)
        if not os.path.isfile(abs_cfg):
            raise ScanGateError(
                "DETECTOR_CONFIG_MISSING",
                f"TruffleHog detector config not found at '{abs_cfg}'.",
            )
        cmd.extend(["-v", f"{abs_cfg}:/thog/config.yaml:ro"])

    cmd.extend([TRUFFLEHOG_IMAGE, "git", "file:///repo/"])
    if since_commit is not None:
        cmd.extend(["--since-commit", since_commit])
    cmd.extend(["--branch", branch_ref])

    if config_path:
        cmd.extend(["--config", "/thog/config.yaml"])
    if include_detectors:
        cmd.append(f"--include-detectors={include_detectors}")
    if only_verified:
        cmd.append("--only-verified")
    else:
        cmd.extend(["--no-verification", "--results=verified,unverified"])

    cmd.extend(["--fail", "--no-update", "-j"])

    proc = subprocess.run(
        cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", check=False
    )
    combined = "\n".join(part for part in (proc.stdout, proc.stderr) if part)
    return proc.returncode, combined


def execute_dual_pass_gate(
    repo_dir: str,
    scan_range: ScanRange,
    pass2_config_path: str,
    allowlist_path: str,
    audit_date: Optional[datetime.date] = None,
    pass1_config_path: Optional[str] = None,
    pass1_include_unverified: bool = False,
) -> Tuple[ScanEvaluation, int, ScanEvaluation, int]:
    """Run P0 Pass 1 + P1 Pass 2 scoped secret scan against a validated git range."""
    if not os.path.isfile(pass2_config_path):
        raise ScanGateError(
            "PASS2_CONFIG_MISSING",
            f"Pass 2 detector configuration file not found at '{pass2_config_path}'.",
        )
    allowlist = load_and_validate_allowlist(allowlist_path, audit_date=audit_date)

    # Pass 1: P0 verified scan across all built-in detectors
    p1_rc, p1_raw = run_trufflehog_docker(
        repo_dir=repo_dir,
        since_commit=scan_range.since_commit,
        branch_ref=scan_range.branch,
        only_verified=not pass1_include_unverified,
        config_path=pass1_config_path,
    )
    p1_eval = evaluate_trufflehog_output(
        raw_output=p1_raw,
        exit_code=p1_rc,
        scan_range=scan_range,
        fail_on_unverified=pass1_include_unverified,
    )

    # Pass 2: P1 scoped scan (PrivateKey + internal creds + R2/S3 + Postgres URI)
    p2_rc, p2_raw = run_trufflehog_docker(
        repo_dir=repo_dir,
        since_commit=scan_range.since_commit,
        branch_ref=scan_range.branch,
        only_verified=False,
        config_path=pass2_config_path,
        include_detectors=PASS2_INCLUDE_DETECTORS,
    )
    p2_eval = evaluate_trufflehog_output(
        raw_output=p2_raw,
        exit_code=p2_rc,
        scan_range=scan_range,
        fail_on_unverified=True,
        allowlist=allowlist,
    )

    return p1_eval, p1_rc, p2_eval, p2_rc


def _resolve_default_asset(repo_dir: str, rel_path: str, error_code: str) -> str:
    candidate_repo = os.path.abspath(os.path.join(repo_dir, rel_path))
    if os.path.isfile(candidate_repo):
        return candidate_repo
    candidate_script = os.path.abspath(os.path.join(SCRIPT_REPO_ROOT, rel_path))
    if os.path.isfile(candidate_script):
        return candidate_script
    raise ScanGateError(
        error_code,
        f"Required security configuration asset '{rel_path}' missing from both repo '{repo_dir}' and '{SCRIPT_REPO_ROOT}'.",
    )


def _display_path(target_path: str, base_dir: str) -> str:
    try:
        return os.path.relpath(os.path.abspath(target_path), os.path.abspath(base_dir)).replace("\\", "/")
    except ValueError:
        return os.path.abspath(target_path).replace("\\", "/")


def _validate_pass2_yaml_structure(yaml_path: str) -> Tuple[int, List[str]]:
    """Stdlib verification ensuring every detector defines only 1 regex key (avoids AND-bug)."""
    if not os.path.isfile(yaml_path):
        raise ScanGateError("PASS2_CONFIG_MISSING", f"Missing Pass 2 config at '{yaml_path}'.")
    with open(yaml_path, "r", encoding="utf-8") as fh:
        lines = fh.readlines()

    detectors: List[str] = []
    regex_keys_by_detector: Dict[str, List[str]] = {}
    current_detector: Optional[str] = None
    in_regex = False
    regex_indent = 0

    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        if stripped.startswith("- name:"):
            current_detector = stripped.split(":", 1)[1].strip()
            detectors.append(current_detector)
            regex_keys_by_detector[current_detector] = []
            in_regex = False
        elif current_detector and stripped == "regex:":
            in_regex = True
            regex_indent = indent
        elif current_detector and in_regex:
            if indent <= regex_indent:
                in_regex = False
            elif indent == regex_indent + 2 and ":" in stripped:
                key_name = stripped.split(":", 1)[0].strip()
                regex_keys_by_detector[current_detector].append(key_name)

    if len(detectors) < 5:
        raise ScanGateError(
            "PASS2_CONFIG_INVALID",
            f"Expected >= 5 scoped detectors in '{yaml_path}', found {len(detectors)}.",
        )
    for det_name, keys in regex_keys_by_detector.items():
        if len(keys) != 1:
            raise ScanGateError(
                "PASS2_CONFIG_INVALID",
                f"Detector '{det_name}' must declare exactly 1 key under 'regex:' to avoid TruffleHog AND-semantics, found {len(keys)} ({keys}).",
            )
    return len(detectors), detectors


def _build_ephemeral_dummy_openssh_key() -> str:
    """Generate a throwaway Ed25519-formatted OpenSSH PEM block strictly at test runtime."""
    pub = os.urandom(32)
    priv_pub = os.urandom(32) + pub

    def pack_chunk(data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + data

    pub_blob = pack_chunk(b"ssh-ed25519") + pack_chunk(pub)
    check = os.urandom(4)
    priv_inner = (
        check
        + check
        + pack_chunk(b"ssh-ed25519")
        + pack_chunk(pub)
        + pack_chunk(priv_pub)
        + pack_chunk(b"omninovel-ephemeral-ci-dummy-fixture")
    )
    pad_len = (8 - (len(priv_inner) % 8)) % 8
    priv_inner += bytes(range(1, pad_len + 1))
    payload = (
        b"openssh-key-v1\x00"
        + pack_chunk(b"none")
        + pack_chunk(b"none")
        + pack_chunk(b"")
        + struct.pack(">I", 1)
        + pack_chunk(pub_blob)
        + pack_chunk(priv_inner)
    )
    b64 = base64.b64encode(payload).decode("ascii")
    wrapped = "\n".join(b64[i : i + 70] for i in range(0, len(b64), 70))
    header = "-----BEGIN " + "OPENSSH PRIVATE KEY-----"
    footer = "-----END " + "OPENSSH PRIVATE KEY-----"
    return f"{header}\n{wrapped}\n{footer}\n"


def _init_git_repo(repo_dir: str) -> str:
    _run_git(repo_dir, ["init", "-q"])
    _run_git(repo_dir, ["config", "user.email", "ci-security-test@omninovel.local"])
    _run_git(repo_dir, ["config", "user.name", "OmniNovel Security Test"])
    with open(os.path.join(repo_dir, "README.md"), "w", encoding="utf-8") as fh:
        fh.write("baseline\n")
    _run_git(repo_dir, ["add", "README.md"])
    _run_git(repo_dir, ["commit", "-q", "-m", "chore: baseline commit"])
    return _run_git(repo_dir, ["rev-parse", "HEAD"])


def _write_allowlist_file(path: str, entries: List[Dict[str, Any]], min_iterations: int = 100_000) -> None:
    doc = {
        "schema_version": 1,
        "kdf": "pbkdf2_sha256",
        "min_iterations": min_iterations,
        "entries": entries,
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=2)


def run_unit_tests() -> int:
    """Execute fail-closed ref resolution, JSON parser, P1 allowlist & zero-leak matrix."""
    print("================================================================================")
    print("[TEST] RUNNING SECRET SCAN P0+P1 FAIL-CLOSED UNIT & GOVERNANCE MATRIX")
    print("================================================================================")

    tmp_root = tempfile.mkdtemp(prefix="omninovel_sec_unit_")
    passed = 0
    try:
        repo = os.path.join(tmp_root, "repo")
        os.makedirs(repo)
        c0 = _init_git_repo(repo)

        # Create PR feature branch and advance main independently
        _run_git(repo, ["checkout", "-q", "-b", "feat/sample"])
        with open(os.path.join(repo, "feature.txt"), "w", encoding="utf-8") as fh:
            fh.write("safe code change\n")
        _run_git(repo, ["add", "feature.txt"])
        _run_git(repo, ["commit", "-q", "-m", "feat: safe PR commit"])
        feat_sha = _run_git(repo, ["rev-parse", "HEAD"])

        _run_git(repo, ["checkout", "-q", "-b", "main-sim", c0])
        with open(os.path.join(repo, "main.txt"), "w", encoding="utf-8") as fh:
            fh.write("main moved forward\n")
        _run_git(repo, ["add", "main.txt"])
        _run_git(repo, ["commit", "-q", "-m", "chore: advance base"])
        main_sha = _run_git(repo, ["rev-parse", "HEAD"])

        # SEC-01: Empty / bogus / zero PR base ref fails closed
        for bad_base in ("", "0" * 40, "nonexistent-branch-ref", "--all"):
            try:
                resolve_scan_range(repo, "pull_request", bad_base, feat_sha)
                raise AssertionError(f"SEC-01 failed: accepted bad_base={bad_base!r}")
            except ScanGateError:
                pass
        print("  [PASS] SEC-01: Empty, zero-SHA, flag-like, and unresolvable PR base refs rejected")
        passed += 1

        # SEC-02: Invalid PR head ref (e.g. '209/merge') fails closed
        for bad_head in ("", "209/merge", "deadbeef" * 5):
            try:
                resolve_scan_range(repo, "pull_request", main_sha, bad_head)
                raise AssertionError(f"SEC-02 failed: accepted bad_head={bad_head!r}")
            except ScanGateError as exc:
                assert exc.code == "INVALID_HEAD_REF", f"Unexpected code: {exc.code}"
        print("  [PASS] SEC-02: Invalid PR head ref (including '209/merge') rejected fail-closed")
        passed += 1

        # SEC-03: Identical base and head rejected
        try:
            resolve_scan_range(repo, "pull_request", main_sha, main_sha)
            raise AssertionError("SEC-03 failed: identical base/head allowed")
        except ScanGateError as exc:
            assert exc.code == "IDENTICAL_BASE_AND_HEAD"
        print("  [PASS] SEC-03: Identical base/head commit rejected (IDENTICAL_BASE_AND_HEAD)")
        passed += 1

        # SEC-04: PR head at merge-base (0 commits ahead) rejected
        try:
            resolve_scan_range(repo, "pull_request", main_sha, c0)
            raise AssertionError("SEC-04 failed: 0-commit PR allowed")
        except ScanGateError as exc:
            assert exc.code == "NO_PR_COMMITS"
        print("  [PASS] SEC-04: Zero-commit PR range rejected (NO_PR_COMMITS)")
        passed += 1

        # SEC-05: Push with missing/shallow non-zero before ref rejected
        try:
            resolve_scan_range(repo, "push", "1" * 40, main_sha)
            raise AssertionError("SEC-05 failed: missing push before SHA allowed")
        except ScanGateError as exc:
            assert exc.code == "INVALID_BASE_REF"
        print("  [PASS] SEC-05: Missing non-zero push before ref rejected (INVALID_BASE_REF)")
        passed += 1

        # SEC-06: Push with all-zeros before ref resolves full reachable scan cleanly
        push_init = resolve_scan_range(repo, "push", ZERO_SHA, main_sha)
        assert push_init.since_commit is None
        assert push_init.branch == main_sha
        assert push_init.commit_count == 2
        print("  [PASS] SEC-06: Initial branch push (zero-SHA) resolves full reachable branch scan")
        passed += 1

        # SEC-07: Diverged PR resolves exact merge-base (c0) and changed files
        pr_range = resolve_scan_range(repo, "pull_request", main_sha, feat_sha)
        assert pr_range.since_commit == c0
        assert pr_range.branch == feat_sha
        assert pr_range.commit_count == 1
        assert pr_range.changed_files == ["feature.txt"]
        print("  [PASS] SEC-07: Diverged pull_request resolves exact merge-base and changed files")
        passed += 1

        # SEC-08: Fail-open reproduction (exit=0, error + chunks=0, bytes=0) MUST FAIL
        fail_open_log = "\n".join([
            json.dumps({"level": "info-0", "msg": "running source"}),
            json.dumps({"level": "error", "msg": "encountered errors during scan", "errors": ["unable to resolve ref: \"209/merge\""]}),
            json.dumps({"level": "info-0", "msg": "finished scanning", "chunks": 0, "bytes": 0, "verified_secrets": 0, "unverified_secrets": 0}),
        ])
        ev = evaluate_trufflehog_output(fail_open_log, 0, pr_range)
        assert not ev.passed
        assert any("SCANNER_ERROR:" in e for e in ev.errors)
        assert any("ZERO_INPUT_SCANNED:" in e for e in ev.errors)
        print("  [PASS] SEC-08: PR #209/#210 fail-open signature (error + chunks=0 + exit 0) blocked")
        passed += 1

        # SEC-09: Silent zero-input (exit=0, no error line, chunks=0, bytes=0) MUST FAIL
        zero_input_log = json.dumps({
            "level": "info-0", "msg": "finished scanning",
            "chunks": 0, "bytes": 0, "verified_secrets": 0, "unverified_secrets": 0,
        })
        ev = evaluate_trufflehog_output(zero_input_log, 0, pr_range)
        assert not ev.passed
        assert any("ZERO_INPUT_SCANNED:" in e for e in ev.errors)
        print("  [PASS] SEC-09: Silent zero-input scan on PR with changes blocked (ZERO_INPUT_SCANNED)")
        passed += 1

        # SEC-10: Missing summary telemetry MUST FAIL
        ev = evaluate_trufflehog_output('{"level":"info-0","msg":"running source"}', 0, pr_range)
        assert not ev.passed
        assert any("MISSING_SCAN_SUMMARY:" in e for e in ev.errors)
        print("  [PASS] SEC-10: Missing TruffleHog summary record blocked (MISSING_SCAN_SUMMARY)")
        passed += 1

        # SEC-11: Unexpected exit code MUST FAIL
        ev = evaluate_trufflehog_output("", 125, pr_range)
        assert not ev.passed
        assert any("SCANNER_CRASH:" in e for e in ev.errors)
        print("  [PASS] SEC-11: Unexpected scanner exit code blocked (SCANNER_CRASH)")
        passed += 1

        # SEC-12: Verified secret triggers failure and scrubs Raw fields
        secret_sentinel = "SENSITIVE_UNIT_TEST_" + secrets.token_hex(8)
        finding_log = "\n".join([
            json.dumps({
                "SourceMetadata": {"Data": {"Git": {"commit": feat_sha, "file": "feature.txt", "line": 1}}},
                "DetectorName": "AWS",
                "Verified": True,
                "Raw": secret_sentinel,
                "Redacted": "AKIA***REDACTED***",
            }),
            json.dumps({
                "level": "info-0", "msg": "finished scanning",
                "chunks": 2, "bytes": 120, "verified_secrets": 1, "unverified_secrets": 0,
                "scan_duration": "15ms",
            }),
        ])
        ev = evaluate_trufflehog_output(finding_log, 183, pr_range)
        assert not ev.passed
        assert any("SECRETS_DETECTED:" in e for e in ev.errors)
        assert secret_sentinel not in json.dumps(ev.findings_redacted)
        print("  [PASS] SEC-12: Verified secret blocked fail-closed with raw secret redacted")
        passed += 1

        # SEC-13: Valid non-zero clean scan passes
        clean_log = json.dumps({
            "level": "info-0", "msg": "finished scanning",
            "chunks": 3, "bytes": 412, "verified_secrets": 0, "unverified_secrets": 0,
            "scan_duration": "120ms",
        })
        ev = evaluate_trufflehog_output(clean_log, 0, pr_range)
        assert ev.passed, f"Unexpected failure: {ev.errors}"
        assert ev.chunks == 3 and ev.bytes_scanned == 412
        print("  [PASS] SEC-13: Valid clean PR scan with chunks>0 and bytes>0 PASSED")
        passed += 1

        # SEC-14: Merged-PR topology & push-to-main range lifecycle (forward, identical, rewind)
        _run_git(repo, ["checkout", "-q", "feat/sample"])
        _run_git(repo, ["merge", "-q", "--no-ff", main_sha, "-m", "chore: sync feat with main-sim"])
        pr_synced_sha = _run_git(repo, ["rev-parse", "HEAD"])
        synced_pr_range = resolve_scan_range(repo, "pull_request", main_sha, pr_synced_sha)
        assert synced_pr_range.since_commit == main_sha
        assert synced_pr_range.branch == pr_synced_sha
        assert synced_pr_range.commit_count == 2
        assert synced_pr_range.changed_files == ["feature.txt"]

        _run_git(repo, ["checkout", "-q", "main-sim"])
        _run_git(repo, ["merge", "-q", "--no-ff", pr_synced_sha, "-m", "Merge PR into main-sim"])
        main_after_merge = _run_git(repo, ["rev-parse", "HEAD"])
        push_inc = resolve_scan_range(repo, "push", main_sha, main_after_merge)
        assert push_inc.since_commit == main_sha
        assert push_inc.branch == main_after_merge
        assert push_inc.commit_count >= 2
        assert push_inc.changed_files == ["feature.txt"]

        for bad_pair, expected_code in (
            ((main_after_merge, main_after_merge), "IDENTICAL_BASE_AND_HEAD"),
            ((main_after_merge, main_sha), "NO_NEW_COMMITS"),
        ):
            try:
                resolve_scan_range(repo, "push", bad_pair[0], bad_pair[1])
                raise AssertionError(f"SEC-14 failed: accepted invalid push pair={bad_pair!r}")
            except ScanGateError as exc:
                assert exc.code == expected_code, f"Unexpected code: {exc.code}"
        print("  [PASS] SEC-14: Merged-PR topology & push-to-main lifecycle validated fail-closed")
        passed += 1

        # SEC-15: Push-path fail-closed enforcement on scanner error, zero-input, crash & findings
        push_err_log = "\n".join([
            json.dumps({"level": "info-0", "msg": "running source"}),
            json.dumps({
                "level": "error",
                "msg": "encountered errors during scan",
                "errors": ['error chunking dir "/repo/": unable to resolve commit: object not found'],
            }),
            json.dumps({
                "level": "info-0",
                "msg": "finished scanning",
                "chunks": 0,
                "bytes": 0,
                "verified_secrets": 0,
                "unverified_secrets": 0,
            }),
        ])
        ev = evaluate_trufflehog_output(push_err_log, 0, push_inc)
        assert not ev.passed
        assert any("SCANNER_ERROR:" in e for e in ev.errors)
        assert any("ZERO_INPUT_SCANNED:" in e for e in ev.errors)

        ev = evaluate_trufflehog_output(zero_input_log, 0, push_init)
        assert not ev.passed
        assert any("ZERO_INPUT_SCANNED:" in e for e in ev.errors)

        ev = evaluate_trufflehog_output("", 2, push_inc)
        assert not ev.passed
        assert any("SCANNER_CRASH:" in e for e in ev.errors)

        ev = evaluate_trufflehog_output(clean_log, 0, push_inc)
        assert ev.passed
        ev = evaluate_trufflehog_output(clean_log, 0, push_init)
        assert ev.passed
        print("  [PASS] SEC-15: Push-to-main (incremental & ZERO_SHA) enforces fail-closed invariants")
        passed += 1

        # SEC-16: Allowlist blanket-exclusion, wildcard, weak-hash, & missing-metadata rejection
        valid_fp = compute_salted_fingerprint("tests/a.ts", "PrivateKey", "secret", iterations=100_000)
        bad_cases = [
            ({"path": "tests/"}, "INVALID_ALLOWLIST_PATH"),
            ({"path": "docs/*.md"}, "INVALID_ALLOWLIST_PATH"),
            ({"path": "plans/"}, "INVALID_ALLOWLIST_PATH"),
            ({"path": "*"}, "INVALID_ALLOWLIST_PATH"),
            ({"detector": "*"}, "INVALID_ALLOWLIST_DETECTOR"),
            ({"classification": "verified"}, "INVALID_ALLOWLIST_CLASSIFICATION"),
            ({"fingerprint": hashlib.sha256(b"weak").hexdigest()}, "INVALID_ALLOWLIST_FINGERPRINT"),
            ({"fingerprint": f"pbkdf2_sha256$1000${'ab'*16}${'cd'*32}"}, "INVALID_ALLOWLIST_FINGERPRINT"),
            ({"owner": "TODO"}, "INVALID_ALLOWLIST_ENTRY"),
            ({"rationale": "short"}, "INVALID_ALLOWLIST_ENTRY"),
            ({"expiry": "2020-01-01"}, "EXPIRED_ALLOWLIST_ENTRY"),
        ]
        for idx, (override, exp_code) in enumerate(bad_cases):
            base_entry = {
                "id": f"BAD-{idx:02d}",
                "classification": "approved_false_positive",
                "path": "tests/a.ts",
                "detector": "PrivateKey",
                "fingerprint": valid_fp,
                "owner": "Security",
                "rationale": "Explicit audited false positive entry rationale.",
                "expiry": "2026-12-01",
            }
            base_entry.update(override)
            bad_al = os.path.join(tmp_root, f"bad_al_{idx}.json")
            _write_allowlist_file(bad_al, [base_entry])
            try:
                load_and_validate_allowlist(bad_al, audit_date=datetime.date(2026, 11, 9))
                raise AssertionError(f"SEC-16 failed to reject override={override!r}")
            except ScanGateError as exc:
                assert exc.code == exp_code, f"Expected {exp_code}, got {exc.code} for {override!r}"
        print("  [PASS] SEC-16: Blanket exclusions (tests/, docs/, plans/), wildcards, weak hashes & expiry rejected")
        passed += 1

        # SEC-17: Auditable 4-class classification (approved_false_positive, dummy, unverified, verified)
        fp_val = "syn_fp_val_" + secrets.token_hex(8)
        dummy_val = "syn_dummy_val_" + secrets.token_hex(8)
        unreg_dummy_prefix = "dummy_" + secrets.token_hex(8)
        al_path = os.path.join(tmp_root, "good_al.json")
        _write_allowlist_file(
            al_path,
            [
                {
                    "id": "FP-001",
                    "classification": "approved_false_positive",
                    "path": "docs/example.md",
                    "detector": "CustomRegex:OmniNovelJwtSecret",
                    "fingerprint": compute_salted_fingerprint(
                        "docs/example.md", "CustomRegex:OmniNovelJwtSecret", fp_val, iterations=100_000
                    ),
                    "owner": "Security",
                    "rationale": "Controlled documentation example reviewed in P1 audit.",
                    "expiry": "2026-12-01",
                },
                {
                    "id": "DM-001",
                    "classification": "dummy",
                    "path": "tests/fixture.env",
                    "detector": "CustomRegex:OmniNovelAiWorkerSecret",
                    "fingerprint": compute_salted_fingerprint(
                        "tests/fixture.env", "CustomRegex:OmniNovelAiWorkerSecret", dummy_val, iterations=100_000
                    ),
                    "owner": "QA",
                    "rationale": "Controlled synthetic unit-test fixture for worker client tests.",
                    "expiry": "2026-12-01",
                },
            ],
        )
        al_store = load_and_validate_allowlist(al_path, audit_date=datetime.date(2026, 11, 9))

        def _make_p2_log(items: List[Tuple[str, str, str, bool, Optional[str]]]) -> str:
            recs = []
            ver_c = 0
            unver_c = 0
            for fpath, det, raw_v, ver_b, custom_n in items:
                if ver_b:
                    ver_c += 1
                else:
                    unver_c += 1
                extra = {"name": custom_n} if custom_n else {}
                recs.append(
                    json.dumps({
                        "SourceMetadata": {"Data": {"Git": {"commit": feat_sha, "file": fpath, "line": 1}}},
                        "DetectorName": det,
                        "Verified": ver_b,
                        "Raw": raw_v,
                        "ExtraData": extra,
                    })
                )
            recs.append(
                json.dumps({
                    "level": "info-0", "msg": "finished scanning",
                    "chunks": 4, "bytes": 512, "verified_secrets": ver_c, "unverified_secrets": unver_c,
                    "scan_duration": "12ms",
                })
            )
            return "\n".join(recs)

        # Positive: both allowlisted entries pass cleanly with exact audit counts
        ev_ok = evaluate_trufflehog_output(
            _make_p2_log([
                ("docs/example.md", "CustomRegex", fp_val, False, "OmniNovelJwtSecret"),
                ("tests/fixture.env", "CustomRegex", dummy_val, False, "OmniNovelAiWorkerSecret"),
            ]),
            183,
            pr_range,
            fail_on_unverified=True,
            allowlist=al_store,
        )
        assert ev_ok.passed, f"SEC-17 expected PASS, got {ev_ok.errors}"
        assert ev_ok.approved_false_positive_count == 1
        assert ev_ok.dummy_count == 1
        assert ev_ok.unverified_count == 0
        assert ev_ok.verified_count == 0

        # Mutated path -> unverified FAIL
        ev_path = evaluate_trufflehog_output(
            _make_p2_log([("docs/other.md", "CustomRegex", fp_val, False, "OmniNovelJwtSecret")]),
            183, pr_range, fail_on_unverified=True, allowlist=al_store,
        )
        assert not ev_path.passed and ev_path.unverified_count == 1

        # Mutated value -> unverified FAIL
        ev_val = evaluate_trufflehog_output(
            _make_p2_log([("docs/example.md", "CustomRegex", fp_val + "_x", False, "OmniNovelJwtSecret")]),
            183, pr_range, fail_on_unverified=True, allowlist=al_store,
        )
        assert not ev_val.passed and ev_val.unverified_count == 1

        # Unregistered dummy_ prefix -> STILL unverified FAIL
        ev_prefix = evaluate_trufflehog_output(
            _make_p2_log([("tests/a.env", "CustomRegex", unreg_dummy_prefix, False, "OmniNovelJwtSecret")]),
            183, pr_range, fail_on_unverified=True, allowlist=al_store,
        )
        assert not ev_prefix.passed and ev_prefix.unverified_count == 1

        # Verified=True overrides allowlist -> ALWAYS FAIL
        ev_verified = evaluate_trufflehog_output(
            _make_p2_log([("docs/example.md", "CustomRegex", fp_val, True, "OmniNovelJwtSecret")]),
            183, pr_range, fail_on_unverified=True, allowlist=al_store,
        )
        assert not ev_verified.passed and ev_verified.verified_count == 1
        print("  [PASS] SEC-17 & SEC-18: 4-class audit verified, path/value mutation FAIL, dummy_ prefix NOT auto-allowed, Verified=True overrides allowlist")
        passed += 2

        # SEC-19: Zero raw secret & weak fingerprint leakage under findings, parser error & exception
        leak_sentinel = "LEAK_TEST_TOKEN_" + secrets.token_hex(12)
        weak_sha256 = hashlib.sha256(leak_sentinel.encode("utf-8")).hexdigest()
        bad_stream = "\n".join([
            json.dumps({
                "SourceMetadata": {"Data": {"Git": {"commit": feat_sha, "file": "src/a.ts", "line": 7}}},
                "DetectorName": "CustomRegex",
                "Verified": False,
                "Raw": leak_sentinel,
                "RawV2": leak_sentinel + "_v2",
                "SecretParts": {"pattern": leak_sentinel},
                "ExtraData": {"name": "OmniNovelJwtSecret", "debug_url": "post" + f"gresql://u:{leak_sentinel}@db:5432/x"},
            }),
            json.dumps({"level": "error", "msg": "encountered errors", "errors": [f"failed parsing {leak_sentinel}"]}),
            '{"truncated_raw": "' + leak_sentinel,
            json.dumps({"level": "info-0", "msg": "finished scanning", "chunks": 2, "bytes": 90, "verified_secrets": 0, "unverified_secrets": 1}),
        ])
        ev_leak = evaluate_trufflehog_output(bad_stream, 183, pr_range, fail_on_unverified=True, allowlist=al_store)
        assert not ev_leak.passed
        assert any("SCANNER_PARSE_ERROR:" in e for e in ev_leak.errors)
        serialized = json.dumps({
            "errors": ev_leak.errors,
            "findings": ev_leak.findings_redacted,
        })
        assert leak_sentinel not in serialized
        assert weak_sha256 not in serialized
        exc_msg = _safe_error_summary(ValueError(f'bad Raw: "{leak_sentinel}"'), [leak_sentinel])
        assert leak_sentinel not in exc_msg and weak_sha256 not in exc_msg
        print("  [PASS] SEC-19: Zero leakage of raw secrets or weak hashes across findings, parse errors, and exceptions")
        passed += 1

        # SEC-20: Unaccounted rc=183 / missing findings fail-closed check
        missing_finding_log = json.dumps({
            "level": "info-0", "msg": "finished scanning",
            "chunks": 3, "bytes": 200, "verified_secrets": 0, "unverified_secrets": 1,
        })
        ev_unacc = evaluate_trufflehog_output(missing_finding_log, 183, pr_range, fail_on_unverified=True, allowlist=al_store)
        assert not ev_unacc.passed
        assert any("UNACCOUNTED_SCAN_FINDINGS:" in e for e in ev_unacc.errors)
        print("  [PASS] SEC-20: Exit 183 / unverified count mismatch with dropped findings rejected fail-closed")
        passed += 1

        # SEC-21 & SEC-22: Validate repo Pass 2 YAML structure and repo allowlist file
        repo_yaml = os.path.join(SCRIPT_REPO_ROOT, DEFAULT_PASS2_CONFIG_REL)
        det_count, det_names = _validate_pass2_yaml_structure(repo_yaml)
        repo_al_path = os.path.join(SCRIPT_REPO_ROOT, DEFAULT_ALLOWLIST_REL)
        repo_al = load_and_validate_allowlist(repo_al_path, audit_date=datetime.date(2026, 11, 9))
        assert len(repo_al.entries) > 0
        print(f"  [PASS] SEC-21 & SEC-22: Repo Pass 2 YAML ({det_count} single-regex detectors: {det_names}) & allowlist ({len(repo_al.entries)} salted entries) verified")
        passed += 2

        # SEC-23: Plain-text scanner errors mixed with valid summary (chunks>0, bytes>0, exit 0) rejected fail-closed
        pt_err_log = "\n".join([
            "fatal: unable to read tree deadbeef",
            json.dumps({"level": "info-0", "msg": "finished scanning", "chunks": 5, "bytes": 500, "verified_secrets": 0, "unverified_secrets": 0}),
        ])
        ev_pt1 = evaluate_trufflehog_output(pt_err_log, 0, pr_range)
        assert not ev_pt1.passed
        assert any("SCANNER_RAW_ERROR" in e for e in ev_pt1.errors)

        pt_non_json = "\n".join([
            "unexpected plain text banner from daemon",
            json.dumps({"level": "info-0", "msg": "finished scanning", "chunks": 5, "bytes": 500, "verified_secrets": 0, "unverified_secrets": 0}),
        ])
        ev_pt2 = evaluate_trufflehog_output(pt_non_json, 0, pr_range)
        assert not ev_pt2.passed
        assert any("SCANNER_NON_JSON_OUTPUT" in e for e in ev_pt2.errors)
        print("  [PASS] SEC-23: Plain-text scanner errors mixed with valid summary rejected fail-closed (SCANNER_RAW_ERROR / SCANNER_NON_JSON_OUTPUT)")
        passed += 1

        # SEC-24: Missing, duplicate, and conflicting scan summaries rejected fail-closed
        ev_miss = evaluate_trufflehog_output('{"level":"info-0","msg":"running source"}', 0, pr_range)
        assert not ev_miss.passed
        assert any("MISSING_SCAN_SUMMARY" in e for e in ev_miss.errors)

        sum_rec1 = json.dumps({"level": "info-0", "msg": "finished scanning", "chunks": 3, "bytes": 300, "verified_secrets": 0, "unverified_secrets": 0})
        dup_log = f"{sum_rec1}\n{sum_rec1}"
        ev_dup = evaluate_trufflehog_output(dup_log, 0, pr_range)
        assert not ev_dup.passed
        assert any("DUPLICATE_SCAN_SUMMARY" in e for e in ev_dup.errors)

        sum_rec2 = json.dumps({"level": "info-0", "msg": "finished scanning", "chunks": 4, "bytes": 450, "verified_secrets": 0, "unverified_secrets": 0})
        conf_log = f"{sum_rec1}\n{sum_rec2}"
        ev_conf = evaluate_trufflehog_output(conf_log, 0, pr_range)
        assert not ev_conf.passed
        assert any("CONFLICTING_SCAN_SUMMARY" in e for e in ev_conf.errors)
        print("  [PASS] SEC-24: Missing, duplicate, and conflicting scan summaries rejected (MISSING/DUPLICATE/CONFLICTING_SCAN_SUMMARY)")
        passed += 1

        # SEC-25: Malformed NDJSON, truncated JSON, and unknown exit codes rejected fail-closed
        bad_ndjson = "\n".join([
            '{"level": "info-0", "msg": "running source", invalid_syntax',
            clean_log,
        ])
        ev_bad_nd = evaluate_trufflehog_output(bad_ndjson, 0, pr_range)
        assert not ev_bad_nd.passed
        assert any("SCANNER_PARSE_ERROR" in e for e in ev_bad_nd.errors)

        trunc_ndjson = "\n".join([
            '{"SourceMetadata": {"Data": {"Git": {"commit": "abc',
            clean_log,
        ])
        ev_trunc = evaluate_trufflehog_output(trunc_ndjson, 0, pr_range)
        assert not ev_trunc.passed
        assert any("SCANNER_PARSE_ERROR" in e for e in ev_trunc.errors)

        for bad_code in (1, 2, 125, 255):
            ev_code = evaluate_trufflehog_output(clean_log, bad_code, pr_range)
            assert not ev_code.passed
            assert any("SCANNER_CRASH" in e for e in ev_code.errors)
        print("  [PASS] SEC-25: Malformed NDJSON, truncated JSON, and unknown exit codes rejected fail-closed")
        passed += 1

        # SEC-26: Summary finding count inconsistency (under/over-reporting) & exit 0 with findings rejected
        under_log = json.dumps({
            "level": "info-0", "msg": "finished scanning", "chunks": 2, "bytes": 200, "verified_secrets": 0, "unverified_secrets": 1,
        })
        ev_under = evaluate_trufflehog_output(under_log, 183, pr_range)
        assert not ev_under.passed
        assert any("UNACCOUNTED_SCAN_FINDINGS" in e for e in ev_under.errors)

        finding_rec = json.dumps({
            "SourceMetadata": {"Data": {"Git": {"commit": feat_sha, "file": "src/a.ts", "line": 1}}},
            "DetectorName": "CustomRegex",
            "Verified": False,
            "Raw": "dummy_secret_value_123",
            "ExtraData": {"name": "OmniNovelJwtSecret"},
        })
        over_log = "\n".join([
            finding_rec,
            clean_log,
        ])
        ev_over = evaluate_trufflehog_output(over_log, 183, pr_range)
        assert not ev_over.passed
        assert any("UNACCOUNTED_SCAN_FINDINGS" in e for e in ev_over.errors)

        exit0_with_findings = "\n".join([
            finding_rec,
            json.dumps({"level": "info-0", "msg": "finished scanning", "chunks": 2, "bytes": 200, "verified_secrets": 0, "unverified_secrets": 1}),
        ])
        ev_exit0 = evaluate_trufflehog_output(exit0_with_findings, 0, pr_range)
        assert not ev_exit0.passed
        assert any("INVALID_EXIT_CODE" in e for e in ev_exit0.errors)
        print("  [PASS] SEC-26: Finding count mismatch (under/over) and exit 0 with findings rejected fail-closed")
        passed += 1

        # SEC-27: Error sanitization blocks leakage across plain-text errors, JSON errors, malformed lines, exceptions
        raw_db_uri = "post" + "gresql://admin:super_secret_db_pass@postgres-host:5432/omninovel"
        raw_jwt_asgn = "JWT_SECRET=super_secret_jwt_token_value_xyz"
        raw_redis_asgn = 'REDIS_PASSWORD: "redis_super_pass_secret"'
        raw_weak_hash = "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        dummy_pem_block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0\n-----END RSA PRIVATE KEY-----"

        sanitize_stream = "\n".join([
            f"fatal: database connection failed: {raw_db_uri}",
            json.dumps({"level": "error", "msg": "encountered errors", "errors": [f"failed to parse config {raw_jwt_asgn} and {raw_redis_asgn}"]}),
            f'{{"bad_json": "{raw_weak_hash}", "key": "{dummy_pem_block}"',
            clean_log,
        ])
        ev_san = evaluate_trufflehog_output(sanitize_stream, 0, pr_range)
        assert not ev_san.passed
        san_serialized = json.dumps({"errors": ev_san.errors})
        assert "super_secret_db_pass" not in san_serialized
        assert "super_secret_jwt_token_value_xyz" not in san_serialized
        assert "redis_super_pass_secret" not in san_serialized
        assert "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855" not in san_serialized
        assert "MIIEowIBAAKCAQEA0" not in san_serialized
        assert "[REDACTED_SECRET]" in san_serialized
        print("  [PASS] SEC-27: Error sanitization blocks leakage of URIs, assignments, hashes, PEM blocks across all error paths")
        passed += 1

        print("--------------------------------------------------------------------------------")
        print(f"[TEST RESULT] {passed}/{passed} P0+P1 Secret Scan Unit & Governance Tests PASSED")
        print("================================================================================\n")
        return 0
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def run_e2e_docker_tests() -> int:
    """Execute live TruffleHog Docker regression (P0 E2E-01..06 + P1 Scoped Detection E2E-07..11)."""
    print("================================================================================")
    print("[E2E DOCKER] RUNNING LIVE TRUFFLEHOG CONTAINER P0+P1 REGRESSION SUITE")
    print(f"[INFO] Image: {TRUFFLEHOG_IMAGE}")
    print("================================================================================")

    repo_yaml = os.path.join(SCRIPT_REPO_ROOT, DEFAULT_PASS2_CONFIG_REL)
    _validate_pass2_yaml_structure(repo_yaml)

    tmp_root = tempfile.mkdtemp(prefix="omninovel_thog_e2e_")
    passed = 0
    try:
        repo = os.path.join(tmp_root, "repo")
        os.makedirs(repo)
        c0 = _init_git_repo(repo)

        # Clean PR commit
        with open(os.path.join(repo, "clean.txt"), "w", encoding="utf-8") as fh:
            fh.write("clean PR payload\n")
        _run_git(repo, ["add", "clean.txt"])
        _run_git(repo, ["commit", "-q", "-m", "feat: clean change"])
        c_clean = _run_git(repo, ["rev-parse", "HEAD"])
        clean_range = resolve_scan_range(repo, "pull_request", c0, c_clean)

        # E2E-01: Reproduce exact PR #209/#210 fail-open ref bug against real container
        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit="",
            branch_ref="209/merge",
            only_verified=True,
        )
        assert rc == 0, f"Expected TruffleHog CLI fail-open exit 0 on bad ref, got {rc}"
        ev_bad = evaluate_trufflehog_output(out, rc, clean_range)
        assert not ev_bad.passed
        assert any("SCANNER_ERROR:" in e for e in ev_bad.errors)
        assert any("ZERO_INPUT_SCANNED:" in e for e in ev_bad.errors)
        print(
            f"  [PASS] E2E-01: Live container reproduced fail-open bug (raw_exit={rc}, chunks={ev_bad.chunks}, bytes={ev_bad.bytes_scanned}) -> Gate BLOCKED fail-closed"
        )
        passed += 1

        # E2E-02: Real --only-verified clean commit diff MUST pass with chunks>0 and bytes>0
        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit=clean_range.since_commit,
            branch_ref=clean_range.branch,
            only_verified=True,
        )
        ev_clean = evaluate_trufflehog_output(out, rc, clean_range)
        assert ev_clean.passed, f"E2E-02 failed: {ev_clean.errors}"
        assert ev_clean.chunks > 0 and ev_clean.bytes_scanned > 0
        print(
            f"  [PASS] E2E-02: Live container clean PR diff PASSED (chunks={ev_clean.chunks}, bytes={ev_clean.bytes_scanned}, verified=0)"
        )
        passed += 1

        # E2E-03: Ephemeral throwaway OpenSSH dummy key detection proof (built-in PrivateKey detector)
        dummy_pem = _build_ephemeral_dummy_openssh_key()
        with open(os.path.join(repo, "ephemeral_dummy.key"), "w", encoding="utf-8") as fh:
            fh.write(dummy_pem)
        _run_git(repo, ["add", "ephemeral_dummy.key"])
        _run_git(repo, ["commit", "-q", "-m", "test: ephemeral dummy private key fixture"])
        c_key = _run_git(repo, ["rev-parse", "HEAD"])
        key_range = resolve_scan_range(repo, "pull_request", c_clean, c_key)

        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit=key_range.since_commit,
            branch_ref=key_range.branch,
            only_verified=False,
        )
        ev_key = evaluate_trufflehog_output(out, rc, key_range, fail_on_unverified=True)
        assert rc == 183, f"Expected exit 183 on dummy key, got {rc}"
        assert not ev_key.passed
        assert any(f["detector"] == "PrivateKey" for f in ev_key.findings_redacted)
        print(
            f"  [PASS] E2E-03: Live container detected ephemeral dummy key (raw_exit={rc}, detector=PrivateKey, unverified={ev_key.unverified_secrets}) -> Gate BLOCKED"
        )
        passed += 1

        # E2E-04: Custom regex detector rule proof with synthetic OmniNovel dummy canary
        dummy_canary = f"{DUMMY_CANARY_PREFIX}SafeFixture9876543210"
        cfg_path = os.path.join(tmp_root, "custom-canary.yaml")
        with open(cfg_path, "w", encoding="utf-8") as fh:
            fh.write(
                "detectors:\n"
                "  - name: OmniNovelDummyCanary\n"
                "    keywords:\n"
                f"      - {DUMMY_CANARY_PREFIX}\n"
                "    regex:\n"
                f"      canary: '{DUMMY_CANARY_PREFIX}[A-Za-z0-9]{{16,32}}'\n"
            )
        with open(os.path.join(repo, "canary_fixture.env"), "w", encoding="utf-8") as fh:
            fh.write(f"TEST_DUMMY_TOKEN={dummy_canary}\n")
        _run_git(repo, ["add", "canary_fixture.env"])
        _run_git(repo, ["commit", "-q", "-m", "test: ephemeral custom dummy canary"])
        c_canary = _run_git(repo, ["rev-parse", "HEAD"])
        canary_range = resolve_scan_range(repo, "pull_request", c_key, c_canary)

        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit=canary_range.since_commit,
            branch_ref=canary_range.branch,
            only_verified=False,
            config_path=cfg_path,
        )
        ev_canary = evaluate_trufflehog_output(out, rc, canary_range, fail_on_unverified=True)
        assert rc == 183, f"Expected exit 183 on custom dummy canary, got {rc}"
        assert not ev_canary.passed
        assert any(f["detector"] == "CustomRegex" for f in ev_canary.findings_redacted)
        print(
            f"  [PASS] E2E-04: Live container detected custom dummy canary (raw_exit={rc}, detector=CustomRegex, chunks={ev_canary.chunks}) -> Gate BLOCKED"
        )
        passed += 1

        # E2E-05: Live container merged-PR topology (pull_request) + push-to-main (incremental & ZERO_SHA) PASS
        _run_git(repo, ["checkout", "-q", "-b", "clean-main", c0])
        with open(os.path.join(repo, "web_main.ts"), "w", encoding="utf-8") as fh:
            fh.write("export const tombstoneSync = true;\n")
        _run_git(repo, ["add", "web_main.ts"])
        _run_git(repo, ["commit", "-q", "-m", "feat: advance simulated main"])
        c_main1 = _run_git(repo, ["rev-parse", "HEAD"])

        _run_git(repo, ["checkout", "-q", "-b", "sec-pr", c0])
        with open(os.path.join(repo, "sec_gate.py"), "w", encoding="utf-8") as fh:
            fh.write("print('clean security gate change')\n")
        _run_git(repo, ["add", "sec_gate.py"])
        _run_git(repo, ["commit", "-q", "-m", "fix(security): clean gate commit"])
        _run_git(repo, ["merge", "-q", "--no-ff", "clean-main", "-m", "chore: sync clean-main into sec-pr"])
        c_pr_sync = _run_git(repo, ["rev-parse", "HEAD"])

        synced_pr_range = resolve_scan_range(repo, "pull_request", c_main1, c_pr_sync)
        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit=synced_pr_range.since_commit,
            branch_ref=synced_pr_range.branch,
            only_verified=True,
        )
        ev_pr_sync = evaluate_trufflehog_output(out, rc, synced_pr_range)
        assert ev_pr_sync.passed, f"E2E-05 PR sync failed: {ev_pr_sync.errors}"
        assert ev_pr_sync.chunks > 0 and ev_pr_sync.bytes_scanned > 0

        _run_git(repo, ["checkout", "-q", "clean-main"])
        _run_git(repo, ["merge", "-q", "--no-ff", "sec-pr", "-m", "Merge PR into clean-main"])
        c_main2 = _run_git(repo, ["rev-parse", "HEAD"])

        push_range = resolve_scan_range(repo, "push", c_main1, c_main2)
        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit=push_range.since_commit,
            branch_ref=push_range.branch,
            only_verified=True,
        )
        ev_push_inc = evaluate_trufflehog_output(out, rc, push_range)
        assert ev_push_inc.passed, f"E2E-05 push incremental failed: {ev_push_inc.errors}"
        assert ev_push_inc.chunks > 0 and ev_push_inc.bytes_scanned > 0

        push_zero_range = resolve_scan_range(repo, "push", ZERO_SHA, c_main2)
        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit=push_zero_range.since_commit,
            branch_ref=push_zero_range.branch,
            only_verified=True,
        )
        ev_push_zero = evaluate_trufflehog_output(out, rc, push_zero_range)
        assert ev_push_zero.passed, f"E2E-05 ZERO_SHA push failed: {ev_push_zero.errors}"
        assert ev_push_zero.chunks > 0 and ev_push_zero.bytes_scanned > 0
        print(
            "  [PASS] E2E-05: Live container merged-PR & push-to-main scans PASSED "
            f"(pr_chunks={ev_pr_sync.chunks}, push_chunks={ev_push_inc.chunks}, init_chunks={ev_push_zero.chunks})"
        )
        passed += 1

        # E2E-06: Live container push scanner-error & push secret leak MUST fail closed
        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit="1" * 40,
            branch_ref=c_main2,
            only_verified=True,
        )
        assert rc == 0, f"Expected TruffleHog CLI fail-open exit 0 on invalid since-commit, got {rc}"
        ev_push_err = evaluate_trufflehog_output(out, rc, push_range)
        assert not ev_push_err.passed
        assert any("SCANNER_ERROR:" in e for e in ev_push_err.errors)
        assert any("ZERO_INPUT_SCANNED:" in e for e in ev_push_err.errors)

        with open(os.path.join(repo, "main_canary.env"), "w", encoding="utf-8") as fh:
            fh.write(f"MAIN_PUSH_TOKEN={dummy_canary}\n")
        _run_git(repo, ["add", "main_canary.env"])
        _run_git(repo, ["commit", "-q", "-m", "test: simulated push secret leak"])
        c_main3 = _run_git(repo, ["rev-parse", "HEAD"])
        push_leak_range = resolve_scan_range(repo, "push", c_main2, c_main3)
        rc, out = run_trufflehog_docker(
            repo_dir=repo,
            since_commit=push_leak_range.since_commit,
            branch_ref=push_leak_range.branch,
            only_verified=False,
            config_path=cfg_path,
        )
        ev_push_leak = evaluate_trufflehog_output(out, rc, push_leak_range, fail_on_unverified=True)
        assert rc == 183, f"Expected exit 183 on push dummy canary, got {rc}"
        assert not ev_push_leak.passed
        assert any(f["detector"] == "CustomRegex" for f in ev_push_leak.findings_redacted)
        print(
            f"  [PASS] E2E-06: Live container push scanner-error (raw_exit=0) & push leak (raw_exit={rc}) BLOCKED fail-closed"
        )
        passed += 1

        # =====================================================================
        # P1 LIVE DOCKER E2E SUITE (E2E-07 .. E2E-11)
        # =====================================================================
        p1_repo = os.path.join(tmp_root, "p1_repo")
        os.makedirs(p1_repo)
        p1_c0 = _init_git_repo(p1_repo)
        empty_al_path = os.path.join(tmp_root, "empty_al.json")
        _write_allowlist_file(empty_al_path, [])

        # Collect runtime synthetic secrets solely to assert zero-leak across outputs
        all_syn_secrets: List[str] = []

        # E2E-07: Synthetic unverified PrivateKey + all Pass 2 internal/R2/S3/DB secrets in production paths -> DETECT & FAIL
        syn_rsa = _build_ephemeral_dummy_openssh_key()
        syn_jwt = "synjwt_" + secrets.token_hex(12)
        syn_jref = "synjref_" + secrets.token_hex(12)
        syn_aiw = "synaiw_" + secrets.token_hex(12)
        syn_red = "synred_" + secrets.token_hex(12)
        syn_red_uri = "synreduri_" + secrets.token_hex(10)
        syn_db = "syndbpwd_" + secrets.token_hex(12)
        syn_akid = "AKIA" + "IOSFODNN7SYN0101"
        syn_r2s = "synr2sec_" + secrets.token_hex(16)
        syn_cf = "syncftok_" + secrets.token_hex(14)
        all_syn_secrets.extend([
            syn_jwt, syn_jref, syn_aiw, syn_red, syn_red_uri, syn_db, syn_akid, syn_r2s, syn_cf,
            syn_rsa.splitlines()[1],
        ])

        os.makedirs(os.path.join(p1_repo, "services", "api", "src"), exist_ok=True)
        with open(os.path.join(p1_repo, "services", "api", "src", "prod_secrets.env"), "w", encoding="utf-8") as fh:
            fh.write("\n".join([
                "JWT_" + "SECRET=" + syn_jwt,
                "JWT_REFRESH_" + "SECRET='" + syn_jref + "'",
                "AI_WORKER_" + "SECRET=" + syn_aiw,
                "REDIS_" + "PASSWORD=" + syn_red,
                "REDIS_URL=" + "redis" + "://default:" + syn_red_uri + "@redis.internal:6379/0",
                "DATABASE_" + "URL=" + "postgresql" + "://svcuser:" + syn_db + "@pg.internal:5432/omninovel",
                "S3_ACCESS_" + "KEY_ID=" + syn_akid,
                "R2_SECRET_" + "ACCESS_KEY=" + syn_r2s,
                "CLOUDFLARE_API_" + "TOKEN=" + syn_cf,
            ]) + "\n")
        with open(os.path.join(p1_repo, "services", "api", "src", "signing.pem"), "w", encoding="utf-8") as fh:
            fh.write(syn_rsa)
        _run_git(p1_repo, ["add", "."])
        _run_git(p1_repo, ["commit", "-q", "-m", "test: inject synthetic production secrets"])
        p1_c_prod = _run_git(p1_repo, ["rev-parse", "HEAD"])

        prod_range = resolve_scan_range(p1_repo, "pull_request", p1_c0, p1_c_prod)
        _, _, ev_p1_prod, p1_prod_rc = execute_dual_pass_gate(
            repo_dir=p1_repo,
            scan_range=prod_range,
            pass2_config_path=repo_yaml,
            allowlist_path=empty_al_path,
            audit_date=datetime.date(2026, 11, 9),
        )
        assert p1_prod_rc == 183, f"Expected exit 183 on P1 production secrets, got {p1_prod_rc}"
        assert not ev_p1_prod.passed
        found_dets = {f["canonical_detector"] for f in ev_p1_prod.findings_redacted}
        expected_dets = {
            "PrivateKey",
            "CustomRegex:OmniNovelJwtSecret",
            "CustomRegex:OmniNovelAiWorkerSecret",
            "CustomRegex:OmniNovelRedisPassword",
            "CustomRegex:OmniNovelDatabaseUrl",
            "Postgres",
            "CustomRegex:OmniNovelS3R2Credentials",
        }
        assert expected_dets.issubset(found_dets), f"Missing detectors: {expected_dets - found_dets}"
        assert ev_p1_prod.unverified_count >= len(expected_dets)
        serialized_prod = json.dumps({"errors": ev_p1_prod.errors, "findings": ev_p1_prod.findings_redacted})
        for s in all_syn_secrets:
            assert s not in serialized_prod, "Synthetic raw secret leaked in E2E-07 evaluation payload!"
            assert hashlib.sha256(s.encode("utf-8")).hexdigest() not in serialized_prod
        print(
            f"  [PASS] E2E-07: Live Pass 2 detected PrivateKey(Verified=false) + all 5 OmniNovel secret classes in prod paths "
            f"(detectors={len(found_dets)}, unverified={ev_p1_prod.unverified_count}, raw_leaks=0) -> Gate BLOCKED"
        )
        passed += 1

        # E2E-08: Ensure NO blanket exemption on tests/, docs/, plans/ and NO prefix bypass for dummy_/fake_/mock_
        syn_dummy_jwt = "dummy_" + secrets.token_hex(10)
        syn_fake_aiw = "fake_" + secrets.token_hex(10)
        syn_mock_r2 = "mock_" + secrets.token_hex(10)
        syn_doc_cf = "syn_doc_cf_" + secrets.token_hex(10)
        syn_plan_ssh = _build_ephemeral_dummy_openssh_key()
        all_syn_secrets.extend([syn_dummy_jwt, syn_fake_aiw, syn_mock_r2, syn_doc_cf, syn_plan_ssh.splitlines()[1]])

        os.makedirs(os.path.join(p1_repo, "tests"), exist_ok=True)
        os.makedirs(os.path.join(p1_repo, "docs"), exist_ok=True)
        os.makedirs(os.path.join(p1_repo, "plans"), exist_ok=True)
        with open(os.path.join(p1_repo, "tests", "leak_spec.ts"), "w", encoding="utf-8") as fh:
            fh.write(
                f"const a = 'ok';\n// JWT_" + f"SECRET='{syn_dummy_jwt}'\n"
                f"export const cfg = {{ AI_WORKER_" + f"SECRET: '{syn_fake_aiw}', R2_SECRET_" + f"ACCESS_KEY: '{syn_mock_r2}' }};\n"
            )
        with open(os.path.join(p1_repo, "docs", "guide.md"), "w", encoding="utf-8") as fh:
            fh.write("Run with `CLOUDFLARE_API_" + f"TOKEN={syn_doc_cf}`\n")
        with open(os.path.join(p1_repo, "plans", "key_note.txt"), "w", encoding="utf-8") as fh:
            fh.write(syn_plan_ssh)

        _run_git(p1_repo, ["add", "tests/leak_spec.ts", "docs/guide.md", "plans/key_note.txt"])
        _run_git(p1_repo, ["commit", "-q", "-m", "test: secrets with dummy_/fake_/mock_ inside tests/docs/plans"])
        p1_c_dirs = _run_git(p1_repo, ["rev-parse", "HEAD"])
        dirs_range = resolve_scan_range(p1_repo, "pull_request", p1_c_prod, p1_c_dirs)

        _, _, ev_dirs, dirs_rc = execute_dual_pass_gate(
            repo_dir=p1_repo,
            scan_range=dirs_range,
            pass2_config_path=repo_yaml,
            allowlist_path=empty_al_path,
            audit_date=datetime.date(2026, 11, 9),
        )
        assert dirs_rc == 183 and not ev_dirs.passed
        found_files = {f["file"] for f in ev_dirs.findings_redacted}
        assert {"tests/leak_spec.ts", "docs/guide.md", "plans/key_note.txt"}.issubset(found_files), found_files
        assert ev_dirs.unverified_count >= 5
        serialized_dirs = json.dumps({"errors": ev_dirs.errors, "findings": ev_dirs.findings_redacted})
        for s in all_syn_secrets:
            assert s not in serialized_dirs
        print(
            f"  [PASS] E2E-08: Scanned tests/, docs/, plans/ (no blanket exclusions) & rejected dummy_/fake_/mock_ "
            f"(files={sorted(found_files)}, unverified={ev_dirs.unverified_count}, raw_leaks=0) -> Gate BLOCKED"
        )
        passed += 1

        # E2E-09: Approved false positive PASS, then value / path / expiry mutation FAIL
        fp_repo = os.path.join(tmp_root, "fp_repo")
        os.makedirs(fp_repo)
        fp_c0 = _init_git_repo(fp_repo)

        syn_fp_tok = "syn_approved_fp_" + secrets.token_hex(12)
        all_syn_secrets.append(syn_fp_tok)
        fp_rel_path = "docs/controlled_example.md"
        os.makedirs(os.path.join(fp_repo, "docs"), exist_ok=True)
        with open(os.path.join(fp_repo, fp_rel_path), "w", encoding="utf-8") as fh:
            fh.write("Documented fixture: JWT_" + f"SECRET='{syn_fp_tok}'\n")
        _run_git(fp_repo, ["add", fp_rel_path])
        _run_git(fp_repo, ["commit", "-q", "-m", "docs: add controlled audited FP fixture"])
        fp_c1 = _run_git(fp_repo, ["rev-parse", "HEAD"])
        fp_range1 = resolve_scan_range(fp_repo, "pull_request", fp_c0, fp_c1)

        # Notice TruffleHog captures the assignment "JWT_SECRET='<syn_fp_tok>'" from the custom regex
        exact_matched_raw = "JWT_" + f"SECRET='{syn_fp_tok}'"
        fp_al_path = os.path.join(tmp_root, "fp_al.json")
        fp_entry = {
            "id": "E2E-FP-001",
            "classification": "approved_false_positive",
            "path": fp_rel_path,
            "detector": "CustomRegex:OmniNovelJwtSecret",
            "fingerprint": compute_salted_fingerprint(
                fp_rel_path, "CustomRegex:OmniNovelJwtSecret", exact_matched_raw, iterations=100_000
            ),
            "owner": "Security Audit",
            "rationale": "Explicit audited non-secret fixture for P1 E2E gate verification.",
            "expiry": "2026-12-01",
        }
        _write_allowlist_file(fp_al_path, [fp_entry])

        # E2E-09a: Explicit approved_false_positive -> PASS!
        ev_fp_p1, _, ev_fp_p2, fp_p2_rc = execute_dual_pass_gate(
            repo_dir=fp_repo,
            scan_range=fp_range1,
            pass2_config_path=repo_yaml,
            allowlist_path=fp_al_path,
            audit_date=datetime.date(2026, 11, 9),
        )
        assert ev_fp_p1.passed and ev_fp_p2.passed, f"E2E-09a expected PASS, errors={ev_fp_p2.errors}"
        assert ev_fp_p2.approved_false_positive_count == 1
        assert ev_fp_p2.unverified_count == 0
        assert fp_p2_rc == 183 and ev_fp_p2.chunks > 0 and ev_fp_p2.bytes_scanned > 0
        assert syn_fp_tok not in json.dumps(ev_fp_p2.findings_redacted)

        # E2E-09b: Mutate expiry to expired date -> FAIL
        expired_al_path = os.path.join(tmp_root, "fp_al_expired.json")
        expired_entry = dict(fp_entry, expiry="2020-01-01")
        _write_allowlist_file(expired_al_path, [expired_entry])
        try:
            execute_dual_pass_gate(
                repo_dir=fp_repo,
                scan_range=fp_range1,
                pass2_config_path=repo_yaml,
                allowlist_path=expired_al_path,
                audit_date=datetime.date(2026, 11, 9),
            )
            raise AssertionError("E2E-09b expected EXPIRED_ALLOWLIST_ENTRY failure!")
        except ScanGateError as exc:
            assert exc.code == "EXPIRED_ALLOWLIST_ENTRY"

        # E2E-09c: Mutate secret value -> FAIL
        mut_val_tok = syn_fp_tok + "_MUT"
        all_syn_secrets.append(mut_val_tok)
        with open(os.path.join(fp_repo, fp_rel_path), "w", encoding="utf-8") as fh:
            fh.write("Documented fixture: JWT_" + f"SECRET='{mut_val_tok}'\n")
        _run_git(fp_repo, ["add", fp_rel_path])
        _run_git(fp_repo, ["commit", "-q", "-m", "test: mutate secret value"])
        fp_c2 = _run_git(fp_repo, ["rev-parse", "HEAD"])
        fp_range2 = resolve_scan_range(fp_repo, "pull_request", fp_c1, fp_c2)
        _, _, ev_mut_val, _ = execute_dual_pass_gate(
            repo_dir=fp_repo,
            scan_range=fp_range2,
            pass2_config_path=repo_yaml,
            allowlist_path=fp_al_path,
            audit_date=datetime.date(2026, 11, 9),
        )
        assert not ev_mut_val.passed and ev_mut_val.unverified_count == 1
        assert mut_val_tok not in json.dumps({"e": ev_mut_val.errors, "f": ev_mut_val.findings_redacted})

        # E2E-09d: Mutate path (same exact value in new file) -> FAIL
        moved_path = "docs/moved_example.md"
        with open(os.path.join(fp_repo, moved_path), "w", encoding="utf-8") as fh:
            fh.write("Documented fixture: JWT_" + f"SECRET='{syn_fp_tok}'\n")
        _run_git(fp_repo, ["add", moved_path])
        _run_git(fp_repo, ["commit", "-q", "-m", "test: move exact secret value to unallowlisted path"])
        fp_c3 = _run_git(fp_repo, ["rev-parse", "HEAD"])
        fp_range3 = resolve_scan_range(fp_repo, "pull_request", fp_c2, fp_c3)
        _, _, ev_mut_path, _ = execute_dual_pass_gate(
            repo_dir=fp_repo,
            scan_range=fp_range3,
            pass2_config_path=repo_yaml,
            allowlist_path=fp_al_path,
            audit_date=datetime.date(2026, 11, 9),
        )
        assert not ev_mut_path.passed and ev_mut_path.unverified_count == 1
        print(
            "  [PASS] E2E-09: Live container explicit approved_false_positive PASS; value/path/expiry mutations all FAILED fail-closed"
        )
        passed += 1

        # E2E-10: Clean Pass 1 + Pass 2 PR & Push PASS (with plumbing patterns verifying zero false positives)
        clean_p1_repo = os.path.join(tmp_root, "clean_p1_repo")
        os.makedirs(clean_p1_repo)
        cp_c0 = _init_git_repo(clean_p1_repo)
        plumbing_src = "\n".join([
            "export const runtimeCfg = {",
            "  jwt: process.env.JWT_SECRET,",
            "  refresh: process.env.JWT_REFRESH_SECRET || '',",
            "  worker: process.env.AI_WORKER_SECRET ?? '',",
            "  redis: process.env.REDIS_PASSWORD,",
            "  db: `postgresql://${process.env.DB_USER}:${process.env.DB_PASS}@localhost:5432/db`,",
            "  dbNoPass: 'postgresql://postgres@localhost:5432/db',",
            "  redisVar: '--requirepass $$REDIS_PASSWORD',",
            "  accessKeyId: accessKey,",
            "  secretAccessKey: secretKey,",
            "};",
        ]) + "\n"
        with open(os.path.join(clean_p1_repo, "runtime.ts"), "w", encoding="utf-8") as fh:
            fh.write(plumbing_src)
        _run_git(clean_p1_repo, ["add", "runtime.ts"])
        _run_git(clean_p1_repo, ["commit", "-q", "-m", "feat: clean env plumbing"])
        cp_c1 = _run_git(clean_p1_repo, ["rev-parse", "HEAD"])

        cp_pr = resolve_scan_range(clean_p1_repo, "pull_request", cp_c0, cp_c1)
        p1_cp, _, p2_cp, _ = execute_dual_pass_gate(
            repo_dir=clean_p1_repo,
            scan_range=cp_pr,
            pass2_config_path=repo_yaml,
            allowlist_path=empty_al_path,
            audit_date=datetime.date(2026, 11, 9),
        )
        assert p1_cp.passed and p2_cp.passed, f"E2E-10 PR failed: {p1_cp.errors + p2_cp.errors}"
        assert p2_cp.chunks > 0 and p2_cp.bytes_scanned > 0

        cp_push = resolve_scan_range(clean_p1_repo, "push", cp_c0, cp_c1)
        p1_ps, _, p2_ps, _ = execute_dual_pass_gate(
            repo_dir=clean_p1_repo,
            scan_range=cp_push,
            pass2_config_path=repo_yaml,
            allowlist_path=empty_al_path,
            audit_date=datetime.date(2026, 11, 9),
        )
        assert p1_ps.passed and p2_ps.passed, f"E2E-10 push failed: {p1_ps.errors + p2_ps.errors}"
        assert p2_ps.chunks > 0 and p2_ps.bytes_scanned > 0
        print(
            f"  [PASS] E2E-10: Clean PR & Push dual-pass (Pass 1 + Pass 2) PASSED with plumbing safety "
            f"(p2_pr_chunks={p2_cp.chunks}, p2_push_chunks={p2_ps.chunks})"
        )
        passed += 1

        # E2E-11: End-to-end log & exception audit verifying ZERO synthetic raw secret leakage
        combined_audit_blob = json.dumps({
            "prod": {"err": ev_p1_prod.errors, "find": ev_p1_prod.findings_redacted},
            "dirs": {"err": ev_dirs.errors, "find": ev_dirs.findings_redacted},
            "fp": {"err": ev_fp_p2.errors, "find": ev_fp_p2.findings_redacted},
            "mutv": {"err": ev_mut_val.errors, "find": ev_mut_val.findings_redacted},
            "mutp": {"err": ev_mut_path.errors, "find": ev_mut_path.findings_redacted},
        })
        for secret_val in all_syn_secrets:
            assert secret_val not in combined_audit_blob, "Raw synthetic secret leaked into E2E-11 aggregate output!"
            assert hashlib.sha256(secret_val.encode("utf-8")).hexdigest() not in combined_audit_blob
        print(
            f"  [PASS] E2E-11: Audited all {len(all_syn_secrets)} synthetic test secrets across E2E logs/findings -> 0 leaks & 0 weak hashes"
        )
        passed += 1

        print("--------------------------------------------------------------------------------")
        print(f"[E2E RESULT] {passed}/{passed} Live TruffleHog Docker P0+P1 Regression Tests PASSED")
        print("================================================================================\n")
        return 0
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def _print_findings(findings: List[Dict[str, Any]], include_unapproved_only: bool = True) -> None:
    """Print strictly redacted, auditable finding telemetry (NO raw secret or fingerprint)."""
    for idx, finding in enumerate(findings, 1):
        cls = finding.get("classification", "unverified")
        det = finding.get("canonical_detector", finding.get("detector", "unknown"))
        loc = f"{finding.get('file', 'unknown')}:{finding.get('line', 0)}"
        commit = finding.get("commit", "unknown")
        if cls in {"verified", "unverified"}:
            print(
                f"::error::SECRET FINDING id=F-{idx:03d} class={cls} detector={det} "
                f"verified={finding['verified']} file={loc} commit={commit}"
            )
        elif not include_unapproved_only:
            print(
                f"[AUDIT] ALLOWLISTED id={finding.get('allowlist_id', 'unknown')} class={cls} "
                f"detector={det} file={loc} owner={finding.get('owner', 'unknown')} "
                f"expiry={finding.get('expiry', 'unknown')}"
            )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run TruffleHog OSS Pass 1 (Verified) + Pass 2 (P1 Scoped) Fail-Closed Gate."
    )
    parser.add_argument("--test", action="store_true", help="Run P0+P1 unit, governance & zero-leak test matrix")
    parser.add_argument("--e2e-docker", action="store_true", help="Run live Docker TruffleHog P0+P1 regression suite")
    parser.add_argument("--event", type=str, help="GitHub event name (pull_request, push, workflow_dispatch, schedule)")
    parser.add_argument("--base-ref", type=str, default="", help="Base commit/ref (PR base SHA or push before SHA)")
    parser.add_argument("--head-ref", type=str, default="", help="Head commit/ref (PR head SHA or push SHA)")
    parser.add_argument("--repo-dir", type=str, default=".", help="Path to git repository")
    parser.add_argument("--config", type=str, default=None, help="Optional TruffleHog config YAML for Pass 1")
    parser.add_argument("--pass2-config", type=str, default=None, help="TruffleHog scoped detector YAML for Pass 2")
    parser.add_argument("--allowlist", type=str, default=None, help="Path to salted P1 secret-scan-allowlist.json")
    parser.add_argument("--audit-date", type=str, default=None, help="Optional YYYY-MM-DD audit date override")
    parser.add_argument("--include-unverified", action="store_true", help="Pass 1 fail on unverified findings too")
    args = parser.parse_args()

    try:
        if args.test:
            if run_unit_tests() != 0:
                return 1
            if not args.event and not args.e2e_docker:
                return 0

        if args.e2e_docker:
            if run_e2e_docker_tests() != 0:
                return 1
            if not args.event:
                return 0

        if not args.event:
            parser.error("Provide --event or --test / --e2e-docker.")

        audit_date: Optional[datetime.date] = None
        if args.audit_date:
            if not DATE_RE.match(args.audit_date.strip()):
                raise ScanGateError("INVALID_AUDIT_DATE", f"Invalid --audit-date '{args.audit_date}'.")
            audit_date = datetime.datetime.strptime(args.audit_date.strip(), "%Y-%m-%d").date()

        pass2_cfg = args.pass2_config or _resolve_default_asset(
            args.repo_dir, DEFAULT_PASS2_CONFIG_REL, "PASS2_CONFIG_MISSING"
        )
        allowlist_path = args.allowlist or _resolve_default_asset(
            args.repo_dir, DEFAULT_ALLOWLIST_REL, "ALLOWLIST_MISSING"
        )
        _validate_pass2_yaml_structure(pass2_cfg)

        print("================================================================================")
        print("[SECURITY GATE] OmniNovel TruffleHog P0+P1 Fail-Closed Secret Scan (Pass 1 + Pass 2)")
        print("================================================================================")

        scan_range = resolve_scan_range(
            repo_dir=args.repo_dir,
            event_name=args.event,
            base_ref=args.base_ref,
            head_ref=args.head_ref,
        )

        print(f"[INFO] Event        : {scan_range.event}")
        print(f"[INFO] Since Commit : {scan_range.since_commit or '<FULL_HISTORY>'}")
        print(f"[INFO] Branch/Head  : {scan_range.branch}")
        print(f"[INFO] Commits      : {scan_range.commit_count}")
        print(f"[INFO] Changed Files: {len(scan_range.changed_files)}")
        print(f"[INFO] Pass 2 Config: {_display_path(pass2_cfg, args.repo_dir)}")
        print(f"[INFO] Allowlist    : {_display_path(allowlist_path, args.repo_dir)}")
        print(f"[INFO] Image        : {TRUFFLEHOG_IMAGE}")

        p1_eval, p1_rc, p2_eval, p2_rc = execute_dual_pass_gate(
            repo_dir=args.repo_dir,
            scan_range=scan_range,
            pass2_config_path=pass2_cfg,
            allowlist_path=allowlist_path,
            audit_date=audit_date,
            pass1_config_path=args.config,
            pass1_include_unverified=args.include_unverified,
        )

        print(
            f"[PASS 1 TELEMETRY] chunks={p1_eval.chunks} bytes={p1_eval.bytes_scanned} "
            f"verified={p1_eval.verified_count} unverified={p1_eval.unverified_count} "
            f"duration={p1_eval.scan_duration} raw_exit={p1_rc}"
        )
        print(
            f"[PASS 2 TELEMETRY] chunks={p2_eval.chunks} bytes={p2_eval.bytes_scanned} "
            f"verified={p2_eval.verified_count} unverified={p2_eval.unverified_count} "
            f"approved_false_positive={p2_eval.approved_false_positive_count} "
            f"dummy={p2_eval.dummy_count} duration={p2_eval.scan_duration} raw_exit={p2_rc}"
        )

        _print_findings(p1_eval.findings_redacted, include_unapproved_only=True)
        _print_findings(p2_eval.findings_redacted, include_unapproved_only=False)

        if not p1_eval.passed or not p2_eval.passed:
            print("\n[FAIL] TRUFFLEHOG P0+P1 FAIL-CLOSED GATE REJECTED SCAN:")
            for err in p1_eval.errors:
                print(f"::error::[PASS1] {err}")
            for err in p2_eval.errors:
                print(f"::error::[PASS2] {err}")
            print("================================================================================")
            return 1

        print(
            f"\n[PASS] SECRET SCAN P0+P1 PASSED: "
            f"Pass 1 (chunks={p1_eval.chunks}, bytes={p1_eval.bytes_scanned}, verified=0); "
            f"Pass 2 (chunks={p2_eval.chunks}, bytes={p2_eval.bytes_scanned}, "
            f"verified=0, unverified=0, approved_false_positive={p2_eval.approved_false_positive_count}, "
            f"dummy={p2_eval.dummy_count})."
        )
        print("================================================================================")
        return 0
    except ScanGateError as exc:
        print(f"::error::{_scrub_sensitive_text(exc.code)}: {_scrub_sensitive_text(exc.message)}")
        print("[FAIL] SECRET SCAN PREFLIGHT/GOVERNANCE FAILED (FAIL-CLOSED)")
        print("================================================================================")
        return 1
    except Exception as exc:
        print(f"::error::INTERNAL_GATE_ERROR: {_safe_error_summary(exc)}")
        print("[FAIL] SECRET SCAN INTERNAL FAILURE (FAIL-CLOSED)")
        print("================================================================================")
        return 1


if __name__ == "__main__":
    sys.exit(main())
