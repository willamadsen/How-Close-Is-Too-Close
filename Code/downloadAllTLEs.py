# Download EVERY TLE Space-Track has for each satellite in the sheet (its whole history),
# for the other tool. Saves one file per satellite in Data/TLEs_full/[COSPAR ID].tle,
# then joins them all into Data/all_tles_full.txt
#
# The per-satellite files end in .tle (not .txt) so build_tle_library.py, which reads
# every Data/*/*.txt, doesn't pull them into the compare page's library.
import csv, io, re
import datetime as dt
from pathlib import Path
from time import sleep
import requests
import spacetrack.operators as op
from spacetrack import SpaceTrackClient

data = Path(__file__).parent.parent / "Data"
folder = data / "TLEs_full"
folder.mkdir(parents=True, exist_ok=True)

# Log in to Space-Track
print("Log in using your Space-Track.org account credentials.\n")
st = SpaceTrackClient(identity=input("Email: "), password=input("Password: "))

# Every COSPAR ID in the sheet (columns C, D, E), each one only once
SHEET_ID = "1IEQ3tmerXXxEty8BcZeaonWhQbHUfA2Z5b44IuCsQ8I"
url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/export?format=csv&gid=0"
response = requests.get(url)
response.raise_for_status()
COSPAR_PATTERN = r"^\d{4}-\d{3}[A-Z]{1,3}$"   # e.g. 2013-043A or 2020-001BK
reader = csv.reader(io.StringIO(response.text))
next(reader)    # skip the heading row
cospars = sorted({cell.strip() for row in reader for cell in row[2:5] if re.match(COSPAR_PATTERN, cell.strip())})
print("Found " + str(len(cospars)) + " different satellites.")

# Ask for one year at a time, from the launch year (the start of the COSPAR ID) to today.
# (Monthly pieces would be thousands of requests; Space-Track allows about 30 a minute, 300 an hour.)
def download_all(cospar):
    pieces = []
    for year in range(int(cospar[:4]), dt.date.today().year + 1):
        for attempt in range(3):
            try:
                piece = st.gp_history(object_id=cospar, epoch=op.inclusive_range(dt.date(year, 1, 1), dt.date(year + 1, 1, 1)),
                                      orderby="epoch asc", format="tle", timeout=300)
                break
            except Exception:
                if attempt == 2:
                    raise
                print("  Space-Track was slow, waiting 60 s and trying again...")
                sleep(60)
        pieces.append(piece)
    return "".join(pieces)

# Download each satellite. Ones already saved are skipped, so if it stops partway, just run it again.
for cospar in cospars:
    file = folder / (cospar + ".tle")
    if file.exists():
        print("Already have " + cospar + ", skipping")
        continue
    try:
        tles = download_all(cospar)
    except Exception as error:
        print("FAILED: " + cospar + ": " + str(error))
        continue
    if tles.strip() == "":
        print("No TLEs found: " + cospar)
        continue
    file.write_text(tles)
    print("Saved " + cospar + " (" + str(tles.count("\n1 ") + 1) + " TLEs)")

# Join them all into one text file, without repeats
# (a TLE on the boundary of two years can come back in both pieces)
seen = set()
with open(data / "all_tles_full.txt", "w") as out:
    for file in sorted(folder.glob("*.tle")):
        lines = [line.rstrip() for line in open(file) if line.strip() != ""]
        for i in range(0, len(lines) - 1, 2):
            pair = lines[i] + "\n" + lines[i + 1] + "\n"
            if lines[i].startswith("1 ") and lines[i + 1].startswith("2 ") and pair not in seen:
                seen.add(pair)
                out.write(pair)
print("Saved " + str(len(seen)) + " TLEs to Data/all_tles_full.txt")
