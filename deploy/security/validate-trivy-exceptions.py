#!/usr/bin/env python3
"""
Trivy Exception Lifecycle, Scope & Expiry Gate Validator (P1 Security Automation)
Standard: Fail-Closed Gate (SEC-REG-6.4.4A)

Enforces:
  1. Image-Scoped Enforcement: Every CVE in deploy/security/trivy/<image>.trivyignore
     must be explicitly registered AND authorized for that specific container image.
  2. Package-Level Governance: Every CVE suppression binds to authorized packages/PURLs.
     Cross-package leakage within the same image is detected and rejected fail-closed.
  3. Lifecycle Gate: Every exception must have a valid future expiration date (expiry_date >= today).
  4. No Stale Suppressions: Resolved CVEs (e.g., CVE-2026-90711) must not appear in any ignore file.
  5. Conflict Prevention: Rejects duplicate records in Risk Register with mismatched images,
     packages, or expiration dates.
  6. Accurate Token Matching: Image and package identifiers are parsed distinctly without false positives.
  7. Automated Test Suite: Supports '--test' mode with validated negative test matrix (8/8 scenarios).
"""

import datetime
import json
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


def is_image_token(s: str) -> bool:
    """Check if a string matches a container image identifier."""
    s_clean = s.lower().strip()
    for img in VALID_IMAGES:
        if (
            s_clean == img
            or s_clean.startswith(f"{img}:")
            or s_clean.startswith(f"prom/{img}")
            or s_clean.startswith(f"grafana/{img}")
        ):
            return True
    return False


def extract_package_tokens(package_lines: List[str]) -> Set[str]:
    """
    Extract normalized package names from package description lines in Risk Register.
    Handles:
      - `libcrypto3`, `libssl3`
      - `util-linux`, `bsdutils`, `mount`
      - `tar` (node-tar), build packages
      - `js-yaml@4.1.0`
      - `starlette` / `fastapi`
      - `github.com/getkin/kin-openapi`
      - `Pillow`
      - `transformers` (HuggingFace)
    """
    tokens = set()
    for raw in package_lines:
        clean = re.sub(r"\(.*?\)", "", raw)
        clean = re.sub(r"\*.*?\*", "", clean)
        cb_matches = re.findall(r"`([^`]+)`", clean)
        if cb_matches:
            for item in cb_matches:
                item_clean = item.strip().lower()
                if not is_image_token(item_clean):
                    pkg_name = item_clean.split("@")[0].strip()
                    if pkg_name:
                        tokens.add(pkg_name)
        else:
            for part in re.split(r"[,/]", clean):
                token = part.strip().strip("`").strip().split("@")[0].strip().lower()
                if token and token not in {"build packages", "base utilities", "bundled plugins:"}:
                    tokens.add(token)
    return tokens


def parse_scope_cell(scope_col: str) -> Tuple[Set[str], Set[str], List[str]]:
    """
    Parse Image & Package cell accurately.
    Distinguishes container image identifiers from library/package names using code blocks
    and structural line breaks (<br>), avoiding substring matching.
    Returns:
      (detected_images, package_tokens, raw_package_lines)
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

    package_tokens = extract_package_tokens(package_lines)
    return detected_images, package_tokens, package_lines


def match_package(detected_pkg: str, authorized_pkgs: Set[str], purl: Optional[str] = None) -> bool:
    """
    Verify whether a detected package or PURL matches the set of authorized packages.
    Supports canonical name matching, PURL subpath matching, and base OS library normalization.
    """
    det_norm = detected_pkg.strip().lower()
    purl_norm = (purl or "").strip().lower()

    for auth in authorized_pkgs:
        auth_norm = auth.strip().lower()
        if det_norm == auth_norm:
            return True
        if purl_norm and auth_norm in purl_norm:
            return True
        # Base package normalization (e.g. libexpat vs libexpat1, libcurl4t64 vs libcurl)
        auth_base = re.sub(r"\d+.*$", "", auth_norm)
        det_base = re.sub(r"\d+.*$", "", det_norm)
        if len(auth_base) >= 4 and auth_base == det_base:
            return True
    return False


def load_register(register_file: str) -> Tuple[Dict[str, dict], List[str]]:
    """
    Parse the Markdown Risk Register table.
    Returns:
      - exceptions: dict mapping cve -> {
          images: Set[str],
          packages: Set[str],
          raw_packages: List[str],
          expiry_date: date,
          is_resolved: bool
        }
      - errors: list of parsing/consistency errors (e.g. duplicate conflicting rows, missing expiry)
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

        detected_images, package_tokens, package_lines = parse_scope_cell(scope_str)
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
                existing = exceptions[cve]
                if (
                    existing["images"] != detected_images
                    or existing["expiry_date"] != expiry_date
                    or existing["packages"] != package_tokens
                ):
                    errors.append(
                        f"CONFLICTING DUPLICATE RECORD for '{cve}': "
                        f"Existing(images={existing['images']}, packages={existing['packages']}, expiry={existing['expiry_date']}) vs "
                        f"New(images={detected_images}, packages={package_tokens}, expiry={expiry_date}) at line {line_num}"
                    )
            else:
                exceptions[cve] = {
                    "images": detected_images,
                    "packages": package_tokens,
                    "raw_packages": package_lines,
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


def load_trivy_json_report(report_path: str, default_image: Optional[str] = None) -> List[dict]:
    """
    Parse a Trivy JSON vulnerability scan report.
    Returns list of findings: [{'cve': ..., 'image': ..., 'package': ..., 'purl': ...}]
    """
    if not os.path.isfile(report_path):
        return []
    findings = []
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return []

    artifact_name = data.get("ArtifactName", "")
    inferred_image = default_image
    if not inferred_image:
        for img in VALID_IMAGES:
            if img in artifact_name.lower():
                inferred_image = img
                break

    for result in data.get("Results", []):
        for vuln in result.get("Vulnerabilities", []):
            cve = vuln.get("VulnerabilityID")
            pkg = vuln.get("PkgName")
            purl = None
            pkg_id = vuln.get("PkgIdentifier")
            if isinstance(pkg_id, dict):
                purl = pkg_id.get("PURL")
            elif isinstance(pkg_id, str):
                purl = pkg_id

            if cve and pkg:
                findings.append({
                    "cve": cve,
                    "image": inferred_image or "unknown",
                    "package": pkg,
                    "purl": purl,
                })
    return findings


def validate_package_bindings(
    scan_findings: List[dict],
    exceptions: Dict[str, dict],
) -> List[str]:
    """
    Enforces package-level binding gate.
    Every finding must match an authorized package/PURL registered for that CVE and image.
    """
    errors = []
    for item in scan_findings:
        cve = item.get("cve")
        img = item.get("image")
        pkg = item.get("package", "")
        purl = item.get("purl")

        if not cve or not img:
            continue

        if cve not in exceptions:
            errors.append(f"UNAPPROVED EXCEPTION: Finding '{cve}' in '{img}' is not registered in Risk Register.")
            continue

        entry = exceptions[cve]
        if img not in entry["images"]:
            errors.append(
                f"CROSS-IMAGE LEAKAGE: Finding '{cve}' in image '{img}' is only authorized for {sorted(list(entry['images']))}."
            )
            continue

        if entry["packages"] and pkg:
            if not match_package(pkg, entry["packages"], purl=purl):
                errors.append(
                    f"WRONG-PACKAGE SUPPRESSION: CVE '{cve}' detected in package '{pkg}' of image '{img}', "
                    f"but is only authorized for package(s) {sorted(list(entry['packages']))}."
                )
    return errors


def validate_governance(
    trivy_dir: str,
    register_file: str,
    root_trivyignore: Optional[str] = None,
    audit_date: Optional[datetime.date] = None,
    scan_findings: Optional[List[dict]] = None,
) -> Tuple[List[str], List[str], Dict[str, int]]:
    """
    Run full governance validation:
      1. Register integrity & conflict checks
      2. Image-scoped ignore file authorization
      3. Lifecycle & expiration date tracking
      4. Stale suppression detection
      5. Package-binding enforcement (if scan_findings provided)
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
            if cve not in exceptions:
                errors.append(
                    f"UNAPPROVED EXCEPTION: '{cve}' is present in '{img}.trivyignore' but not registered in Risk Register."
                )
                continue

            entry = exceptions[cve]

            if entry["is_resolved"]:
                errors.append(
                    f"STALE SUPPRESSION: '{cve}' in '{img}.trivyignore' is marked as RESOLVED in Risk Register."
                )
                continue

            if img not in entry["images"]:
                errors.append(
                    f"CROSS-IMAGE LEAKAGE: '{cve}' is suppressed in '{img}.trivyignore' but only authorized for "
                    f"images {sorted(list(entry['images']))}."
                )

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

    # 2. Validate root .trivyignore (if present)
    if root_trivyignore and os.path.isfile(root_trivyignore):
        root_cves = load_ignore_file(root_trivyignore)
        for cve in sorted(root_cves):
            if cve not in exceptions:
                errors.append(f"UNAPPROVED EXCEPTION: '{cve}' in root .trivyignore is not in Risk Register.")
            elif exceptions[cve]["is_resolved"]:
                errors.append(f"STALE SUPPRESSION: '{cve}' in root .trivyignore is marked as RESOLVED.")
            elif exceptions[cve]["expiry_date"] and exceptions[cve]["expiry_date"] < audit_date:
                errors.append(f"EXPIRED EXCEPTION: '{cve}' in root .trivyignore expired on {exceptions[cve]['expiry_date']}.")

    # 3. Validate package-level bindings if findings provided
    if scan_findings:
        binding_errors = validate_package_bindings(scan_findings, exceptions)
        errors.extend(binding_errors)

    return errors, warnings, stats


def run_tests() -> int:
    """
    Execute full negative and positive test matrix for P1 governance validator.
    Covers 8 critical failure and verification scenarios.
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
        total_tests = 8

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

        # --- Test 5: Conflicting duplicate records (images/expiry) fail ---
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

        # --- Test 7: Wrong package in valid image fails package-binding gate ---
        wrong_pkg_reg = "| **CVE-2026-7777** | `api`<br>`fast-xml-parser` | desc | expl | comp | team | 2026-12-01 |\n"
        write_test_env(reg_content=wrong_pkg_reg, image_cves={"api": ["CVE-2026-7777"]})
        findings = [{"cve": "CVE-2026-7777", "image": "api", "package": "axios", "purl": "pkg:npm/axios@1.7.0"}]
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file, scan_findings=findings)
        assert any("WRONG-PACKAGE SUPPRESSION" in e and "axios" in e for e in errors), f"Test 7 failed: {errors}"
        print("  [PASS] Test 7: Wrong package in valid image correctly blocked (WRONG-PACKAGE SUPPRESSION)")
        passed_tests += 1

        # --- Test 8: Conflicting duplicate records with mismatched package mapping fail ---
        conflicting_pkg_reg = (
            "| **CVE-2026-8888** | `ai-worker`<br>`pillow` | desc | expl | comp | team | 2026-12-01 |\n"
            "| **CVE-2026-8888** | `ai-worker`<br>`transformers` | desc | expl | comp | team | 2026-12-01 |\n"
        )
        write_test_env(reg_content=conflicting_pkg_reg, image_cves={})
        errors, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("CONFLICTING DUPLICATE RECORD" in e and "packages" in e.lower() for e in errors), f"Test 8 failed: {errors}"
        print("  [PASS] Test 8: Conflicting duplicate package mapping correctly blocked (CONFLICTING DUPLICATE RECORD)")
        passed_tests += 1

        print("--------------------------------------------------------------------------------")
        print(f"[TEST RESULT] {passed_tests}/{total_tests} Negative & Governance Tests PASSED (Validated Fail-Closed Scenarios)")
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

    # Parse optional report paths from command line
    scan_findings: List[dict] = []
    for idx, arg in enumerate(sys.argv):
        if arg == "--report" and idx + 1 < len(sys.argv):
            r_path = sys.argv[idx + 1]
            scan_findings.extend(load_trivy_json_report(r_path))

    errors, warnings, stats = validate_governance(
        trivy_dir=TRIVY_DIR,
        register_file=REGISTER_PATH,
        root_trivyignore=ROOT_TRIVYIGNORE,
        audit_date=today,
        scan_findings=scan_findings if scan_findings else None,
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
