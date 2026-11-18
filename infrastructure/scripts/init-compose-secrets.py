#!/usr/bin/env python3
"""Initialize private credentials together, preserving existing deployments on rerun."""
import os
import secrets
import tempfile
from pathlib import Path

root = Path(__file__).resolve().parents[2] / "secrets"
target = root / "compose"
root.mkdir(mode=0o700, exist_ok=True)

admin, api, cache = (secrets.token_hex(32) for _ in range(3))
files = {
    "db_admin_password": admin,
    "db_api_password": api,
    "migration_url": f"postgresql://messaging_owner:{admin}@db:5432/messaging",
    "database_url": f"postgresql://messaging_api:{api}@db:5432/messaging?connection_limit=4",
    "redis_url": f"redis://default:{cache}@cache:6379/0",
    "redis_config": f'requirepass {cache}\nsave ""\nappendonly no\nmaxmemory 64mb\nmaxmemory-policy noeviction',
}

if target.exists():
    if not target.is_dir() or not all((target / name).is_file() and (target / name).stat().st_size for name in files):
        raise SystemExit("Incomplete secret directory. Restore the matching credentials before starting.")
    print("Using existing Compose credentials.")
else:
    with tempfile.TemporaryDirectory(dir=root) as stage:
        ready = Path(stage) / "compose"
        ready.mkdir(mode=0o700)
        for name, value in files.items():
            path = ready / name
            path.write_text(value + "\n", encoding="ascii")
            # The enclosing 0700 directory protects host access. Individual
            # read-only bind mounts must also work for postgres, redis and node UIDs.
            path.chmod(0o444)
        os.rename(ready, target)
    print("Created private Compose credentials.")
