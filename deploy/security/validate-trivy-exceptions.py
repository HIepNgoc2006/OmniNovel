#!/usr/bin/env python3
"""
Trivy Exception Lifecycle, Scope & Expiry Gate Validator (P1 Security Automation)
Standard: Fail-Closed Gate (SEC-REG-6.4.4A)
Validates that:
  1. Every CVE listed in .trivyignore is registered in deploy/security/trivy-exception-register.md.
  2. Every registered exception is bound to an authorized container image/package scope.
  3. Every registered exception has a valid, non-expired date (expiry_date >= today).
  4. Provides audit logs, image breakdown, and lifecycle warnings for quarterly review.
"""

import datetime
import os
import re
import sys

# Ensure UTF-8 output on all platforms
if sys.platform == "win32":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    except Exception:
        pass

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
TRIVYIGNORE_PATH = os.path.join(REPO_ROOT, ".trivyignore")
REGISTER_PATH = os.path.join(REPO_ROOT, "deploy", "security", "trivy-exception-register.md")

CVE_PATTERN = re.compile(r"(?:CVE-\d{4}-\d+|GHSA-[a-zA-Z0-9-]+)")
DATE_PATTERN = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")

# Authorized container scopes in OmniNovel topology
VALID_IMAGE_KEYWORDS = {"api", "ai-worker", "nginx", "prometheus", "grafana"}

def load_trivyignore():
    if not os.path.isfile(TRIVYIGNORE_PATH):
        print(f"::error::File .trivyignore not found at {TRIVYIGNORE_PATH}")
        sys.exit(1)

    cves = set()
    with open(TRIVYIGNORE_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            match = CVE_PATTERN.search(line)
            if match:
                cves.add(match.group(0))
    return cves

def load_register():
    if not os.path.isfile(REGISTER_PATH):
        print(f"::error::File trivy-exception-register.md not found at {REGISTER_PATH}")
        sys.exit(1)

    exceptions = {}
    with open(REGISTER_PATH, "r", encoding="utf-8") as f:
        lines = f.readlines()

    for line in lines:
        line = line.strip()
        if not line.startswith("|") or "---" in line or "CVE ID" in line:
            continue

        parts = [p.strip() for p in line.split("|")]
        if len(parts) < 8:
            continue

        cves_found = CVE_PATTERN.findall(parts[1])
        scope_str = parts[2]
        dates_found = DATE_PATTERN.findall(parts[7])

        if not cves_found:
            continue

        # Check if resolved
        is_resolved = "ĐÃ GIẢI QUYẾT" in parts[7] or "RESOLVED" in parts[7].upper()

        expiry_date = None
        if dates_found:
            expiry_str = dates_found[-1]
            try:
                expiry_date = datetime.datetime.strptime(expiry_str, "%Y-%m-%d").date()
            except ValueError:
                expiry_date = None

        for cve in cves_found:
            exceptions[cve] = {
                "scope": scope_str,
                "expiry_date": expiry_date,
                "is_resolved": is_resolved,
            }

    return exceptions

def main():
    print("================================================================================")
    print("[SECURITY GATE] OmniNovel: Validating Trivy Exception Lifecycle, Scope & Expiry")
    print("================================================================================")

    today = datetime.date.today()
    print(f"[INFO] Audit Date (System): {today.isoformat()}")

    trivyignore_cves = load_trivyignore()
    registered_exceptions = load_register()

    print(f"[INFO] Loaded {len(trivyignore_cves)} active CVE suppresses from .trivyignore.")
    print(f"[INFO] Loaded {len(registered_exceptions)} registered exceptions from Risk Register.")

    errors = []
    warnings = []

    # Track scope statistics
    scope_counts = {"api": 0, "ai-worker": 0, "nginx": 0, "prometheus": 0, "grafana": 0}

    # 1. Check for unapproved ignores
    for cve in sorted(trivyignore_cves):
        if cve not in registered_exceptions:
            errors.append(f"UNAPPROVED EXCEPTION: '{cve}' is present in .trivyignore but not documented in trivy-exception-register.md")
        else:
            entry = registered_exceptions[cve]
            if entry["is_resolved"]:
                errors.append(f"STALE SUPPRESSION: '{cve}' is marked as RESOLVED in Risk Register but still present in .trivyignore.")

    # 2. Check each registered exception bound to active .trivyignore
    for cve, entry in sorted(registered_exceptions.items()):
        if cve in trivyignore_cves:
            scope = entry["scope"].lower()
            expiry_date = entry["expiry_date"]

            # Validate scope binding
            matched_keywords = [kw for kw in VALID_IMAGE_KEYWORDS if kw in scope]
            if not matched_keywords:
                errors.append(f"INVALID SCOPE: '{cve}' has no recognized container binding in '{entry['scope']}'.")
            else:
                for kw in matched_keywords:
                    scope_counts[kw] += 1

            # Validate expiration date
            if not expiry_date:
                errors.append(f"MISSING EXPIRY: '{cve}' in Risk Register has no parseable expiry date (YYYY-MM-DD).")
            elif expiry_date < today:
                errors.append(f"EXPIRED EXCEPTION: '{cve}' expired on {expiry_date.isoformat()} (Audit Date: {today.isoformat()}). Renewal or upstream fix required!")
            else:
                days_remaining = (expiry_date - today).days
                if days_remaining <= 30:
                    warnings.append(f"UPCOMING EXPIRY: '{cve}' bound to [{entry['scope']}] expires in {days_remaining} days ({expiry_date.isoformat()}).")

    print("\n[INFO] Active Exception Distribution Across Container Topologies:")
    for kw, count in scope_counts.items():
        print(f"  - {kw:<12}: {count} bound CVE exceptions")

    if warnings:
        print(f"\n[WARNING] LIFECYCLE WARNINGS ({len(warnings)} CVEs approach quarterly review):")
        for w in warnings[:10]:
            print(f"  - {w}")
        if len(warnings) > 10:
            print(f"  ... and {len(warnings) - 10} more approaching review date.")

    if errors:
        print(f"\n[FAIL] TRIVY EXCEPTION AUDIT FAILED ({len(errors)} violations):")
        for err in errors:
            print(f"::error::{err}")
        sys.exit(1)

    print("\n[PASS] TRIVY EXCEPTION AUDIT PASSED: 100% of suppressed CVEs are registered, bound to container scope, and within active lifecycle window.")
    print("================================================================================")
    sys.exit(0)

if __name__ == "__main__":
    main()
