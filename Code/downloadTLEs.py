import spacetrack.operators as op
from spacetrack import SpaceTrackClient
import datetime as dt
from time import sleep
import csv
from pathlib import Path
import requests 
import io
import re
import calendar
import sys
import logbook
logbook.StreamHandler(sys.stdout, level="DEBUG").push_application()

PAD_DAYS = 7   # download this many extra days either side of each case, so even one-day cases get nearby TLEs

# Check whether ./Data/TLEs/ exists. If not, make it.
path = str(Path(__file__).parent.parent / "Data" / "TLEs") + "/"
Path(path).mkdir(parents=True, exist_ok=True)

# Turn a date from the sheet into a datetime. Fuzzy dates cover the whole month (or year).
# is_end=True gives the LAST moment of that period, is_end=False the FIRST.
# Returns None if the text has no year in it.
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

# Prompt user for Space-Track log-in credentials
print("Log in to using your Space-Track.org account credentials.\n")
st_email = input("Email: ")
st_pass = input("Password: ")

# Log in to Space-Track using your email and password
st = SpaceTrackClient(identity=st_email, password=st_pass)

# Grab the list of satellites of interest from the google sheet
SHEET_ID = "1IEQ3tmerXXxEty8BcZeaonWhQbHUfA2Z5b44IuCsQ8I"
TAB_ID = "0" 
url = "https://docs.google.com/spreadsheets/d/" + SHEET_ID + "/export?format=csv&gid=" + TAB_ID 
response = requests.get(url)
response.raise_for_status() 

# Read the sheet: each row is one event, with up to three satellites (columns C, D, E)
# and its own start and end dates (columns F and G)
COSPAR_PATTERN = r"^\d{4}-\d{3}[A-Z]{1,3}$"   # e.g. 2013-043A or 2020-001BK

downloads = []
reader = csv.reader(io.StringIO(response.text))
next(reader)    # skip the heading row
for row in reader:
    event_id = row[1]
    start = sheet_date(row[5], False)
    end = sheet_date(row[6], True)
    if end is None:
        end = sheet_date(row[5], True)
    if start is None:
        print("Skipping " + event_id + ": no usable start date")
        continue
    for cell in row[2:5]:
        cospar = cell.strip()
        if re.match(COSPAR_PATTERN, cospar):
            downloads.append([event_id, cospar, start, end])

print("Found " + str(len(downloads)) + " satellites to download.")

# Space-Track sends back nothing if you ask for too long a period at once,
# so ask for about a month at a time and join the pieces together
def download_tles(cospar, start, end):
    pieces = []
    chunk_start = start.date()
    last_day = (end + dt.timedelta(days=1)).date()
    while chunk_start < last_day:
        chunk_end = min(chunk_start + dt.timedelta(days=30), last_day)
        for attempt in range(3):
            try:
                piece = st.gp_history(object_id=cospar, epoch=op.inclusive_range(chunk_start, chunk_end), format="tle", timeout=120)
                break
            except Exception:
                if attempt == 2:
                    raise
                print("  Space-Track was slow, waiting 30 s and trying again...")
                sleep(30)
        pieces.append(piece)
        chunk_start = chunk_end
    return "".join(pieces)

# Download the TLEs for each satellite, for its own event's dates,
# and save them in Data/TLEs/[event]_[COSPAR ID].txt
for event_id, cospar, start, end in downloads:
    filename = path + event_id + "_" + cospar + ".txt"
    if Path(filename).exists():
        print("Already have " + filename + ", skipping")
        continue
    try:
        tles = download_tles(cospar, start - dt.timedelta(days=PAD_DAYS), end + dt.timedelta(days=PAD_DAYS))
    except Exception as error:
        print("FAILED: " + event_id + " " + cospar + ": " + str(error))
        continue
    if tles.strip() == "":
        print("No TLEs found: " + event_id + " " + cospar + " (" + str(start.date()) + " to " + str(end.date()) + ")")
        continue
    with open(filename, "w") as f:
        f.write(tles)
    print("Saved " + filename)




