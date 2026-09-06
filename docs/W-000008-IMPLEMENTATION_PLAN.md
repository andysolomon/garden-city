# W-000008 Implementation Plan

**Story:** W-000008 Load real locations through a map-data provider  
**Issue:** [#43](https://github.com/andysolomon/garden-city/issues/43)  
**Branch:** `feat/W-000008-map-data-provider`  
**PR:** [#53](https://github.com/andysolomon/garden-city/pull/53) (merged `07166a9`)

## Product goal and scope boundaries

Add a runtime-configured Mapbox-geocoding + Overpass-compatible geographic
data adapter. The application `SOURCE` control offers `PROCEDURAL` (default),
`HYBRID / REAL DATA`, and `GEOGRAPHIC / REAL DATA`. The user supplies a
`longitude, latitude` pair, a place name, or a crop radius from 25–450 metres
and presses `LOAD LOCATION`. Provider credentials are runtime-only; they are
held in memory, sent on the request, and never written to the repository, URL,
local storage, or issue bodies.

The adapter owns all I/O; `generateCity()` and every renderer remain
synchronous and provider-neutral. The hybrid, geographic, and procedural paths
keep their existing byte-identical serialization, and shared map, ink, solid,
poster, and PNG paths continue to consume the same CityModel with no
source-specific renderer branch. Automated tests inject `fetch` and never call
a live service.

## Current baseline

- `src/geography.js` provides a deterministic local equirectangular projection
  from `[longitude, latitude]` to local `[x, z]` in metres, plus viewport
  containment/cropping helpers (`makeProjection`, `VIEWPORT_HALF`).
- `src/geojson.js` normalizes GeoJSON Features / FeatureCollections into local
  records + per-feature diagnostics.
- `src/model.js::generateCity()` already accepts
  `{ source: 'geographic' | 'hybrid', geography: { records, diagnostics } }`
  and stays synchronous.
- The application had no provider, no location input, and no asynchronous
  loading path. Credentials were not requested or stored.

## Missing capabilities

- A Mapbox-compatible geocoding path (place-name → coordinates) with a
  runtime token only.
- An Overpass-compatible OSM data query around the resolved coordinates
  that returns roads, buildings, water, and parks in the local viewport.
- Conversion from Overpass JSON (or an already GeoJSON-compatible response)
  into the same normalized records that offline fixtures use.
- A UI for source selection, location, crop radius, runtime token,
  loading/error status, and visible attribution.
- Readable error categories (missing-token, rate-limit, network, invalid
  response, no-road-data, location-not-found) shown without replacing the
  current model.
- Mocked tests that exercise every error class without live network calls.

## Milestones

### 1. Provider adapter and Overpass → GeoJSON conversion

- **Goal:** Introduce `src/provider.js` as the single async boundary,
  exposing `createMapProvider({ fetchImpl, geocoderEndpoint, dataEndpoint })`,
  `loadProviderGeography(...)`, `ProviderError`, `parseCoordinateLocation`,
  `buildOverpassQuery`, and `osmToGeoJSON`.
- **Files:** `src/provider.js`, `test/provider.mjs`
- **Deliverables:** Coordinate and radius validation with bounded error
  codes; Mapbox geocoder URL template with a token query parameter and a
  configurable endpoint; Overpass query builder covering highways,
  buildings, water, riverbanks, parks/landuse; conversion of Overpass
  elements to LineString + Polygon features with building/water/park
  classification.
- **Dependencies:** `src/geography.js`, `src/geojson.js`.
- **Risks:** Overpass mirrors reject non-browser User-Agents; an injected
  User-Agent must be added only outside `window`. Polygon rings from OSM
  rarely close themselves; the converter must append the first point.
- **Acceptance criteria:** Direct coordinate loading never calls the
  geocoder and returns at least one line record when roads are present.

### 2. UI integration and async loading

- **Goal:** Add the SOURCE / LOCATION / CROP RADIUS / PROVIDER TOKEN
  controls and the LOAD LOCATION button to the panel; route provider data
  into `generateCity()` and surface status, error, and attribution
  banners; cancel in-flight loads when the user switches source or
  re-enters location.
- **Files:** `index.html`, `src/main.js`, `README.md`
- **Deliverables:** Hidden-by-default provider rows revealed when
  `SOURCE` is not `PROCEDURAL`; BSP engine auto-disabled for imported
  sources; default crop radius `100` (larger radii regularly time out at
  the upstream Overpass mirror); AbortController cancellation per
  request; readable error banner that never replaces the current model.
- **Dependencies:** Milestone 1.
- **Risks:** The synchronous `generateCity()` call must remain blocking
  inside `setTimeout` to survive occluded windows; the async load path
  must not block the synchronous procedural path.
- **Acceptance criteria:** Procedural mode loads without network calls;
  imported sources load asynchronously, swap into the same renderers,
  and show attribution.

### 3. Tests and documentation

- **Goal:** Cover every provider error class and document the runtime
  configuration path.
- **Files:** `test/provider.mjs`, `package.json`, `README.md`
- **Deliverables:** Mocked tests for coordinate parsing, Overpass query
  shape, OSM → GeoJSON conversion with building/water/park classification,
  missing-token, rate-limit, network, invalid-response, no-road-data,
  GeoJSON-input shortcut; `npm test` runs the provider suite; README
  documents the runtime configuration and the credential-free path for
  coordinate input.
- **Dependencies:** Milestones 1–2.
- **Risks:** Avoid network calls in CI; injected `fetchImpl` is required.
- **Acceptance criteria:** `npm test` is green; `git grep` finds no
  embedded access tokens.

### 4. Ship

- **Goal:** Ship a reviewable PR without merging it; archive plan +
  progress; clean the worktree on merge.
- **Files:** all issue-scoped files
- **Deliverables:** Squash merge via `gh pr merge --squash` on operator
  signal; remove the worktree; archive `docs/W-000008-*` after merge.
- **Dependencies:** Milestones 1–3.
- **Acceptance criteria:** PR #53 merged as commit `07166a9`, worktree
  cleaned, issue #43 closed by the squash footer.

## Test strategy

- **Provider unit tests:** `node test/provider.mjs`
  exercises coordinate parsing, radius validation, Overpass query
  construction, Overpass → GeoJSON conversion with building/water/park
  classification, and every `ProviderError` code via an injected
  `fetchImpl`. No live network requests.
- **Compatibility:** `npm test` exercises `npm run test` which runs
  `node test/invariants.mjs && node test/grade.mjs && node test/geography.mjs && node test/provider.mjs`.
- **Browser smoke:** Headless Chromium `--dump-dom` confirms the
  default procedural app boots and `src/provider.js` is fetched.
- **Privacy:** `git grep` over the worktree, excluding the provider test,
  finds no `pk.` / `sk-` access tokens or hardcoded `access_token`
  literals.

## Acceptance criteria mapping

| Issue criterion | Milestone(s) | Verification |
| --- | --- | --- |
| Location + crop radius supplied from the UI | 2 | `index.html` panel rows; `src/main.js` reads `$('location')` and `$('cropRadius')` |
| Async provider loading without blocking procedural mode | 2 | `loadProviderGeography` is awaited; procedural default path uses no fetch seam |
| Missing-token / rate-limit / network failures show readable errors | 1, 2 | `ProviderError` codes in `src/provider.js`; mocked tests in `test/provider.mjs`; `#error` banner in `index.html` |
| Provider attribution is visible | 2 | `data.attribution` exposed on `providerData` and rendered in `#attribution` |
| At least one real location renders in ink/solid/map modes | 2 | Loaded geography feeds the existing `generateCity()` and the shared `ink` / `solid` / `map` paths; live round-trip verified for a real coordinate (`-73.9857, 40.7484`) in this branch |
| Provider credentials are runtime-configured and not committed | 1, 3 | `PROVIDER TOKEN` input is `type="password"`; injected geocoder URL; `git grep` access-token scan is clean |
| No automated test depends on live provider requests | 1, 3 | `test/provider.mjs` injects `fetchImpl`; no live host is contacted |

## Out of scope / deferred

- Mapbox tile rendering (geocoder only).
- Caching or retry beyond the documented error categories.
- Geocoding autocomplete or recent-location history.
- Persistent provider configuration across reloads.

## Immediate next steps

1. Run `npm test` from the worktree.
2. Open the merged PR #53 link.
3. Clean the merged worktree (manual `git worktree remove`).
