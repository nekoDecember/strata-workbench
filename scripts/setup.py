"""Idempotent local setup; never prints or overwrites credentials."""

import secrets
from pathlib import Path

root = Path(__file__).resolve().parents[1]
private = root / "secrets"
private.mkdir(exist_ok=True)
try:
    private.chmod(0o700)
except OSError:
    pass
for name in ("app_token.txt", "notebook_token.txt"):
    file = private / name
    if not file.exists():
        file.write_text(secrets.token_urlsafe(32) + "\n")
    # Compose file secrets preserve the source mode. A private parent directory
    # protects host access; 0444 permits the non-root container UID to read it.
    try:
        file.chmod(0o444)
    except OSError:
        pass
connections = private / "connections.json"
if not connections.exists():
    connections.write_text("{}\n")
try:
    connections.chmod(0o644)
except OSError:
    pass
env = root / ".env"
if not env.exists():
    env.write_text((root / ".env.example").read_text())
print("Setup ready. Existing settings and tokens were preserved.")
print("Start: docker compose up --build -d")
print("Open:  http://localhost:8080")
print("Login token: secrets/app_token.txt (open this file locally)")
