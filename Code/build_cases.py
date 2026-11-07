# Build Viz/data/cases.json: the incidents the compare page can open from a link like compare.html?case=E-002
# An incident is kept if it has dates and at least two satellites with published TLEs near those dates.
# Run from the project root:  python Code/build_cases.py
import calendar
import csv
import datetime as dt
import io
import json
import re
from pathlib import Path
import requests

PAD_DAYS = 7   # the page opens this many days either side of the reported dates
PAGE_URL = "https://willamadsen.github.io/How-Close-Is-Too-Close/Viz/compare.html"
SHEET_ID = "1IEQ3tmerXXxEty8BcZeaonWhQbHUfA2Z5b44IuCsQ8I"
TAB_ID = "0"
COSPAR_PATTERN = r"^\d{4}-\d{3}[A-Z]{1,3}$"   # e.g. 2013-043A or 2020-001BK
TIME_FORMAT = "%Y-%m-%dT%H:%M:%SZ"            # the same format as the TLE epochs in the library

data_folder = Path(__file__).parent.parent / "Viz" / "data"

# Turn a date from the sheet into a datetime. Fuzzy dates cover the whole month (or year).
# is_end=True gives the LAST moment of that period, is_end=False the FIRST.
# Returns None if the text has no year in it. (The same function as in downloadTLEs.py.)
def sheet_date(text, is_end):
    match = re.search(r"(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?", text)
    if match is None:
        return None
    year = int(match.group(1))
    month = match.group(2)
    day = match.group(3)
    if month is None:
        month = 12 if is_end else 1
    month = int(month)
    if day is None:
        day = calendar.monthrange(year, month)[1] if is_end else 1
    day = int(day)
    if is_end:
        return dt.datetime(year, month, day, 23, 59, 59)
    return dt.datetime(year, month, day)

# Does this satellite have a published TLE between these two times?
# Times in this format sort like plain text, so they can be compared directly.
def has_tles(norad, first, last):
    file = data_folder / "tles_public" / (norad + ".json")
    if not file.exists():
        return False
    with open(file, encoding="utf-8") as f:
        tles = json.load(f)["tles"]
    return any(first <= tle["epoch"] <= last for tle in tles)

# The catalog turns a COSPAR ID (2013-043A) into the NORAD number the page uses (39232) and the name
with open(data_folder / "satcat.json", encoding="utf-8") as f:
    catalog = {satellite["intlDes"]: satellite for satellite in json.load(f)}

url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/export?format=csv&gid=" + TAB_ID
response = requests.get(url)
response.raise_for_status()
response.encoding = "utf-8"

# Each row is one incident: ID in column B, satellites in C, D, E, dates in F and G
cases = {}
links = []      # one line per sheet row, in order: a link if the incident can be modeled, otherwise blank
reader = csv.reader(io.StringIO(response.text))
next(reader)    # skip the heading row
for sheet_row, row in enumerate(reader, start=2):
    links.append("")
    event_id = row[1].strip()
    start = sheet_date(row[5], False)
    end = sheet_date(row[6], True)
    if end is None:
        end = sheet_date(row[5], True)
    if event_id == "" or start is None:
        continue
    first = (start - dt.timedelta(days=PAD_DAYS)).strftime(TIME_FORMAT)
    last = (end + dt.timedelta(days=PAD_DAYS)).strftime(TIME_FORMAT)
    satellites = []
    for cell in row[2:5]:
        cospar = cell.strip()
        if re.match(COSPAR_PATTERN, cospar) and cospar in catalog and has_tles(catalog[cospar]["norad"], first, last):
            satellites.append({"norad": catalog[cospar]["norad"], "name": catalog[cospar]["name"]})
    if len(satellites) < 2:
        print("Left out row " + str(sheet_row) + " (" + event_id + "): " + str(len(satellites)) + " satellite(s) with TLEs")
        continue
    cases[event_id] = {"satellites": satellites, "start": start.strftime(TIME_FORMAT), "end": end.strftime(TIME_FORMAT)}
    links[-1] = '=HYPERLINK("' + PAGE_URL + '?case=' + event_id + '","View")'

with open(data_folder / "cases.json", "w", encoding="utf-8") as f:
    json.dump(cases, f, indent=2)
print("Saved " + str(len(cases)) + " cases to Viz/data/cases.json")


# The VIZ column: paste this whole file into cell A2 of the sheet
links_file = Path(__file__).parent.parent / "Data" / "viz_column.txt"
with open(links_file, "w", encoding="utf-8") as f:
    f.write("\n".join(links))
print("Saved the VIZ column to Data/viz_column.txt")
