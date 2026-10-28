# Nearby Flights

A command-line tracker and iPhone app that show airborne aircraft around each of your registered locations, using live ADS-B data from [ADSB.lol](https://adsb.lol). Each location gets its own section, nearest aircraft first.

Positions are fetched on startup and then every 5 minutes. These are periodic snapshots, not continuous tracking: aircraft passing between polls can be missed, and an empty result means the provider returned no aircraft, not necessarily that the airspace is empty.

## Usage

Requires Node.js 22 or newer.

```sh
npm install
npm run dev            # run from source (restarts on file changes)
npm run build && npm start
npm start -- --once    # fetch once, print, exit
```

| Option                | Description                                                                          |
| --------------------- | ------------------------------------------------------------------------------------ |
| `-c, --config <path>` | Location registry. Defaults to `config/locations.json`, or `$NEARBY_FLIGHTS_CONFIG`. |
| `--once`              | Fetch once, print the result and exit (exit code 1 if every location failed).        |
| `-h, --help`          | Show help.                                                                           |

On an interactive terminal the display refreshes in place, with a countdown to the next poll. Press Ctrl-C to quit. When output is redirected, each poll prints one plain, timestamped frame. Colour follows `NO_COLOR` / `FORCE_COLOR`.

Narrow terminals hide secondary columns first (track, position age, bearing, registration), then truncate long labels, then hide speed, owner and route. Short terminals show the nearest aircraft per location and say how many are hidden.

## Locations

Edit `config/locations.json`. No code changes are needed.

```json
{
  "timeZone": "Asia/Kolkata",
  "timeZoneLabel": "IST",
  "locations": [
    {
      "id": "rgia",
      "name": "RGIA, Hyderabad",
      "latitude": 17.239943874504426,
      "longitude": 78.42947104117285,
      "radiusKm": 100,
      "enabled": true
    }
  ]
}
```

- `id`: unique, lowercase letters, digits, `-` or `_`.
- `latitude` / `longitude`: decimal degrees.
- `radiusKm`: positive, at most 463 km (ADSB.lol's 250 nm limit). It is sent as `radiusKm / 1.852` nautical miles.
- `enabled`: set to `false` to keep a location without polling it. At least one must be enabled.

Invalid files are rejected at startup with a list of every problem.

The shipped RGIA coordinates were supplied by the user. The Lucknow coordinates are the AAI aerodrome reference point (26°45′43″N, 80°53′00″E). The Delhi coordinates are the AAI aerodrome reference point for Indira Gandhi International (28°34′07″N, 77°06′44″E). Raebareli is the approximate city centre with a 30 km radius, to show flights passing overhead without repeating Lucknow airport traffic 70 km away. None are detected GPS.

## Data sources

| Source                                                | Used for                                                                                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| ADSB.lol `/v2/point`                                  | Positions, altitude, ground speed, track, distance and bearing. No key needed; rate limits are dynamic.                         |
| [tar1090-db](https://github.com/wiedehopf/tar1090-db) | Registration, type and model. Cached in `apps/cli/.cache/`, revalidated weekly. The last valid copy is kept if a refresh fails. |
| ADSBdb `/v0/aircraft`                                 | Registered owner, when known. Looked up once per aircraft (hits and misses cached for 24 h).                                    |
| ADSBdb `/v0/callsign`                                 | Origin and destination airports, looked up by callsign (cached for 6 h).                                                        |

Owner and operator are kept distinct: the table shows ADSBdb's _registered owner_ when available, otherwise tar1090-db's combined owner/operator label. Each resolved field records its source, and whether a second source agrees.

### Routes

Routes are shown as airport codes, for example `DEL→BLR`. They come from a crowd-sourced database of the route _published for a callsign_, not from the aircraft itself, and airlines reuse callsigns across routes. Each route is therefore checked against the aircraft's live position: it is consistent when the aircraft is within 150 km of either airport, or inside a corridor around the great-circle path between them (15% of the route length, at least 100 km). A route that fails the check is shown in amber with a trailing `?` (for example `GAU→CCU?`) instead of being presented as fact.

No lookup is made for callsigns that are just the aircraft's registration (private and general-aviation flights such as `VTVIN`), since those have no schedule.

Not yet included, because no verified source exists: flight purpose (scheduled/private/charter/cargo) and aircraft age.

## Behaviour on failures

- Each location is fetched independently. A failure at one never blocks another.
- After a failure, the last successful snapshot stays visible and is marked `STALE`, with the time and reason. A location that has never succeeded shows `ERROR` and "aircraft count unknown", never "0 aircraft".
- Requests time out after 10 s and are retried with backoff. HTTP 429 `Retry-After` is honoured and shared across requests to that provider.
- Polling cycles never overlap, and missed cycles (for example after sleep) are not replayed in a burst.

## iPhone app

`apps/mobile` is a React Native (Expo) app with the same data and polling as the CLI: one card per location, nearest aircraft first, refreshed every 5 minutes, on returning to the app, and on pull-to-refresh. Tap an aircraft for airports, heading, speed and age of the position. The locations button turns locations on or off; the choice is saved on the phone.

The phone does not download tar1090-db (about 40 MB), so registration and model come from the ADSB.lol feed and ADSBdb. Owner/operator is shown less often than in the CLI.

The locations in `config/locations.json` are bundled when the app is built. Rebuild after editing them.

### Install on your iPhone with Xcode

Needs a Mac with Xcode and its iOS platform (Xcode > Settings > Components), and an Apple ID added under Xcode > Settings > Accounts. A free Apple ID works; the app then stops opening after 7 days and has to be installed again from Xcode. A paid developer account extends that to a year.

1. Generate the native project (it is not committed; rerun after changing `app.json` or native dependencies):

   ```sh
   npm install
   cd apps/mobile
   npx expo prebuild -p ios
   open ios/NearbyFlights.xcworkspace
   ```

2. In Xcode, select the **NearbyFlights** target, then **Signing & Capabilities**: tick _Automatically manage signing_ and choose your **Personal Team**. If Xcode reports the bundle identifier is taken, change `com.pranjalagni.nearbyflights` to something unique (in `app.json` too, so the next prebuild keeps it).
3. **Product > Scheme > Edit Scheme > Run > Build Configuration: Release.** Release builds embed the JavaScript, so the app runs without a development server.
4. On the iPhone, turn on **Settings > Privacy & Security > Developer Mode** (the phone restarts). Connect it by cable and tap _Trust_.
5. Pick the iPhone as the run destination and press **Run** (⌘R).
6. The first launch is blocked until you trust the developer: **Settings > General > VPN & Device Management**, select your Apple ID, then _Trust_.

After the first setup, `npx expo run:ios --configuration Release --device` builds and installs from the terminal.

## Development

```sh
npm run typecheck   # strict TypeScript, every workspace
npm test            # node:test, fixture-based, no network
npm run lint -w @watch-flights/mobile
npm run format      # Prettier
```

Run the app in the iOS Simulator with `npm run ios -w @watch-flights/mobile`.

The repo is an npm workspace:

| Path            | Contents                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core` | Providers, enrichment, polling and formatting. Web-standard APIs only (`fetch`, `TextDecoder`), so the same code runs on Node and React Native. |
| `apps/cli`      | The terminal UI, plus the Node-only parts: config file loading and the on-disk tar1090-db cache.                                                |
| `apps/mobile`   | The iPhone app.                                                                                                                                 |
| `config`        | The shared location registry.                                                                                                                   |

Tests use `packages/core/test/fixtures/adsb.json` (a real ADSB.lol response near RGIA), a sample of tar1090-db rows, ADSBdb responses, mocked `fetch` and a controllable clock.
