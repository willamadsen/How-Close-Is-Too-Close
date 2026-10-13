# have to run satcat_ret.py first to get the full catalog
"""
build_satcat_json.py

Makes a small satellite catalog for the website's lookup feature.

  INPUT   Viz/full_satcat.csv     The full CelesTrak catalog (about 70,000 objects).
                                  Get it first by running:  python Viz/satcat_ret.py
  OUTPUT  Viz/data/satcat.json    Just the NORAD number, international designator
                                  and name of each object.

Run it from anywhere:
    python Viz/build_satcat_json.py
"""
# then run this script to make a smaller version for the website


# PART 1: LIBRARIES
# All three come with Python, no extra instal needed 
import csv                  # reads spreadsheet-style .csv files
import json                 # writes .json files that JavaScript can read
import sys                  # lets us stop the script early with a message
from pathlib import Path    # builds file locations that work on any computer


# PART 2: FILE LOCATIONS
# Worked out from where THIS script is saved on local device, not from the terminal's folder
# and not from anyone's username, so it works for anyone who downloads the project
HERE = Path(__file__).resolve().parent          # the Viz folder
INPUT_FILE = HERE / "full_satcat.csv"
OUTPUT_FILE = HERE / "data" / "satcat.json"
# The columns we keep. Left side = name in the CSV, right side = name in our JSON.
# REMEMBER: To keep another column later, add one line here; nothing else needs to change.
COLUMNS_TO_KEEP = {
    "NORAD_CAT_ID": "norad",
    "OBJECT_ID": "intlDes",
    "OBJECT_NAME": "name", 
}


    # PART 3: CHECK THE INPUT EXISTS
# If someone runs the script without the download first then tell them what to do next
if not INPUT_FILE.exists():
    print(f"Can't find {INPUT_FILE}")
    print("Download it first by running:  python Viz/satcat_ret.py")
    sys.exit(1)


    # PART 4: READ THE CATALOG AND KEEP ONLY WHAT WE NEED
satellites = []
# "utf-8-sig" also copes with files saved by Excel, which add a hidden marker at the start
with open(INPUT_FILE, newline="", encoding="utf-8-sig") as f:
    reader = csv.DictReader(f)
# Check the columns we need are really there (in case CelesTrak changes the format)
    missing = [col for col in COLUMNS_TO_KEEP if col not in reader.fieldnames]
    if missing:
        print(f"The catalog is missing these columns: {missing}")
        print(f"Columns it does have: {reader.fieldnames}")
        sys.exit(1)

    for row in reader:
        small = {}
        for csv_name, json_name in COLUMNS_TO_KEEP.items():
            small[json_name] = row[csv_name].strip()   # strip() removes stray spaces
        satellites.append(small)
        
print(f"Read {len(satellites):,} objects from {INPUT_FILE.name}")

# PART 5: SAVE THE SMALL VERSION
OUTPUT_FILE.parent.mkdir(parents=True, exist_ok=True)   # make the data folder if it's missing
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump(satellites, f, separators=(",", ":"))      # no extra spaces = smaller file

size_mb = OUTPUT_FILE.stat().st_size / 1_000_000
print(f"Saved {OUTPUT_FILE.name} ({size_mb:.1f} MB) to {OUTPUT_FILE.parent}")