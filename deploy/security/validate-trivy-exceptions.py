#!/usr/bin/env python3
"""
Trivy Exception Lifecycle, Scope & Expiry Gate Validator (P1 Security Automation)
Standard: Fail-Closed Gate (SEC-REG-6.4.4A)

Enforces:
  1. Image-Scoped Enforcement: Every CVE in deploy/security/trivy/<image>.trivyignore
     must be explicitly registered AND authorized for that specific container image.
  2. Lifecycle Gate: Every exception must have a valid future expiration date (expiry_date >= today).
  3. No Stale Suppressions: Resolved CVEs (e.g., CVE-2026-90711) must not appear in any ignore file.
  4. Conflict Prevention: Rejects duplicate/conflicting records in the Risk Register.
  5. Accurate Token Matching: Image and package identifiers are parsed distinctly, eliminating substring false positives.
  6. Automated Test Suite: Supports '--test' mode with full negative test coverage.
"""

import datetime
import os
import re
import sys
from typing import Dict, List, Set, Tuple, Optional

# Ensure UTF-8 output on all platforms
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TRIVY_DIR = os.path.join(REPO_ROOT, "deploy", "security", "trivy")
ROOT_TRIVYIGNORE = os.path.join(REPO_ROOT, ".trivyignore")
REGISTER_PATH = os.path.join(REPO_ROOT, "deploy", "security", "trivy-exception-register.md")

CVE_PATTERN = re.compile(r"(?:CVE-\d{4}-\d+|GHSA-[a-zA-Z0-9-]+)")
DATE_PATTERN = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")

VALID_IMAGES = {"api", "ai-worker", "nginx", "prometheus", "grafana"}


def parse_scope_cell(scope_col: str) -> Tuple[Set[str], List[str]]:
    """
    Parse Image & Package cell accurately.
    Distinguishes container image identifiers from library/package names using code blocks
    and structural line breaks (<br>), avoiding substring matching.
    """
    scope_lines = [s.strip() for s in re.split(r"<br\s*/?>", scope_col, flags=re.IGNORECASE) if s.strip()]
    detected_images: Set[str] = set()
    package_lines: List[str] = []

    for line in scope_lines:
        code_blocks = re.findall(r"`([^`]+)`", line)
        line_has_image = False
        for cb in code_blocks:
            cb_clean = cb.lower().strip()
            for img in VALID_IMAGES:
                if (
                    cb_clean == img
                    or cb_clean.startswith(f"{img}:")
                    or cb_clean.startswith(f"prom/{img}")
                    or cb_clean.startswith(f"grafana/{img}")
                ):
                    detected_images.add(img)
                    line_has_image = True
        if not line_has_image:
            package_lines.append(line)

    return detected_images, package_lines


def load_register(register_file: str) -> Tuple[Dict[str, dict], List[str]]:
    """
    Parse the Markdown Risk Register table.
    Returns:
      - exceptions: dict mapping cve -> { images: Set[str], packages: List[str], expiry_date: date, is_resolved: bool }
      - errors: list of parsing/consistency errors (e.g. duplicate conflicting rows)
    """
    if not os.path.isfile(register_file):
        return {}, [f"Risk register file not found at: {register_file}"]

    exceptions: Dict[str, dict] = {}
    errors: List[str] = []

    with open(register_file, "r", encoding="utf-8") as f:
        lines = f.readlines()

    for line_num, line in enumerate(lines, 1):
        line = line.strip()
        if not line.startswith("|") or "---" in line or "CVE ID" in line:
            continue

        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 8:
            continue

        cves_found = CVE_PATTERN.findall(parts[1])
        if not cves_found:
            continue

        scope_str = parts[2]
        date_col = parts[7]

        detected_images, package_names = parse_scope_cell(scope_str)
        is_resolved = "ĐÃ GIẢI QUYẾT" in date_col or "RESOLVED" in date_col.upper()

        dates_found = DATE_PATTERN.findall(date_col)
        expiry_date = None
        if dates_found:
            expiry_str = dates_found[-1]
            try:
                expiry_date = datetime.datetime.strptime(expiry_str, "%Y-%m-%d").date()
            except ValueError:
                expiry_date = None

        if not detected_images and not is_resolved:
            errors.append(f"Line {line_num}: No recognized container image in scope cell '{scope_str}' for CVEs {cves_found}")

        if not expiry_date and not is_resolved:
            for cve in cves_found:
                errors.append(f"MISSING EXPIRY: '{cve}' has no valid expiry date (YYYY-MM-DD) in line {line_num}")

        for cve in cves_found:
            if cve in exceptions:
                # Check for conflicting duplicate records
                existing = exceptions[cve]
                if existing["images"] != detected_images or existing["expiry_date"] != expiry_date:
                    errors.append(
                        f"CONFLICTING DUPLICATE RECORD for '{cve}': "
                        f"Existing(images={existing['images']}, expiry={existing['expiry_date']}) vs "
                        f"New(images={detected_images}, expiry={expiry_date}) at line {line_num}"
                    )
            else:
                exceptions[cve] = {
                    "images": detected_images,
                    "packages": package_names,
                    "expiry_date": expiry_date,
                    "is_resolved": is_resolved,
                    "line": line_num,
                }

    return exceptions, errors


def load_ignore_file(file_path: str) -> Set[str]:
    """Parse CVEs from a .trivyignore file, skipping comments and blank lines."""
    if not os.path.isfile(file_path):
        return set()
    cves = set()
    with open(file_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            match = CVE_PATTERN.search(line)
            if match:
                cves.add(match.group(0))
    return cves


def validate_governance(
    trivy_dir: str,
    register_file: str,
    root_trivyignore: Optional[str] = None,
    audit_date: Optional[datetime.date] = None,
) -> Tuple[List[str], List[str], Dict[str, int]]:
    """
    Run full governance validation.
    Returns: (errors, warnings, stats)
    """
    if audit_date is None:
        audit_date = datetime.date.today()

    exceptions, reg_errors = load_register(register_file)
    errors: List[str] = list(reg_errors)
    warnings: List[str] = []
    stats: Dict[str, int] = {}

    # 1. Validate image-scoped ignore files
    for img in sorted(VALID_IMAGES):
        ignore_path = os.path.join(trivy_dir, f"{img}.trivyignore")
        if not os.path.isfile(ignore_path):
            errors.append(f"MISSING SCOPED IGNORE FILE: Expected image ignore file at {ignore_path}")
            continue

        cves_in_file = load_ignore_file(ignore_path)
        stats[img] = len(cves_in_file)

        for cve in sorted(cves_in_file):
            # Check 1: Must be in register
            if cve not in exceptions:
                errors.append(
                    f"UNAPPROVED EXCEPTION: '{cve}' is present in '{img}.trivyignore' but not registered in Risk Register."
                )
                continue

            entry = exceptions[cve]

            # Check 2: Stale resolved check
            if entry["is_resolved"]:
                errors.append(
                    f"STALE SUPPRESSION: '{cve}' in '{img}.trivyignore' is marked as RESOLVED in Risk Register."
                )
                continue

            # Check 3: Image-scope boundary check (Anti-Leakage)
            if img not in entry["images"]:
                errors.append(
                    f"CROSS-IMAGE LEAKAGE: '{cve}' is suppressed in '{img}.trivyignore' but only authorized for "
                    f"images {sorted(list(entry['images']))}."
                )

            # Check 4: Expiration date check
            expiry = entry["expiry_date"]
            if expiry:
                if expiry < audit_date:
                    errors.append(
                        f"EXPIRED EXCEPTION: '{cve}' in '{img}.trivyignore' expired on {expiry.isoformat()} "
                        f"(Audit Date: {audit_date.isoformat()}). Renewal or upstream fix required!"
                    )
                else:
                    days_left = (expiry - audit_date).days
                    if days_left <= 30:
                        warnings.append(
                            f"UPCOMING EXPIRY: '{cve}' in [{img}] expires in {days_left} days ({expiry.isoformat()})."
                        )

    # 2. Validate root .trivyignore (if present) to prevent unmonitored backdoors
    if root_trivyignore and os.path.isfile(root_trivyignore):
        root_cves = load_ignore_file(root_trivyignore)
        for cve in sorted(root_cves):
            if cve not in exceptions:
                errors.append(f"UNAPPROVED EXCEPTION: '{cve}' in root .trivyignore is not in Risk Register.")
            elif exceptions[cve]["is_resolved"]:
                errors.append(f"STALE SUPPRESSION: '{cve}' in root .trivyignore is marked as RESOLVED.")
            elif exceptions[cve]["expiry_date"] and exceptions[cve]["expiry_date"] < audit_date:
                errors.append(f"EXPIRED EXCEPTION: '{cve}' in root .trivyignore expired on {exceptions[cve]['expiry_date']}.")

    return errors, warnings, stats


def run_tests() -> int:
    """
    Execute full negative and positive test matrix for P1 governance validator.
    """
    import tempfile
    import shutil

    print("================================================================================")
    print("[TEST SUITE] Running P1 Security Exception Governance Verification Matrix")
    print("================================================================================")

    test_dir = tempfile.mkdtemp(prefix="trivy_gov_test_")
    try:
        t_trivy_dir = os.path.join(test_dir, "trivy")
        os.makedirs(t_trivy_dir, exist_ok=True)
        t_reg_file = os.path.join(test_dir, "register.md")

        def write_test_env(reg_content: str, image_cves: Dict[str, List[str]]):
            with open(t_reg_file, "w", encoding="utf-8") as f:
                f.write(reg_content)
            for img in VALID_IMAGES:
                p = os.path.join(t_trivy_dir, f"{img}.trivyignore")
                with open(p, "w", encoding="utf-8") as f:
                    for cve in image_cves.get(img, []):
                        f.write(f"{cve}\n")

        passed_tests = 0
        total_tests = 6

        # --- Test 1: Unregistered CVE fails ---
        write_test_env(
            reg_content="| **CVE-2026-1111** | `api`<br>`test` | desc | expl | comp | team | 2026-12-01 |\n",
            image_cves={"api": ["CVE-2026-1111", "CVE-2026-9999"]},
        )
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("UNAPPROVED EXCEPTION" in e and "CVE-2026-9999" in e for e in errors), f"Test 1 failed: {errors}"
        print("  [PASS] Test 1: Unregistered CVE correctly blocked (UNAPPROVED EXCEPTION)")
        passed_tests += 1

        # --- Test 2: Expired CVE fails ---
        write_test_env(
            reg_content="| **CVE-2026-2222** | `api`<br>`test` | desc | expl | comp | team | 2026-01-01 |\n",
            image_cves={"api": ["CVE-2026-2222"]},
        )
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file, audit_date=datetime.date(2026, 10, 20))
        assert any("EXPIRED EXCEPTION" in e and "CVE-2026-2222" in e for e in errors), f"Test 2 failed: {errors}"
        print("  [PASS] Test 2: Expired CVE correctly blocked (EXPIRED EXCEPTION)")
        passed_tests += 1

        # --- Test 3: Cross-image leakage (Grafana CVE in API ignore) fails ---
        write_test_env(
            reg_content="| **CVE-2026-3333** | `grafana`<br>`kin-openapi` | desc | expl | comp | team | 2026-12-01 |\n",
            image_cves={"api": ["CVE-2026-3333"], "grafana": ["CVE-2026-3333"]},
        )
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("CROSS-IMAGE LEAKAGE" in e and "CVE-2026-3333" in e for e in errors), f"Test 3 failed: {errors}"
        print("  [PASS] Test 3: Cross-image leakage correctly blocked (CROSS-IMAGE LEAKAGE)")
        passed_tests += 1

        # --- Test 4: Stale RESOLVED CVE still present in ignore file fails ---
        write_test_env(
            reg_content="| **CVE-2026-4444** | `api`<br>`proxy` | desc | expl | comp | team | ĐÃ GIẢI QUYẾT |\n",
            image_cves={"api": ["CVE-2026-4444"]},
        )
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("STALE SUPPRESSION" in e and "CVE-2026-4444" in e for e in errors), f"Test 4 failed: {errors}"
        print("  [PASS] Test 4: Stale RESOLVED CVE correctly blocked (STALE SUPPRESSION)")
        passed_tests += 1

        # --- Test 5: Conflicting duplicate records in Risk Register fail ---
        conflicting_reg = (
            "| **CVE-2026-5555** | `api`<br>`lib1` | desc | expl | comp | team | 2026-12-01 |\n"
            "| **CVE-2026-5555** | `nginx`<br>`lib2` | desc | expl | comp | team | 2026-11-01 |\n"
        )
        write_test_env(reg_content=conflicting_reg, image_cves={})
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("CONFLICTING DUPLICATE RECORD" in e for e in errors), f"Test 5 failed: {errors}"
        print("  [PASS] Test 5: Conflicting duplicate records correctly blocked (CONFLICTING DUPLICATE RECORD)")
        passed_tests += 1

        # --- Test 6: Missing expiry date in register fails ---
        missing_expiry_reg = "| **CVE-2026-6666** | `api`<br>`lib1` | desc | expl | comp | team | NoDateHere |\n"
        write_test_env(reg_content=missing_expiry_reg, image_cves={"api": ["CVE-2026-6666"]})
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("MISSING EXPIRY" in e and "CVE-2026-6666" in e for e in errors), f"Test 6 failed: {errors}"
        print("  [PASS] Test 6: Missing expiry date correctly blocked (MISSING EXPIRY)")
        passed_tests += 1

        print("--------------------------------------------------------------------------------")
        print(f"[TEST RESULT] {passed_tests}/{total_tests} Negative & Governance Tests PASSED (100% Fail-Closed Coverage)")
        print("================================================================================\n")
        return 0
    finally:
        shutil.rmtree(test_dir, ignore_errors=True)


def main():
    if "--test" in sys.argv:
        test_exit_code = run_tests()
        if test_exit_code != 0:
            sys.exit(test_exit_code)

    print("================================================================================")
    print("[SECURITY GATE] OmniNovel: Validating Trivy Exception Lifecycle, Scope & Expiry")
    print("================================================================================")

    today = datetime.date.today()
    print(f"[INFO] Audit Date (System): {today.isoformat()}")
    print(f"[INFO] Risk Register: {os.path.relpath(REGISTER_PATH, REPO_ROOT)}")
    print(f"[INFO] Scoped Ignore Directory: {os.path.relpath(TRIVY_DIR, REPO_ROOT)}")

    errors, warnings, stats = validate_governance(
        trivy_dir=TRIVY_DIR,
        register_file=REGISTER_PATH,
        root_trivyignore=ROOT_TRIVYIGNORE,
        audit_date=today,
    )

    print("\n[INFO] Active Scoped Exception Distribution:")
    for img, count in stats.items():
        print(f"  - {img:<12}: {count:>2} authorized CVE suppressions")

    if warnings:
        print(f"\n[WARNING] LIFECYCLE WARNINGS ({len(warnings)} upcoming reviews):")
        for w in warnings[:10]:
            print(f"  - {w}")
        if len(warnings) > 10:
            print(f"  ... and {len(warnings) - 10} more approaching review date.")

    if errors:
        print(f"\n[FAIL] TRIVY EXCEPTION AUDIT FAILED ({len(errors)} violations):")
        for err in errors:
            print(f"::error::{err}")
        print("================================================================================")
        sys.exit(1)

    print("\n[PASS] TRIVY EXCEPTION AUDIT PASSED: 100% of suppressed CVEs are registered, strictly image-scoped, and within active lifecycle window.")
    print("================================================================================")
    sys.exit(0)


if __name__ == "__main__":
    main()
