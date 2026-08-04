# @pipeworx/ia-dmv

Iowa DOT Motor Vehicle Division driver license stations — hours, CDL testing, and the live
queue cameras Iowa points at its own waiting rooms. Keyless.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

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

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Ia Dmv data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
