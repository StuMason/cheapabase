# Cursors room: how far one container goes

Load tests of `examples/cursors`, run on 13 October 2026. Each bot is a real websocket client
moving its cursor 10 times a second. They ran from a GitHub Actions runner in US West with
`scripts/swarm.mjs` (the `swarm` workflow). The server was one cheapabase container capped at
1 CPU and 512MB, with `REALTIME_TICK_MS=100`.

Every client receives every other cursor, so traffic grows with the square of the room size.
State batching keeps that to one frame per client per tick. It doesn't change the square.

| Bots | Compression | Gateway CPU | Gateway RAM | Sent (JSON) | Sent (wire) | Frames per bot per second | Worst gap |
|---|---|---|---|---|---|---|---|
| 100 | off | ~9% of a core | ~55MB | 2.6MB/s | ~2.6MB/s | 8.6 | 0.7s |
| 250 | off | ~15% | ~84MB | 15.8MB/s | ~15.8MB/s | 8.2 | 0.45s |
| 250 | on | ~33% | ~60MB | 15.7MB/s | 4.7MB/s | (not recorded) | (not recorded) |
| 500 | on | 99% (capped) | ~95MB | 50MB/s | 14MB/s | 6.4 | 7.1s |

What this shows:

- **Up to 250 cursors run smoothly** either way. Memory stays under 100MB.
- **Compression (`REALTIME_COMPRESS=true`) cuts bandwidth about 3.3x but doubles CPU.** It moves
  the wall from bandwidth to CPU.
- **500 cursors is the wall for one process.** The JS thread saturates, frames slow from 10 a
  second to about 6, and stalls reach seconds. Bun runs JavaScript on one thread, so a bigger CPU cap
  won't help much.
- **1000 cursors would need about 250MB/s uncompressed**, or about 4x the CPU we had compressed.

Levers not yet tried, in order of payoff:

1. **A binary or packed frame format.** Two uint16s per cursor instead of JSON is roughly 5x smaller
   with no compression CPU.
2. **A slower tick.** 200ms halves everything, and client-side interpolation hides most of it.
3. **Interest management.** Send each client only the cursors near its own viewport.
4. **More processes.** Shard the room across instances behind a shared pub/sub.

One client gotcha: Node's built-in `WebSocket` (Node 22 and 24) can't read compressed frames sent
with Bun's `publish()`. It hands back empty strings. Browsers and the `ws` package are fine, and the
swarm uses `ws`.
