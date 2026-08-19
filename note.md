**AI used.** Claude, via Claude Code. Chat link in the README.

**Mine vs its.** The data-layer plan was mine: check `res.ok`, since fetch doesn't reject
on a 404 or 500; `allSettled` rather than `all`, so a dead country lookup
can't take the course list with it; one `status` value instead of three
booleans; `AbortController` so a slow response can't overwrite a newer one. Claude wrote the code from that
and caught bugs I'd have shipped.

**Where I got stuck.** The error boundary. I added it, tested it, and the page still
went blank — `.map()` runs in the parent's render, so the field read happened above the
boundary, where nothing catches it. Fixing it meant pulling each card into its own
component.

**With two more days.** The API cold-starts on Render's free tier, so a first load can sit
on skeletons a while — worst case is three attempts at a 20s timeout. I'd bound that
properly and cache between remounts; today every mount refetches.

**Not happy with.** The skeleton's 205px min-height is a magic number. The `key` read sits outside the boundary. And the empty state can't
happen with this API, so it has never been seen working.
