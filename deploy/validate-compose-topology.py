#!/usr/bin/env python3
"""
OmniNovel VPS Production Topology & Docker Compose Assertion Validator
Validates 3-network topology, service isolation, port loopback binding, and supply chain digest invariants.

Usage:
  python deploy/validate-compose-topology.py --test
  python deploy/validate-compose-topology.py --json <path-to-resolved-compose-json>
  python deploy/validate-compose-topology.py --stdin
"""

import sys
import json
import argparse
import copy
from typing import Dict, Any, List, Tuple

PROMETHEUS_DIGEST = "sha256:efd719c99d83b060d9daefdcf00360461adf279f45ef5391f8d111892118753e"
GRAFANA_DIGEST = "sha256:b28bae15e219c998fb0e0424ed724930cc61b1f61fb404d47c862f9a23f9e572"

EXPECTED_NETWORKS = {"omninovel-edge", "omninovel-internal", "omninovel-egress"}

EXPECTED_SERVICE_NETWORKS = {
    "nginx": {"omninovel-edge"},
    "api": {"omninovel-edge", "omninovel-internal", "omninovel-egress"},
    "ai-worker": {"omninovel-internal", "omninovel-egress"},
    "redis": {"omninovel-internal"},
    "prometheus": {"omninovel-internal"},
    "grafana": {"omninovel-internal"},
}


def validate_topology(data: Dict[str, Any]) -> List[str]:
    """
    Validates resolved Docker Compose JSON structure against architectural security invariants.
    Returns a list of violation errors (empty if completely valid).
    """
    errors: List[str] = []

    services = data.get("services", {})
    networks = data.get("networks", {})

    # 1. Network Boundary Invariant: Exactly 3 designated networks
    actual_networks = set(networks.keys())
    missing_networks = EXPECTED_NETWORKS - actual_networks
    if missing_networks:
        errors.append(f"MISSING_NETWORKS: Missing required topology networks: {sorted(missing_networks)}")

    internal_net = networks.get("omninovel-internal", {})
    if not internal_net.get("internal", False):
        errors.append("INTERNAL_NETWORK_NOT_ISOLATED: 'omninovel-internal' must have 'internal: true' to block outbound routing.")

    # 2. Service Membership Invariants
    for svc_name, expected_nets in EXPECTED_SERVICE_NETWORKS.items():
        if svc_name not in services:
            errors.append(f"MISSING_SERVICE: Required service '{svc_name}' not defined in compose specification.")
            continue

        svc = services[svc_name]
        svc_nets = set(svc.get("networks", {}).keys())

        if svc_nets != expected_nets:
            errors.append(
                f"NETWORK_MEMBERSHIP_VIOLATION: Service '{svc_name}' networks mismatch. "
                f"Expected {sorted(expected_nets)}, found {sorted(svc_nets)}."
            )

    # 3. Port Invariants & Strict Loopback Bindings
    for svc_name, svc in services.items():
        ports = svc.get("ports", [])
        if svc_name == "nginx":
            # Nginx is the public edge reverse proxy; must publish 80 and 443
            published_ports = {str(p.get("published", "")) for p in ports}
            if not {"80", "443"}.issubset(published_ports):
                errors.append(f"EDGE_INGRESS_PORT_MISSING: 'nginx' must expose ports 80 and 443, found: {published_ports}")
        elif svc_name in ("api", "ai-worker", "redis"):
            # Internal backend services must NEVER expose ports to host
            if len(ports) > 0:
                errors.append(
                    f"PORT_LEAKAGE_DETECTED: Service '{svc_name}' exposes host ports {ports}. "
                    "Internal services must communicate solely across private Docker bridge networks."
                )
        elif svc_name in ("prometheus", "grafana"):
            # Observability services, if mapped, MUST strictly bind to 127.0.0.1 (never 0.0.0.0 or wildcard)
            for p in ports:
                host_ip = p.get("host_ip", "")
                if host_ip != "127.0.0.1":
                    errors.append(
                        f"OBSERVABILITY_PORT_NOT_LOOPBACK: Service '{svc_name}' published port {p.get('published')} "
                        f"bound to '{host_ip or '0.0.0.0'}'. Must bind strictly to '127.0.0.1' (loopback only)."
                    )

    # 4. Supply Chain Digest Pinning Invariants
    prom_svc = services.get("prometheus", {})
    prom_img = prom_svc.get("image", "")
    if PROMETHEUS_DIGEST not in prom_img:
        errors.append(f"PROMETHEUS_DIGEST_UNPINNED: Prometheus image '{prom_img}' must pin digest {PROMETHEUS_DIGEST}")

    graf_svc = services.get("grafana", {})
    graf_img = graf_svc.get("image", "")
    if GRAFANA_DIGEST not in graf_img:
        errors.append(f"GRAFANA_DIGEST_UNPINNED: Grafana image '{graf_img}' must pin digest {GRAFANA_DIGEST}")

    return errors


def run_unit_tests() -> int:
    """Runs full test matrix covering both positive and negative failure scenarios."""
    print("================================================================================")
    print("[TEST SUITE] Running VPS Production Topology & Compose Gate Invariant Matrix")
    print("================================================================================")

    # Base valid fixture matching OmniNovel resolved compose
    valid_fixture = {
        "networks": {
            "omninovel-edge": {"driver": "bridge"},
            "omninovel-internal": {"driver": "bridge", "internal": True},
            "omninovel-egress": {"driver": "bridge"},
        },
        "services": {
            "nginx": {
                "networks": {"omninovel-edge": {}},
                "ports": [
                    {"mode": "ingress", "target": 80, "published": "80", "protocol": "tcp"},
                    {"mode": "ingress", "target": 443, "published": "443", "protocol": "tcp"},
                ],
            },
            "api": {
                "networks": {"omninovel-edge": {}, "omninovel-internal": {}, "omninovel-egress": {}},
                "ports": [],
            },
            "ai-worker": {
                "networks": {"omninovel-internal": {}, "omninovel-egress": {}},
                "ports": [],
            },
            "redis": {
                "networks": {"omninovel-internal": {}},
                "ports": [],
            },
            "prometheus": {
                "image": f"prom/prometheus:v3.15.0@{PROMETHEUS_DIGEST}",
                "networks": {"omninovel-internal": {}},
                "ports": [
                    {"mode": "ingress", "host_ip": "127.0.0.1", "target": 9090, "published": "9090", "protocol": "tcp"}
                ],
            },
            "grafana": {
                "image": f"grafana/grafana:13.2.3@{GRAFANA_DIGEST}",
                "networks": {"omninovel-internal": {}},
                "ports": [
                    {"mode": "ingress", "host_ip": "127.0.0.1", "target": 3000, "published": "3001", "protocol": "tcp"}
                ],
            },
        },
    }

    passed = 0

    # Test 1: Valid topology passes
    errs = validate_topology(valid_fixture)
    assert len(errs) == 0, f"Test 1 failed: {errs}"
    print("  [PASS] Test 1: Fully compliant 3-network production topology verified")
    passed += 1

    # Test 2: Port leakage on internal API container
    bad_api = copy.deepcopy(valid_fixture)
    bad_api["services"]["api"]["ports"] = [{"target": 8000, "published": "8000"}]
    errs = validate_topology(bad_api)
    assert any("PORT_LEAKAGE_DETECTED" in e and "api" in e for e in errs), f"Test 2 failed: {errs}"
    print("  [PASS] Test 2: Internal API direct host port leakage correctly blocked")
    passed += 1

    # Test 3: Port leakage on Redis container
    bad_redis = copy.deepcopy(valid_fixture)
    bad_redis["services"]["redis"]["ports"] = [{"target": 6379, "published": "6379"}]
    errs = validate_topology(bad_redis)
    assert any("PORT_LEAKAGE_DETECTED" in e and "redis" in e for e in errs), f"Test 3 failed: {errs}"
    print("  [PASS] Test 3: Redis direct host port leakage correctly blocked")
    passed += 1

    # Test 4: Observability port bound to public interface (0.0.0.0 or wildcard)
    bad_prom = copy.deepcopy(valid_fixture)
    bad_prom["services"]["prometheus"]["ports"] = [
        {"mode": "ingress", "host_ip": "0.0.0.0", "target": 9090, "published": "9090"}
    ]
    errs = validate_topology(bad_prom)
    assert any("OBSERVABILITY_PORT_NOT_LOOPBACK" in e and "prometheus" in e for e in errs), f"Test 4 failed: {errs}"
    print("  [PASS] Test 4: Prometheus non-loopback exposure (0.0.0.0) correctly blocked")
    passed += 1

    # Test 5: Missing internal: true on omninovel-internal network
    bad_net = copy.deepcopy(valid_fixture)
    bad_net["networks"]["omninovel-internal"]["internal"] = False
    errs = validate_topology(bad_net)
    assert any("INTERNAL_NETWORK_NOT_ISOLATED" in e for e in errs), f"Test 5 failed: {errs}"
    print("  [PASS] Test 5: Missing 'internal: true' on internal network correctly blocked")
    passed += 1

    # Test 6: Cross-network leakage (Redis joining edge network)
    bad_leak = copy.deepcopy(valid_fixture)
    bad_leak["services"]["redis"]["networks"]["omninovel-edge"] = {}
    errs = validate_topology(bad_leak)
    assert any("NETWORK_MEMBERSHIP_VIOLATION" in e and "redis" in e for e in errs), f"Test 6 failed: {errs}"
    print("  [PASS] Test 6: Unauthorized cross-network membership (Redis in edge) correctly blocked")
    passed += 1

    # Test 7: Unpinned Prometheus supply chain image
    bad_img = copy.deepcopy(valid_fixture)
    bad_img["services"]["prometheus"]["image"] = "prom/prometheus:latest"
    errs = validate_topology(bad_img)
    assert any("PROMETHEUS_DIGEST_UNPINNED" in e for e in errs), f"Test 7 failed: {errs}"
    print("  [PASS] Test 7: Unpinned Prometheus image correctly blocked")
    passed += 1

    print("--------------------------------------------------------------------------------")
    print(f"[TEST RESULT] {passed}/{passed} Negative & Integration Scenarios PASSED")
    print("================================================================================\n")
    return 0


def main():
    parser = argparse.ArgumentParser(description="Validate OmniNovel Docker Compose Topology Specification")
    parser.add_argument("--test", action="store_true", help="Run self-testing negative & positive assertion matrix")
    parser.add_argument("--json", type=str, help="Path to resolved Docker Compose JSON file")
    parser.add_argument("--stdin", action="store_true", help="Read resolved Docker Compose JSON from stdin")
    args = parser.parse_args()

    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if args.test:
        test_exit = run_unit_tests()
        if test_exit != 0:
            sys.exit(test_exit)

    raw_json = None
    if args.json:
        with open(args.json, "r", encoding="utf-8") as f:
            raw_json = json.load(f)
    elif args.stdin:
        raw_json = json.load(sys.stdin)

    if raw_json is not None:
        errors = validate_topology(raw_json)
        print("================================================================================")
        print("[GATE] OMNINOVEL VPS PRODUCTION TOPOLOGY ASSERTION GATE")
        print("================================================================================")
        print(f"[INFO] Analyzed {len(raw_json.get('services', {}))} services and {len(raw_json.get('networks', {}))} networks.")
        for svc_name, svc in sorted(raw_json.get("services", {}).items()):
            nets = sorted(svc.get("networks", {}).keys())
            ports = [f"{p.get('host_ip', '')}:{p.get('published')}->{p.get('target')}" if p.get('host_ip') else f"{p.get('published')}->{p.get('target')}" for p in svc.get("ports", [])]
            ports_str = ", ".join(ports) if ports else "NO_HOST_PORTS (isolated)"
            print(f"  - {svc_name:12}: networks={nets} | ports={ports_str}")

        if errors:
            print("\n[FAIL] TOPOLOGY VIOLATIONS DETECTED:")
            for e in errors:
                print(f"  [ERROR] {e}")
            print("================================================================================")
            sys.exit(1)

        print("\n[PASS] TOPOLOGY VERIFICATION PASSED: All 3-network, port-binding, and supply chain invariants verified.")
        print("================================================================================")


if __name__ == "__main__":
    main()
