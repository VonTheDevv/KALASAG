# Heat and structure-fire pipeline validation

## Outcome

The configured satellite heat pipeline was live during the investigation. The absence of an exact Panghulo Road marker is not evidence of a broken feed: this source observes thermal pixels during orbital passes and is not a verified structure-fire incident service.

Two low-confidence satellite observations were within five kilometres of the Panghulo Road reference point. They cannot honestly be linked to the reported fire. The app therefore retains them as thermal indicators and avoids presenting them as confirmed residential incidents.

## Hypothesis results

1. **Provider/gateway unavailable:** refuted at check time; all three upstreams and the local gateway responded.
2. **Every recent structure fire must produce an exact point:** refuted by product design and documented omission/coverage limitations.
3. **Old observations could generate urgent proximity warnings:** confirmed in code and remediated.
4. **A documented public BFP live incident API is ready to integrate:** under-determined; none was found in the checked official public material.

## Implemented controls

- Normalized every valid acquisition date/time into an auditable UTC `observedAt` field in both production and development gateways.
- Preserved independent satellite observations with deterministic IDs and robust CSV parsing.
- Added explicit 24-hour dataset metadata that separates delivery health from observation recency.
- Aligned map refresh with the five-minute server cache and refreshes on app visibility/network return.
- Rejects malformed/out-of-bounds records and defensively removes observations outside the feed window.
- Limits five-kilometre background heat alerts to observations no older than six hours.
- Groups nearby pixels into one alert and includes observation age and confidence-aware wording.
- Replaced unsupported residential-fire claims in visible map text with urban-area satellite heat indications.

## Adversarial review

- **Could a six-hour cutoff hide a true fire?** Yes. It limits stale alerts, but cannot solve orbital gaps. Verified incident feeds remain necessary.
- **Could a low-confidence pixel still be a real fire?** Yes. Low confidence is retained on the map and may alert when recent; wording exposes the uncertainty.
- **Could a high-confidence urban pixel be non-residential?** Yes. Industrial heat, vegetation, and other sources remain possible, so the UI no longer claims residential classification.
- **Does HTTP 200 prove current observations?** No. Source-health, gateway-fetch time, and record-observation time are now separate concepts.

## External dependency

To show verified residential-fire reports such as an official Panghulo incident, KALASAG needs a documented server-to-server incident feed from BFP, Unified 911, an LGU dispatch center, or a licensed provider. Required fields include incident ID, verified status, coordinates/address, alarm level, started/updated/controlled/out timestamps, correction/retraction state, and a legally permitted update channel. No data should be simulated while that integration is absent.

