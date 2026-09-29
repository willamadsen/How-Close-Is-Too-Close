from sgp4.api import Satrec

def parse_chunk(lines):
    """
    Parse a chunk of TLE lines (pairs of line1 + line2) into a list of dicts

    After parsing, validate that satellite catalog numbers in both
    lines agree. Discard any pair where they don't match
    """
    out = []
    i = 0
    while i < len(lines) - 1:
        try:
            l1 = lines[i].rstrip()
            l2 = lines[i + 1].rstrip()

            # Both lines must be non-empty
            if not l1 or not l2:
                i += 1
                continue

            # Swap if line order is reversed
            if l1.startswith("2") and l2.startswith("1"):
                l1, l2 = l2, l1

            # Both must start with expected identifiers
            if not l1.startswith("1") or not l2.startswith("2"):
                # One of the lines is not a valid TLE line — skip one line
                # to attempt re-synchronization
                i += 1
                continue

            # Validate that catalog numbers match
            # Columns 3-7 (0-indexed 2:7) hold the satellite number
            # in both line 1 and line 2.
            try:
                satnum_l1 = int(l1[2:7].strip())
                satnum_l2 = int(l2[2:7].strip())
            except ValueError:
                i += 1
                continue

            if satnum_l1 != satnum_l2:
                # Lines are from different satellites
                # Skip just one line so that line2
                # becomes the new line1 candidate on the next iteration,
                # allowing re-sync
                i += 1
                continue

            sat = Satrec.twoline2rv(l1, l2)

            out.append({
                "satnum": sat.satnum,
                "epoch_jd": sat.jdsatepoch + sat.jdsatepochF,

                # preserve original TLE text
                "tle_line1": l1,
                "tle_line2": l2,

                # keep parsed values only for filtering
                "inclination": sat.inclo,
                "eccentricity": sat.ecco,
                "mean_motion": sat.no_kozai
            })

            i += 2  # advance by a full pair

        except Exception:
            i += 1  # on any error, skip one line and try to re-sync
            continue

    return out
