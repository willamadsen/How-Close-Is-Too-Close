# Testing notes for the compare page

> **Data sources:** while testing, the satellite catalog (names and designators) and
> live current TLEs for satellites outside the TLE library both come from **CelesTrak**.
> This is a testing setup; for actual use these can be swapped for other sources
> (for example, Space-Track history added to the TLE library). See `README.md`.

Pairs and dates to check the tool against the original research.
Load both satellites (search box or dropdowns), then set the dates.

| Satellites (A – B) | NORAD | Dates (UTC) | What to look for |
| --- | --- | --- | --- |
| USA 245 – Kosmos 2542 | 39232 – 44797 | 2020-01-20 to 2020-01-30 | Late-January 2020 approach; the original storyline models about 99 km on Jan 25 |
| USA 245 – Kosmos 2543 | 39232 – 44835 | 2019-12-31 to 2020-01-05 | Early-January 2020 approach; the original storyline models about 21 km on Jan 2 |
| Kosmos 2542 – Kosmos 2543 | 44797 – 44835 | 2019-12-06 to 2019-12-16 | Kosmos 2543 separates from Kosmos 2542 on Dec 6, 2019 |
