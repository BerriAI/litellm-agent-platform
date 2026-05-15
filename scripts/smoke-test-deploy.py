#!/usr/bin/env python3
"""
Post-deploy smoke test. Run after kubectl rollout status succeeds.

Required env vars:
  MASTER_KEY   Platform master key (GitHub Actions secret).
  ALB_URL      Base URL of the platform ALB, e.g. http://abc.us-east-1.elb.amazonaws.com
               (GitHub Actions variable: vars.ALB_URL).

Exit 0 on pass, 1 on failure.
"""
import os
import socket
import ssl
import sys
import urllib.request

MASTER_KEY = os.environ["MASTER_KEY"]
ALB_URL = os.environ["ALB_URL"].rstrip("/")

# Derive host and port from ALB_URL (http or https).
if ALB_URL.startswith("https://"):
    host = ALB_URL[len("https://"):]
    port = 443
else:
    host = ALB_URL[len("http://"):]
    port = 80
if ":" in host:
    host, port_str = host.rsplit(":", 1)
    port = int(port_str)

failures = []


def check(label: str, ok: bool, detail: str = "") -> None:
    status = "✓" if ok else "✗"
    print(f"{status} {label}" + (f": {detail}" if detail else ""))
    if not ok:
        failures.append(label)


# ── 1. Platform health + auth (Authorization header, never in URL) ────────────
# This also implicitly proves that a valid token is accepted — if MASTER_KEY
# were wrong or the platform were rejecting auth, this returns 401/403, not 200.
try:
    req = urllib.request.Request(
        f"{ALB_URL}/api/v1/health/k8s",
        headers={"Authorization": f"Bearer {MASTER_KEY}"},
    )
    with urllib.request.urlopen(req, timeout=10) as resp:
        code = resp.getcode()
    check("GET /api/v1/health/k8s → 200", code == 200, f"got {code}")
except Exception as e:
    check("GET /api/v1/health/k8s → 200", False, str(e))


# ── 2. TTY proxy rejects invalid token with 401 ───────────────────────────────
# Only the wrong-token case uses a query param — a throwaway value, no secret
# in the URL. The valid-token path is already covered by the health check above.
FAKE_SESSION = "00000000-0000-0000-0000-000000000000"


def tty_ws_status(token: str) -> str:
    """Send a WebSocket upgrade to the TTY proxy; return the HTTP status line."""
    raw = socket.socket()
    raw.settimeout(10)
    try:
        raw.connect((host, port))
        s = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if port == 443 else raw
        path = f"/api/v1/managed_agents/sessions/{FAKE_SESSION}/tty?token={token}"
        req = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            f"Upgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n"
        )
        s.sendall(req.encode())
        return s.recv(256).decode(errors="replace").split("\r\n")[0]
    finally:
        raw.close()


try:
    r = tty_ws_status("intentionally-wrong-token-xyzzy")
    check("TTY bad token → 401", "401" in r, r)
except Exception as e:
    check("TTY bad token → 401", False, str(e))


# ── Result ────────────────────────────────────────────────────────────────────
if failures:
    print(f"\nFAILED: {failures}", file=sys.stderr)
    sys.exit(1)

print("\nAll smoke tests passed.")
