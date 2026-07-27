-- Evacuation-center capacity and occupancy were placeholder values, not live data.
ALTER TABLE public.evacuation_centers
  DROP COLUMN IF EXISTS capacity,
  DROP COLUMN IF EXISTS current_occupancy;
