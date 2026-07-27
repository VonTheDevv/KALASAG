# Heat and structure-fire pipeline investigation

## Decision

Determine whether KALASAG's heat layer is current and operational, why a reported Panghulo structure fire may not appear, and which alert/UI changes are defensible without inventing incident data.

## Falsifiable hypotheses

1. The satellite heat provider or KALASAG gateway is unavailable.
2. A recent structure fire inside the provider area must produce an exact map point.
3. The existing nearby alert logic can warn from an old or low-confidence observation without stating its age.
4. A documented public Philippine fire-dispatch API is available for immediate integration.

## Scope and method

- Inspect the production edge implementation, local gateway, map, urban-context classifier, and background proximity alerts.
- Query all configured upstream feeds and the running local gateway.
- Compare behavior with official product documentation and official Philippine fire-system material.
- Search specifically for failure modes: orbital gaps, latency, false alarms, omission errors, and non-public incident systems.
- Do not treat social posts, app-store claims, or reverse-engineered private endpoints as authoritative incident data.

## Risks

- Satellite thermal pixels may be mistaken for verified structure-fire incidents.
- A reachable 24-hour CSV can contain records too old for an urgent proximity warning.
- Absence of a satellite point is not proof that a reported fire did not occur.
- Absence of public API documentation in this search is not proof that no partner API exists.

## Stop criteria

- Every configured feed and the local normalized endpoint has been checked.
- Observation timing and coverage limitations are supported by primary documentation.
- The app no longer sends urgent nearby warnings from the full 24-hour history.
- Any structure-fire incident-data gap is stated explicitly with the needed external dependency.

