# Buildings, floors, rooms and resources

SILLA now navigates through **site → building → floor → room → resource**.
Buildings and floors organize the map. The bookable targets in this release
are rooms, seats, desks and equipment. Whole buildings and floors are not
reservation targets.

## Configuring the map

1. Sign in as a superadmin and open **Editor**.
2. Choose a building, or use **Add building**. Existing installations appear
   under their site's name with **needs setup**. **Set up building** can move
   those existing floors into a named building without changing floor IDs,
   furniture, zones, labels or reservation history.
3. **Add floor** creates a grid inside the selected building and opens it.
   A floor can be renamed, resized or moved to another building at the same
   site. Move or remove its room levels before changing its building.
4. Select **Room** and drag between two corners. The room dialog asks for a
   name and its booking mode. Pieces fully inside the boundary become its
   contents; a boundary cannot cut through a piece or overlap another room.
5. To give a room a balcony or another level, open **Configure**, choose a
   building floor under **Draw on floor**, and press **Draw level**. Draw its
   boundary and save. Drawing on an existing level's floor replaces that
   level's rectangle; drawing on a different floor adds a level. Every level
   belongs to the same room and shares one reservation.
6. Continue placing resources with the existing catalog tools. Membership is
   derived from full footprint containment, so there is no second membership
   list to maintain.

Room levels must use different floors within one building. Rectangles use
integer cells and must fit their floor's grid. At least one level must remain.
Shrinking a floor cannot orphan a room, resource, zone or label. Remove rooms
and pieces before deleting a floor; a site must retain at least one floor.
An empty building can be removed from its building dialog.

## Booking rules

| Room mode | What members can reserve |
| --- | --- |
| Individual resources | Seats, desks and equipment inside the room |
| Whole room | One reservation covering all levels and everything inside |
| Either | The room or individual resources, with overlapping bookings refused |

A whole-room booking conflicts with **every** live booking inside its levels.
An individual booking conflicts with its own unit and whole-room bookings.
Other individual units remain independently bookable. Adjacent time windows
are allowed. Physically active sessions continue to block arrival until they
are released, including overstays beyond their scheduled end.

The reservation form checks the chosen window before asking the member to
confirm. That is guidance; the committed claim checks the same rules again.
Room reservations use the normal PIN confirmation, maximum stay, operating
hours, closures, check-in, check-out, reminders, cancellation and no-show
lifecycle. Early room arrival cannot occupy a seat or another room level that
is still in use.

Staff open **Space controls** to change resource availability, close/reopen
rooms and view their schedules. Room schedules include whole-room bookings
and individual bookings on all levels. Staff cannot redraw boundaries, change
booking mode or manage buildings/floors. Active or upcoming bookings must be
cancelled before structural changes or taking a booked resource out of use.
Cancellation records a reason and is scoped to the staff member's organization.

## Data and concurrency

`Building` owns a site's floors. `Room` stores its building, booking mode and
level rectangles. Each room has one internal `Resource` booking target with a
single stable unit named `room`. The existing reservation engine and workers
therefore operate on it without a parallel occupancy model.

The internal target is excluded from furniture, the placement catalog and
physical-unit counts. Its status is included on every floor containing a room
level. Whole-room status changes stream to all those floors. The minute worker
also turns future holds into reserved status when their start time arrives.
Room locks are
composed for display and never overwrite a child's manual availability or
service status. Releasing the room restores each child's own state.

Claims, check-in, cancellation, room changes, resource availability and
structural writes contend on an actual organization revision write inside a
MongoDB transaction. This prevents write skew across different room/seat IDs
and enforces one live reservation per member under concurrent requests.
MongoDB must support transactions (Atlas or a local replica set). Operations
within one organization serialize; other organizations remain independent.
If traffic outgrows this guard, partition it only with equivalent concurrency
checks for every room level and member.

Existing floor documents can have no building. Reading the hierarchy projects
them into an unassigned building without migrating or deleting anything.
Adoption is an explicit superadmin action. Removing a room retains furniture
and reservation history; reservations snapshot the target's display name.
Seed layout replacement and vertical-profile swapping refuse organizations
with configured rooms, because reseeding would invalidate their boundaries.

## Verification and local preview

From `server/`:

```sh
npm run test:spaces
npm run test:isolated
```

The spatial suite uses a disposable MongoDB replica set and does not read
`.env`. The isolated runner seeds another disposable database and runs the
existing 117 system checks with email disabled. Neither touches live Atlas.

For an isolated browser preview, start these in separate terminals:

```sh
cd server
npm run test:spaces -- --serve
```

```sh
cd client
VITE_API_URL=http://localhost:4010 VITE_DEMO_ORG_ID=6abd97aca6022143a42a51d7 npm run dev -- --host 127.0.0.1 --port 5175
```

Open `http://127.0.0.1:5175`. Preview accounts are
`superadmin0@test.silla`, `staff0@test.silla`, and `member0@test.silla`, all
with PIN `123456`. This test-only database disappears when the preview API
stops. These accounts are not production credentials.

The preview contains two buildings, a two-level Commons room, a whole-bookable
meeting room, and an equipment studio with individual booking. Browser verification covered whole-room reservation and
cancellation, room drawing, adding a level on another floor, creating a
building/floor, staff close/reopen controls, schedules and responsive navigation.
Deployment follows the existing deployment scripts; this change does not
automatically reseed or migrate a live organization.
