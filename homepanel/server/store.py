"""Persistent state for HomePanel Studio: tablets, designs, uploaded assets. Plain JSON files, no database.

Layout under the data directory:
    tablets.json          every tablet that has ever said hello
    designs/<id>.json     one design per file: {"id", "name", "version", "design": {...}}
    assets/<file>         uploaded images
"""
from __future__ import annotations

import json
import re
import secrets
import time
from pathlib import Path

SAFE_NAME = re.compile(r"[^A-Za-z0-9._-]+")


class Store:
    def __init__(self, data_dir: Path):
        self.dir = Path(data_dir)
        self.designs_dir = self.dir / "designs"
        self.assets_dir = self.dir / "assets"
        for d in (self.dir, self.designs_dir, self.assets_dir):
            d.mkdir(parents=True, exist_ok=True)
        self._tablets_file = self.dir / "tablets.json"
        self.tablets: dict[str, dict] = self._read(self._tablets_file, {})

    # ---- files ----
    @staticmethod
    def _read(path: Path, default):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return default

    @staticmethod
    def _write(path: Path, obj) -> None:
        # Write beside the target then swap, so a crash mid-write never leaves a half file.
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(obj, indent=1), encoding="utf-8")
        tmp.replace(path)

    def _save_tablets(self) -> None:
        self._write(self._tablets_file, self.tablets)

    # ---- tablets ----
    def hello(self, info: dict) -> dict:
        """A tablet announces itself. New ones wait as 'pending' until approved in the Studio."""
        tid = SAFE_NAME.sub("", str(info.get("id", "")))[:64]
        if not tid:
            raise ValueError("tablet id missing")
        t = self.tablets.get(tid)
        if t is None:
            t = {"id": tid, "name": info.get("name") or info.get("model") or "Tablet", "status": "pending",
                 "key": None, "design": None, "start_page": None}
            self.tablets[tid] = t
        for k in ("model", "width", "height", "scale"):
            if info.get(k) is not None:
                t[k] = info[k]
        if t.get("width") and t.get("height"):
            t["orientation"] = "landscape" if t["width"] >= t["height"] else "portrait"
        t["last_seen"] = int(time.time())
        self._save_tablets()
        return t

    def approve(self, tid: str) -> dict:
        t = self.tablets[tid]
        t["status"] = "approved"
        t["key"] = t.get("key") or secrets.token_urlsafe(32)
        self._save_tablets()
        return t

    def update_tablet(self, tid: str, changes: dict) -> dict:
        t = self.tablets[tid]
        for k in ("name", "design", "start_page"):
            if k in changes:
                t[k] = changes[k]
        self._save_tablets()
        return t

    def remove_tablet(self, tid: str) -> None:
        self.tablets.pop(tid, None)
        self._save_tablets()

    def tablet_by_key(self, key: str | None) -> dict | None:
        if not key:
            return None
        for t in self.tablets.values():
            if t.get("status") == "approved" and t.get("key") and secrets.compare_digest(t["key"], key):
                return t
        return None

    # ---- designs ----
    def _design_path(self, did: str) -> Path:
        return self.designs_dir / (SAFE_NAME.sub("", did) + ".json")

    def list_designs(self) -> list[dict]:
        out = []
        for p in sorted(self.designs_dir.glob("*.json")):
            d = self._read(p, None)
            if d:
                g = d["design"].get("grid", {})
                out.append({"id": d["id"], "name": d["name"], "version": d["version"],
                            "pages": len(d["design"].get("pages", [])), "cols": g.get("cols"), "rows": g.get("rows")})
        return out

    def get_design(self, did: str) -> dict | None:
        return self._read(self._design_path(did), None) if did else None

    def save_design(self, did: str | None, name: str, design: dict) -> dict:
        """Create (did None) or replace a design. Every save bumps the version so tablets know to reload."""
        if not isinstance(design, dict) or not isinstance(design.get("pages"), list) or "grid" not in design:
            raise ValueError("not a design: needs grid and pages")
        did = did or secrets.token_hex(4)
        old = self.get_design(did)
        rec = {"id": did, "name": name or (old or {}).get("name") or "Untitled",
               "version": (old["version"] + 1) if old else 1, "design": design}
        self._write(self._design_path(did), rec)
        return rec

    def duplicate_design(self, did: str, name: str | None = None) -> dict:
        src = self.get_design(did)
        if not src:
            raise KeyError(did)
        return self.save_design(None, name or src["name"] + " copy", json.loads(json.dumps(src["design"])))

    def delete_design(self, did: str) -> None:
        self._design_path(did).unlink(missing_ok=True)
        for t in self.tablets.values():
            if t.get("design") == did:
                t["design"] = None
        self._save_tablets()

    # ---- assets ----
    def save_asset(self, filename: str, data: bytes) -> str:
        name = SAFE_NAME.sub("-", Path(filename).name).strip("-.") or "image"
        (self.assets_dir / name).write_bytes(data)
        return name

    def list_assets(self) -> list[str]:
        return sorted(p.name for p in self.assets_dir.iterdir() if p.is_file())

    def delete_asset(self, name: str) -> None:
        (self.assets_dir / SAFE_NAME.sub("-", Path(name).name)).unlink(missing_ok=True)
