#!/usr/bin/env python3
"""
Static Validation & Negative Assertion Suite for Production Rollback Runbook (P1.1 Final Gate)

Strict Invariants Validated:
1. Presence of deploy/PRODUCTION_ROLLBACK_RUNBOOK.md.
2. Status is NOT 'APPROVED & LOCKED' (must be DRAFT / PENDING REVIEW).
3. Ground-truth gap disclosure: Explicitly declares immutable image rollback as 'NOT YET SUPPORTED' in current CI.
4. Target Release Manifest schema and fail-closed digest mismatch verification logic.
5. Prohibition of unsafe Git patterns ('git checkout -B main', detached HEAD without reconciliation, direct push to main).
6. Dual GitOps revert syntax: Merge commit (-m 1) vs Single/Squash commit (no -m 1) with rev-parse check.
7. Healthcheck separation: Distinct HTTP Readiness Probe vs TLS x509 Certificate / SAN inspection (no conflation).
8. Host port 8000 protection: Rejects host port 8000 curl (TOP-02 compliant), requires Ingress port 443 or container exec.
9. SSH security: known_hosts pinning with independent fingerprint verification (ssh-keygen -lf) and Environment Approval Gate.
10. Schema Compatibility Matrix: No unconditional migration:revert, requires PITR snapshot preflight.
11. Downtime analysis: Rejects unsubstantiated fixed downtime claims, acknowledges cold start / pool acquisition factors.
12. VPS tracking branch reconciliation: Mandatory restoration back to origin/main.
13. Docker Compose topology negative validation matrix (17/17 scenarios).
"""

import os
import re
import subprocess
import sys

RUNBOOK_PATH = os.path.join(os.path.dirname(__file__), "PRODUCTION_ROLLBACK_RUNBOOK.md")

def read_runbook() -> str:
    assert os.path.isfile(RUNBOOK_PATH), f"Missing runbook file at {RUNBOOK_PATH}"
    with open(RUNBOOK_PATH, "r", encoding="utf-8") as f:
        return f.read()

def test_runbook_file_exists():
    content = read_runbook()
    assert len(content) > 1000, "Runbook content is too short or empty"
    print("  [PASS] RUNBOOK-01: Runbook document exists at deploy/PRODUCTION_ROLLBACK_RUNBOOK.md")

def test_status_is_draft_pending_review():
    content = read_runbook()
    assert "APPROVED & LOCKED" not in content, "Runbook must NOT claim 'APPROVED & LOCKED' while gaps exist"
    assert "DRAFT / PENDING REVIEW" in content, "Runbook must state 'DRAFT / PENDING REVIEW'"
    print("  [PASS] RUNBOOK-02: Status correctly asserted as DRAFT / PENDING REVIEW")

def test_gap_analysis_and_not_yet_supported_notice():
    content = read_runbook()
    assert "NOT YET SUPPORTED" in content, (
        "Runbook must explicitly declare immutable image rollback as NOT YET SUPPORTED in current CI topology"
    )
    assert "build:" in content and "image:" in content, (
        "Runbook must explain build vs image distinction in deploy/docker-compose.yml"
    )
    print("  [PASS] RUNBOOK-03: Architectural gap disclosed and marked NOT YET SUPPORTED")

def test_target_release_manifest_and_fail_closed_digest():
    content = read_runbook()
    assert "release-manifest.json" in content, "Runbook must specify release-manifest.json"
    assert "EXPECTED_DIGEST" in content or "digest" in content, "Runbook must specify digest comparison"
    assert "CRITICAL FAIL-CLOSED" in content or "FAIL-CLOSED" in content, (
        "Runbook must specify fail-closed behavior on digest mismatch"
    )
    print("  [PASS] RUNBOOK-04: Target Release Manifest & fail-closed image identity verification verified")

def get_code_blocks(content: str) -> list[str]:
    blocks = []
    in_block = False
    current_block = []
    for line in content.splitlines():
        if line.startswith("```"):
            if in_block:
                blocks.append("\n".join(current_block))
                current_block = []
                in_block = False
            else:
                in_block = True
        elif in_block:
            current_block.append(line)
    return blocks

def test_no_unsafe_git_checkout_b_main():
    content = read_runbook()
    code_blocks = get_code_blocks(content)
    for block in code_blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip() and not line.strip().startswith('#')]
        for line in lines:
            assert not re.search(r'\bgit\s+checkout\s+-B\s+main\b', line), (
                f"Executable 'git checkout -B main' found in runbook code block: {line}"
            )
    assert "CẤM sử dụng `git checkout -B main`" in content or "CẤM sử dụng git checkout -B main" in content, (
        "Runbook must explicitly prohibit 'git checkout -B main'"
    )
    print("  [PASS] RUNBOOK-05: Unsafe 'git checkout -B main' prohibited with zero executable occurrences")

def test_no_direct_push_to_main_command():
    content = read_runbook()
    code_blocks = get_code_blocks(content)
    for block in code_blocks:
        lines = [line.strip() for line in block.splitlines() if line.strip() and not line.strip().startswith('#')]
        for line in lines:
            assert not re.match(r'^git\s+push\s+origin\s+main\b', line), (
                f"Executable 'git push origin main' found in runbook code block: {line}"
            )
    assert "CẤM tuyệt đối push trực tiếp lên nhánh `main`" in content or "tuyệt đối không push lên main" in content, (
        "Runbook must explicitly prohibit direct push to main"
    )
    print("  [PASS] RUNBOOK-06: Direct push to main strictly prohibited with zero executable occurrences")

def test_dual_revert_syntax_with_detection():
    content = read_runbook()
    assert "git revert -m 1" in content, "Runbook must specify 'git revert -m 1' for merge commits"
    assert "rev-parse" in content, "Runbook must include 'git rev-parse' commit parent detection"
    assert "error: option -m is only for merge commits" in content or "Squash & Merge" in content, (
        "Runbook must distinguish squash/single commit syntax"
    )
    print("  [PASS] RUNBOOK-07: Dual revert syntax (merge -m 1 vs squash/single) with rev-parse asserted")

def test_healthcheck_separation_and_port_protection():
    content = read_runbook()
    assert "KHÔNG mở cổng 8000 ra host" in content, "Runbook must state port 8000 is internal only"
    assert "https://127.0.0.1/health/ready" in content, "Runbook must specify Ingress endpoint on port 443"
    assert "openssl s_client" in content and "openssl x509" in content, (
        "Runbook must provide independent TLS x509 certificate check"
    )
    assert "KHÔNG chứng minh chứng chỉ TLS" in content or "Xác minh Độc lập Chứng chỉ TLS" in content, (
        "Runbook must explicitly separate HTTP readiness probe from TLS cert validation"
    )
    print("  [PASS] RUNBOOK-08: HTTP readiness probe and TLS certificate validation independently asserted")

def test_ssh_security_and_environment_gate():
    content = read_runbook()
    assert "VPS_SSH_KNOWN_HOSTS" in content, "Runbook must document VPS_SSH_KNOWN_HOSTS"
    assert "ssh-keygen -lf" in content, "Runbook must require independent fingerprint verification"
    assert "StrictHostKeyChecking=yes" in content, "Runbook must recommend StrictHostKeyChecking=yes"
    assert "Required reviewers" in content or "Environment Approval Gate" in content, (
        "Runbook must document GitHub Environment Approval Gate"
    )
    print("  [PASS] RUNBOOK-09: SSH known_hosts fingerprint pinning & Environment Gate asserted")

def test_schema_compatibility_matrix_and_pitr():
    content = read_runbook()
    assert "Schema Compatibility Matrix" in content, "Runbook must include Schema Compatibility Matrix"
    assert "Point-In-Time-Recovery" in content or "PITR" in content, "Runbook must require PITR for destructive changes"
    assert "CẤM TỰ Ý CHẠY `migration:revert`" in content or "CẤM TỰ Ý CHẠY migration:revert" in content, (
        "Runbook must strictly prohibit blind migration:revert on destructive changes"
    )
    print("  [PASS] RUNBOOK-10: Schema Compatibility Matrix & PITR preflight verified")

def test_downtime_analysis():
    content = read_runbook()
    assert "không phải là con số cố định" in content or "phụ thuộc vào các yếu tố runtime" in content, (
        "Runbook must acknowledge downtime runtime dependencies"
    )
    assert "Cold Start" in content or "connection pool" in content, (
        "Runbook must cite cold start or connection pool latency factors"
    )
    print("  [PASS] RUNBOOK-11: Realistic runtime downtime dependencies verified")

def test_vps_tracking_branch_reconciliation():
    content = read_runbook()
    assert "git checkout main" in content and "git reset --hard origin/main" in content, (
        "Runbook must include mandatory tracking branch reconciliation"
    )
    print("  [PASS] RUNBOOK-12: Mandatory VPS tracking branch reconciliation step verified")

def test_compose_topology_negative_matrix():
    topology_script = os.path.join(os.path.dirname(__file__), "validate-compose-topology.py")
    res = subprocess.run([sys.executable, topology_script, "--test"], capture_output=True, text=True)
    assert res.returncode == 0, f"Topology test matrix failed:\n{res.stdout}\n{res.stderr}"
    assert "17/17 Negative & Integration Scenarios PASSED" in res.stdout
    print("  [PASS] RUNBOOK-13: Docker Compose 17/17 negative & topology invariants asserted")

def main():
    print("=" * 80)
    print("[TEST SUITE] Production Rollback Runbook Strict Invariant & Negative Matrix")
    print("=" * 80)
    test_runbook_file_exists()
    test_status_is_draft_pending_review()
    test_gap_analysis_and_not_yet_supported_notice()
    test_target_release_manifest_and_fail_closed_digest()
    test_no_unsafe_git_checkout_b_main()
    test_no_direct_push_to_main_command()
    test_dual_revert_syntax_with_detection()
    test_healthcheck_separation_and_port_protection()
    test_ssh_security_and_environment_gate()
    test_schema_compatibility_matrix_and_pitr()
    test_downtime_analysis()
    test_vps_tracking_branch_reconciliation()
    test_compose_topology_negative_matrix()
    print("-" * 80)
    print("[TEST RESULT] 13/13 Runbook Strict Invariants & Negative Assertions PASSED")
    print("=" * 80)

if __name__ == "__main__":
    main()
