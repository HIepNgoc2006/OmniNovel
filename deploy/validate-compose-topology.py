#!/usr/bin/env python3
"""
OmniNovel VPS Production Topology & Docker Compose Strict Exact-Set Assertion Validator
Validates 3-network exact-set, 6-service exact-set, exact network memberships, exact port mappings,
host network blocking, and exact image supply chain digest invariants.

Usage:
  python deploy/validate-compose-topology.py --test
  python deploy/validate-compose-topology.py --json <path-to-resolved-compose-json>
  python deploy/validate-compose-topology.py --stdin
"""

import sys
import json
import argparse
import copy
from typing import Dict, Any, List, Set, Tuple

EXACT_PROMETHEUS_IMAGE = "prom/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06"
EXACT_GRAFANA_IMAGE = "grafana/grafana:13.3.0@sha256:488984b716c0862639f91a698adbe2862677a5a07bad42da5f03f3030883b205"

EXPECTED_NETWORKS: Set[str] = {"omninovel-edge", "omninovel-internal", "omninovel-egress"}

EXPECTED_SERVICES: Set[str] = {"nginx", "api", "ai-worker", "redis", "prometheus", "grafana"}

EXPECTED_SERVICE_NETWORKS: Dict[str, Set[str]] = {
    "nginx": {"omninovel-edge"},
    "api": {"omninovel-edge", "omninovel-internal", "omninovel-egress"},
    "ai-worker": {"omninovel-internal", "omninovel-egress"},
    "redis": {"omninovel-internal"},
    "prometheus": {"omninovel-internal"},
    "grafana": {"omninovel-internal"},
}


def normalize_port_entry(port_entry: Any) -> Dict[str, Any]:
    """Normalizes port entry dict from Docker Compose JSON."""
    if isinstance(port_entry, dict):
        raw_pub = port_entry.get("published", "")
        raw_target = port_entry.get("target", 0)
        protocol = str(port_entry.get("protocol", "tcp")).lower().strip()
        host_ip = str(port_entry.get("host_ip", "")).strip()
        return {
            "published": str(raw_pub).strip(),
            "target": int(raw_target) if str(raw_target).isdigit() else 0,
            "protocol": protocol,
            "host_ip": host_ip,
        }
    return {"published": str(port_entry), "target": 0, "protocol": "tcp", "host_ip": ""}


def validate_topology(data: Dict[str, Any]) -> List[str]:
    """
    Validates resolved Docker Compose JSON structure against architectural security invariants.
    Returns a list of violation errors (empty if completely valid).
    """
    errors: List[str] = []

    services = data.get("services", {})
    networks = data.get("networks", {})

    # --------------------------------------------------------------------------
    # B1. Exact Network Set Invariant (Two-way set equality)
    # --------------------------------------------------------------------------
    actual_networks = set(networks.keys())
    missing_networks = EXPECTED_NETWORKS - actual_networks
    extra_networks = actual_networks - EXPECTED_NETWORKS

    if missing_networks:
        errors.append(f"MISSING_NETWORKS: Missing required topology networks: {sorted(missing_networks)}")
    if extra_networks:
        errors.append(f"UNAPPROVED_EXTRA_NETWORKS: Found unapproved extra networks: {sorted(extra_networks)}. Exact set required: {sorted(EXPECTED_NETWORKS)}")

    internal_net = networks.get("omninovel-internal", {})
    if not internal_net.get("internal", False):
        errors.append("INTERNAL_NETWORK_NOT_ISOLATED: 'omninovel-internal' must have 'internal: true' to block outbound routing.")

    # --------------------------------------------------------------------------
    # B2. Exact Service Set & Membership Invariants
    # --------------------------------------------------------------------------
    actual_services = set(services.keys())
    missing_services = EXPECTED_SERVICES - actual_services
    extra_services = actual_services - EXPECTED_SERVICES

    if missing_services:
        errors.append(f"MISSING_SERVICES: Missing required services: {sorted(missing_services)}")
    if extra_services:
        errors.append(f"UNAPPROVED_EXTRA_SERVICES: Found unapproved extra services: {sorted(extra_services)}. Exact set required: {sorted(EXPECTED_SERVICES)}")

    for svc_name, svc in services.items():
        # Check network_mode: host breach
        net_mode = svc.get("network_mode", "")
        if net_mode and net_mode.lower() in ("host", "container"):
            errors.append(f"FORBIDDEN_NETWORK_MODE: Service '{svc_name}' uses unapproved network_mode '{net_mode}'. Host network mode is strictly blocked.")

        if svc_name in EXPECTED_SERVICE_NETWORKS:
            expected_nets = EXPECTED_SERVICE_NETWORKS[svc_name]
            svc_nets = set(svc.get("networks", {}).keys())
            if svc_nets != expected_nets:
                errors.append(
                    f"NETWORK_MEMBERSHIP_VIOLATION: Service '{svc_name}' networks mismatch. "
                    f"Expected exact set {sorted(expected_nets)}, found {sorted(svc_nets)}."
                )

    # --------------------------------------------------------------------------
    # B3. Strict Exact Published Port Assertions
    # --------------------------------------------------------------------------
    for svc_name, svc in services.items():
        raw_ports = svc.get("ports", [])
        normalized_ports = [normalize_port_entry(p) for p in raw_ports]

        # Duplicate mapping check
        seen_keys: Set[Tuple[str, str, str]] = set()
        for p in normalized_ports:
            key = (p["host_ip"], p["published"], p["protocol"])
            if key in seen_keys:
                errors.append(f"DUPLICATE_PORT_MAPPING: Service '{svc_name}' defines duplicate mapping {key}")
            seen_keys.add(key)

        if svc_name == "nginx":
            # Nginx must expose EXACTLY two ports: 80/tcp and 443/tcp
            if len(normalized_ports) != 2:
                errors.append(f"NGINX_PORT_COUNT_VIOLATION: Nginx must expose exactly 2 ports (80/443), found {len(normalized_ports)}: {normalized_ports}")

            has_80 = False
            has_443 = False
            for p in normalized_ports:
                if p["protocol"] != "tcp":
                    errors.append(f"NGINX_NON_TCP_PORT: Nginx published port {p['published']} uses invalid protocol '{p['protocol']}'. Only TCP permitted.")
                if p["published"] == "80":
                    has_80 = True
                    if p["target"] != 80:
                        errors.append(f"NGINX_PORT_TARGET_MISMATCH: Port 80 must target port 80, found target {p['target']}")
                elif p["published"] == "443":
                    has_443 = True
                    if p["target"] != 443:
                        errors.append(f"NGINX_PORT_TARGET_MISMATCH: Port 443 must target port 443, found target {p['target']}")
                else:
                    errors.append(f"NGINX_UNAPPROVED_PORT: Nginx publishes unapproved host port '{p['published']}'. Only 80 and 443 permitted.")

            if not has_80:
                errors.append("EDGE_INGRESS_PORT_MISSING: 'nginx' missing published port 80.")
            if not has_443:
                errors.append("EDGE_INGRESS_PORT_MISSING: 'nginx' missing published port 443.")

        elif svc_name in ("api", "ai-worker", "redis"):
            # Internal backend services must NEVER expose ports to host
            if len(normalized_ports) > 0:
                errors.append(
                    f"PORT_LEAKAGE_DETECTED: Service '{svc_name}' exposes host ports {raw_ports}. "
                    "Internal services must communicate solely across private Docker bridge networks."
                )

        elif svc_name == "prometheus":
            # Exactly 1 mapping: 127.0.0.1:9090 -> 9090/tcp
            if len(normalized_ports) != 1:
                errors.append(f"PROMETHEUS_PORT_COUNT_VIOLATION: Prometheus must expose exactly 1 port (9090), found {len(normalized_ports)}")
            for p in normalized_ports:
                if p["published"] != "9090" or p["target"] != 9090:
                    errors.append(f"PROMETHEUS_PORT_MISMATCH: Expected published 9090 -> target 9090, found {p['published']} -> {p['target']}")
                if p["host_ip"] != "127.0.0.1":
                    errors.append(f"OBSERVABILITY_PORT_NOT_LOOPBACK: Prometheus published port {p['published']} bound to '{p['host_ip'] or '0.0.0.0'}'. Must bind strictly to '127.0.0.1'.")
                if p["protocol"] != "tcp":
                    errors.append(f"OBSERVABILITY_PORT_NON_TCP: Prometheus uses protocol '{p['protocol']}'. Only TCP permitted.")

        elif svc_name == "grafana":
            # Exactly 1 mapping: 127.0.0.1:3001 -> 3000/tcp
            if len(normalized_ports) != 1:
                errors.append(f"GRAFANA_PORT_COUNT_VIOLATION: Grafana must expose exactly 1 port (3001), found {len(normalized_ports)}")
            for p in normalized_ports:
                if p["published"] != "3001" or p["target"] != 3000:
                    errors.append(f"GRAFANA_PORT_MISMATCH: Expected published 3001 -> target 3000, found {p['published']} -> {p['target']}")
                if p["host_ip"] != "127.0.0.1":
                    errors.append(f"OBSERVABILITY_PORT_NOT_LOOPBACK: Grafana published port {p['published']} bound to '{p['host_ip'] or '0.0.0.0'}'. Must bind strictly to '127.0.0.1'.")
                if p["protocol"] != "tcp":
                    errors.append(f"OBSERVABILITY_PORT_NON_TCP: Grafana uses protocol '{p['protocol']}'. Only TCP permitted.")

    # --------------------------------------------------------------------------
    # B4. Exact Supply Chain Image Pinning Invariants
    # --------------------------------------------------------------------------
    prom_svc = services.get("prometheus", {})
    prom_img = prom_svc.get("image", "").strip()
    if prom_img != EXACT_PROMETHEUS_IMAGE:
        errors.append(f"PROMETHEUS_IMAGE_MISMATCH: Prometheus image '{prom_img}' must exactly match pinned reference '{EXACT_PROMETHEUS_IMAGE}'")

    graf_svc = services.get("grafana", {})
    graf_img = graf_svc.get("image", "").strip()
    if graf_img != EXACT_GRAFANA_IMAGE:
        errors.append(f"GRAFANA_IMAGE_MISMATCH: Grafana image '{graf_img}' must exactly match pinned reference '{EXACT_GRAFANA_IMAGE}'")

    return errors


def run_unit_tests() -> int:
    """Runs full test matrix covering both positive and negative failure scenarios (TOP-01 to TOP-17)."""
    print("================================================================================")
    print("[TEST SUITE] Running VPS Production Topology & Compose Strict Exact-Set Invariant Matrix")
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
                "image": EXACT_PROMETHEUS_IMAGE,
                "networks": {"omninovel-internal": {}},
                "ports": [
                    {"mode": "ingress", "host_ip": "127.0.0.1", "target": 9090, "published": "9090", "protocol": "tcp"}
                ],
            },
            "grafana": {
                "image": EXACT_GRAFANA_IMAGE,
                "networks": {"omninovel-internal": {}},
                "ports": [
                    {"mode": "ingress", "host_ip": "127.0.0.1", "target": 3000, "published": "3001", "protocol": "tcp"}
                ],
            },
        },
    }

    passed = 0

    # TOP-01: Valid topology passes
    errs = validate_topology(valid_fixture)
    assert len(errs) == 0, f"TOP-01 failed: {errs}"
    print("  [PASS] TOP-01: Fully compliant 3-network production topology verified")
    passed += 1

    # TOP-02: Port leakage on internal API container
    bad_api = copy.deepcopy(valid_fixture)
    bad_api["services"]["api"]["ports"] = [{"target": 8000, "published": "8000"}]
    errs = validate_topology(bad_api)
    assert any("PORT_LEAKAGE_DETECTED" in e and "api" in e for e in errs), f"TOP-02 failed: {errs}"
    print("  [PASS] TOP-02: Internal API direct host port leakage correctly blocked")
    passed += 1

    # TOP-03: Port leakage on Redis container
    bad_redis = copy.deepcopy(valid_fixture)
    bad_redis["services"]["redis"]["ports"] = [{"target": 6379, "published": "6379"}]
    errs = validate_topology(bad_redis)
    assert any("PORT_LEAKAGE_DETECTED" in e and "redis" in e for e in errs), f"TOP-03 failed: {errs}"
    print("  [PASS] TOP-03: Redis direct host port leakage correctly blocked")
    passed += 1

    # TOP-04: Observability port bound to public interface (0.0.0.0 or wildcard)
    bad_prom = copy.deepcopy(valid_fixture)
    bad_prom["services"]["prometheus"]["ports"] = [
        {"mode": "ingress", "host_ip": "0.0.0.0", "target": 9090, "published": "9090"}
    ]
    errs = validate_topology(bad_prom)
    assert any("OBSERVABILITY_PORT_NOT_LOOPBACK" in e and ("Prometheus" in e or "prometheus" in e) for e in errs), f"TOP-04 failed: {errs}"
    print("  [PASS] TOP-04: Prometheus non-loopback exposure (0.0.0.0) correctly blocked")
    passed += 1

    # TOP-05: Missing internal: true on omninovel-internal network
    bad_net = copy.deepcopy(valid_fixture)
    bad_net["networks"]["omninovel-internal"]["internal"] = False
    errs = validate_topology(bad_net)
    assert any("INTERNAL_NETWORK_NOT_ISOLATED" in e for e in errs), f"TOP-05 failed: {errs}"
    print("  [PASS] TOP-05: Missing 'internal: true' on internal network correctly blocked")
    passed += 1

    # TOP-06: Cross-network leakage (Redis joining edge network)
    bad_leak = copy.deepcopy(valid_fixture)
    bad_leak["services"]["redis"]["networks"]["omninovel-edge"] = {}
    errs = validate_topology(bad_leak)
    assert any("NETWORK_MEMBERSHIP_VIOLATION" in e and "redis" in e for e in errs), f"TOP-06 failed: {errs}"
    print("  [PASS] TOP-06: Unauthorized cross-network membership (Redis in edge) correctly blocked")
    passed += 1

    # TOP-07: Unpinned Prometheus supply chain image
    bad_img = copy.deepcopy(valid_fixture)
    bad_img["services"]["prometheus"]["image"] = "prom/prometheus:latest"
    errs = validate_topology(bad_img)
    assert any("PROMETHEUS_IMAGE_MISMATCH" in e for e in errs), f"TOP-07 failed: {errs}"
    print("  [PASS] TOP-07: Unpinned Prometheus image correctly blocked")
    passed += 1

    # TOP-08: Extra 4th network added -> BLOCK
    bad_extra_net = copy.deepcopy(valid_fixture)
    bad_extra_net["networks"]["omninovel-unauthorized"] = {"driver": "bridge"}
    errs = validate_topology(bad_extra_net)
    assert any("UNAPPROVED_EXTRA_NETWORKS" in e for e in errs), f"TOP-08 failed: {errs}"
    print("  [PASS] TOP-08: Unapproved fourth network correctly blocked")
    passed += 1

    # TOP-09: Extra 7th service added -> BLOCK
    bad_extra_svc = copy.deepcopy(valid_fixture)
    bad_extra_svc["services"]["rogue-sidecar"] = {"networks": {"omninovel-edge": {}}, "ports": []}
    errs = validate_topology(bad_extra_svc)
    assert any("UNAPPROVED_EXTRA_SERVICES" in e for e in errs), f"TOP-09 failed: {errs}"
    print("  [PASS] TOP-09: Unapproved seventh service correctly blocked")
    passed += 1

    # TOP-10: Nginx publishes extra port (e.g. 8080) -> BLOCK
    bad_nginx_extra = copy.deepcopy(valid_fixture)
    bad_nginx_extra["services"]["nginx"]["ports"].append(
        {"mode": "ingress", "target": 8080, "published": "8080", "protocol": "tcp"}
    )
    errs = validate_topology(bad_nginx_extra)
    assert any("NGINX_PORT_COUNT_VIOLATION" in e or "NGINX_UNAPPROVED_PORT" in e for e in errs), f"TOP-10 failed: {errs}"
    print("  [PASS] TOP-10: Nginx extra port exposure (8080) correctly blocked")
    passed += 1

    # TOP-11: Nginx missing or changed target for 443 -> BLOCK
    bad_nginx_target = copy.deepcopy(valid_fixture)
    bad_nginx_target["services"]["nginx"]["ports"] = [
        {"mode": "ingress", "target": 80, "published": "80", "protocol": "tcp"},
        {"mode": "ingress", "target": 8443, "published": "443", "protocol": "tcp"},
    ]
    errs = validate_topology(bad_nginx_target)
    assert any("NGINX_PORT_TARGET_MISMATCH" in e for e in errs), f"TOP-11 failed: {errs}"
    print("  [PASS] TOP-11: Nginx incorrect target port mapping correctly blocked")
    passed += 1

    # TOP-12: Nginx opens UDP instead of TCP -> BLOCK
    bad_nginx_udp = copy.deepcopy(valid_fixture)
    bad_nginx_udp["services"]["nginx"]["ports"] = [
        {"mode": "ingress", "target": 80, "published": "80", "protocol": "udp"},
        {"mode": "ingress", "target": 443, "published": "443", "protocol": "tcp"},
    ]
    errs = validate_topology(bad_nginx_udp)
    assert any("NGINX_NON_TCP_PORT" in e for e in errs), f"TOP-12 failed: {errs}"
    print("  [PASS] TOP-12: Nginx non-TCP port protocol correctly blocked")
    passed += 1

    # TOP-13: Grafana publishes extra port -> BLOCK
    bad_graf_extra = copy.deepcopy(valid_fixture)
    bad_graf_extra["services"]["grafana"]["ports"].append(
        {"mode": "ingress", "host_ip": "127.0.0.1", "target": 3001, "published": "3002", "protocol": "tcp"}
    )
    errs = validate_topology(bad_graf_extra)
    assert any("GRAFANA_PORT_COUNT_VIOLATION" in e for e in errs), f"TOP-13 failed: {errs}"
    print("  [PASS] TOP-13: Grafana extra port exposure correctly blocked")
    passed += 1

    # TOP-14: Duplicate published port mapping -> BLOCK
    bad_dup_port = copy.deepcopy(valid_fixture)
    bad_dup_port["services"]["nginx"]["ports"] = [
        {"mode": "ingress", "target": 80, "published": "80", "protocol": "tcp"},
        {"mode": "ingress", "target": 80, "published": "80", "protocol": "tcp"},
    ]
    errs = validate_topology(bad_dup_port)
    assert any("DUPLICATE_PORT_MAPPING" in e for e in errs), f"TOP-14 failed: {errs}"
    print("  [PASS] TOP-14: Duplicate port mapping correctly blocked")
    passed += 1

    # TOP-15: Service has network_mode: host -> BLOCK
    bad_net_mode = copy.deepcopy(valid_fixture)
    bad_net_mode["services"]["api"]["network_mode"] = "host"
    errs = validate_topology(bad_net_mode)
    assert any("FORBIDDEN_NETWORK_MODE" in e for e in errs), f"TOP-15 failed: {errs}"
    print("  [PASS] TOP-15: Host network mode (network_mode: host) correctly blocked")
    passed += 1

    # TOP-16: Fake image repository containing valid digest -> BLOCK
    bad_fake_repo = copy.deepcopy(valid_fixture)
    bad_fake_repo["services"]["prometheus"]["image"] = (
        "evil-registry.io/attacker/prometheus:v3.16.0@sha256:e04987641b57704f408e31f6373ba4138ecf27cb4a165d24aabb6c38fddd0f06"
    )
    errs = validate_topology(bad_fake_repo)
    assert any("PROMETHEUS_IMAGE_MISMATCH" in e for e in errs), f"TOP-16 failed: {errs}"
    print("  [PASS] TOP-16: Fake repository containing valid digest correctly blocked")
    passed += 1

    # TOP-17: Exact check matching baseline manifest structure
    errs = validate_topology(valid_fixture)
    assert len(errs) == 0, f"TOP-17 failed: {errs}"
    print("  [PASS] TOP-17: Final production & observability Compose manifest invariant PASSED")
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
        print("[GATE] OMNINOVEL VPS PRODUCTION TOPOLOGY STRICT EXACT-SET GATE")
        print("================================================================================")
        print(f"[INFO] Analyzed {len(raw_json.get('services', {}))} services and {len(raw_json.get('networks', {}))} networks.")
        for svc_name, svc in sorted(raw_json.get("services", {}).items()):
            nets = sorted(svc.get("networks", {}).keys())
            ports = [
                f"{p.get('host_ip', '')}:{p.get('published')}->{p.get('target')}" if p.get('host_ip') else f"{p.get('published')}->{p.get('target')}"
                for p in svc.get("ports", [])
            ]
            ports_str = ", ".join(ports) if ports else "NO_HOST_PORTS (isolated)"
            print(f"  - {svc_name:12}: networks={nets} | ports={ports_str}")

        if errors:
            print("\n[FAIL] TOPOLOGY VIOLATIONS DETECTED:")
            for e in errors:
                print(f"  [ERROR] {e}")
            print("================================================================================")
            sys.exit(1)

        print("\n[PASS] TOPOLOGY VERIFICATION PASSED: All 3-network exact-set, 6-service exact-set, port-binding, and supply chain invariants verified.")
        print("================================================================================")


if __name__ == "__main__":
    main()
