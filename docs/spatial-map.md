# Buildings, floors, rooms and resources

SILLA's map follows the space the way it is built: **site → building → floor →
room → resource**. Buildings and floors organize the map; members book rooms
(as a whole) and the resources inside them — seats, desks, equipment, in the
organization's own words. Whole buildings and floors are not bookable.

Floors, rooms and zones need not be rectangles. Any square-cornered shape the
grid allows — an L, a T, a U, a floor around a courtyard — is drawn, edited and
enforced as itself (see [Shapes](#shapes)).

## What a member sees

The map page reads top to bottom in the same order:

| Row | Shows | Notes |
| --- | --- | --- |
| Breadcrumb | `Building › Floor › Room` | The floor steps back out of a room. |
| Building | A switcher | Only when there is more than one building to choose. |
| Floor | Tabs | Every floor of the building at once. |
| Rooms on the floor | One tab per room, plus "All of *floor*" | Each says what it offers — "Whole room only", "Whole room or a desk", "Pick a desk" — or its live state ("Booked now", "In use now", "Closed"). Scrolls sideways when there are many. |

The floor plan draws the building's real outline: only the floor's own cells
have a surface and the grid, with a wall along their edge, so an L-shaped
floor's missing corner is empty page rather than floor nobody may use. It
draws each room as a named outline with its furniture inside — one outline
whatever the room's shape, with the name in its largest part. Tapping any cell
of a room chooses it.
A free room is neutral; a room booked, in use or closed takes that state's
colour and a pill with an icon (colour is never the only signal). Furniture in
a room that is only booked whole is drawn as part of the room — neutral, with
a door icon — rather than as unavailable seats. Room names are sized for the
screen, so they stay readable when a whole floor fits a phone. The legend at
the foot explains every mark, including "Room" and "Comes with its room", and
counts only units a member could book on their own.

Choosing a room (its tab, or its outline) zooms the plan to it and opens the
**room panel**:

- **When?** — a start and a length. This one window is shared by the whole page:
  the time chosen here is the time confirmed later.
- **What would you like to book?** — in plain words, only what the room allows:
  - *Book the whole room* (whole or either): free for that time, or why not.
  - *Pick a <resource> inside* (individual or either): "4 of 5 free for this
    time", then each piece with its units. Hovering a unit outlines it on the map.
- For a room on several floors, the levels it covers, with a switch to see each.

Availability is answered for the **chosen** time, not for right now, from one
request for the whole room (`GET /api/reservations/rooms/:id/options`). It is
re-asked when the time changes and when the map's live status moves. It is
guidance; the booking checks everything again when it commits.

Picking an option opens the confirmation: the same time, "Free for this time"
or the reason it is not, the PIN, and *Reserve*. A missing PIN is only pointed
out when *Reserve* is pressed. A member holding a reservation sees it at the top
of the panel with *Cancel reservation* (confirmed in a second step); other
options stay visible but explain that one reservation is the limit.

Status streams live (MAP-2): another member's booking changes the colours, the
room panel's counts and its answers without a reload.

**On a phone** the panel is a bottom sheet docked under the map — the map
shrinks rather than being covered — and its handle folds it to its title. While
a room is open the building, floor and room rows fold away and the breadcrumb
does the navigating. A reservation reminder arrives folded. Nothing scrolls
sideways except the room row.

## Configuring the map

Superadmins open **Editor**. Above the map are three numbered steps; the first
one still to do is highlighted and says what to do next:

1. **Building** — the building switcher, *Rename*, *Add building*. Floors that
   predate buildings appear as "*site* — needs setup": *Set up building* names
   the building and, with *Move the existing floors into this building*,
   adopts them without changing floor ids, furniture, zones, labels or booking
   history. Loose floors anywhere else are announced above the steps with the
   same action.
2. **Floors** — the building's floors as tabs, and *Add floor*: a name and a
   sketch. Drag a *Rectangle*, then *Add area* or *Cut area* for an L, a T or a
   U; only the shape is kept, not where it was drawn. The open floor's name,
   size and building are under **Floor settings** below the map, with *Remove
   floor*.
3. **Rooms** — *Draw a room*, then drag a box around it on the map. Only cells
   that are floor are kept, so a box dragged across an L's missing corner gives
   an L-shaped room. A dialog asks for its name and **what members can book
   here**: *One <resource> at a time*, *Whole room*, or *Whole room or one at a
   time*, each explained in a sentence. Pieces wholly inside the boundary become
   its contents; a boundary cannot cut through a piece or share a cell with
   another room.

A room's **Settings** (from the rooms panel, or by clicking the room on the map)
change its name and booking mode, name its levels, and *Draw a level on* another
floor of the building — a balcony shares the room's one booking. Drawing on a
floor the room already reaches redraws that level. Each level shows its shape,
with *Add to room* and *Cut from room*: the dialog closes for a drag on the map
(the result is previewed before you let go) and comes back with the new shape,
saved with everything else — this is how a room becomes an L or a T. *Remove
room* keeps its furniture and booking history.

The toolbar's other tools place and remove furniture, draw zones and add labels
as before, plus **Shape**, which redraws the open floor's outline: *Add area* /
*Cut area*, a drag previewed live with the whole grid shown faintly, *Undo*,
*Reset to rectangle*, *Discard* and *Save outline*. A save that would leave
anything outside the floor is refused in place, in words that say what
("1 piece and the room “Commons” are in the part you're removing"), and the map
outlines each of those things. Zones are reshaped from the zones list the same
way (*Add to* / *Cut from*, saved at once).

Room levels must use different floors of one building, in whole cells inside
the floor's outline; at least one level remains. Shrinking or reshaping a floor
cannot orphan a room, piece, zone or label, and only an empty floor can be
removed (a site keeps at least one). An empty building can be removed from its
rename dialog.

**Staff** open **Space controls**: the same map with building and floor
navigation, availability (unavailable, out of service) by clicking a unit, and
for each room *Close*/*Reopen* and its *Schedule*, where bookings of the room
and of everything inside it can be cancelled. Staff are not shown the setup
steps, booking modes or layout tools — the server refuses them regardless.

## Booking rules

| Room mode | What members can reserve |
| --- | --- |
| One at a time (`individual`) | The seats, desks and equipment inside, each on its own |
| Whole room (`whole`) | One reservation covering all levels and everything inside |
| Either (`either`) | The room or individual units, with overlapping bookings refused |

A whole-room booking conflicts with **every** live booking inside its levels.
An individual booking conflicts with its own unit and with whole-room bookings.
Other units stay independently bookable. Adjacent windows are allowed. A
session physically in progress blocks arrival until it is released, including
an overstay past its scheduled end.

Room reservations use the normal PIN confirmation, maximum stay, operating
hours, closures, check-in, check-out, reminders, cancellation and no-show
lifecycle. Arriving early for a room cannot occupy it while a seat or level
inside is still in use. Active or upcoming bookings must be cancelled before a
room is changed or closed, or a booked unit is taken out of use.

## Shapes

A shape is a **set of grid cells**. The map was always whole cells, so any
outline with square corners is exactly a set of cells, and every question the
map asks of one is a set question: is this piece on the floor (all its cells
are), do two rooms overlap (they share a cell), does a boundary cut a piece
(some of its cells are in, some out). `lib/cells.js` holds that geometry once;
the client keeps a byte-identical copy (no cross-imports), and the geometry
suite fails if the two differ.

Stored, a shape is a short list of rectangles, `areas: [{ col, row, w, h }]`,
in a canonical form — the same cells always store the same rectangles, so an L
is two whatever drags made it:

| Where | Field | When absent or empty |
| --- | --- | --- |
| Floor | `shape.areas` — the cells that ARE the floor | the whole grid |
| Room level | `areas`, with `bounds` kept as their bounding box | the one `bounds` rectangle |
| Zone | `areas`, with `bounds` kept as their bounding box | the one `bounds` rectangle |

Absent means what it always meant, so **nothing was migrated**: every floor,
room and zone written before shapes reads and behaves exactly as before. New
writes store `areas` and keep `bounds`, so anything that predates shapes still
finds roughly where a room is. An outline that covers the whole grid is stored
as no outline, keeping a plain floor's meaning: grow the grid and the floor
grows with it. The layout (`GET /api/floors/:id/layout`), the hierarchy and the
floor list carry `floor.shape.areas` (empty for a plain floor); rooms and zones
carry `areas` always, a legacy one reporting its `bounds` as its one area.

The rules, all enforced on the server inside the space transaction:

- **Everything sits on the floor.** Every cell of a piece's footprint, every cell
  of a zone or room level, and a label's cell must be inside the floor's
  outline, not merely its grid; anything else is refused, saying so.
- **Reshaping strands nothing.** A new outline (`PATCH /api/floors/:id
  { shape }`, `null` to reset) or a smaller grid is refused with 409 while
  anything would be left outside, naming what and listing their ids. A smaller
  grid trims a shaped floor's outline to the new edge; a larger one leaves it
  as it was.
- **Rooms tile, never stack.** Two rooms may not share a single cell; a room may
  not cut through a piece. Membership is full footprint containment in the
  level's union, so a piece in either arm of an L belongs to the room, and a
  whole-room booking covers every area of every level.
- **Limits.** Whole cells only, at most 200 rectangles per shape. Curves and
  diagonal walls are out of scope: on a grid they can only be staircases of
  cells. The portal's configurator still describes rectangular floors only;
  shape a provisioned floor in the editor.

## Plan limits

A managed organization's plan (`Organization.entitlements`, see
`docs/control-plane.md` §2) is enforced on the map only through
`server/src/services/entitlements.js`, inside the same transaction as the
creation, so two creations cannot both pass a count of "one left":

| Action | Check | Refusal |
| --- | --- | --- |
| Create a building (including *Set up building*) | `assertWithinLimit("buildings")` | 403 `PLAN_LIMIT` |
| Create a floor | `assertWithinLimit("floors")` | 403 `PLAN_LIMIT` |
| Draw a room | `assertWithinLimit("rooms")` | 403 `PLAN_LIMIT` |
| Place a piece | `assertWithinLimit("resources", seats)` — the bookable units it adds; none for a piece nobody books | 403 `PLAN_LIMIT` |
| Create a room as whole/either, or **change** one to whole/either | `assertFeature("wholeRoomBooking")` | 403 `PLAN_FEATURE` |
| A new whole-room booking (and its preview) | `assertFeature("wholeRoomBooking")` | 403 `PLAN_FEATURE` |

Refusals carry `limit`, `max`, `used` and `adding` (or `feature`) through
app.js's error handler. Limits block new things only: a room booked whole before
a downgrade can still be renamed or redrawn, and its existing bookings checked
into. Organizations that are not managed — every one that exists today — have
no limits and every feature.

The editor reads the same entitlements (`useOrg().entitlements`) and the same
counts (`GET /api/spaces/usage`, superadmin) to show "3 of 5 rooms" in each step
and "44 of 60 bookable desks" in the place tool. At a cap, the step's Add, the
Room tool and the loose-floors *Set up building* are replaced by a sentence
saying why. Without whole-room booking, the room dialog shows the whole-room
choices but does not offer them, keeping a room's existing choice. Members see
"Booking a whole room isn't available here at the moment" rather than a message
addressed to an administrator.

## Data and concurrency

`Building` owns a site's floors. `Room` stores its building, booking mode and
level rectangles. Each room has one internal `Resource` booking target with a
single unit named `room`, so the reservation engine and workers handle
whole-room bookings without a parallel occupancy model. The target is excluded
from furniture, the catalog, plan unit counts and physical-unit counts; its
status is streamed to every floor the room reaches.

Membership is derived from containment in the room's shape, never stored. Room locks are composed
for display (`effectiveRoomState`, `effectiveStatus`) and never overwrite a
unit's own availability, so releasing the room restores each unit's state.

**Claims, check-in, cancellation, room changes, availability and structural
writes** — floors and their outlines, pieces, zones and labels included —
contend on an actual write to the organization's `spaceRevision` inside a
MongoDB transaction (`withSpaceTransaction`). Zones and labels joined that guard
with shapes: written outside it, one placed in a corner being cut away could
commit beside the cut and be left off the floor (the spatial suite races the
two, and fails every time against the old writes). That turns write skew between a
room and a seat inside it into a write conflict, and enforces one live
reservation per member under concurrency. A conflict is retried with a short,
jittered, growing pause, at most `MAX_ATTEMPTS` (10) times; then the request is
refused with 503 `BUSY` and "A lot is changing on the map right now, so nothing
was saved. Please try again in a moment." — instead of the driver's two-minute
retry ending in a driver error. Different organizations never contend.
MongoDB must support transactions (Atlas or a replica set).

**The minute worker** (`workers/scheduler.js`) reads a batch and works through
it, so each move it makes is conditional on the state it read
(`services/reservations/lifecycle.js`): a member who taps in, taps out or
cancels after the batch was read keeps their newer state. Closing time picks
released or expired from the live status in one update, and a reminder's
sent-once flag is claimed before the email goes. Each job runs in its own try,
so one failing job does not starve the rest.

**Map status** is derived from reservations and written back; a refresh
re-derives after writing until two answers agree, so a refresh that read before
a booking committed cannot leave a stale colour behind. Side effects after a
commit (the map update, the confirmation email) log instead of failing a
booking that already exists.

Existing floors can have no building. Reading the hierarchy projects them into
an unassigned building without migrating anything; adoption is an explicit
superadmin action. Removing a room keeps its furniture and reservation history
(reservations snapshot the target's display name). Seed layout replacement and
vertical-profile swapping refuse organizations with configured rooms, because
reseeding would invalidate their boundaries.

## Verification and local preview

From `server/`:

```sh
npm run test:spaces     # 52 geometry checks, then 110 spatial checks
npm run test:cells      # the geometry checks alone (no database)
npm run test:isolated   # the 117 system checks
```

Both run on disposable MongoDB replica sets and never read `.env` or touch
Atlas. The geometry suite (`tests/cells.test.mjs`) covers cells and rectangles,
the canonical form, containment, outlines, label placement, validation and the
fallbacks for documents written before shapes, and checks the client's copy is
identical. The spatial suite covers the hierarchy, room rules, racing claims,
the retry bound, the scheduler's races (each confirmed to fail against the old
unconditional saves), room options agreeing unit by unit with the single-unit
preview, plan limits against a managed organization written straight into the
test database, and shapes: outline validation, placement outside an L refused,
reshapes refused and allowed, grid resizing, L-shaped rooms and zones, a shared
cell as an overlap, whole-room bookings across both arms, a reshape racing
placements, and legacy documents (fields unset in the database) behaving as
before.

For a browser preview, start these in separate terminals:

```sh
cd server
npm run test:spaces -- --serve             # add --managed to preview a limited plan,
                                           # --port=4011 if another preview holds 4010
```

```sh
cd client
VITE_API_URL=http://localhost:4010 VITE_DEMO_ORG_ID=6abd97aca6022143a42a51d7 npx vite --host 127.0.0.1 --port 5175 --strictPort
```

Open `http://127.0.0.1:5175`. The preview accounts are
`superadmin0@test.silla`, `staff0@test.silla` and `member0@test.silla`, all with
PIN `123456`; they are test-only and the database disappears when the preview
API stops. The organization calls its units "desks". It has Building 1 (Ground:
the two-level Commons, whole-or-desk, and a whole-only meeting room with a
six-seat table; open-plan desks in every state; Upper: the Commons balcony and
focus desks), Building 2 (a focus studio booked one desk at a time), a
Shaped building left by the shape checks (an L-shaped floor with an L-shaped
reading room, a T-shaped hall, and a floor whose room and zone are written as
before shapes), and a South annex site whose floor predates buildings, to show
*Set up building*. With
`--managed` the organization is on a plan with whole-room booking withheld and
its building and room limits reached.

Deployment follows the existing deployment scripts; nothing here reseeds or
migrates a live organization.
