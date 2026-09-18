# @pipeworx/ia-dmv

Iowa DOT Motor Vehicle Division driver license stations — hours, CDL testing, and the live
queue cameras Iowa points at its own waiting rooms. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1476+ live data sources.

## Why Iowa gets its own pack

This came out of splitting a single multiplexed `us-dmv` tool into one pack per state agency.
Iowa's motor-vehicle surface is a small, unusually rich station layer: 18 stations, but each one
ships **live camera image URLs and a wait-time widget**, which no other state publishes. Nothing
about that shape generalises across a union schema, so Iowa gets its own tool.

## Tools

| Tool | What it returns |
|---|---|
| `ia_dmv_driver_license_stations` | Address, per-day hours, phone, coordinates, CDL testing flag, station page, wait-time widget URL and up to four live queue-camera image URLs |

Filters: `city`, `name`, `cdl_only`, `limit`.

## The distinctive field

`url_cam1..url_cam4` are live JPEG snapshots of the station lobby, refreshed by Iowa DOT — e.g.
`https://mvdphotos.iowadot.gov/MasonCityDL.jpg`. Returned as `queue_camera_urls`, they let a
caller *see* the queue rather than guess at it. `wait_times_url` is Iowa's own per-station wait
widget. 17 of the 18 stations do CDL testing.

## Auth

None. The layer is a public ArcGIS Online feature service owned by Iowa DOT.

## Gotchas worth knowing

- **The upstream `state` column is dirty.** It contains the literal `", IA"` — with a leading
  comma — on every row. It is not passed through; `state` is normalised to `IA`.
- **No latitude/longitude columns exist** on this layer, so the query requests WGS84 geometry
  (`outSR=4326`) and reads coordinates from there.
- **A second camera slot is often a "closed" placeholder.** Mason City's `url_cam4` points at
  `MasonCityClosed.jpg`. All non-empty slots are returned as published rather than guessed at.
- **Hours list open days only.** `hours_*` carries the literal `Closed` for the rest; a day
  absent from `hours` is a closed day.
- **There is no county column.** Iowa DOT keys these stations by city. `county` is null by
  design; filter by `city`, or use the coordinates.
- **18 stations for the whole state**, so most Iowa towns have none. The not-found hint says so
  and points the caller at the full list plus coordinates rather than implying a data gap.

## What is *not* buildable for Iowa today

Iowa's richest motor-vehicle data — county-level vehicle registrations and fleet summaries —
lives on `data.iowa.gov`, which **migrated off Socrata**. Every old API path
(`/resource/<id>.json`, `/api/views/...`) now answers with an HTML 404 page from the new portal
front end rather than JSON, so a registration tool would be building on a dead endpoint.
Recheck when the new Iowa Data Hub exposes an API; until then this pack is stations only,
deliberately.

## Data source

- [Iowa DOT ArcGIS `DLSv2_View/FeatureServer/0`](https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/DLSv2_View/FeatureServer/0)
  — verified live 2026-07-30

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ia-dmv": {
      "url": "https://gateway.pipeworx.io/ia-dmv/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ia-dmv/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1476+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ia Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ia_dmv_driver_license_stations \
  -H 'Content-Type: application/json' \
  -d '{"city":"Mason City"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ia_dmv_driver_license_stations`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.
