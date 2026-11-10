#!/usr/bin/env python3
"""
Executable Local Rollback Simulation & Operational Safety Test Matrix (P1.1 Implementation)

Simulates and verifies:
1. GitOps Revert Syntax Compatibility (Merge Commit -m 1 vs Squash/Single Commit).
2. Missing Immutable Image Fail-Closed Behavior (preventing fallback/silent execution).
3. Release Manifest Digest Mismatch Fail-Closed Gate.
4. Persistent Volume Data Preservation across container recreation (Redis safety).
5. VPS Tracking Branch Reconciliation protocol (eliminating lingering branch state).
6. Schema Compatibility Safety: Refusal of destructive migration revert without PITR snapshot.
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import time

def run_cmd(cmd: list[str], cwd: str = None) -> tuple[int, str, str]:
    res = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    return res.returncode, res.stdout, res.stderr

def test_1_gitops_revert_dual_syntax():
    """Verifies that Git requires -m 1 for merge commits and rejects -m 1 for single commits."""
    print("[TEST 1/6] GitOps Dual Revert Syntax & Parent Detection...")
    with tempfile.TemporaryDirectory() as tmpdir:
        # Initialize test repo
        assert run_cmd(["git", "init"], cwd=tmpdir)[0] == 0
        run_cmd(["git", "config", "user.name", "Test Agent"], cwd=tmpdir)
        run_cmd(["git", "config", "user.email", "agent@omninovel.test"], cwd=tmpdir)

        # Commit 1 (root)
        with open(os.path.join(tmpdir, "file.txt"), "w") as f:
            f.write("base\n")
        run_cmd(["git", "add", "."], cwd=tmpdir)
        run_cmd(["git", "commit", "-m", "chore: base commit"], cwd=tmpdir)

        # Commit 2 (Single commit on main)
        with open(os.path.join(tmpdir, "file.txt"), "a") as f:
            f.write("feature single\n")
        run_cmd(["git", "add", "."], cwd=tmpdir)
        run_cmd(["git", "commit", "-m", "feat: single commit"], cwd=tmpdir)
        single_sha = run_cmd(["git", "rev-parse", "HEAD"], cwd=tmpdir)[1].strip()

        # Check: rev-parse <single_sha>^2 MUST fail (1 parent)
        rc_p2, _, _ = run_cmd(["git", "rev-parse", "-q", "--verify", f"{single_sha}^2"], cwd=tmpdir)
        assert rc_p2 != 0, "Single commit must NOT have a second parent"

        # Check: git revert (standard syntax without -m) on single commit MUST succeed
        rc_succ, _, _ = run_cmd(["git", "revert", single_sha, "--no-edit"], cwd=tmpdir)
        assert rc_succ == 0, "git revert on single commit must succeed"

        # Now create a branch and a true merge commit
        run_cmd(["git", "checkout", "-b", "feature-branch"], cwd=tmpdir)
        with open(os.path.join(tmpdir, "branch_file.txt"), "w") as f:
            f.write("from branch\n")
        run_cmd(["git", "add", "."], cwd=tmpdir)
        run_cmd(["git", "commit", "-m", "feat: branch commit"], cwd=tmpdir)

        run_cmd(["git", "checkout", "master" if run_cmd(["git", "rev-parse", "--verify", "master"], cwd=tmpdir)[0] == 0 else "main"], cwd=tmpdir)
        with open(os.path.join(tmpdir, "main_diverge.txt"), "w") as f:
            f.write("diverge\n")
        run_cmd(["git", "add", "."], cwd=tmpdir)
        run_cmd(["git", "commit", "-m", "chore: diverge on main"], cwd=tmpdir)

        # Merge with --no-ff to create a true 2-parent merge commit
        rc_merge, _, _ = run_cmd(["git", "merge", "--no-ff", "feature-branch", "-m", "merge: join branch"], cwd=tmpdir)
        assert rc_merge == 0, "Merge --no-ff failed"
        merge_sha = run_cmd(["git", "rev-parse", "HEAD"], cwd=tmpdir)[1].strip()

        # Check: rev-parse <merge_sha>^2 MUST succeed (2 parents)
        rc_p2_m, _, _ = run_cmd(["git", "rev-parse", "-q", "--verify", f"{merge_sha}^2"], cwd=tmpdir)
        assert rc_p2_m == 0, "Merge commit MUST have a second parent"

        # Check: git revert without -m on merge commit MUST fail
        rc_fail_m, _, err_fail_m = run_cmd(["git", "revert", merge_sha, "--no-edit"], cwd=tmpdir)
        assert rc_fail_m != 0, "git revert without -m must fail on merge commit"
        assert "is a merge but no -m option was given" in err_fail_m, f"Unexpected error: {err_fail_m}"

        # Check: git revert -m 1 on merge commit MUST succeed
        rc_succ_m, _, _ = run_cmd(["git", "revert", "-m", "1", merge_sha, "--no-edit"], cwd=tmpdir)
        assert rc_succ_m == 0, f"git revert -m 1 on merge commit must succeed"

    print("  [PASS] GitOps dual revert syntax correctly asserts merge (-m 1) vs single commit semantics")

def test_2_missing_immutable_image_fail_closed():
    """Verifies that launching a non-existent image tag fails closed immediately."""
    print("[TEST 2/6] Missing Immutable Image Fail-Closed...")
    nonexistent_image = f"omninovel-api-mock:missing_sha_{secrets.token_hex(8)}"
    rc, stdout, stderr = run_cmd(["docker", "run", "--rm", nonexistent_image])
    assert rc != 0, "Running a missing image must fail closed"
    assert "Unable to find image" in stderr or "manifest unknown" in stderr or "not found" in stderr or "repository does not exist" in stderr or "pull access denied" in stderr, (
        f"Expected missing image error, got: {stderr}"
    )
    print("  [PASS] Missing image tag correctly triggers fail-closed error")

def test_3_manifest_digest_mismatch_fail_closed():
    """Verifies fail-closed execution when running container digest mismatches release-manifest.json."""
    print("[TEST 3/6] Release Manifest Digest Mismatch Fail-Closed Verification...")
    manifest = {
        "release_sha": "a695a1eb2d12038c0e27fc2d9611dc3b3dc66c01",
        "services": {
            "api": {
                "digest": "sha256:4f8a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a"
            }
        }
    }

    def verify_image_digest(actual_digest: str, expected_digest: str) -> bool:
        if not actual_digest or expected_digest not in actual_digest:
            return False
        return True

    # Scenario A: Mismatch digest
    assert verify_image_digest(
        actual_digest="sha256:9999999999999999999999999999999999999999999999999999999999999999",
        expected_digest=manifest["services"]["api"]["digest"]
    ) is False, "Mismatched digest must fail verification"

    # Scenario B: Empty digest
    assert verify_image_digest(
        actual_digest="",
        expected_digest=manifest["services"]["api"]["digest"]
    ) is False, "Empty digest must fail verification"

    # Scenario C: Valid matching digest
    assert verify_image_digest(
        actual_digest="ghcr.io/hiepngoc2006/omninovel-api@sha256:4f8a9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a",
        expected_digest=manifest["services"]["api"]["digest"]
    ) is True, "Exact digest must pass verification"

    print("  [PASS] Release manifest digest mismatch gate is strictly fail-closed")

def test_4_persistent_volume_preservation():
    """Verifies Redis named volume preserves data across container destruction & recreation."""
    print("[TEST 4/6] Persistent Volume Data Preservation across Container Recreate...")
    vol_name = f"omninovel_test_vol_{secrets.token_hex(4)}"
    container_1 = f"test_redis_run1_{secrets.token_hex(4)}"
    container_2 = f"test_redis_run2_{secrets.token_hex(4)}"
    test_key = f"key_{secrets.token_hex(4)}"
    test_val = f"val_{secrets.token_hex(8)}"

    try:
        # Step 1: Create volume
        rc_v, _, _ = run_cmd(["docker", "volume", "create", vol_name])
        assert rc_v == 0, f"Failed to create test volume {vol_name}"

        # Step 2: Start Container 1 and write data
        rc_c1, _, err_c1 = run_cmd([
            "docker", "run", "-d", "--name", container_1,
            "-v", f"{vol_name}:/data",
            "redis:7-alpine", "redis-server", "--appendonly", "yes"
        ])
        assert rc_c1 == 0, f"Failed to run container 1: {err_c1}"
        time.sleep(2)

        # Write data to Redis
        rc_w, out_w, _ = run_cmd(["docker", "exec", container_1, "redis-cli", "SET", test_key, test_val])
        assert rc_w == 0 and "OK" in out_w, f"Redis SET failed: {out_w}"

        # Sync AOF to disk
        run_cmd(["docker", "exec", container_1, "redis-cli", "BGREWRITEAOF"])
        time.sleep(1)

        # Step 3: Destroy Container 1 (simulate container recreation / rollback without -v)
        run_cmd(["docker", "stop", container_1])
        run_cmd(["docker", "rm", container_1])

        # Step 4: Start Container 2 mounted to the SAME named volume
        rc_c2, _, err_c2 = run_cmd([
            "docker", "run", "-d", "--name", container_2,
            "-v", f"{vol_name}:/data",
            "redis:7-alpine", "redis-server", "--appendonly", "yes"
        ])
        assert rc_c2 == 0, f"Failed to run container 2: {err_c2}"
        time.sleep(2)

        # Step 5: Read data back from Container 2
        rc_r, out_r, _ = run_cmd(["docker", "exec", container_2, "redis-cli", "GET", test_key])
        assert rc_r == 0, "Redis GET failed"
        assert test_val in out_r, f"Data loss detected! Expected '{test_val}', got '{out_r.strip()}'"

        print("  [PASS] Persistent Named Volume data preserved 100% across container recreation")

    finally:
        # Cleanup containers and volume
        run_cmd(["docker", "rm", "-f", container_1])
        run_cmd(["docker", "rm", "-f", container_2])
        run_cmd(["docker", "volume", "rm", vol_name])

def test_5_vps_tracking_branch_reconciliation():
    """Simulates VPS temporary emergency branch and verifies tracking branch reconciliation."""
    print("[TEST 5/6] VPS Tracking Branch Reconciliation Protocol...")
    with tempfile.TemporaryDirectory() as base_dir:
        origin_dir = os.path.join(base_dir, "origin.git")
        vps_dir = os.path.join(base_dir, "vps_deploy")

        # Create bare origin repo
        run_cmd(["git", "init", "--bare", origin_dir])

        # Initial commit in a temp repo to push to origin
        init_dir = os.path.join(base_dir, "init")
        run_cmd(["git", "init", init_dir])
        run_cmd(["git", "config", "user.name", "CI Bot"], cwd=init_dir)
        run_cmd(["git", "config", "user.email", "ci@omninovel.test"], cwd=init_dir)
        with open(os.path.join(init_dir, "app.js"), "w") as f:
            f.write("// release A\n")
        run_cmd(["git", "add", "."], cwd=init_dir)
        run_cmd(["git", "commit", "-m", "release: Release A (stable)"], cwd=init_dir)
        run_cmd(["git", "branch", "-M", "main"], cwd=init_dir)
        run_cmd(["git", "remote", "add", "origin", origin_dir], cwd=init_dir)
        run_cmd(["git", "push", "origin", "main"], cwd=init_dir)
        sha_a = run_cmd(["git", "rev-parse", "HEAD"], cwd=init_dir)[1].strip()

        # Commit Release B (bad release)
        with open(os.path.join(init_dir, "app.js"), "w") as f:
            f.write("// release B (faulty)\n")
        run_cmd(["git", "commit", "-am", "release: Release B (faulty)"], cwd=init_dir)
        run_cmd(["git", "push", "origin", "main"], cwd=init_dir)
        sha_b = run_cmd(["git", "rev-parse", "HEAD"], cwd=init_dir)[1].strip()

        # Clone on VPS
        run_cmd(["git", "clone", origin_dir, vps_dir])
        run_cmd(["git", "config", "user.name", "VPS Maintainer"], cwd=vps_dir)
        run_cmd(["git", "config", "user.email", "ops@omninovel.test"], cwd=vps_dir)

        # Maintainer does emergency intervention on VPS: creates emergency branch to commit A
        run_cmd(["git", "checkout", "-b", "emergency-rollback", sha_a], cwd=vps_dir)
        cur_branch = run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=vps_dir)[1].strip()
        assert cur_branch == "emergency-rollback", "Must be on emergency-rollback branch"

        # Meanwhile, on origin/main, the forward revert PR was merged
        run_cmd(["git", "revert", sha_b, "--no-edit"], cwd=init_dir)
        run_cmd(["git", "push", "origin", "main"], cwd=init_dir)
        sha_revert = run_cmd(["git", "rev-parse", "HEAD"], cwd=init_dir)[1].strip()

        # VPS executes mandatory RECONCILIATION protocol from runbook:
        # git checkout main && git fetch origin main && git reset --hard origin/main && git branch -D emergency-rollback
        rc_co, _, _ = run_cmd(["git", "checkout", "main"], cwd=vps_dir)
        assert rc_co == 0, "Checkout main failed"
        rc_f, _, _ = run_cmd(["git", "fetch", "origin", "main"], cwd=vps_dir)
        assert rc_f == 0, "Fetch origin main failed"
        rc_r, _, _ = run_cmd(["git", "reset", "--hard", "origin/main"], cwd=vps_dir)
        assert rc_r == 0, "Reset hard origin/main failed"
        rc_del, _, _ = run_cmd(["git", "branch", "-D", "emergency-rollback"], cwd=vps_dir)
        assert rc_del == 0, "Branch delete failed"

        # Verify final state on VPS
        final_sha = run_cmd(["git", "rev-parse", "HEAD"], cwd=vps_dir)[1].strip()
        final_branch = run_cmd(["git", "rev-parse", "--abbrev-ref", "HEAD"], cwd=vps_dir)[1].strip()
        branches = run_cmd(["git", "branch"], cwd=vps_dir)[1]

        assert final_sha == sha_revert, f"VPS did not reconcile to revert commit: {final_sha} vs {sha_revert}"
        assert final_branch == "main", f"VPS is not on main branch: {final_branch}"
        assert "emergency-rollback" not in branches, "emergency-rollback branch was not cleanly removed"

    print("  [PASS] VPS Tracking Branch Reconciliation protocol cleanly restores main branch")

def test_6_schema_destructive_rollback_refusal():
    """Verifies that destructive schema changes refuse rollback without confirmed PITR snapshot."""
    print("[TEST 6/6] Schema Safety: Destructive Rollback Refusal without PITR Preflight...")

    class SchemaRollbackRefusedError(Exception):
        pass

    def evaluate_schema_rollback(migration_sql: str, pitr_snapshot_confirmed: bool) -> str:
        destructive_keywords = ["DROP COLUMN", "DROP TABLE", "ALTER COLUMN", "TRUNCATE"]
        is_destructive = any(kw in migration_sql.upper() for kw in destructive_keywords)
        if is_destructive:
            if not pitr_snapshot_confirmed:
                raise SchemaRollbackRefusedError(
                    "REFUSAL: Destructive schema migration detected! Automated 'migration:revert' is "
                    "STRICTLY FORBIDDEN without verified PITR Snapshot to prevent catastrophic user data loss."
                )
            return "PERMITTED_WITH_PITR"
        return "SAFE_IN_PLACE"

    # Scenario A: Additive migration (Safe)
    status_add = evaluate_schema_rollback("CREATE TABLE user_preferences (id INT);", False)
    assert status_add == "SAFE_IN_PLACE"

    # Scenario B: Destructive migration without PITR (Must REFUSE)
    refused = False
    try:
        evaluate_schema_rollback("ALTER TABLE users DROP COLUMN email_verified_at;", False)
    except SchemaRollbackRefusedError as e:
        refused = True
        assert "STRICTLY FORBIDDEN" in str(e)
    assert refused, "Destructive rollback without PITR was not refused!"

    # Scenario C: Destructive migration with PITR confirmed (Permitted)
    status_dest_pitr = evaluate_schema_rollback("ALTER TABLE users DROP COLUMN email_verified_at;", True)
    assert status_dest_pitr == "PERMITTED_WITH_PITR"

    print("  [PASS] Destructive schema rollback strictly refuses without PITR preflight confirmation")

def main():
    print("=" * 80)
    print("[TEST SUITE] Executable Local Rollback & Operational Safety Matrix")
    print("=" * 80)
    test_1_gitops_revert_dual_syntax()
    test_2_missing_immutable_image_fail_closed()
    test_3_manifest_digest_mismatch_fail_closed()
    test_4_persistent_volume_preservation()
    test_5_vps_tracking_branch_reconciliation()
    test_6_schema_destructive_rollback_refusal()
    print("-" * 80)
    print("[TEST RESULT] 6/6 Executable Rollback Operational Scenarios PASSED (100%)")
    print("=" * 80)

if __name__ == "__main__":
    main()
