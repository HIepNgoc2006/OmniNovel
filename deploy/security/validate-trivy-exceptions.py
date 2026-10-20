#!/usr/bin/env python3
"""
Trivy Exception Lifecycle, Scope & Expiry Gate Validator (P1 Security Automation)
Standard: Fail-Closed Gate (SEC-REG-6.4.4A)

Enforces:
  1. Image-Scoped Enforcement: Every CVE in deploy/security/trivy/<image>.trivyignore
     must be explicitly registered AND authorized for that specific container image.
  2. Package-Level Governance Gate: Cross-references CVE suppressions with real Trivy scan findings.
     Every suppressed CVE must strictly match the authorized package/PURL from the Risk Register.
     Cross-package leakage within the same image is detected and rejected fail-closed.
  3. Lifecycle Gate: Every exception must have a valid future expiration date (expiry_date >= today).
  4. No Stale Suppressions: Resolved CVEs (e.g., CVE-2026-90711) must not appear in any ignore file.
  5. Conflict Prevention: Rejects duplicate records in Risk Register with mismatched images,
     packages, or expiration dates.
  6. Fail-Closed Report Handling: Missing or corrupt Trivy reports trigger immediate failure.
  7. Automated Integration Test Suite: Supports '--test' mode with full negative matrix (10/10 scenarios).
"""

import datetime
import json
import os
import re
import sys
import urllib.parse
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

IMAGE_ARTIFACT_PATTERNS = {
    "api": re.compile(r"(?:^|/)(?:omninovel-)?api(?::|@|$)"),
    "ai-worker": re.compile(r"(?:^|/)(?:omninovel-)?ai-worker(?::|@|$)"),
    "nginx": re.compile(r"(?:^|/)(?:omninovel-)?nginx(?::|@|$)"),
    "prometheus": re.compile(r"(?:^|/)(?:prom/)?prometheus(?::|@|$)"),
    "grafana": re.compile(r"(?:^|/)(?:grafana/)?grafana(?::|@|$)"),
}


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


def extract_purl_pkg_name(purl: str) -> Optional[str]:
    """
    Extract canonical package name from a Package URL (PURL).
    Examples:
      pkg:golang/github.com/getkin/kin-openapi@0.129.0 -> github.com/getkin/kin-openapi
      pkg:npm/%40nestjs/swagger@7.4.2 -> @nestjs/swagger
      pkg:deb/debian/libexpat1@2.9.0-1 -> libexpat1
      pkg:pypi/pillow@10.2.0 -> pillow
      pkg:apk/alpine/libcrypto3@3.3.2-r0 -> libcrypto3
    """
    if not purl or not purl.startswith("pkg:"):
        return None
    remainder = re.sub(r"^pkg:[^/]+/", "", purl)
    pkg_part = re.split(r"[@?#]", remainder)[0]
    decoded = urllib.parse.unquote(pkg_part).strip().lower()
    return decoded if decoded else None


def normalize_pkg_name(name: str) -> str:
    """Normalize package identifier for exact comparison."""
    clean = name.strip().lower()
    clean = clean.split("@")[0].strip()
    return clean


def match_package(detected_pkg: str, authorized_pkgs: Set[str], purl: Optional[str] = None) -> bool:
    """
    Strict package match without arbitrary substring leakage.
    Matches:
      1. Exact normalized package name.
      2. Exact normalized PURL package name.
      3. Base library normalization for OS packages (e.g. libexpat1 == libexpat, libcurl4t64 == libcurl).
      4. Trailing component match for scoped/namespaced packages (e.g. 'kin-openapi' vs 'github.com/getkin/kin-openapi').
    """
    det_norm = normalize_pkg_name(detected_pkg)
    purl_pkg = extract_purl_pkg_name(purl) if purl else None
    det_base = re.sub(r"\d+.*$", "", det_norm)

    for auth in authorized_pkgs:
        auth_norm = normalize_pkg_name(auth)
        # 1. Exact match with detected_pkg
        if det_norm == auth_norm:
            return True
        # 2. Exact match with purl_pkg
        if purl_pkg and purl_pkg == auth_norm:
            return True
        # 3. Base name match for OS libraries (e.g. libexpat vs libexpat1)
        auth_base = re.sub(r"\d+.*$", "", auth_norm)
        if len(auth_base) >= 4 and auth_base == det_base:
            return True
        # 4. Trailing component match for scoped packages
        if "/" in auth_norm and auth_norm.endswith(f"/{det_norm}"):
            return True
        if "/" in det_norm and det_norm.endswith(f"/{auth_norm}"):
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
      - errors: list of parsing/consistency errors
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


def load_trivy_json_report(report_path: str, expected_image: str) -> Tuple[List[dict], Optional[str]]:
    """
    Load and parse a Trivy JSON scan report.
    Returns: (findings_list, error_message)
    Fail-closed:
      - If report_path does not exist -> returns ([], "REPORT_MISSING: ...")
      - If report_path is corrupt / empty / invalid JSON -> returns ([], "REPORT_CORRUPT: ...")
      - If report is missing 'Results' array -> returns ([], "REPORT_CORRUPT: ...")
      - If report ArtifactName does not match expected_image -> returns ([], "IMAGE_IDENTITY_MISMATCH: ...")
      - If report is valid -> returns (findings, None)
    """
    if not os.path.isfile(report_path):
        return [], f"REPORT_MISSING: Expected Trivy scan report for image '{expected_image}' at '{report_path}' was not found."

    try:
        with open(report_path, "r", encoding="utf-8") as f:
            content = f.read().strip()
            if not content:
                return [], f"REPORT_CORRUPT: Trivy scan report for image '{expected_image}' at '{report_path}' is empty."
            data = json.loads(content)
    except Exception as e:
        return [], f"REPORT_CORRUPT: Failed to parse Trivy scan report for image '{expected_image}' at '{report_path}': {e}"

    if not isinstance(data, dict):
        return [], f"REPORT_CORRUPT: Trivy scan report for image '{expected_image}' at '{report_path}' is not a valid JSON object."

    if "Results" not in data or not isinstance(data.get("Results"), list):
        return [], f"REPORT_CORRUPT: Trivy scan report for image '{expected_image}' at '{report_path}' is missing 'Results' array."

    # Strict container image identity validation via ArtifactName
    artifact_name = data.get("ArtifactName", "")
    pattern = IMAGE_ARTIFACT_PATTERNS.get(expected_image)
    if not artifact_name or not pattern or not pattern.search(artifact_name):
        return [], (
            f"IMAGE_IDENTITY_MISMATCH: Scan report at '{report_path}' has ArtifactName '{artifact_name}', "
            f"which does not match expected container image identity for '{expected_image}'."
        )

    findings = []
    for result in data.get("Results", []):
        if not isinstance(result, dict):
            continue
        # 1. Standard active vulnerabilities
        for vuln in result.get("Vulnerabilities", []) or []:
            cve = vuln.get("VulnerabilityID")
            pkg = vuln.get("PkgName")
            pkg_id = vuln.get("PkgIdentifier")
            purl = pkg_id.get("PURL") if isinstance(pkg_id, dict) else (pkg_id if isinstance(pkg_id, str) else None)
            if cve:
                findings.append({
                    "cve": cve,
                    "image": expected_image,
                    "package": pkg or "",
                    "purl": purl,
                    "severity": vuln.get("Severity", "UNKNOWN"),
                })
        # 2. Suppressed / modified findings (when --show-suppressed or experimental flags used)
        for mod in (result.get("ExperimentalModifiedFindings", []) or result.get("ModifiedFindings", []) or []):
            vuln = mod.get("Vulnerability", mod)
            cve = vuln.get("VulnerabilityID")
            pkg = vuln.get("PkgName")
            pkg_id = vuln.get("PkgIdentifier")
            purl = pkg_id.get("PURL") if isinstance(pkg_id, dict) else (pkg_id if isinstance(pkg_id, str) else None)
            if cve:
                findings.append({
                    "cve": cve,
                    "image": expected_image,
                    "package": pkg or "",
                    "purl": purl,
                    "severity": vuln.get("Severity", "UNKNOWN"),
                    "suppressed": True,
                })

    return findings, None


def validate_governance(
    trivy_dir: str,
    register_file: str,
    root_trivyignore: Optional[str] = None,
    audit_date: Optional[datetime.date] = None,
    image_reports: Optional[Dict[str, str]] = None,
    enforce_reports: bool = False,
) -> Tuple[List[str], List[str], Dict[str, int], Dict[str, Dict[str, int]]]:
    """
    Run full governance validation:
      1. Register integrity & conflict checks
      2. Image-scoped ignore file authorization
      3. Lifecycle & expiration date tracking
      4. Stale suppression detection
      5. Fail-closed Package-Binding Enforcement on Real Trivy Scan Reports
    Returns: (errors, warnings, ignore_stats, report_metrics)
    """
    if audit_date is None:
        audit_date = datetime.date.today()

    exceptions, reg_errors = load_register(register_file)
    errors: List[str] = list(reg_errors)
    warnings: List[str] = []
    ignore_stats: Dict[str, int] = {}
    report_metrics: Dict[str, Dict[str, int]] = {}

    scoped_cves_by_image: Dict[str, Set[str]] = {}

    # 1. Validate image-scoped ignore files
    for img in sorted(VALID_IMAGES):
        ignore_path = os.path.join(trivy_dir, f"{img}.trivyignore")
        if not os.path.isfile(ignore_path):
            errors.append(f"MISSING SCOPED IGNORE FILE: Expected image ignore file at {ignore_path}")
            continue

        cves_in_file = load_ignore_file(ignore_path)
        ignore_stats[img] = len(cves_in_file)
        scoped_cves_by_image[img] = cves_in_file

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

    # 3. Fail-Closed Package-Binding Enforcement on Real Trivy Scan Reports
    if image_reports is not None or enforce_reports:
        reports = image_reports or {}

        if enforce_reports:
            for img in sorted(VALID_IMAGES):
                if img not in reports:
                    errors.append(
                        f"MISSING_IMAGE_REPORT: Required scan report for image '{img}' was not provided under --enforce-reports."
                    )

        for img, report_path in sorted(reports.items()):
            if img not in VALID_IMAGES:
                errors.append(f"UNKNOWN_IMAGE_REPORT: Report provided for unrecognized container image '{img}'.")
                continue

            findings, report_err = load_trivy_json_report(report_path, expected_image=img)
            if report_err:
                errors.append(report_err)
                continue

            suppressed_cves = scoped_cves_by_image.get(img, set())
            matched_findings_count = 0
            verified_count = 0

            for f in findings:
                cve = f.get("cve")
                pkg = f.get("package", "")
                purl = f.get("purl")

                # Only evaluate package binding for CVEs requested for suppression in this image
                if cve in suppressed_cves:
                    matched_findings_count += 1
                    entry = exceptions.get(cve)
                    if not entry:
                        errors.append(f"UNAPPROVED EXCEPTION: '{cve}' in report for '{img}' is not in Risk Register.")
                        continue

                    if img not in entry["images"]:
                        errors.append(
                            f"CROSS-IMAGE LEAKAGE: Finding '{cve}' in image '{img}' is only authorized for {sorted(list(entry['images']))}."
                        )
                        continue

                    if not pkg:
                        errors.append(
                            f"MISSING_PACKAGE_NAME: Finding for '{cve}' in image '{img}' has missing package name (PkgName). Cannot verify package binding fail-closed."
                        )
                        continue

                    if not entry["packages"]:
                        errors.append(
                            f"UNAUTHORIZED_PACKAGE: CVE '{cve}' in image '{img}' has no authorized package registered in Risk Register."
                        )
                        continue

                    if not match_package(pkg, entry["packages"], purl=purl):
                        errors.append(
                            f"WRONG-PACKAGE SUPPRESSION: CVE '{cve}' was found in package '{pkg}' of image '{img}', "
                            f"but Risk Register only authorizes it for package(s): {sorted(list(entry['packages']))}."
                        )
                    else:
                        verified_count += 1

            report_metrics[img] = {
                "raw": len(findings),
                "matched": matched_findings_count,
                "verified": verified_count,
            }

        if enforce_reports:
            total_verified = sum(m["verified"] for m in report_metrics.values())
            if total_verified == 0:
                errors.append(
                    "ZERO_SUPPRESSIONS_VERIFIED: Under --enforce-reports, 0 suppressed CVE findings were verified across all raw reports. "
                    "Ensure raw scan commands execute with --ignorefile='' so active vulnerabilities are captured and audited."
                )

    return errors, warnings, ignore_stats, report_metrics


def run_tests() -> int:
    """
    Execute full negative, integration and positive test matrix for P1 governance validator.
    Covers 10 critical failure and verification scenarios with realistic Trivy JSON fixtures.
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
        total_tests = 10

        # --- Test 1: Unregistered CVE fails ---
        write_test_env(
            reg_content="| **CVE-2026-1111** | `api`<br>`test` | desc | expl | comp | team | 2026-12-01 |\n",
            image_cves={"api": ["CVE-2026-1111", "CVE-2026-9999"]},
        )
        errors, _, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("UNAPPROVED EXCEPTION" in e and "CVE-2026-9999" in e for e in errors), f"Test 1 failed: {errors}"
        print("  [PASS] Test 1: Unregistered CVE correctly blocked (UNAPPROVED EXCEPTION)")
        passed_tests += 1

        # --- Test 2: Expired CVE fails ---
        write_test_env(
            reg_content="| **CVE-2026-2222** | `api`<br>`test` | desc | expl | comp | team | 2026-01-01 |\n",
            image_cves={"api": ["CVE-2026-2222"]},
        )
        errors, _, _, _ = validate_governance(t_trivy_dir, t_reg_file, audit_date=datetime.date(2026, 10, 20))
        assert any("EXPIRED EXCEPTION" in e and "CVE-2026-2222" in e for e in errors), f"Test 2 failed: {errors}"
        print("  [PASS] Test 2: Expired CVE correctly blocked (EXPIRED EXCEPTION)")
        passed_tests += 1

        # --- Test 3: Cross-image leakage (Grafana CVE in API ignore) fails ---
        write_test_env(
            reg_content="| **CVE-2026-3333** | `grafana`<br>`kin-openapi` | desc | expl | comp | team | 2026-12-01 |\n",
            image_cves={"api": ["CVE-2026-3333"], "grafana": ["CVE-2026-3333"]},
        )
        errors, _, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("CROSS-IMAGE LEAKAGE" in e and "CVE-2026-3333" in e for e in errors), f"Test 3 failed: {errors}"
        print("  [PASS] Test 3: Cross-image leakage correctly blocked (CROSS-IMAGE LEAKAGE)")
        passed_tests += 1

        # --- Test 4: Stale RESOLVED CVE still present in ignore file fails ---
        write_test_env(
            reg_content="| **CVE-2026-4444** | `api`<br>`proxy` | desc | expl | comp | team | ĐÃ GIẢI QUYẾT |\n",
            image_cves={"api": ["CVE-2026-4444"]},
        )
        errors, _, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("STALE SUPPRESSION" in e and "CVE-2026-4444" in e for e in errors), f"Test 4 failed: {errors}"
        print("  [PASS] Test 4: Stale RESOLVED CVE correctly blocked (STALE SUPPRESSION)")
        passed_tests += 1

        # --- Test 5: Conflicting duplicate records (images/expiry) fail ---
        conflicting_reg = (
            "| **CVE-2026-5555** | `api`<br>`lib1` | desc | expl | comp | team | 2026-12-01 |\n"
            "| **CVE-2026-5555** | `nginx`<br>`lib2` | desc | expl | comp | team | 2026-11-01 |\n"
        )
        write_test_env(reg_content=conflicting_reg, image_cves={})
        errors, _, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("CONFLICTING DUPLICATE RECORD" in e for e in errors), f"Test 5 failed: {errors}"
        print("  [PASS] Test 5: Conflicting duplicate records correctly blocked (CONFLICTING DUPLICATE RECORD)")
        passed_tests += 1

        # --- Test 6: Missing expiry date in register fails ---
        missing_expiry_reg = "| **CVE-2026-6666** | `api`<br>`lib1` | desc | expl | comp | team | NoDateHere |\n"
        write_test_env(reg_content=missing_expiry_reg, image_cves={"api": ["CVE-2026-6666"]})
        errors, _, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("MISSING EXPIRY" in e and "CVE-2026-6666" in e for e in errors), f"Test 6 failed: {errors}"
        print("  [PASS] Test 6: Missing expiry date correctly blocked (MISSING EXPIRY)")
        passed_tests += 1

        # --- Test 7: Conflicting duplicate records with mismatched package mapping fail ---
        conflicting_pkg_reg = (
            "| **CVE-2026-8888** | `ai-worker`<br>`pillow` | desc | expl | comp | team | 2026-12-01 |\n"
            "| **CVE-2026-8888** | `ai-worker`<br>`transformers` | desc | expl | comp | team | 2026-12-01 |\n"
        )
        write_test_env(reg_content=conflicting_pkg_reg, image_cves={})
        errors, _, _, _ = validate_governance(t_trivy_dir, t_reg_file)
        assert any("CONFLICTING DUPLICATE RECORD" in e and "packages" in e.lower() for e in errors), f"Test 7 failed: {errors}"
        print("  [PASS] Test 7: Conflicting duplicate package mapping correctly blocked (CONFLICTING DUPLICATE RECORD)")
        passed_tests += 1

        # --- Test 8: Real Trivy JSON fixture with valid package verified ---
        fixture_reg = "| **CVE-2026-100351** | `grafana`<br>`github.com/getkin/kin-openapi` | desc | expl | comp | team | 2026-12-01 |\n"
        write_test_env(reg_content=fixture_reg, image_cves={"grafana": ["CVE-2026-100351"]})
        valid_json = {
            "SchemaVersion": 2,
            "ArtifactName": "grafana/grafana:13.2.3",
            "Results": [{
                "Target": "usr/share/grafana/bin/grafana",
                "Vulnerabilities": [{
                    "VulnerabilityID": "CVE-2026-100351",
                    "PkgName": "github.com/getkin/kin-openapi",
                    "PkgIdentifier": {"PURL": "pkg:golang/github.com/getkin/kin-openapi@0.129.0"},
                    "Severity": "HIGH"
                }]
            }]
        }
        valid_report_path = os.path.join(test_dir, "grafana_valid.json")
        with open(valid_report_path, "w", encoding="utf-8") as f:
            json.dump(valid_json, f)

        errors, _, _, report_metrics = validate_governance(
            t_trivy_dir, t_reg_file, image_reports={"grafana": valid_report_path}
        )
        assert len(errors) == 0, f"Test 8 failed with unexpected errors: {errors}"
        assert report_metrics.get("grafana", {}).get("verified") == 1
        print("  [PASS] Test 8: Real Trivy JSON fixture with valid package verified (PACKAGE-BINDING PASS)")
        passed_tests += 1

        # --- Test 9: Real Trivy JSON fixture with wrong package fails ---
        wrong_json = {
            "SchemaVersion": 2,
            "ArtifactName": "grafana/grafana:13.2.3",
            "Results": [{
                "Target": "usr/share/grafana/bin/grafana",
                "Vulnerabilities": [{
                    "VulnerabilityID": "CVE-2026-100351",
                    "PkgName": "unauthorized-malicious-pkg",
                    "PkgIdentifier": {"PURL": "pkg:golang/unauthorized-malicious-pkg@1.0.0"},
                    "Severity": "HIGH"
                }]
            }]
        }
        wrong_report_path = os.path.join(test_dir, "grafana_wrong.json")
        with open(wrong_report_path, "w", encoding="utf-8") as f:
            json.dump(wrong_json, f)

        errors, _, _, _ = validate_governance(
            t_trivy_dir, t_reg_file, image_reports={"grafana": wrong_report_path}
        )
        assert any("WRONG-PACKAGE SUPPRESSION" in e and "unauthorized-malicious-pkg" in e for e in errors), f"Test 9 failed: {errors}"
        print("  [PASS] Test 9: Real Trivy JSON fixture with wrong package correctly blocked (WRONG-PACKAGE SUPPRESSION)")
        passed_tests += 1

        # --- Test 10: Missing/Corrupt report under --enforce-reports fails ---
        corrupt_report_path = os.path.join(test_dir, "corrupt.json")
        with open(corrupt_report_path, "w", encoding="utf-8") as f:
            f.write("{invalid_json_stream:")

        errors, _, _, _ = validate_governance(
            t_trivy_dir, t_reg_file,
            image_reports={"api": corrupt_report_path, "ai-worker": os.path.join(test_dir, "missing.json")},
            enforce_reports=True
        )
        assert any("REPORT_CORRUPT" in e for e in errors)
        assert any("REPORT_MISSING" in e for e in errors)
        assert any("MISSING_IMAGE_REPORT" in e for e in errors)
        print("  [PASS] Test 10: Missing and corrupt reports correctly blocked fail-closed (REPORT_MISSING/REPORT_CORRUPT)")
        passed_tests += 1

        # --- Test 11: Image identity mismatch fails ---
        mismatched_json = {
            "SchemaVersion": 2,
            "ArtifactName": "omninovel-ai-worker:test",
            "Results": [{
                "Target": "usr/share/test",
                "Vulnerabilities": []
            }]
        }
        mismatched_report_path = os.path.join(test_dir, "mismatched.json")
        with open(mismatched_report_path, "w", encoding="utf-8") as f:
            json.dump(mismatched_json, f)

        errors, _, _, _ = validate_governance(
            t_trivy_dir, t_reg_file, image_reports={"api": mismatched_report_path}
        )
        assert any("IMAGE_IDENTITY_MISMATCH" in e for e in errors), f"Test 11 failed: {errors}"
        print("  [PASS] Test 11: Image identity mismatch correctly blocked (IMAGE_IDENTITY_MISMATCH)")
        passed_tests += 1

        # --- Test 12: Suppressed finding with missing PkgName fails ---
        missing_pkg_json = {
            "SchemaVersion": 2,
            "ArtifactName": "grafana/grafana:13.2.3",
            "Results": [{
                "Target": "usr/share/grafana/bin/grafana",
                "Vulnerabilities": [{
                    "VulnerabilityID": "CVE-2026-100351",
                    "PkgName": "",
                    "Severity": "HIGH"
                }]
            }]
        }
        missing_pkg_report_path = os.path.join(test_dir, "missing_pkg.json")
        with open(missing_pkg_report_path, "w", encoding="utf-8") as f:
            json.dump(missing_pkg_json, f)

        errors, _, _, _ = validate_governance(
            t_trivy_dir, t_reg_file, image_reports={"grafana": missing_pkg_report_path}
        )
        assert any("MISSING_PACKAGE_NAME" in e for e in errors), f"Test 12 failed: {errors}"
        print("  [PASS] Test 12: Suppressed finding with missing PkgName correctly blocked (MISSING_PACKAGE_NAME)")
        passed_tests += 1

        total_tests = passed_tests
        print("--------------------------------------------------------------------------------")
        print(f"[TEST RESULT] {passed_tests}/{total_tests} Negative, Integration & Governance Tests PASSED (Validated Fail-Closed Scenarios)")
        print("================================================================================\n")
        return 0
    finally:
        shutil.rmtree(test_dir, ignore_errors=True)


def main():
    enforce_reports = "--enforce-reports" in sys.argv

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

    # Parse reports from CLI: --report <image>=<path> or --report <path>
    image_reports: Dict[str, str] = {}
    for idx, arg in enumerate(sys.argv):
        if arg == "--report" and idx + 1 < len(sys.argv):
            val = sys.argv[idx + 1]
            if "=" in val:
                img, path = val.split("=", 1)
                image_reports[img.strip().lower()] = path.strip()
            else:
                for img_candidate in VALID_IMAGES:
                    if img_candidate in os.path.basename(val).lower():
                        image_reports[img_candidate] = val.strip()
                        break

    if image_reports:
        print(f"[INFO] Package-Level Binding Enforcement: Active across {len(image_reports)} report(s)")
        for img, p in image_reports.items():
            print(f"  - [{img}]: {p}")

    errors, warnings, ignore_stats, report_metrics = validate_governance(
        trivy_dir=TRIVY_DIR,
        register_file=REGISTER_PATH,
        root_trivyignore=ROOT_TRIVYIGNORE,
        audit_date=today,
        image_reports=image_reports if image_reports else None,
        enforce_reports=enforce_reports,
    )

    print("\n[INFO] Active Scoped Exception Distribution:")
    for img, count in ignore_stats.items():
        print(f"  - {img:<12}: {count:>2} authorized CVE suppressions")

    if report_metrics:
        print("\n[PACKAGE GOVERNANCE]")
        for img in sorted(VALID_IMAGES):
            if img in report_metrics:
                m = report_metrics[img]
                print(f"  - {img:<12}: raw findings {m['raw']:>3}, suppressed IDs matched {m['matched']:>2}, verified {m['verified']:>2}")
            else:
                print(f"  - {img:<12}: no scan report provided")

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
    if report_metrics:
        print("[PASS] PACKAGE-LEVEL BINDING GATE PASSED: All evaluated suppressions match authorized packages on real Trivy scan reports.")
    print("================================================================================")
    sys.exit(0)


if __name__ == "__main__":
    main()
