# KALASAG pipeline code inspection

- Type: primary implementation evidence
- Accessed: 2026-07-18
- Scores: credibility 5/5, recency 5/5, bias risk 1/5

## Inspected paths

- `supabase/functions/live-data/index.ts`
- `scripts/vite-live-data.ts`
- `src/components/HazardMap.tsx`
- `src/components/BackgroundSafetyCheck.tsx`
- `src/lib/urbanHeat.ts`
- `src/lib/liveData.ts`

## Findings before remediation

- The edge cache refreshed heat data every five minutes, while the map polled it every ten minutes.
- Records used acquisition date/time but did not expose a normalized `observedAt` field.
- Nearby alerts considered every record in the 24-hour feed, including low-confidence and old observations.
- Alert copy called the full five-kilometre area dangerous even though the source was only a satellite thermal pixel.
- Urban proximity plus nominal/high confidence was labeled as a potential residential fire even though the settlement mask cannot determine building use.

