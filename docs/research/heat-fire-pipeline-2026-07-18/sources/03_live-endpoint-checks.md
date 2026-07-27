# Live endpoint checks

- Type: direct primary observation
- Executed: 2026-07-18
- Scores: credibility 5/5, recency 5/5, bias risk 1/5

## Results

- All three configured regional CSV endpoints returned HTTP 200.
- S-NPP: 2,976 regional rows, 91 in the Philippine bounding box.
- NOAA-20: 2,065 regional rows, 22 in the Philippine bounding box.
- NOAA-21: 2,742 regional rows, 64 in the Philippine bounding box.
- The local normalized gateway returned 177 records with all three source-health states marked live.
- Its newest observation was `2026-07-18T05:12:00.000Z` when checked.
- Relative to the geocoded Panghulo Road point (`14.6890798, 120.9539959`), S-NPP contained two low-confidence observations about 3.272 km and 3.738 km away. There was no exact incident-coordinate match.

## Interpretation

The configured satellite pipeline was functioning at check time. Nearby pixels cannot be attributed to the reported Panghulo structure fire without an authoritative incident source.

