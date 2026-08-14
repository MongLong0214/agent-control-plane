#!/usr/bin/env python3
"""CONNECT-only allowlist proxy: tunnels allowed hosts, records every request as JSONL.

Usage: python3 allowlist-proxy.py <port> <allowlist-file> <log-file>

Vendored from the owner's ~/.agent-control-plane/egress/ implementation, which was built and
proved for #419. It is shipped here because `reviewer-egress.ts` requires a specific handshake
of whatever proxy it launches, and an out-of-tree script cannot be held to a contract it never
sees. The original emitted a START record without `allowlistDigest`, so every reviewer refused
REVIEWER_EGRESS_ALLOWLIST_UNBOUND — a one-field mismatch that read as a failing boundary.

The digest binds the proxy to the exact allowlist it was handed. ACP generates one allowlist
per invocation and compares sha256 of that file against what the proxy attests, so a proxy
enforcing a different or stale list cannot pass as the one that was asked for."""
import hashlib, socket, threading, sys, json, time, os

PORT = int(sys.argv[1]); ALLOW = sys.argv[2]; LOG = sys.argv[3]

def allowed_hosts():
    with open(ALLOW) as f:
        return {l.strip().lower() for l in f if l.strip() and not l.startswith("#")}

def log(ev):
    with open(LOG, "a") as f:
        f.write(json.dumps(ev, ensure_ascii=False) + "\n")

def pipe(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    finally:
        for s in (a, b):
            try: s.shutdown(socket.SHUT_RDWR)
            except OSError: pass

def handle(c, addr):
    try:
        c.settimeout(15)
        head = b""
        while b"\r\n\r\n" not in head:
            chunk = c.recv(4096)
            if not chunk: return
            head += chunk
        line = head.split(b"\r\n", 1)[0].decode("latin1")
        method, target = line.split()[0], line.split()[1]
        if method != "CONNECT":
            log({"t": time.time(), "verdict": "DENY_METHOD", "line": line[:120]})
            c.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n"); return
        host, _, port = target.rpartition(":")
        hl = host.lower()
        allow = allowed_hosts()
        ok = hl in allow or any(hl.endswith("." + a) for a in allow)
        if not ok or port != "443":
            log({"t": time.time(), "verdict": "DENY", "host": host, "port": port})
            c.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n"); return
        up = socket.create_connection((host, int(port)), timeout=15)
        log({"t": time.time(), "verdict": "ALLOW", "host": host, "port": port})
        c.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        c.settimeout(None); up.settimeout(None)
        t = threading.Thread(target=pipe, args=(up, c), daemon=True); t.start()
        pipe(c, up)
    except Exception as e:
        log({"t": time.time(), "verdict": "ERROR", "error": str(e)[:120]})
    finally:
        try: c.close()
        except OSError: pass

srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(("127.0.0.1", PORT)); srv.listen(64)
# Digest the allowlist as handed to us, so the attestation names the file actually enforced
# rather than the path it arrived on.
with open(ALLOW, "rb") as _f:
    ALLOWLIST_DIGEST = "sha256:" + hashlib.sha256(_f.read()).hexdigest()

log({
    "t": time.time(),
    "verdict": "START",
    "port": PORT,
    "pid": os.getpid(),
    "allowlistDigest": ALLOWLIST_DIGEST,
})
while True:
    conn, addr = srv.accept()
    threading.Thread(target=handle, args=(conn, addr), daemon=True).start()
