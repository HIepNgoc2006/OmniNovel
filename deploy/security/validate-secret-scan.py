#!/usr/bin/env python3
"""
TruffleHog Fail-Closed Secret Scan Wrapper & Regression Gate (P0 Security Fix)

Addresses the TruffleHog fail-open vulnerability where unresolvable git refs,
scan errors, or 0-chunk/0-byte scans exit with code 0.

Enforces:
  1. Strict git commit ref resolution & validation via `git rev-parse --verify`
     for both `pull_request` (base..head via merge-base) and `push` (before..after,
     or full reachable branch on initial zero-SHA branch push).
  2. Fail-closed validation of TruffleHog execution:
     - Unexpected exit codes (anything other than 0 or 183) fail immediately.
     - Any TruffleHog error log (`level == "error"` or `"encountered errors"`) fails.
     - Missing `"finished scanning"` telemetry summary fails.
     - Zero scanned input (`chunks == 0` or `bytes == 0`) when commits or changed
       files exist fails immediately (`ZERO_INPUT_SCANNED`).
     - Any secret finding triggers immediate failure (`SECRETS_DETECTED`) while
       redacting raw secret material from CI logs.
  3. Built-in `--test` and `--e2e-docker` regression suites using an ephemeral
     safe dummy secret fixture (never persisted in git history).
"""

import argparse
from dataclasses import dataclass
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import tempfile
import base64
from typing import Any, Dict, List, Optional, Tuple

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
ZERO_SHA = "0" * 40
SHA_PATTERN = re.compile(r"^[0-9a-fA-F]{40}$")
DUMMY_CANARY_PREFIX = "OMNINOVEL_DUMMY_" + "CANARY_"


class ScanGateError(RuntimeError):
    """Raised when git ref resolution or preflight validation fails."""

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
class ScanEvaluation:
    passed: bool
    errors: List[str]
    chunks: int
    bytes_scanned: int
    verified_secrets: int
    unverified_secrets: int
    scan_duration: str
    findings_redacted: List[Dict[str, Any]]


def _run_git(repo_dir: str, args: List[str]) -> str:
    cmd = ["git", "-C", repo_dir] + args
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0:
        stderr = (proc.stderr or proc.stdout or "").strip()
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


def _redact_finding(obj: Dict[str, Any]) -> Dict[str, Any]:
    """Strip raw secret payloads before any logging or serialization."""
    git_meta = (
        obj.get("SourceMetadata", {})
        .get("Data", {})
        .get("Git", {})
    )
    return {
        "detector": obj.get("DetectorName", "unknown"),
        "verified": bool(obj.get("Verified", False)),
        "file": git_meta.get("file", "unknown"),
        "line": git_meta.get("line", 0),
        "commit": git_meta.get("commit", "unknown"),
        "extra": obj.get("ExtraData") or {},
    }


def evaluate_trufflehog_output(
    raw_output: str,
    exit_code: int,
    scan_range: ScanRange,
    fail_on_unverified: bool = False,
) -> ScanEvaluation:
    """Parse TruffleHog -j NDJSON output and enforce strict fail-closed invariants."""
    errors: List[str] = []
    scanner_errors: List[str] = []
    findings_redacted: List[Dict[str, Any]] = []
    summary: Optional[Dict[str, Any]] = None

    if exit_code not in (0, 183):
        errors.append(f"SCANNER_CRASH: TruffleHog exited with unexpected status code {exit_code}.")

    for raw_line in (raw_output or "").splitlines():
        line = raw_line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        level = str(obj.get("level", "")).lower()
        msg = str(obj.get("msg", ""))
        if level == "error" or "encountered errors" in msg.lower():
            detail = obj.get("errors") or obj.get("error") or msg
            scanner_errors.append(f"{msg}: {detail}")
        elif "DetectorName" in obj or "SourceMetadata" in obj:
            findings_redacted.append(_redact_finding(obj))
        elif msg == "finished scanning":
            summary = obj

    for err_detail in scanner_errors:
        errors.append(f"SCANNER_ERROR: {err_detail}")

    if summary is None:
        errors.append(
            "MISSING_SCAN_SUMMARY: TruffleHog 'finished scanning' JSON telemetry record is missing."
        )
        return ScanEvaluation(
            passed=False,
            errors=errors,
            chunks=0,
            bytes_scanned=0,
            verified_secrets=0,
            unverified_secrets=0,
            scan_duration="unknown",
            findings_redacted=findings_redacted,
        )

    try:
        chunks = int(summary["chunks"])
        bytes_scanned = int(summary["bytes"])
        verified_secrets = int(summary.get("verified_secrets", 0))
        unverified_secrets = int(summary.get("unverified_secrets", 0))
    except (KeyError, TypeError, ValueError) as exc:
        errors.append(f"INVALID_SCAN_METRICS: Malformed summary metrics ({exc}).")
        return ScanEvaluation(
            passed=False,
            errors=errors,
            chunks=0,
            bytes_scanned=0,
            verified_secrets=0,
            unverified_secrets=0,
            scan_duration=str(summary.get("scan_duration", "unknown")),
            findings_redacted=findings_redacted,
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

    verified_findings = [f for f in findings_redacted if f["verified"]]
    if verified_secrets > 0 or len(verified_findings) > 0:
        errors.append(
            f"SECRETS_DETECTED: TruffleHog detected {max(verified_secrets, len(verified_findings))} verified secret(s)."
        )

    if fail_on_unverified and (unverified_secrets > 0 or len(findings_redacted) > 0):
        errors.append(
            f"SECRETS_DETECTED: TruffleHog detected {max(unverified_secrets, len(findings_redacted))} unverified/custom secret(s)."
        )

    if exit_code == 183 and not any(e.startswith("SECRETS_DETECTED:") for e in errors):
        errors.append("SECRETS_DETECTED: TruffleHog exited with finding exit code 183.")

    return ScanEvaluation(
        passed=len(errors) == 0,
        errors=errors,
        chunks=chunks,
        bytes_scanned=bytes_scanned,
        verified_secrets=verified_secrets,
        unverified_secrets=unverified_secrets,
        scan_duration=scan_duration,
        findings_redacted=findings_redacted,
    )


def run_trufflehog_docker(
    repo_dir: str,
    since_commit: Optional[str],
    branch_ref: str,
    only_verified: bool = True,
    config_path: Optional[str] = None,
) -> Tuple[int, str]:
    """Execute pinned TruffleHog Docker container against a git repository."""
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
        cmd.extend(["-v", f"{abs_cfg}:/thog/config.yaml:ro"])

    cmd.extend([TRUFFLEHOG_IMAGE, "git", "file:///repo/"])
    if since_commit is not None:
        cmd.extend(["--since-commit", since_commit])
    cmd.extend(["--branch", branch_ref])

    if config_path:
        cmd.extend(["--config", "/thog/config.yaml"])
    if only_verified:
        cmd.append("--only-verified")
    else:
        cmd.extend(["--no-verification", "--results=verified,unverified"])

    cmd.extend(["--fail", "--no-update", "-j"])

    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    combined = "\n".join(part for part in (proc.stdout, proc.stderr) if part)
    return proc.returncode, combined


def _build_ephemeral_dummy_openssh_key() -> str:
    """Generate a harmless throwaway Ed25519-formatted OpenSSH PEM block strictly for test runtime."""
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


def run_unit_tests() -> int:
    """Execute fail-closed ref resolution and JSON parser matrix (15 assertions)."""
    print("================================================================================")
    print("[TEST] RUNNING SECRET SCAN FAIL-CLOSED UNIT & GIT RESOLUTION MATRIX")
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
        secret_sentinel = "SENSITIVE_UNIT_TEST_RAW_VALUE_DO_NOT_LOG"
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

        print("--------------------------------------------------------------------------------")
        print(f"[TEST RESULT] {passed}/{passed} Secret Scan Fail-Closed Unit Tests PASSED")
        print("================================================================================\n")
        return 0
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def run_e2e_docker_tests() -> int:
    """Execute live TruffleHog Docker regression & dummy-secret detection proof."""
    print("================================================================================")
    print("[E2E DOCKER] RUNNING LIVE TRUFFLEHOG CONTAINER REGRESSION & DUMMY SECRET PROOF")
    print(f"[INFO] Image: {TRUFFLEHOG_IMAGE}")
    print("================================================================================")

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

        print("--------------------------------------------------------------------------------")
        print(f"[E2E RESULT] {passed}/{passed} Live TruffleHog Docker Regression Tests PASSED")
        print("================================================================================\n")
        return 0
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Run TruffleHog OSS secret scan with strict fail-closed validation."
    )
    parser.add_argument("--test", action="store_true", help="Run unit and git-resolution test matrix")
    parser.add_argument("--e2e-docker", action="store_true", help="Run live Docker TruffleHog dummy-secret & fail-closed regression")
    parser.add_argument("--event", type=str, help="GitHub event name (pull_request, push, workflow_dispatch, schedule)")
    parser.add_argument("--base-ref", type=str, default="", help="Base commit/ref (PR base SHA or push before SHA)")
    parser.add_argument("--head-ref", type=str, default="", help="Head commit/ref (PR head SHA or push SHA)")
    parser.add_argument("--repo-dir", type=str, default=".", help="Path to git repository")
    parser.add_argument("--config", type=str, default=None, help="Optional TruffleHog custom detector config YAML")
    parser.add_argument("--include-unverified", action="store_true", help="Scan without --only-verified and fail on unverified findings")
    args = parser.parse_args()

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

    print("================================================================================")
    print("[SECURITY GATE] OmniNovel TruffleHog Fail-Closed Secret Scan")
    print("================================================================================")
    try:
        scan_range = resolve_scan_range(
            repo_dir=args.repo_dir,
            event_name=args.event,
            base_ref=args.base_ref,
            head_ref=args.head_ref,
        )
    except ScanGateError as exc:
        print(f"::error::{exc.code}: {exc.message}")
        print("[FAIL] SECRET SCAN PREFLIGHT FAILED (FAIL-CLOSED)")
        print("================================================================================")
        return 1

    print(f"[INFO] Event        : {scan_range.event}")
    print(f"[INFO] Since Commit : {scan_range.since_commit or '<FULL_HISTORY>'}")
    print(f"[INFO] Branch/Head  : {scan_range.branch}")
    print(f"[INFO] Commits      : {scan_range.commit_count}")
    print(f"[INFO] Changed Files: {len(scan_range.changed_files)}")
    print(f"[INFO] Image        : {TRUFFLEHOG_IMAGE}")

    try:
        exit_code, raw_output = run_trufflehog_docker(
            repo_dir=args.repo_dir,
            since_commit=scan_range.since_commit,
            branch_ref=scan_range.branch,
            only_verified=not args.include_unverified,
            config_path=args.config,
        )
    except ScanGateError as exc:
        print(f"::error::{exc.code}: {exc.message}")
        print("[FAIL] SECRET SCAN EXECUTION FAILED (FAIL-CLOSED)")
        print("================================================================================")
        return 1

    evaluation = evaluate_trufflehog_output(
        raw_output=raw_output,
        exit_code=exit_code,
        scan_range=scan_range,
        fail_on_unverified=args.include_unverified,
    )

    print(
        f"[TELEMETRY] chunks={evaluation.chunks} bytes={evaluation.bytes_scanned} "
        f"verified_secrets={evaluation.verified_secrets} unverified_secrets={evaluation.unverified_secrets} "
        f"duration={evaluation.scan_duration} raw_exit={exit_code}"
    )

    for finding in evaluation.findings_redacted:
        if finding["verified"] or args.include_unverified:
            print(
                f"::error::SECRET FINDING detector={finding['detector']} verified={finding['verified']} "
                f"file={finding['file']}:{finding['line']} commit={finding['commit']}"
            )

    if not evaluation.passed:
        print("\n[FAIL] TRUFFLEHOG FAIL-CLOSED GATE REJECTED SCAN:")
        for err in evaluation.errors:
            print(f"::error::{err}")
        print("================================================================================")
        return 1

    print(
        f"\n[PASS] SECRET SCAN PASSED: Scanned {evaluation.chunks} chunks / {evaluation.bytes_scanned} bytes "
        f"across {scan_range.commit_count} commit(s) with 0 verified secrets and 0 scanner errors."
    )
    print("================================================================================")
    return 0


if __name__ == "__main__":
    sys.exit(main())
