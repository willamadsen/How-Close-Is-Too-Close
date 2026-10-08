"""
build_tle_library.py

WORK IN PROGRESS: this is a working copy that is changing often. Expect unfinished features and breaking changes.

Turns raw TLE text files into tidy files the website can read.

  INPUT   Data/<source name>/*.txt   Raw TLE files. The folder name is recorded as
                                     the data source, e.g. Data/space-track/ or Data/seesat/.
          Code/satcat_local.csv      Satellite catalog: NORAD number -> name, international
                                     designator, country. Uses the same columns as
                                     Space-Track's SATCAT, so a full SATCAT download can
                                     replace it later.

  OUTPUT  Viz/data/tles/<NORAD>.json One file per satellite: all of its TLEs, sorted by date.
          Viz/data/tles/index.json   The list of satellites the website can show.

Along the way it checks each TLE and reports problems (bad checksums, duplicates,
TLEs whose international designator doesn't match the catalog, and so on).

Run it from the project folder:
    python Code/build_tle_library.py
"""

import csv
import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

# Folder locations, worked out relative to this script so it runs from anywhere.
PROJECT = Path(__file__).resolve().parent.parent
RAW_DIR = PROJECT / "Data"
CATALOG_FILE = PROJECT / "Code" / "satcat_local.csv"
OUT_DIR = PROJECT / "Viz" / "data" / "tles"


def tle_checksum_ok(line):
    """TLE lines end in a checksum digit: add up every digit on the line
    (a minus sign counts as 1), and the last digit of that total must match."""
    if len(line) < 69 or not line[68].isdigit():
        return False
    total = 0
    for char in line[:68]:
        if char.isdigit():
            total += int(char)
        elif char == "-":
            total += 1
    return total % 10 == int(line[68])


def tle_epoch(line1):
    """Read the epoch (the moment the TLE describes) from columns 19-32 of line 1.
    Format is YYDDD.DDDDDDDD: a 2-digit year, then the day of the year with a fraction."""
    year = int(line1[18:20])
    year += 2000 if year < 57 else 1900          # TLEs started in 1957
    day_of_year = float(line1[20:32])
    return datetime(year, 1, 1, tzinfo=timezone.utc) + timedelta(days=day_of_year - 1)


def short_to_full_intldes(short):
    """'19079D' (as written inside a TLE) -> '2019-079D' (as written in the catalog)."""
    short = short.strip()
    if len(short) < 5:
        return short
    year = int(short[:2])
    year += 2000 if year < 57 else 1900
    return f"{year}-{short[2:5]}{short[5:]}"


def read_catalog():
    """Load the satellite catalog into a dictionary keyed by NORAD number."""
    catalog = {}
    with open(CATALOG_FILE, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            catalog[row["NORAD_CAT_ID"].zfill(5)] = row
    return catalog


def read_raw_tles():
    """Find every pair of lines that looks like a TLE ('1 NNNNN...' followed by
    '2 NNNNN...') in every .txt file under Data/. Anything else in the files
    (headers, web-page text) is ignored."""
    found = []
    for path in sorted(RAW_DIR.glob("*/*.txt")):
        source = path.parent.name                 # e.g. "space-track"
        lines = [l.rstrip() for l in path.read_text(encoding="utf-8", errors="replace").splitlines()]
        for i in range(len(lines) - 1):
            line1, line2 = lines[i], lines[i + 1]
            if (line1.startswith("1 ") and line2.startswith("2 ")
                    and len(line1) >= 64 and len(line2) >= 63
                    and line1[2:7] == line2[2:7]):
                found.append({"source": source, "file": path.name, "line1": line1, "line2": line2})
    return found


def main():
    catalog = read_catalog()
    raw = read_raw_tles()
    print(f"Found {len(raw)} TLEs in {RAW_DIR}")

    # Group the TLEs by satellite (NORAD number), dropping exact duplicates
    # and keeping only the first TLE for any given epoch.
    satellites = {}
    for tle in raw:
        norad = tle["line1"][2:7].strip().zfill(5)
        sat = satellites.setdefault(norad, {"tles": {}, "warnings": [], "duplicates": 0,
                                            "conflicts": 0, "bad_checksums": 0, "intldes_seen": {}})
        epoch = tle_epoch(tle["line1"])
        key = epoch.isoformat()
        if key in sat["tles"]:
            # .split() breaks a line into words, so lines that differ only in spacing count as the same.
            same = sat["tles"][key]["line2"].split() == tle["line2"].split()
            sat["duplicates" if same else "conflicts"] += 1
            continue
        if not (tle_checksum_ok(tle["line1"]) and tle_checksum_ok(tle["line2"])):
            sat["bad_checksums"] += 1
        intldes = short_to_full_intldes(tle["line1"][9:17])
        sat["intldes_seen"][intldes] = sat["intldes_seen"].get(intldes, 0) + 1
        sat["tles"][key] = {
            "epoch": epoch.strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
            "source": tle["source"],
            "line1": tle["line1"],
            "line2": tle["line2"],
        }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    index = []
    for norad, sat in sorted(satellites.items()):
        tles = sorted(sat["tles"].values(), key=lambda t: t["epoch"])
        entry = catalog.get(norad)

        # Check that the TLEs really belong to the satellite the catalog says they do.
        warnings = []
        if entry is None:
            warnings.append(f"NORAD {norad} is not in the local catalog, so its name is unknown.")
        else:
            for intldes, count in sat["intldes_seen"].items():
                if intldes != entry["INTLDES"]:
                    warnings.append(f"{count} TLE(s) list international designator {intldes}, "
                                    f"but the catalog says {entry['INTLDES']}.")
        if sat["bad_checksums"]:
            warnings.append(f"{sat['bad_checksums']} TLE(s) have an invalid checksum (common for amateur-observer TLEs).")
        if sat["conflicts"]:
            warnings.append(f"{sat['conflicts']} TLE(s) shared an epoch with a different TLE and were skipped.")

        name = entry["OBJECT_NAME"] if entry else f"Unknown object {norad}"
        sources = sorted({t["source"] for t in tles})

        (OUT_DIR / f"{norad}.json").write_text(json.dumps({"norad": norad, "tles": tles}), encoding="utf-8")
        index.append({
            "norad": norad,
            "name": name,
            "intlDes": entry["INTLDES"] if entry else None,
            "country": entry["COUNTRY"] if entry else None,
            "tleCount": len(tles),
            "firstEpoch": tles[0]["epoch"],
            "lastEpoch": tles[-1]["epoch"],
            "sources": sources,
            "warnings": warnings,
        })

        # Report to the terminal
        print(f"\n{name} (NORAD {norad})")
        print(f"  {len(tles)} TLEs from {', '.join(sources)}: {tles[0]['epoch'][:10]} to {tles[-1]['epoch'][:10]}"
              f"  ({sat['duplicates']} exact duplicates removed)")
        for w in warnings:
            print(f"  WARNING: {w}")

    generated = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    (OUT_DIR / "index.json").write_text(json.dumps({"generated": generated, "satellites": index}, indent=2), encoding="utf-8")
    print(f"\nWrote {len(index)} satellites to {OUT_DIR}")


if __name__ == "__main__":
    main()
