"""
build_public_tle_library.py

WORK IN PROGRESS: this is a working copy that is changing often. Expect unfinished features and breaking changes.

Makes a trimmed copy of the TLE library that is small enough to publish on the website.

  INPUT   Viz/data/tles/            The full TLE library (made by build_tle_library.py).
                                    It stays on your computer and is never published.
  OUTPUT  Viz/data/tles_public/     The trimmed copy:
                                      - every TLE that is NOT from Space-Track
                                        (e.g. USA 245's SeeSat-L amateur TLEs), and
                                      - Space-Track TLEs only inside the KEY_EVENTS windows below.

Why: Space-Track's user agreement limits passing its data on in bulk, so only the
TLEs needed for the key events (the approaches listed in Viz/TESTING.md) are kept.
Check with your advisor before publishing this folder.

Run it from the project folder, after build_tle_library.py:
    python Code/build_public_tle_library.py
"""

import json
from datetime import datetime, timezone
from pathlib import Path

# Folder locations, worked out relative to this script so it runs from anywhere.
PROJECT = Path(__file__).resolve().parent.parent
FULL_DIR = PROJECT / "Viz" / "data" / "tles"
PUBLIC_DIR = PROJECT / "Viz" / "data" / "tles_public"

# The key events: Space-Track TLEs are kept only inside these date windows (UTC, inclusive).
# These match the approaches listed in Viz/TESTING.md.
KEY_EVENTS = [
    ("2019-12-06", "2019-12-16", "Kosmos 2543 separates from Kosmos 2542"),
    ("2019-12-31", "2020-01-05", "Early-January 2020 approach to USA 245"),
    ("2020-01-20", "2020-01-30", "Late-January 2020 approach to USA 245"),
]

# TLEs from these sources are only published inside the KEY_EVENTS windows.
RESTRICTED_SOURCES = {"space-track"}


def parse_time(text):
    """'2019-12-08T10:03:52.617600Z' -> a datetime (in UTC)."""
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def in_key_event(epoch):
    """True if this epoch falls inside one of the KEY_EVENTS windows."""
    for start, end, _ in KEY_EVENTS:
        first = parse_time(start + "T00:00:00Z")
        last = parse_time(end + "T23:59:59Z")
        if first <= epoch <= last:
            return True
    return False


def main():
    full_index = json.loads((FULL_DIR / "index.json").read_text(encoding="utf-8"))
    PUBLIC_DIR.mkdir(parents=True, exist_ok=True)

    public_index = []
    for sat in full_index["satellites"]:
        norad = sat["norad"]
        tles = json.loads((FULL_DIR / f"{norad}.json").read_text(encoding="utf-8"))["tles"]

        # Keep every TLE from an unrestricted source, and restricted ones only during key events
        kept = [t for t in tles
                if t["source"] not in RESTRICTED_SOURCES or in_key_event(parse_time(t["epoch"]))]
        print(f"{sat['name']} (NORAD {norad}): kept {len(kept)} of {len(tles)} TLEs")
        if not kept:
            continue

        (PUBLIC_DIR / f"{norad}.json").write_text(json.dumps({"norad": norad, "tles": kept}), encoding="utf-8")

        # Same index entry as the full library, but with the trimmed counts and dates
        entry = dict(sat)
        entry["tleCount"] = len(kept)
        entry["firstEpoch"] = kept[0]["epoch"]
        entry["lastEpoch"] = kept[-1]["epoch"]
        if len(kept) < len(tles):
            entry["warnings"] = sat["warnings"] + [
                "Public subset: only TLEs around the key events are included "
                "(the full Space-Track history is not published)."]
        public_index.append(entry)

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    key_events = [{"start": s, "end": e, "description": d} for s, e, d in KEY_EVENTS]
    (PUBLIC_DIR / "index.json").write_text(
        json.dumps({"generated": generated, "publicSubset": True, "keyEvents": key_events,
                    "satellites": public_index}, indent=2),
        encoding="utf-8")
    print(f"\nWrote {len(public_index)} satellites to {PUBLIC_DIR}")


if __name__ == "__main__":
    main()
