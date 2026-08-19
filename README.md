# Skillpath course grid

A Framer code component that renders a course catalogue from a live API.

**Live:** https://tricky-walkthroughs-513614.framer.app/

**AI conversation:** [`transcript.md`](transcript.md) — Claude Code sessions are stored
locally and have no shareable chat URL, so the session is exported into the repo instead.

One file, [`CourseGrid.tsx`](CourseGrid.tsx), pasted into Framer as a code component.
The hero and footer on the live site are Framer layers; everything from the section
heading down is this component.

See [`note.md`](note.md) for the AI-use disclosure and what I'd do with more time.

## The API

Two endpoints on `https://syncsphere-hiv6.onrender.com`:

| Endpoint | Returns |
|---|---|
| `/assignment/course-data` | 5–10 courses, count varies per call |
| `/assignment/country-code` | `{"country_code": "IN"}` or `"US"` |

Both fail on purpose roughly one call in three, with a 404 or a 500. It is also on
Render's free tier, so the first call after an idle period cold-starts.

Everything below follows from those two facts.

## Running it locally

The component imports `framer`, which only resolves inside Framer. `preview/` is a
Vite harness that stubs that import and runs the real file untouched:

```bash
npm --prefix preview install
npm --prefix preview run dev
```

Then http://localhost:5183.

`preview/` is a development aid, not part of the deliverable. `CourseGrid.tsx` is
unmodified by it — the stub is aliased in `preview/vite.config.ts`.

## Decisions that matter

**Retries, not an error state.** One attempt would show an error to a third of
visitors. Three attempts with backoff drops that to about 4%, and what still fails
gets a real error card with a manual retry rather than a blank section.

**`Promise.allSettled`, not `all`.** The two calls fail independently. A dead country
lookup must not take the course list down with it.

**A failed country lookup does not reset the currency.** The fallback is only the
initial value. Overwriting on every failure would flip a US visitor's prices to rupees
on the first retry.

**Currency and price field travel together.** `CURRENCIES` pairs `IN` with `pricePaise`
and `US` with `priceUsdCents`, so the symbol and the field it reads cannot drift apart.
Both are minor units, so both divide by 100 — `199900` paise is ₹1,999.00, not ₹1,99,900.

**Both currencies always show two decimals.** `minimumFractionDigits` and
`maximumFractionDigits` are both pinned to 2, so `199900` paise reads ₹1,999.00 and
`1050` reads ₹10.50. Pinning both ends stops `Intl` dropping the trailing zero on a
whole amount, which would otherwise render ₹10.50 and ₹1,999 side by side in the same
column. The trade is that Indian pricing is more often written ₹1,999 than ₹1,999.00;
consistency across the grid won.

**Failures are typed.** `offline`, `timeout`, and `server` each get their own copy. A
plane-mode failure and a 500 are not the same problem and should not read the same.

**Layout measures the container, not the viewport.** Framer's canvas breakpoints resize
the frame the component sits in while the browser window stays put, so a media query
would report the wrong size in the editor. `ResizeObserver` measures the thing that
actually changed. Thresholds are 960 and 640, giving 3 / 2 / 1 columns.

**One layout table.** Columns, padding, and heading size all read off `LAYOUTS`, so they
cannot disagree about what size we are at.

**Cards link only when there is somewhere to go.** `Card link` is empty by default, and
an empty base renders a plain `<article>`. Set it and each card becomes an `<a>` to
`base + courseCode`, with the anchor replacing the article so the whole card is the hit
target. A card that looks clickable and 404s is worse than one that is not.

**Focus is styled with `:focus-visible`, not `:focus`.** Hover is mouse-only, so without
a focus ring a keyboard user has no idea where they are. `:focus-visible` keeps the ring
off mouse clicks. The offset puts it on the page background so it stays visible on the
accent-filled button, and a `forced-colors` block swaps in a system colour for Windows
high contrast mode.

**The error boundary wraps the card list, and each card is its own component.** Reading
fields inline in the `.map()` would happen while the parent builds its children —
above the boundary, where nothing catches it. This one is covered in `note.md`.

## Property controls

| Control | Effect |
|---|---|
| Heading / Subheading | Section copy. Empty subheading hides it. |
| Accent | Badges, card hover, buttons. |
| Limit cards + Show at most | Caps the list. The number is hidden until the toggle is on, so no value has to double as "no limit". |
| Region | `Auto` uses the live lookup. `IN` and `US` are for previewing prices; ships as `Auto`. |
| Card link | Base URL. The course code is appended to it. Empty leaves cards unlinked. |

## Verified

Live, at 1280 / 810 / 320: 3 / 2 / 1 columns, no horizontal scroll, Inter resolving
rather than falling back, prices matching the raw payload, and the error state
rendering with a working retry when all three attempts fail. Keyboard focus rings
confirmed to appear on Tab and stay off mouse clicks.

The hero and footer sit outside the component, so a failed fetch cannot blank them.

## Known limitations

- Every mount refetches. No cache between remounts.
- Worst-case first load is three attempts at a 20s timeout. A slow-load message
  appears after 6s, but the ceiling is not bounded properly.
- The skeleton's `min-height` is a magic number tuned to the real cards.
- The card `key` reads `courseCode` outside the boundary.
- The empty state cannot occur with this API, so it has never been seen working.
- `mangoId` comes down from the API unused.
