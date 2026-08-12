# Logo concepts

**Status:** exploration, nothing adopted
**Drafted:** 2026-08-12

Ten directions for the `shared-memory` mark. Eight are fresh concepts, two are
refinements of the mark currently shipping in `apps/web/public/logo.svg` and
`apps/web/app/icon.svg`.

Every concept is drafted as a real SVG in `docs/logo-concepts/`, authored the
same way the shipped mark is: a 64×64 viewBox, `currentColor` so it inherits the
surrounding text colour, round caps, and opacity rather than a second hue for
depth. That means any of them can be dropped straight into the app, and the tile
(favicon) variant is a mechanical derivation — wrap it in the rounded `#11151b`
rect and substitute the accent blues.

## How these were judged

A mark for this project has to survive three places: the browser tab at 16px,
the app header at 32–64px, and a README at whatever size GitHub renders. Small
size is the brutal filter — it is where most of the concepts below die, and it
is where the *currently shipped* mark is weakest, which is the single most
useful finding here.

Each was rendered at 120px, 24px and 16px and looked at, not just reasoned
about. The failures noted below are observed, not predicted.

---

## The concepts

### 01 · Venn core

Two outlined circles; the lens where they overlap is filled solid. The overlap
*is* the shared memory.

The most literal, most immediately-readable statement of "shared" in the set —
nobody needs it explained. That is also the problem: Venn diagrams are visual
public domain, and this would not be ownable. At 16px the two outlines fuse into
a single blob with a bright centre, which is legible but says nothing.

### 02 · Handoff

Two brackets facing each other around a single node — one session passing a
memory to the next.

Calm and symmetric, and the metaphor is exactly right for what the MCP does
across sessions. It reads as `( • )`, which unfortunately is also how a hundred
focus / aperture / eye icons read. Holds together at 16px better than 01.

### 03 · Braid

Two threads woven through each other with real over/under crossings, neither
subordinate to the other.

The most distinctive mark here by a wide margin, and the only one that looks
*crafted* rather than assembled from primitives. It also has the cleanest
meaning: two agents, one durable strand, and the weave is what makes it hold.

**It fails as a favicon.** At 16px the crossings collapse and it becomes an
unreadable smudge. This is not fixable by thickening strokes — the weave needs
the crossings to be visible, and they need room. Use it as a hero graphic or a
wordmark companion, not as the app icon.

### 04 · Return arc

An open ring with a solid node inside it: write it down, leave, come back to it.
The gap in the ring is where the next session enters.

The best small-size performer of the fresh concepts — completely legible at
16px, and the interior node keeps it from being just a shape. The risk is
literal: at small sizes it reads as a **©**. Worth checking against that
association before committing.

### 05 · Anchor

One fixed point that three separate agents reference from wherever they are.

Clean, balanced, and conceptually accurate — the memory is the fixed thing and
the clients are transient. But a three-spoke hub at this weight lands very close
to the Mercedes-Benz mark, and adjacent to the peace symbol. Both would come up
in any trademark review. Included for completeness; hard to recommend.

### 06 · Spine

A vertical spine with entries branching off it, the active one reaching furthest
to a node. An index, a ledger.

The only rectilinear mark in the set, so it stands apart from the others
immediately. It is also the most honest about what the product actually is —
a queryable index, not an abstraction. The risk is that it reads as a bar chart,
which pushes the association toward analytics rather than memory.

### 07 · Knot

A single continuous thread with no start and no end.

Renders flawlessly at every size tested — genuinely the most legible mark here.
That is its only advantage. It is the infinity symbol, which means near-zero
ownability, and it says "endless", not "shared". Kept in the set as the
legibility baseline the others are measured against.

### 08 · Triad

Three nodes joined by edges, one lit brighter than the others: the smallest
possible shared graph, with one participant currently active.

The strongest *conceptual* fit after the braid — it shows plurality, connection,
and activity in one figure, and the lit node gives it somewhere to go for a
loading or live state. Degrades gracefully: at 16px the edges thin out but three
dots in a triangle still reads. The concern is category crowding — triangular
node graphs are the default visual language of network and blockchain branding.

### 09 · Current mark, rebalanced

The shipped mark with three targeted changes, all aimed at 16px:

| | Shipped | Rebalanced |
|---|---|---|
| Converging strokes end at | `x=35` (2.5px from the node) | `x=30` (4px clear) |
| Outer stroke opacity | `.45` / `.55` | `.7` |
| Node radius | `7.5` | `8.5` |

At 16px the shipped mark loses its outer strokes to rasterisation and the
remaining gap between stroke and node fills in, so it renders as an
indeterminate horizontal smear. The rebalanced version resolves as an arrow
meeting a node at the same size.

This is the lowest-risk option on the table: it is not a rebrand, it keeps
whatever recognition the current mark has already earned, and it fixes a real
defect. It is worth doing *regardless* of what happens with the eight concepts
above.

### 10 · Lockup

Not an alternative mark — the missing asset. The rebalanced mark set against the
wordmark in the project's monospace stack, on a shared baseline, with the hyphen
dropped to 45% so `shared` and `memory` read as two things joined.

For README headers, the docs site, and the OAuth consent screen, where a bare
64px glyph is too little and the full app header is too much.

---

## Recommendation

Three separate decisions, not one:

1. **Ship 09 now.** The small-size failure of the current mark is a real defect
   and the fix is a five-line diff. It does not depend on choosing a new
   direction.
2. **Adopt 10** for the README and docs headers, using whichever mark wins.
3. **If a genuine replacement is wanted**, the shortlist is **08 Triad** (best
   concept-to-legibility ratio) and **04 Return arc** (best legibility, pending
   the © check). **03 Braid** is the most beautiful and should be used
   *somewhere* — as a hero graphic — but cannot be the icon.

Concepts 01, 05 and 07 are documented here so the reasoning against them is on
record, not because they are live candidates.
