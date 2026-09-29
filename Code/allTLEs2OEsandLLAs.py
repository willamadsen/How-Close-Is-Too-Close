import numpy as np
import pandas as pd
import datetime
import gzip
import csv
import os
import time
from skyfield.api import load, EarthSatellite, wgs84

# Paths
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR   = os.path.join(SCRIPT_DIR, "data")
os.makedirs(DATA_DIR, exist_ok=True)

# Path to combined TLE CSV to read (build_all_tles.py's output)
tles_input = "./data/all_tles_all_orbits.csv.gz"

TLE_INPUT = tles_input if os.path.isabs(tles_input) else os.path.join(SCRIPT_DIR, tles_input)

# Constants
MU_EARTH          = 3.986004418e14
TLE_COVERAGE_DAYS = 14
OUTFILE           = os.path.join(DATA_DIR, "OEs_and_LLAs_all.csv.gz")
HEADER = [
    "satnum", "Time_step", "tle_epoch", "eccentricity", "semimajor_m",
    "inclination_deg", "RAAN_deg", "argperi_deg", "meananomaly_deg",
    "trueanomaly_deg", "latitude_deg", "longitude_deg", "altitude_m",
    "x_km", "y_km", "z_km"
]
# x_km/y_km/z_km are the satellite's position in an Earth-CENTERED INERTIAL
# frame (Skyfield's GCRS, effectively J2000) — NOT Earth-fixed like lat/lon.
# Use these three columns (not lat/lon/alt) for plotting true 3D orbit
# shapes/ground tracks in a non-rotating frame, and for computing straight-
# line distance between two satellites at the same timestamp.
JD_UNIX_EPOCH = 2440587.5

def dt_to_jd(dt: datetime.datetime) -> float:
    return JD_UNIX_EPOCH + dt.timestamp() / 86400.0

def process_satellite_single(satnum, epochs_jd, tle_lines1, tle_lines2,
                             timesteps_jd, ts, writer):
    """Propagate one satellite and write rows to an open gzip CSV writer."""
    if len(epochs_jd) == 0:
        return 0

    epochs_sorted = np.sort(epochs_jd)
    sort_order    = np.argsort(epochs_jd)
    ins           = np.searchsorted(epochs_sorted, timesteps_jd)
    ins           = np.clip(ins, 1, len(epochs_sorted) - 1)
    pick_right    = (np.abs(timesteps_jd - epochs_sorted[ins])
                     < np.abs(timesteps_jd - epochs_sorted[ins - 1]))
    nearest_idx   = sort_order[np.where(pick_right, ins, ins - 1)]
    nearest_age   = np.abs(timesteps_jd - epochs_jd[nearest_idx])

    valid_mask = nearest_age <= TLE_COVERAGE_DAYS
    if not valid_mask.any():
        return 0

    valid_t_jd = timesteps_jd[valid_mask]
    valid_tidx = nearest_idx[valid_mask]
    unique_indices = np.unique(valid_tidx)

    sat_cache = {}
    for idx in unique_indices:
        try:
            sat_cache[idx] = EarthSatellite(
                tle_lines1[idx], tle_lines2[idx], str(satnum), ts)
        except Exception:
            pass

    n = len(valid_t_jd)
    out_lats  = np.full(n, np.nan)
    out_lons  = np.full(n, np.nan)
    out_alts  = np.full(n, np.nan)
    out_sma   = np.full(n, np.nan)
    out_ecc   = np.full(n, np.nan)
    out_inc   = np.full(n, np.nan)
    out_raan  = np.full(n, np.nan)
    out_argp  = np.full(n, np.nan)
    out_M     = np.full(n, np.nan)
    out_ta    = np.full(n, np.nan)
    out_epoch = np.empty(n, dtype=object)
    out_x     = np.full(n, np.nan)
    out_y     = np.full(n, np.nan)
    out_z     = np.full(n, np.nan)

    for idx in unique_indices:
        if idx not in sat_cache:
            continue
        sat  = sat_cache[idx]
        mask = (valid_tidx == idx)
        m     = sat.model
        e_cc  = m.ecco
        M_rad = m.mo
        M_deg = np.degrees(M_rad)
        epoch_str = sat.epoch.utc_datetime().isoformat()

        geo = sat.at(ts.tt_jd(valid_t_jd[mask]))
        lats_sf, lons_sf = wgs84.latlon_of(geo)
        r_km = geo.position.km  # Earth-centered INERTIAL (GCRS) frame
        v_km = geo.velocity.km_per_s
        rmag = np.linalg.norm(r_km, axis=0) * 1000
        vmag = np.linalg.norm(v_km, axis=0) * 1000

        out_lats[mask]  = lats_sf.degrees
        out_lons[mask]  = lons_sf.degrees
        out_alts[mask]  = wgs84.height_of(geo).m
        out_sma[mask]   = 1.0 / (2.0/rmag - vmag**2/MU_EARTH)
        out_ecc[mask]   = e_cc
        out_inc[mask]   = np.degrees(m.inclo)
        out_raan[mask]  = np.degrees(m.nodeo)
        out_argp[mask]  = np.degrees(m.argpo)
        out_M[mask]     = M_deg
        out_ta[mask]    = (M_deg + (2*e_cc - 0.25*e_cc**3) * np.sin(M_rad)) % 360
        out_epoch[mask] = epoch_str
        out_x[mask]     = r_km[0]
        out_y[mask]     = r_km[1]
        out_z[mask]     = r_km[2]

    unix_secs = (valid_t_jd - JD_UNIX_EPOCH) * 86400.0
    rows_written = 0
    for j in range(n):
        if np.isnan(out_sma[j]):
            continue
        writer.writerow([
            satnum,
            datetime.datetime.fromtimestamp(unix_secs[j], tz=datetime.timezone.utc).isoformat(),
            out_epoch[j], out_ecc[j], out_sma[j], out_inc[j], out_raan[j],
            out_argp[j], out_M[j], out_ta[j],
            out_lats[j], out_lons[j], out_alts[j],
            out_x[j], out_y[j], out_z[j],
        ])
        rows_written += 1
    return rows_written

# kept for compatibility but not currently used
def process_satellite(args):
    """
    Propagate one satellite over the shared time grid and write results
    directly to a partial CSV file.  Returns the file path
    """
    satnum, tle_file, timesteps_jd, tmp_dir = args
    print(f"  [worker] starting satnum {satnum}", flush=True)

    ts_w = load.timescale(builtin=True)
    print(f"  [worker] timescale loaded for {satnum}", flush=True)

    # Read this satellite's TLE data from its small per-satellite file.
    sat_df    = pd.read_csv(tle_file)
    epochs_jd = sat_df["epoch_jd"].to_numpy()
    tle_lines1 = sat_df["tle_line1"].tolist()
    tle_lines2 = sat_df["tle_line2"].tolist()
    del sat_df

    if len(epochs_jd) == 0:
        return None

    sat_cache = {}

    print(f"  [worker] starting searchsorted for {satnum} ({len(epochs_jd)} epochs)", flush=True)
    epochs_jd_sorted = np.sort(epochs_jd)
    sort_order       = np.argsort(epochs_jd)
    ins = np.searchsorted(epochs_jd_sorted, timesteps_jd)
    ins = np.clip(ins, 1, len(epochs_jd_sorted) - 1)
    left_idx   = ins - 1
    right_idx  = ins
    pick_right = (np.abs(timesteps_jd - epochs_jd_sorted[right_idx])
                  < np.abs(timesteps_jd - epochs_jd_sorted[left_idx]))
    sorted_nearest = np.where(pick_right, right_idx, left_idx)
    nearest_idx    = sort_order[sorted_nearest]
    nearest_age    = np.abs(timesteps_jd - epochs_jd[nearest_idx])
    valid_mask = nearest_age <= TLE_COVERAGE_DAYS
    print(f"  [worker] searchsorted done for {satnum}, {valid_mask.sum()} valid timesteps", flush=True)

    if not valid_mask.any():
        return []

    valid_t_jd = timesteps_jd[valid_mask]   # (V,)  timesteps to propagate
    valid_tidx = nearest_idx[valid_mask]    # (V,)  which TLE index to use

    # Build only unique TLEs that are actually needed, then propagate
    # all timesteps for each unique TLE in one vectorised sat.at() call
    unique_tle_indices = np.unique(valid_tidx)          # sorted unique TLE row indices
    print(f"  [worker] {satnum}: {len(unique_tle_indices)} unique TLEs to propagate", flush=True)

    # Pre-build all needed EarthSatellite objects
    for idx in unique_tle_indices:
        if idx not in sat_cache:
            try:
                sat_cache[idx] = EarthSatellite(
                    tle_lines1[idx], tle_lines2[idx], str(satnum), ts_w)
            except Exception:
                pass   # missing entries will be skipped below

    # Allocate output arrays sized to valid timesteps
    n_valid   = len(valid_t_jd)
    out_lats  = np.full(n_valid, np.nan)
    out_lons  = np.full(n_valid, np.nan)
    out_alts  = np.full(n_valid, np.nan)
    out_sma   = np.full(n_valid, np.nan)
    # OEs are per-TLE (static), stored per-timestep for convenience
    out_ecc   = np.full(n_valid, np.nan)
    out_inc   = np.full(n_valid, np.nan)
    out_raan  = np.full(n_valid, np.nan)
    out_argp  = np.full(n_valid, np.nan)
    out_M     = np.full(n_valid, np.nan)
    out_ta    = np.full(n_valid, np.nan)
    out_epoch = np.empty(n_valid, dtype=object)  # TLE epoch string per timestep

    for idx in unique_tle_indices:
        if idx not in sat_cache:
            continue
        sat = sat_cache[idx]

        # Mask of valid timesteps that use this TLE
        mask = (valid_tidx == idx)           # bool (V,)
        t_jd_block = valid_t_jd[mask]        # timesteps for this TLE

        # Static OE parameters from TLE model
        m     = sat.model
        e_cc  = m.ecco
        inc   = np.degrees(m.inclo)
        raan  = np.degrees(m.nodeo)
        argp  = np.degrees(m.argpo)
        M_rad = m.mo
        M_deg = np.degrees(M_rad)
        ta    = (M_deg + (2*e_cc - 0.25*e_cc**3) * np.sin(M_rad)) % 360
        epoch_str = sat.epoch.utc_datetime().isoformat()

        # Vectorised SGP4 propagation for all timesteps using this TLE
        geocentric = sat.at(ts_w.tt_jd(t_jd_block))

        lats_sf, lons_sf = wgs84.latlon_of(geocentric)
        alts_m_block     = wgs84.height_of(geocentric).m

        r_km = geocentric.position.km
        v_km = geocentric.velocity.km_per_s
        rmag = np.linalg.norm(r_km, axis=0) * 1000
        vmag = np.linalg.norm(v_km, axis=0) * 1000
        sma  = 1.0 / (2.0/rmag - vmag**2/MU_EARTH)

        # Write results into the output arrays at the right positions
        out_lats[mask]  = lats_sf.degrees
        out_lons[mask]  = lons_sf.degrees
        out_alts[mask]  = alts_m_block
        out_sma[mask]   = sma
        out_ecc[mask]   = e_cc
        out_inc[mask]   = inc
        out_raan[mask]  = raan
        out_argp[mask]  = argp
        out_M[mask]     = M_deg
        out_ta[mask]    = ta
        out_epoch[mask] = epoch_str

    # Convert JD timesteps to ISO strings (vectorised)
    unix_secs = (valid_t_jd - JD_UNIX_EPOCH) * 86400.0
    dt_isos   = [
        datetime.datetime.utcfromtimestamp(s).isoformat() + "+00:00"
        for s in unix_secs
    ]

    # Build output rows — skip any timestep where propagation failed (NaN)
    rows_out = []
    for j in range(n_valid):
        if np.isnan(out_sma[j]):
            continue
        rows_out.append([
            satnum, dt_isos[j], out_epoch[j],
            out_ecc[j], out_sma[j], out_inc[j], out_raan[j],
            out_argp[j], out_M[j], out_ta[j],
            out_lats[j], out_lons[j], out_alts[j],
        ])

    # Write directly to disk — return only the path string, not the rows.
    # This keeps the pipe back to the main process tiny (one short string)
    # regardless of how many rows were generated.
    if not rows_out:
        return None
    out_path = os.path.join(tmp_dir, f"part_{satnum}.csv")
    with open(out_path, "w", newline="") as f:
        csv.writer(f).writerows(rows_out)
    return out_path

# Main
if __name__ == "__main__":
    # User input
    print("\nDefine a study period (yyyy-mm-dd formats).")
    studyperiod_start = input("Start date: ")
    studyperiod_end   = input("End date: ")
    timestep_days     = float(input("Time step (days): "))

    start_dt = datetime.datetime.fromisoformat(studyperiod_start).replace(
        tzinfo=datetime.timezone.utc)
    end_dt   = datetime.datetime.fromisoformat(studyperiod_end).replace(
        tzinfo=datetime.timezone.utc)

    # Build time grid as Julian date floats (no matplotlib.dates needed)
    n_steps  = max(2, int((end_dt - start_dt).total_seconds() / 86400 / timestep_days))
    step_sec = (end_dt - start_dt).total_seconds() / (n_steps - 1)
    timesteps_jd = np.array([
        dt_to_jd(start_dt + datetime.timedelta(seconds=i * step_sec))
        for i in range(n_steps)
    ])
    print(f"Time grid: {n_steps} steps from {studyperiod_start} to {studyperiod_end}")

    # Load TLE data
    if not os.path.exists(TLE_INPUT):
        raise FileNotFoundError(
            f"Cannot find TLE input at:\n  {TLE_INPUT}\n"
        )
    print(f"\nLoading TLE CSV from {TLE_INPUT}")
    df = pd.read_csv(TLE_INPUT,
                     usecols=["satnum", "epoch_jd", "tle_line1", "tle_line2"])
    print(f"Loaded {len(df):,} TLE records for {df['satnum'].nunique():,} satellites.")

    period_start_jd = timesteps_jd[0]  - TLE_COVERAGE_DAYS
    period_end_jd   = timesteps_jd[-1] + TLE_COVERAGE_DAYS
    df = df[(df["epoch_jd"] >= period_start_jd) & (df["epoch_jd"] <= period_end_jd)]
    print(f"After date filter: {len(df):,} records, {df['satnum'].nunique():,} satellites.")

    ts     = load.timescale(builtin=True)
    groups = list(df.groupby("satnum"))
    n_sats = len(groups)

    # Time first satellite for estimate on how long it will take code to run
    import io
    first_satnum, first_grp = groups[0]
    dummy_writer = csv.writer(io.StringIO())
    t0 = time.perf_counter()
    process_satellite_single(
        first_satnum,
        first_grp["epoch_jd"].to_numpy(),
        first_grp["tle_line1"].tolist(),
        first_grp["tle_line2"].tolist(),
        timesteps_jd, ts, dummy_writer
    )
    elapsed_one = time.perf_counter() - t0
    est_min = elapsed_one * n_sats / 60
    print(f"\nTimed first satellite ({first_satnum}): {elapsed_one:.1f}s")
    print(f"Estimated total: {est_min:.0f}\u2013{est_min*1.5:.0f} min for {n_sats} satellites")

    # Process all satellites
    print(f"\nProcessing {n_sats} satellites into {OUTFILE}...")
    t_start     = time.perf_counter()
    total_rows  = 0

    with gzip.open(OUTFILE, "wt", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(HEADER)

        for i, (satnum, grp) in enumerate(groups):
            rows = process_satellite_single(
                satnum,
                grp["epoch_jd"].to_numpy(),
                grp["tle_line1"].tolist(),
                grp["tle_line2"].tolist(),
                timesteps_jd, ts, writer
            )
            total_rows += rows

            if (i + 1) % 50 == 0 or (i + 1) == n_sats:
                elapsed = time.perf_counter() - t_start
                rate    = (i + 1) / elapsed
                eta_s   = (n_sats - i - 1) / rate if rate > 0 else 0
                print(f"  {i+1}/{n_sats} sats | "
                      f"{total_rows:,} rows | "
                      f"elapsed {elapsed/60:.1f}m | "
                      f"ETA {eta_s/60:.1f}m", flush=True)

    print(f"\nDone. {total_rows:,} rows written to {OUTFILE}")
