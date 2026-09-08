# INF-4 — RFID read spike: go / no-go record

**Story:** INF-4 — "As a developer, I want an RFID read spike so we confirm a card UID
reaches the database through the check-in interface."
**AC:** A tapped UID is captured and stored via the interface; timeboxed; go / no-go recorded.

**Date:** 2026-08-28  **Timebox:** 1 day  **Reproduce:** `npm run spike:rfid`

---

## Verdict: **GO — with one hardware item still open**

The software path is proven end to end against the real MongoDB Atlas database.
The physical card read is **not** proven, because no RFID reader was attached to
the machine this spike ran on. That is the one remaining item, and it is a
procurement question, not a design question — see "Still open" below.

Calling this a plain "GO" would overstate it; calling it "NO-GO" would be wrong,
since nothing in the software path is blocked or uncertain.

---

## What was verified (7/7 automated checks)

Run against the seeded `Demo Library` organization, going through
`resolveCheckIn()` — the INF-3 interface — never around it.

| # | Check | Result |
|---|-------|--------|
| 1 | A UID typed in any reader format (`04:a2:2b:9c`, `04A22B9C`, `04 a2 2b 9c`, trailing `\r`) normalises to one canonical form | PASS — all map to `04A22B9C` |
| 2 | An unknown card resolves as `UNREGISTERED` rather than erroring — the trigger for ID-1 | PASS |
| 3 | A tapped UID is **captured and stored** in the database via the interface's own normalisation | PASS |
| 4 | The next tap of that card resolves back to the bound member | PASS |
| 5 | An unverified account resolves as `PENDING`, not `MEMBER` (spec §4) | PASS |
| 6 | A malformed UID is rejected by the interface, not by each caller | PASS |
| 7 | `method: "qr"` is refused — RFID is the only v1 implementation (INF-3 AC) | PASS |

Check 1 is the one that matters most in the field and is easy to skip: the same
physical card reports differently across readers (case, separators, a trailing
carriage return from keyboard-wedge units). Without canonicalisation at the
interface boundary, a card registered at the kiosk silently fails to resolve at
the staff desk — and that failure looks like a broken card, not a broken
normaliser. Storing and comparing one canonical form removes the whole class.
Spec §7's lost-card reissue depends on the same property.

## Key finding: no driver work is required

The common USB RFID readers for this use case (ACR122U, RC522-based units, and
essentially all "125kHz USB reader" products) present as **HID keyboard-wedge**
devices. They type the UID followed by Enter into whatever field has focus.

Consequences, all favourable:

- The kiosk needs **no driver, no serial port code, and no native dependency** —
  a focused `<input>` receives the tap. `KioskPage.jsx` is built this way.
- The same page works in a browser on any OS.
- Swapping reader models is a purchasing decision, not a code change.

This is why the spike is a GO despite the missing hardware: the integration
surface is a text input, which is already implemented and tested.

## Still open (the hardware item)

1. **Confirm on a physical reader.** Run `npm run spike:rfid -- --stdin` with a
   reader attached and tap a real card. The script reads the tap from stdin and
   runs the same 7 checks against it. Expect it to pass; the purpose is to
   confirm the UID format the chosen reader emits falls inside the
   4–32 hex-character range the normaliser accepts.
2. **Confirm the Enter key behaviour.** Some readers send Tab, some send nothing.
   `KioskPage.jsx` handles Enter and also auto-submits on a length+idle
   heuristic, but this should be observed on the actual unit.
3. **Decide the reader model** before INF-5 (AWS deploy), so the kiosk build is
   tested against the unit that will ship.

None of these block Sprint 0 or Sprint 2 work. If the chosen reader emits a
non-hex UID (some proprietary units emit decimal), the only change is the
regex in `normalizeCardUid()` in `server/src/services/checkin/rfid.js` — one
function, one place, which is itself a result of the INF-3 abstraction.

## Where the code lives

- `server/src/services/checkin/index.js` — `resolveCheckIn()`, the INF-3 interface
- `server/src/services/checkin/rfid.js` — the only v1 implementation, plus `normalizeCardUid()`
- `server/src/scripts/rfidSpike.js` — this spike, re-runnable
- `client/src/pages/KioskPage.jsx` — the keyboard-wedge capture surface
