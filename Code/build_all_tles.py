"""
build_all_tles.py
============================
Reads TLE source data and writes a combined CSV for the given study period.

Supports TWO input modes (set INPUT_MODE below):

  "zip"  — original bulk format: a .zip archive containing one tleYYYY.txt
           per year (e.g. Space-Track GP_HISTORY yearly dumps).

  "txt"  — one or more raw, free-form .txt files where TLE line-pairs are
           embedded anywhere in arbitrary text (headers, comments, mailing-
           list quoting, message bodies, etc). tle_parser.parse_chunk()
           scans line-by-line and only keeps lines that look like a valid,
           catalog-number-matched TLE pair — everything else (including
           duplicate/reposted TLEs) is handled automatically. Use this mode
           for things like SeeSat-L / mailing-list archive exports, single
           satellites, or any TLE text that isn't already zipped by year.

Both modes write the exact same output format, so allTLEs2OEsandLLAs.py
does not need to change.

Output
------
  all_tles_all_orbits.csv.gz  (satnum, epoch_jd, epoch_dt,
                                tle_line1, tle_line2,
                                inclination_deg, mean_motion_revday)
"""

import gc
import os
import sys
import glob
import zipfile

import numpy as np
import pandas as pd

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, SCRIPT_DIR)
from tle_parser import parse_chunk

DATA_DIR = os.path.join(SCRIPT_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# ---------------------------------------------------------------------------
# CONFIGURE INPUT HERE
# ---------------------------------------------------------------------------
# Choose "zip" for the original per-year zip archive, or "txt" for one or
# more raw/free-form .txt files (TLEs embedded anywhere in the text).
INPUT_MODE = "txt"   # "zip" or "txt"

# --- "zip" mode settings (only used when INPUT_MODE == "zip") ---
# Edit this to point at your own TLE archive.
# Expected contents inside zip: tleYYYY.txt for each year in YEARS below
tles_zip = "./alltles.zip"
YEARS       = list(range(2010, 2026))  # default for 2010 through 2025 study period

# --- "txt" mode settings (only used when INPUT_MODE == "txt") ---
# One or more raw text files. Relative paths resolve against this script's
# folder. Glob patterns are also accepted (e.g. "./data/raw/*.txt").
txt_inputs = ["./usa245_tles.txt", "./cosmos_2542_2543_tles.txt"]

# ---------------------------------------------------------------------------

ZIP_PATH = tles_zip if os.path.isabs(tles_zip) else os.path.join(SCRIPT_DIR, tles_zip)
OUT_CSV  = os.path.join(DATA_DIR, "all_tles_all_orbits.csv.gz")
TEMP_DIR = DATA_DIR  # temp per-source files written here, cleaned up after

CHUNK_LINES = 200_000  # TLE line pairs per batch (~100k pairs)

J2000 = pd.Timestamp("2000-01-01 12:00:00", tz="UTC")


def finalize_df(all_records):
    """Turn a list of parsed TLE record dicts into the standard output DataFrame."""
    if not all_records:
        return pd.DataFrame()

    df = pd.DataFrame(all_records)

    # Drop exact duplicate TLEs (common in mailing-list/forum sources where
    # the same post gets quoted or cross-posted multiple times).
    before = len(df)
    df = df.drop_duplicates(subset=["satnum", "epoch_jd", "tle_line1", "tle_line2"])
    n_dropped = before - len(df)
    if n_dropped:
        print(f"  Dropped {n_dropped:,} exact-duplicate TLE(s)", flush=True)

    # Convert inclination rad -> deg, mean motion rad/min -> rev/day
    df["inclination_deg"]    = np.degrees(df["inclination"])
    df["mean_motion_revday"] = df["mean_motion"] * (60.0 * 24.0) / (2.0 * np.pi)

    # Epoch as UTC datetime
    df["epoch_dt"] = J2000 + pd.to_timedelta(df["epoch_jd"] - 2451545.0, unit="D")

    cols = ["satnum", "epoch_jd", "epoch_dt",
            "tle_line1", "tle_line2",
            "inclination_deg", "mean_motion_revday"]
    df = df[cols].sort_values(["satnum", "epoch_jd"]).reset_index(drop=True)

    return df


def parse_lines_in_batches(lines):
    """Parse a list of text lines in CHUNK_LINES-pair batches, return a list of records."""
    all_records = []
    for i in range(0, len(lines), CHUNK_LINES * 2):
        chunk = lines[i: i + CHUNK_LINES * 2]
        all_records.extend(parse_chunk(chunk))
        del chunk
    return all_records


def run_zip_mode():
    if not os.path.exists(ZIP_PATH):
        raise FileNotFoundError(f"Cannot find zip archive at:\n  {ZIP_PATH}")

    print(f"Opening {ZIP_PATH} ...")
    temp_files = []

    with zipfile.ZipFile(ZIP_PATH, "r") as zf:
        names = zf.namelist()
        print(f"  {len(names)} file(s) inside zip")

        for year in YEARS:
            matched = None
            for candidate in [
                f"tle{year}.txt",
                f"allOGtles/tle{year}.txt",
                f"TLEs/tle{year}.txt",
            ]:
                if candidate in names:
                    matched = candidate
                    break
            if matched is None:
                for n in names:
                    if str(year) in n and n.endswith(".txt"):
                        matched = n
                        break
            if matched is None:
                print(f"  {year}: no matching file in zip — skipping")
                continue

            print(f"\n[{year}] Reading {matched} ...", flush=True)

            raw = zf.read(matched).decode("latin1", errors="replace")
            lines = raw.splitlines()
            del raw
            gc.collect()

            n_lines = len(lines)
            print(f"  {n_lines:,} lines", flush=True)

            records = parse_lines_in_batches(lines)
            del lines
            gc.collect()

            df_yr = finalize_df(records)
            del records
            gc.collect()

            if df_yr.empty:
                print(f"  WARNING: no records parsed for {year}")
                continue

            print(f"  {len(df_yr):,} records, "
                  f"{df_yr['satnum'].nunique():,} unique satellites", flush=True)

            temp_path = os.path.join(TEMP_DIR, f"_tmp_tles_{year}.csv.gz")
            df_yr.to_csv(temp_path, index=False, compression="gzip")
            temp_files.append(temp_path)
            del df_yr
            gc.collect()
            print(f"  Saved temp -> {os.path.basename(temp_path)}", flush=True)

    return temp_files


def run_txt_mode():
    # Expand globs / relative paths
    resolved_paths = []
    for pattern in txt_inputs:
        p = pattern if os.path.isabs(pattern) else os.path.join(SCRIPT_DIR, pattern)
        matches = sorted(glob.glob(p))
        if not matches:
            print(f"  WARNING: no files matched {pattern}")
        resolved_paths.extend(matches)

    if not resolved_paths:
        raise FileNotFoundError(
            "No input .txt files found. Check the 'txt_inputs' list at the top of this script."
        )

    temp_files = []
    for idx, path in enumerate(resolved_paths):
        print(f"\n[{idx + 1}/{len(resolved_paths)}] Reading {os.path.basename(path)} ...",
              flush=True)

        with open(path, "r", encoding="latin1", errors="replace") as f:
            raw = f.read()
        lines = raw.splitlines()
        del raw
        gc.collect()

        n_lines = len(lines)
        print(f"  {n_lines:,} lines", flush=True)

        records = parse_lines_in_batches(lines)
        del lines
        gc.collect()

        df_src = finalize_df(records)
        del records
        gc.collect()

        if df_src.empty:
            print(f"  WARNING: no valid TLE pairs found in {os.path.basename(path)}")
            continue

        print(f"  {len(df_src):,} records, "
              f"{df_src['satnum'].nunique():,} unique satellites, "
              f"epochs {df_src['epoch_dt'].min()} -> {df_src['epoch_dt'].max()}",
              flush=True)

        temp_path = os.path.join(TEMP_DIR, f"_tmp_tles_src{idx:03d}.csv.gz")
        df_src.to_csv(temp_path, index=False, compression="gzip")
        temp_files.append(temp_path)
        del df_src
        gc.collect()
        print(f"  Saved temp -> {os.path.basename(temp_path)}", flush=True)

    return temp_files


# Main
if __name__ == "__main__":
    if INPUT_MODE == "zip":
        temp_files = run_zip_mode()
    elif INPUT_MODE == "txt":
        temp_files = run_txt_mode()
    else:
        raise ValueError(f"Unknown INPUT_MODE: {INPUT_MODE!r} (use 'zip' or 'txt')")

    if not temp_files:
        print("No data parsed. Check input source(s).")
        sys.exit(1)

    # Concatenate all temp files into final output, then de-dupe across
    # sources too (e.g. the same TLE appearing in two different input files).
    print(f"\nConcatenating {len(temp_files)} source file(s) ...", flush=True)

    parts = []
    for tp in sorted(temp_files):
        df_part = pd.read_csv(tp)
        parts.append(df_part)
        print(f"  loaded {os.path.basename(tp)}: {len(df_part):,} rows", flush=True)

    df_all = pd.concat(parts, ignore_index=True)
    del parts
    gc.collect()

    before = len(df_all)
    df_all = df_all.drop_duplicates(subset=["satnum", "epoch_jd", "tle_line1", "tle_line2"])
    df_all = df_all.sort_values(["satnum", "epoch_jd"]).reset_index(drop=True)
    n_dropped = before - len(df_all)
    if n_dropped:
        print(f"  Dropped {n_dropped:,} cross-source duplicate TLE(s)", flush=True)

    df_all.to_csv(OUT_CSV, index=False, compression="gzip")
    total_rows = len(df_all)

    # Clean up temp files
    for tp in temp_files:
        os.remove(tp)

    print(f"\nDone. Total rows written: {total_rows:,}")
    print(f"Output: {OUT_CSV}")
