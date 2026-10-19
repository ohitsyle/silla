import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router-dom";
import { motion } from "framer-motion";
import {
  BarChart3, CalendarX, ChevronRight, CreditCard, Download, Map as MapIcon, Palette, ShieldCheck, TriangleAlert,
  Wrench,
} from "lucide-react";
import { api } from "../lib/api.js";
import { DEFAULT_ADMIN_SECTION, sectionsFor } from "../lib/adminSections.js";
import HourHistogram from "../components/HourHistogram.jsx";
import PlanUsage from "../components/PlanUsage.jsx";
import UpgradePrompt from "../components/UpgradePrompt.jsx";
import SpaceMap from "../components/SpaceMap.jsx";
import { contrastRatio, resolveStatePalette, toRgbChannels } from "../theme/applyOrgTheme.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import {
  Badge, Button, Card, EmptyState, Field, Loading, Modal, Notice, Page, PageHeader, Panel,
  Segmented, Select, SkeletonRows, SkeletonStats, Stat, StatusDot, listContainer, pageEnter,
} from "../components/ui/index.jsx";
import { unitName } from "../lib/names.js";

/**
 * AdminPage — the admin surface (spec §14, ADM-1..ADM-5 + RPT-1).
 *
 * Desktop-only by design, as the spec states. Staff see the operational
 * tabs; Staff Management and Settings are superadmin-only, gated both
 * here and on the server — the client gate is convenience, the server
 * gate is the actual control.
 */


const cx = (...parts) => parts.filter(Boolean).join(" ");

export default function AdminPage() {
  const { org } = useOrg();
  const { user, booting, isAuthenticated } = useAuth();
  const { section } = useParams();

  if (booting) return <Loading />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user && !["staff", "superadmin"].includes(user.role)) {
    return (
      <Page>
        <Notice>The admin surface is for staff accounts.</Notice>
        <Link to="/map" className="mt-4 inline-block text-sm text-accent underline underline-offset-4">
          Back to the map
        </Link>
      </Page>
    );
  }

  const isSuperadmin = user?.role === "superadmin";
  const allowed = sectionsFor(user?.role);

  // An unknown or forbidden section in the URL falls back rather than
  // rendering nothing — a mistyped link should still land somewhere.
  const active = allowed.some((s) => s.key === section) ? section : DEFAULT_ADMIN_SECTION;
  const current = allowed.find((s) => s.key === active);

  return (
    <Page>
      {/* The section list moved to the sidebar, so the page states which
          one it is showing rather than repeating the whole set of tabs. */}
      <PageHeader
        title={current?.label || "Console"}
        subtitle={`${org?.name || "This organization"} · ${user?.role === "superadmin" ? "superadmin" : "staff"} view`}
      />

      {active === "dashboard" && <Dashboard />}
      {active === "resources" && <Resources />}
      {active === "members" && <Members org={org} />}
      {active === "staff" && isSuperadmin && <Staff />}
      {active === "settings" && isSuperadmin && <Settings />}
      {active === "reports" && <Reports />}
      {active === "plan" && <PlanUsage />}
    </Page>
  );
}

/* ───────────────────────── ADM-1 ───────────────────────── */

function Dashboard() {
  const navigate = useNavigate();
  const { org } = useOrg();
  const [floorId, setFloorId] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [plan, setPlan] = useState(null);
  const palette = useMemo(() => resolveStatePalette(org), [org]);

  const load = useCallback(() => {
    api.adminDashboard(floorId || undefined).then(setData).catch((e) => setError(e.message));
  }, [floorId]);

  useEffect(() => {
    load();
    // The dashboard is a live view (spec §14) — poll as a floor for the
    // metrics, which are derived across floors and so aren't covered by
    // the per-floor socket room.
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  /**
   * The floor itself, under the numbers.
   *
   * A console for a SPATIAL product that shows only counts makes you
   * translate "1 overstay" into "which desk" in your head, and left
   * half the screen empty doing it. This is the same layout the map
   * draws, read-only: staff see where the problem is, not just that
   * there is one.
   */
  useEffect(() => {
    const target = floorId || data?.floors?.[0]?.id;
    if (!target) return undefined;
    let cancelled = false;
    api
      .getFloorLayout(target)
      .then((d) => !cancelled && setPlan(d))
      .catch(() => !cancelled && setPlan(null));
    return () => {
      cancelled = true;
    };
  }, [floorId, data?.floors]);

  if (error) return <Notice tone="error">{error}</Notice>;
  if (!data) {
    return (
      <div className="space-y-5">
        <SkeletonStats />
        <SkeletonStats count={3} />
      </div>
    );
  }

  const m = data.metrics;
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const floorName = (id) => data.floors.find((f) => f.id === id)?.name || null;
  return (
    <div className="space-y-5">
      <Segmented
        className="dashfloors"
        size="sm"
        value={floorId}
        onChange={setFloorId}
        options={[{ value: "", label: "All floors" }, ...data.floors.map((f) => ({ value: f.id, label: f.name }))]}
      />

      {/*
        Both groups sit on the SAME four-column basis. They were a
        four-up row above a three-up row, so no card in the second row
        lined up with anything in the first and the block read as two
        unrelated widgets. The labels earn the split: the top group is
        what the space IS right now, the bottom is what is happening in
        it.
      */}
      <div>
        <SectionLabel>Capacity</SectionLabel>
        <motion.div {...listContainer()} className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Open" value={m.open} sub={`of ${m.total}`} tone="available"
                progress={m.total ? m.open / m.total : 0} />
          <Stat label="Occupied" value={m.occupied} tone="occupied"
                progress={m.total ? m.occupied / m.total : 0} />
          <Stat label="Reserved" value={m.reserved} tone="reserved"
                progress={m.total ? m.reserved / m.total : 0} />
          <Stat label="Unavailable" value={m.unavailable} sub={`${m.outOfService} out of service`}
                tone="unavailable" progress={m.total ? m.unavailable / m.total : 0} />
        </motion.div>
      </div>

      <div>
        <SectionLabel>Right now</SectionLabel>
        <motion.div {...listContainer()} className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Stat label="Active sessions" value={m.activeSessions} />
          <Stat label="Upcoming holds" value={m.upcomingHolds} />
          <Stat label="Overstays" value={m.overstays} tone="overstay" />
        </motion.div>
      </div>

      {plan?.layout && (
        <Card padded={false} className="overflow-hidden">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pt-3">
            <span className="font-medium">{plan.floor?.name}</span>
            <span className="text-sm text-ink-muted">
              {floorId ? "selected floor" : "first floor — pick one above to change"}
            </span>
            <button
              type="button"
              onClick={() => navigate(`/map/${plan.floor.id}`)}
              className="ml-auto inline-flex items-center gap-1.5 text-sm text-ink-secondary
                         transition-colors duration-fast hover:text-ink-primary"
            >
              Open in the map
              <MapIcon size={14} />
            </button>
          </div>
          {/* Read-only: the console changes availability through the
              Resources section, where the change is explicit. A map that
              silently toggled a desk on click would be a trap here. */}
          <div className="pointer-events-none px-2 pb-2">
            <SpaceMap
              floor={plan.floor}
              layout={plan.layout}
              resourceTypes={plan.resourceTypes}
              status={plan.status}
              resourceNoun={org?.terminology?.resourceNoun || "resource"}
              showOverstay
              palette={palette}
            />
          </div>
        </Card>
      )}

      {/* "Overstay renders as a distinct staff-only alert state; the
          metric is clickable to jump to the resource." */}
      {data.overstays.length > 0 && (
        <Panel title={`Overstays (${data.overstays.length})`} icon={TriangleAlert}>
          <ul className="divide-y divide-line/10">
            {data.overstays.map((o) => (
              <li key={`${o.resourceId}-${o.unitLabel}`} className="py-2 flex items-center gap-3 text-sm">
                <span className="text-ink-primary">
                  {o.label || `${resourceNoun} ${o.unitLabel}`}
                  {floorName(o.floorId) && <span className="text-ink-muted"> · {floorName(o.floorId)}</span>}
                </span>
                <Button size="sm" icon={MapIcon} onClick={() => navigate(`/map/${o.floorId}`)} className="ml-auto">
                  Show on map
                </Button>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </div>
  );
}

/* ───────────────────────── ADM-2 ───────────────────────── */

/**
 * ADM-2 — availability and service status, by zone.
 *
 * This was 6,000 pixels of scrolling: every zone expanded, every piece a
 * full-width card, and the word "Disable" printed once per unit — five
 * times a row, a wall of the same verb. Nothing could be collapsed, so
 * finding one desk meant scrolling past every other.
 *
 * Now: zones collapse, each piece is one row, and the unit chip IS the
 * control. Clicking a chip toggles it, which removes five buttons per
 * row and puts the state and the action in the same place.
 */
function Resources() {
  const { org } = useOrg();
  const palette = useMemo(() => resolveStatePalette(org), [org]);
  const [groups, setGroups] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(null);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState({});
  const [floors, setFloors] = useState([]);
  const [floorId, setFloorId] = useState("");
  const [plan, setPlan] = useState(null);
  /** The row under the cursor, lit up on the map beside it. */
  const [hovered, setHovered] = useState(null);

  useEffect(() => {
    const orgId = org?.id || org?._id;
    if (!orgId) return;
    api
      .getFloors(orgId)
      .then((d) => {
        setFloors(d.floors);
        setFloorId((current) => current || d.floors[0]?.id || "");
      })
      .catch(() => setFloors([]));
  }, [org]);

  /**
   * The floor beside the list.
   *
   * Without it a row reads "Long Table (2, 2)" with chips 1–5 and there
   * is no way to know WHICH seat chip 3 is — you would have to open the
   * map in another tab and count. Hovering a row lights its units here,
   * so the thing you are about to change is visible while you change it.
   */
  useEffect(() => {
    if (!floorId) return undefined;
    let cancelled = false;
    api
      .getFloorLayout(floorId)
      .then((d) => !cancelled && setPlan(d))
      .catch(() => !cancelled && setPlan(null));
    return () => {
      cancelled = true;
    };
  }, [floorId, groups]);

  const load = useCallback(() => {
    api
      .adminResources(floorId || undefined)
      .then((d) => {
        setGroups(d.groups);
        // Open the first zone, collapse the rest — on first load only.
        // All-expanded was three thousand pixels of scrolling; all
        // collapsed is a page of headings that makes you click before
        // you can see anything. One open zone shows the shape of the
        // thing and keeps the page short. `setCollapsed` is left alone
        // afterwards so a refresh does not undo what you opened.
        setCollapsed((current) =>
          Object.keys(current).length > 0
            ? current
            : Object.fromEntries(d.groups.slice(1).map((g) => [g.zoneId || "unzoned", true]))
        );
      })
      .catch((e) => setError(e.message));
  }, [floorId]);
  useEffect(load, [load]);

  const setUnit = async (resourceId, label, patch) => {
    setBusy(`${resourceId}:${label}`);
    setError(null);
    try {
      await api.adminSetUnit(resourceId, label, patch);
      load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  // A failed change (a plan refusal, a paused organization) is said above
  // the list; only a list that never loaded is replaced by its error.
  if (error && !groups) return <Notice tone="error">{error}</Notice>;
  if (!groups) return <SkeletonRows count={6} />;

  const term = query.trim().toLowerCase();
  const shown = groups
    .map((g) => ({
      ...g,
      resources: term
        ? g.resources.filter(
            (r) =>
              (r.name || r.typeLabel).toLowerCase().includes(term) ||
              r.typeLabel.toLowerCase().includes(term) ||
              g.zoneName.toLowerCase().includes(term) ||
              `${r.position.col},${r.position.row}`.includes(term.replace(/\s/g, ""))
          )
        : g.resources,
    }))
    .filter((g) => g.resources.length > 0);

  const tally = (resources) => {
    const counts = { available: 0, unavailable: 0, out_of_service: 0, busy: 0, units: 0 };
    for (const r of resources) {
      for (const u of r.units) {
        counts.units += 1;
        if (u.serviceStatus === "out_of_service") counts.out_of_service += 1;
        else if (u.status === "unavailable") counts.unavailable += 1;
        else if (u.status === "available") counts.available += 1;
        else counts.busy += 1;
      }
    }
    return counts;
  };

  const allCollapsed = shown.every((g) => collapsed[g.zoneId || "unzoned"]);

  return (
    <div className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}
      {floors.length > 1 && (
        <Segmented
          size="sm"
          value={floorId}
          onChange={setFloorId}
          options={floors.map((f) => ({ value: f.id, label: f.name }))}
        />
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Field
          className="flex-1 min-w-[220px]"
          placeholder="Filter by name, type or zone…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter resources"
        />
        <Button
          size="sm"
          onClick={() =>
            setCollapsed(
              allCollapsed ? {} : Object.fromEntries(shown.map((g) => [g.zoneId || "unzoned", true]))
            )
          }
        >
          {allCollapsed ? "Expand all" : "Collapse all"}
        </Button>
      </div>

      <p className="text-xs text-ink-muted">
        Grouped by room and zone — membership follows the map. Click a
        {" "}
        {"unit"} to change its availability.
      </p>

      {shown.length === 0 && (
        <EmptyState icon={Wrench} title="Nothing matches" body="Try a different filter." />
      )}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px] items-start">
        <div className="space-y-3">
      {shown.map((g) => {
        const key = g.zoneId || "unzoned";
        const isCollapsed = Boolean(collapsed[key]);
        const counts = tally(g.resources);
        return (
          <Card key={key} padded={false} className="overflow-hidden">
            <button
              type="button"
              onClick={() => setCollapsed((c) => ({ ...c, [key]: !c[key] }))}
              aria-expanded={!isCollapsed}
              className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors
                         duration-fast hover:bg-line/[0.04]"
            >
              <ChevronRight
                size={16}
                className="shrink-0 text-ink-muted transition-transform duration-fast"
                style={{ transform: isCollapsed ? undefined : "rotate(90deg)" }}
              />
              <span className="font-medium">{g.zoneName}</span>
              <span className="text-sm text-ink-muted">
                {g.resources.length} {g.resources.length === 1 ? "piece" : "pieces"} · {counts.units} units
              </span>
              {/* The summary is the point of collapsing: you should not
                  have to expand a zone to see whether it needs you. */}
              <span className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                {counts.available > 0 && <StatusDot tone="available" label="free" count={counts.available} />}
                {counts.busy > 0 && <StatusDot tone="occupied" label="in use" count={counts.busy} />}
                {counts.unavailable > 0 && (
                  <StatusDot tone="unavailable" label="off" count={counts.unavailable} />
                )}
                {counts.out_of_service > 0 && (
                  <StatusDot tone="unavailable" label="broken" count={counts.out_of_service} outline />
                )}
              </span>
            </button>

            {!isCollapsed && (
              <div className="border-t border-line/10">
                {g.resources.map((r) => (
                  <div
                    key={r.id}
                    onMouseEnter={() =>
                      setHovered(r.units.map((u) => ({ resourceId: r.id, unitLabel: u.label })))
                    }
                    onMouseLeave={() => setHovered(null)}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line/[0.06]
                               px-4 py-2.5 last:border-b-0 transition-colors duration-fast
                               hover:bg-line/[0.05]"
                  >
                    {/* "Long Table 2" — the name members see on the map, not
                        a type and a grid coordinate. */}
                    <span className="min-w-[150px] text-sm font-medium">{r.name || r.typeLabel}</span>
                    <div className="ml-auto flex flex-wrap items-center gap-1.5">
                      {r.units.map((u) => (
                        <UnitChip
                          key={u.label}
                          unit={u}
                          name={unitName({
                            piece: r.name || r.typeLabel,
                            unitLabel: u.label,
                            units: r.units.length,
                            noun: org?.terminology?.resourceNoun || "resource",
                          })}
                          busy={busy === `${r.id}:${u.label}`}
                          hasServiceStatus={r.hasServiceStatus}
                          onToggleAvailability={() =>
                            setUnit(r.id, u.label, {
                              status: u.status === "unavailable" ? "available" : "unavailable",
                            })
                          }
                          onToggleService={() =>
                            setUnit(r.id, u.label, {
                              serviceStatus: u.serviceStatus === "out_of_service" ? "working" : "out_of_service",
                            })
                          }
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
        </div>

        {/* The floor, beside the list. Sticky so it stays put while the
            list scrolls — the whole point is being able to see the seat
            you are about to change without leaving the row. */}
        {plan?.layout && (
          <Card padded={false} className="hidden xl:block overflow-hidden xl:sticky xl:top-4">
            <div className="px-4 pt-3 pb-1 text-sm">
              <span className="font-medium">{plan.floor?.name}</span>
              <span className="ml-2 text-ink-muted">
                {hovered ? "highlighted below" : "hover a row to locate it"}
              </span>
            </div>
            <div className="pointer-events-none px-2 pb-2">
              <SpaceMap
                floor={plan.floor}
                layout={plan.layout}
                resourceTypes={plan.resourceTypes}
                status={plan.status}
                resourceNoun={org?.terminology?.resourceNoun || "resource"}
                showOverstay
                palette={palette}
                highlight={hovered || []}
              />
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

/**
 * One unit, as a chip that is also its own control.
 *
 * Colour is never the only signal (spec §12): the chip carries the unit
 * label, an unavailable one is struck through, and an out-of-service one
 * is outlined rather than filled — so the three states are still
 * distinguishable without colour vision.
 *
 * Occupied and reserved are DERIVED from a live reservation, so they are
 * not togglable here: the honest action is to cancel the reservation,
 * and a control that silently did nothing would be worse than none.
 */
function UnitChip({ unit, name, busy, hasServiceStatus, onToggleAvailability, onToggleService }) {
  const derived = unit.status === "occupied" || unit.status === "reserved";
  const broken = unit.serviceStatus === "out_of_service";
  const off = unit.status === "unavailable";

  const label = broken ? "out of service" : off ? "unavailable" : unit.status;

  return (
    <span className="inline-flex items-center">
      <button
        type="button"
        disabled={derived || busy}
        onClick={onToggleAvailability}
        aria-label={`${name} — ${label}${derived ? "" : off ? ", enable" : ", disable"}`}
        title={
          derived
            ? "Held by a reservation — cancel that instead"
            : off
              ? "Click to make available"
              : "Click to make unavailable"
        }
        className={cx(
          "grid h-7 min-w-[28px] place-items-center rounded-md px-1.5 text-xs font-semibold tabular-nums",
          "transition-transform duration-fast ease-out",
          derived ? "cursor-default opacity-70" : "hover:scale-110 active:scale-95",
          busy && "opacity-50"
        )}
        style={
          broken
            ? {
                background: "transparent",
                border: `2px dashed var(--color-state-unavailable)`,
                color: "var(--color-state-unavailable)",
              }
            : {
                background: `var(--color-state-${unit.status})`,
                color: "rgb(var(--c-bg-page))",
                textDecoration: off ? "line-through" : undefined,
              }
        }
      >
        {unit.label}
      </button>

      {hasServiceStatus && (
        <button
          type="button"
          disabled={busy}
          onClick={onToggleService}
          aria-label={`${name} — mark ${broken ? "working" : "out of service"}`}
          title={broken ? "Mark working" : "Mark out of service"}
          className="ml-0.5 grid h-7 w-6 place-items-center rounded-md text-ink-muted
                     transition-colors duration-fast hover:bg-line/10 hover:text-ink-primary"
        >
          <Wrench size={12} />
        </button>
      )}
    </span>
  );
}

/* ───────────────────────── ADM-3 ───────────────────────── */

function Members({ org }) {
  const [q, setQ] = useState("");
  const [members, setMembers] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [reissueFor, setReissueFor] = useState(null);
  const [cardUid, setCardUid] = useState("");

  const memberNoun = org?.terminology?.memberNoun || "member";

  const load = useCallback(() => {
    api.adminMembers(q).then((d) => setMembers(d.members)).catch((e) => setError(e.message));
  }, [q]);
  useEffect(() => {
    const t = setTimeout(load, 250); // debounce the search
    return () => clearTimeout(t);
  }, [load]);

  const resetPin = async (m) => {
    setError(null);
    try {
      const r = await api.adminResetMemberPin(m.id);
      setNotice(
        r.temporaryPin
          ? `Temporary PIN for ${m.name}: ${r.temporaryPin} (also emailed; they must change it at next sign-in)`
          : `A temporary PIN has been emailed to ${m.email}.`
      );
    } catch (e) {
      setError(e.message);
    }
  };

  const reissue = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.adminReissueCard(reissueFor.id, cardUid);
      setNotice(`Card rebound for ${reissueFor.name}. Old card ${r.previousUid || "—"} is now invalid.`);
      setReissueFor(null);
      setCardUid("");
      load();
    } catch (e2) {
      setError(e2.message);
    }
  };

  return (
    <div className="space-y-4">
      <Field
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder={`Search ${memberNoun}s by name, email or ID…`}
        aria-label={`Search ${memberNoun}s`}
      />

      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      {/*
        A dialog, not a panel that grows out of the list.
        Reissuing a card is destructive — the old one stops working the
        moment you confirm — and the inline version appended a form
        below a list that can be a hundred rows long, so the thing you
        had just opened could easily be off screen. It also pushed every
        row underneath it down while you were reading them.
      */}
      <Modal
        open={Boolean(reissueFor)}
        onClose={() => setReissueFor(null)}
        title={reissueFor ? `Reissue card — ${reissueFor.name}` : ""}
        subtitle="The old card stops working immediately. History stays with the account."
        icon={CreditCard}
      >
        <form onSubmit={reissue}>
          <Field
            label="Tap the new card, or type its number"
            data-autofocus
            mono
            value={cardUid}
            onChange={(e) => setCardUid(e.target.value)}
            hint="4–32 hex characters. Case and separators are ignored."
          />
          <div className="mt-5 flex justify-end gap-3">
            <Button onClick={() => setReissueFor(null)}>Cancel</Button>
            <Button type="submit" variant="primary">
              Rebind card
            </Button>
          </div>
        </form>
      </Modal>

      <Panel title={`${members.length} ${memberNoun}${members.length === 1 ? "" : "s"}`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-ink-muted text-xs">
              <tr className="text-left">
                <th className="py-2 pr-3">Name</th>
                <th className="py-2 pr-3">ID</th>
                <th className="py-2 pr-3">Card</th>
                <th className="py-2 pr-3">Session</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line/10">
              {members.map((m) => (
                <tr key={m.id} className="transition-colors duration-fast ease-out hover:bg-bg-panel/40">
                  <td className="py-2 pr-3">
                    <div className="text-ink-primary">{m.name}</div>
                    <div className="text-xs text-ink-muted">{m.email}</div>
                  </td>
                  <td className="py-2 pr-3 font-mono text-xs">{m.memberId || "—"}</td>
                  <td className="py-2 pr-3 font-mono text-xs">{m.cardUid || "—"}</td>
                  <td className="py-2 pr-3 text-xs">
                    {m.currentSession ? (
                      <Badge tone={m.currentSession.status === "active" ? "occupied" : "reserved"}>
                        {m.currentSession.status}
                      </Badge>
                    ) : (
                      <span className="text-ink-muted">none</span>
                    )}
                  </td>
                  <td className="py-2 text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" className="border border-line/10" onClick={() => resetPin(m)}>
                      Reset PIN
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="ml-2 border border-line/10"
                      onClick={() => { setReissueFor(m); setCardUid(""); }}
                    >
                      Reissue card
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

/* ───────────────────────── ADM-4 ───────────────────────── */

function Staff() {
  const [staff, setStaff] = useState([]);
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", role: "staff" });
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  /**
   * The plan's staff limit, { max, used }, counted by the server exactly as
   * it enforces it (active staff and superadmins). max is null when the
   * plan sets no limit, which is every unmanaged organization.
   */
  const [places, setPlaces] = useState(null);

  const load = useCallback(() => {
    api.adminStaff().then((d) => setStaff(d.staff)).catch((e) => setError(e.message));
    api
      .adminPlan()
      .then((plan) => setPlaces(plan.limits.find((limit) => limit.key === "staff") || null))
      .catch(() => setPlaces(null));
  }, []);
  useEffect(load, [load]);

  const full = places && places.max !== null && places.used >= places.max;

  const create = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const r = await api.adminCreateStaff(form);
      setNotice(
        r.temporaryPin
          ? `Created ${form.email}. Temporary PIN: ${r.temporaryPin} — they must change it at first sign-in.`
          : `Created ${form.email}. An onboarding email has been sent.`
      );
      setForm({ firstName: "", lastName: "", email: "", role: "staff" });
      load();
    } catch (e2) {
      setError(e2.message);
      // Someone else took the last place since this page loaded: re-count,
      // and the form gives way to the explanation.
      if (e2.code === "PLAN_LIMIT") load();
    }
  };

  const update = async (id, patch) => {
    setError(null);
    try {
      await api.adminUpdateStaff(id, patch);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      {full ? (
        // At the limit the form would only collect a name and an email for
        // the server to refuse, so it gives way to why and what to do.
        <UpgradePrompt
          icon={ShieldCheck}
          title={
            places.max === 1
              ? "Your plan includes one staff account, and it's in use"
              : `All ${places.max} staff accounts on your plan are in use`
          }
        >
          Deactivate an account below to free its place, or ask SILLA to raise the limit. Staff and superadmin
          accounts both count; deactivated ones don't.
        </UpgradePrompt>
      ) : (
      <Panel
        title="Create a staff account"
        action={
          places?.max != null && (
            <span className="text-xs tabular-nums text-ink-muted">
              {places.used} of {places.max} on your plan
            </span>
          )
        }
      >
        <form onSubmit={create} className="grid sm:grid-cols-5 gap-2 items-end">
          {["firstName", "lastName", "email"].map((field) => (
            <Field
              key={field}
              label={field.replace("Name", " name").replace(/^./, (c) => c.toUpperCase())}
              required
              type={field === "email" ? "email" : "text"}
              value={form[field]}
              onChange={(e) => setForm((f) => ({ ...f, [field]: e.target.value }))}
            />
          ))}
          <Select label="Role" value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
            <option value="staff">staff</option>
            <option value="superadmin">superadmin</option>
          </Select>
          <Button type="submit" variant="primary" size="lg">Create</Button>
        </form>
        <p className="text-xs text-ink-muted mt-2">
          Staff are email-provisioned with no card and no kiosk tap, and must change their PIN
          and accept the terms at first sign-in.
        </p>
      </Panel>
      )}

      <Panel title={`${staff.length} account${staff.length === 1 ? "" : "s"}`}>
        <ul className="divide-y divide-line/10">
          {staff.map((s, index) => {
            // The first superadmin is the org's undeletable root account.
            const isFounder = index === staff.findIndex((x) => x.role === "superadmin");
            return (
              <li key={s.id} className="py-2 flex items-center gap-3 text-sm">
                <div className="mr-auto">
                  <div className="text-ink-primary">
                    {s.name}
                    {isFounder && <span className="ml-2 text-xs text-ink-muted">(founding superadmin)</span>}
                  </div>
                  <div className="text-xs text-ink-muted flex flex-wrap items-center gap-1.5 mt-0.5">
                    {s.email}
                    <Badge>{s.role}</Badge>
                    {!s.termsAccepted && <Badge tone="reserved">terms pending</Badge>}
                    {s.mustChangePin && <Badge tone="reserved">PIN change pending</Badge>}
                    {!s.active && <Badge tone="unavailable">deactivated</Badge>}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="border border-line/10"
                  disabled={isFounder}
                  onClick={() => update(s.id, { role: s.role === "staff" ? "superadmin" : "staff" })}
                >
                  {s.role === "staff" ? "Promote" : "Demote"}
                </Button>
                <Button
                  size="sm"
                  variant={s.active ? "ghost" : "ghost"}
                  className="border border-line/10"
                  disabled={isFounder}
                  onClick={() => update(s.id, { active: !s.active })}
                >
                  {s.active ? "Deactivate" : "Reactivate"}
                </Button>
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}

/* ───────────────────────── ADM-5 ───────────────────────── */

function Settings() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [closure, setClosure] = useState({ startTime: "", endTime: "", reason: "" });

  const load = useCallback(() => {
    api.adminSettings().then(setData).catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const save = async (patch, message) => {
    setError(null);
    setNotice(null);
    try {
      await api.adminUpdateSettings(patch);
      setNotice(message);
      load();
    } catch (e) {
      setError(e.message);
    }
  };

  const addClosure = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api.adminCreateClosure({
        startTime: new Date(closure.startTime).toISOString(),
        endTime: new Date(closure.endTime).toISOString(),
        reason: closure.reason,
      });
      setNotice("Closure scheduled. Affected reservations are cancelled and emailed by the worker.");
      setClosure({ startTime: "", endTime: "", reason: "" });
      load();
    } catch (e2) {
      setError(e2.message);
    }
  };

  if (error && !data) return <Notice tone="error">{error}</Notice>;
  if (!data) return <SkeletonRows count={5} />;

  const o = data.organization;
  return (
    <div className="space-y-4">
      {error && <Notice tone="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}

      <Panel title="Organization status" icon={ShieldCheck}>
        <Segmented
          className="orgstatus"
          value={o.status}
          onChange={(next) => save({ status: next }, `Status set to ${next}.`)}
          options={[
            { value: "open", label: "Open" },
            { value: "limited", label: "Limited" },
            { value: "closed", label: "Closed" },
          ]}
        />
        <p className="text-xs text-ink-muted mt-2">
          While "Closed" is set, nobody can book anything.
        </p>
      </Panel>

      <Panel title="Policy">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            save(
              {
                policy: {
                  gracePeriodMinutes: Number(f.get("grace")),
                  maxStayHours: Number(f.get("maxStay")),
                  operatingHours: { open: f.get("open"), close: f.get("close") },
                },
              },
              "Policy saved. If the grace period changed, everyone booked for today has been told."
            );
          }}
          className="grid sm:grid-cols-4 gap-3 items-end"
        >
          <Field name="grace" label="Grace (min)" defaultValue={o.policy.gracePeriodMinutes} type="number" />
          <Field name="maxStay" label="Max stay (h)" defaultValue={o.policy.maxStayHours} type="number" />
          <Field name="open" label="Opens" defaultValue={o.policy.operatingHours.open} />
          <Field name="close" label="Closes" defaultValue={o.policy.operatingHours.close} />
          <Button type="submit" variant="primary" className="sm:col-span-4 sm:w-fit">
            Save policy
          </Button>
        </form>
      </Panel>

      <Panel title="Scheduled closures" icon={CalendarX}>
        <form onSubmit={addClosure} className="grid sm:grid-cols-4 gap-3 items-end mb-4">
          <Field label="From" required type="datetime-local"
            value={closure.startTime} onChange={(e) => setClosure((c) => ({ ...c, startTime: e.target.value }))} />
          <Field label="Until" required type="datetime-local"
            value={closure.endTime} onChange={(e) => setClosure((c) => ({ ...c, endTime: e.target.value }))} />
          <Field label="Reason (emailed)" required
            value={closure.reason} onChange={(e) => setClosure((c) => ({ ...c, reason: e.target.value }))} />
          <Button type="submit" variant="primary" size="lg">Schedule</Button>
        </form>

        {data.closures.length === 0 ? (
          <EmptyState icon={CalendarX} title="No closures scheduled" body="Scheduling one cancels affected reservations and emails those members with your reason." />
        ) : (
          <ul className="divide-y divide-line/10">
            {data.closures.map((c) => (
              <li key={c.id} className="py-2 flex items-center gap-3 text-sm">
                <div className="mr-auto">
                  <div className="text-ink-primary">{c.reason}</div>
                  <div className="text-xs text-ink-muted">
                    {new Date(c.startTime).toLocaleString()} — {new Date(c.endTime).toLocaleString()}
                    {c.appliedAt && " · applied"}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="border border-line/10"
                  onClick={async () => {
                    setError(null);
                    try {
                      await api.adminDeleteClosure(c.id);
                      load();
                    } catch (err) {
                      setError(err.message);
                    }
                  }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Branding branding={o.branding} />

      <Panel title="White-label configuration">
        <div className="grid sm:grid-cols-3 gap-3 text-sm">
          <KV label="Resource noun" value={o.terminology.resourceNoun} />
          <KV label="Member noun" value={o.terminology.memberNoun} />
          <KV label="Facility label" value={o.terminology.facilityLabel} />
          <KV label="Member ID format" value={o.identity.memberIdFormat} />
          <KV label="Check-in method" value={o.identity.checkInMethod} />
        </div>
        <p className="text-xs text-ink-muted mt-3">
          Every value above came from your provisioning profile. To change your vocabulary or identity
          format, contact your provider — the whole product follows from these, so they are changed
          together rather than one at a time.
        </p>
      </Panel>
    </div>
  );
}

/**
 * The accent colour and the text drawn on it — the two colours every
 * deployment sets, and the ones a buyer most wants to match their brand.
 * The rest of the palette (surfaces, ink, the state colours) stays as it
 * was set up: a bad surface palette can make the whole product illegible,
 * and that is a conversation, not a colour picker.
 *
 * Custom colours are a plan feature (`customBranding`). Without it the
 * panel shows the colours in use and why they can't be changed here,
 * instead of pickers whose Save the server would refuse.
 *
 * Contrast is checked before saving, never while choosing: the readout is
 * shown as you go, and only a Save below the bar is refused with a reason.
 */
const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
function toHex(value) {
  const match = String(value || "").trim().match(HEX);
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join("") : match[1];
  return `#${digits.toLowerCase()}`;
}

function Branding({ branding: loaded }) {
  const { org, entitlements, reload } = useOrg();
  // The live config, so a save (which reloads it) is what "changed" is
  // measured against next — not the settings read from before it.
  const branding = org?.branding || loaded;
  const [accent, setAccent] = useState(() => toHex(branding?.primaryColor) || "#22d3ee");
  const [ink, setInk] = useState(() => toHex(branding?.accentTextColor) || "#04222b");
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  if (!entitlements.hasFeature("customBranding")) {
    return (
      <UpgradePrompt icon={Palette} title="Custom colours aren't included in your plan">
        <p>
          {org?.name || "Your organization"} keeps the colours it was set up with. Ask SILLA to add custom colours
          to your plan to change them here.
        </p>
        <p className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-xs text-ink-muted">
          <span className="inline-flex items-center gap-1.5">
            <Swatch color={branding?.primaryColor} />
            Accent <span className="font-mono text-ink-secondary">{toHex(branding?.primaryColor) || "default"}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Swatch color={branding?.accentTextColor} />
            Text on it <span className="font-mono text-ink-secondary">{toHex(branding?.accentTextColor) || "default"}</span>
          </span>
        </p>
      </UpgradePrompt>
    );
  }

  const accentHex = toHex(accent);
  const inkHex = toHex(ink);
  const textContrast = accentHex && inkHex ? contrastRatio(accentHex, inkHex) : null;
  const pageChannels = toRgbChannels(getComputedStyle(document.documentElement).getPropertyValue("--c-bg-page"));
  const pageContrast = accentHex && pageChannels ? contrastRatio(accentHex, pageChannels) : null;
  const changed = accentHex !== toHex(branding?.primaryColor) || inkHex !== toHex(branding?.accentTextColor);

  const save = async (e) => {
    e.preventDefault();
    setSaved(false);
    if (!changed && accentHex && inkHex) {
      setError(null);
      setSaved(true);
      return;
    }
    if (!accentHex || !inkHex) {
      setError("Enter each colour as a hex code, like #2dd4bf.");
      return;
    }
    if (textContrast < 4.5) {
      setError(
        `Text on the accent would be hard to read (${textContrast.toFixed(1)}:1). Choose a lighter or darker ` +
          "text colour — it needs at least 4.5:1."
      );
      return;
    }
    if (pageContrast < 3) {
      setError(
        `The accent would barely stand out from the page (${pageContrast.toFixed(1)}:1). Choose a brighter or ` +
          "deeper accent — it needs at least 3:1."
      );
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await api.adminUpdateSettings({ branding: { primaryColor: accentHex, accentTextColor: inkHex } });
      await reload(); // repaints the whole product in the new colours
      setSaved(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const colourField = (label, value, setValue, name) => (
    <label className="block">
      <span className="text-sm font-medium text-ink-secondary">{label}</span>
      <span className="mt-1.5 flex gap-2">
        <input
          type="color"
          aria-label={`${label} picker`}
          value={toHex(value) || "#000000"}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          className="h-11 w-12 shrink-0 cursor-pointer rounded-md border border-line/10 bg-bg-panel p-1"
        />
        <input
          name={name}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            setSaved(false);
          }}
          spellCheck={false}
          className="h-11 min-w-0 flex-1 rounded-md border border-line/10 bg-bg-panel px-3 font-mono text-ink-primary
                     outline-none transition-colors duration-fast ease-out focus:border-line/40"
        />
      </span>
    </label>
  );

  return (
    <Panel title="Colours" icon={Palette}>
      <form onSubmit={save} noValidate className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start">
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {colourField("Accent", accent, setAccent, "accent")}
            {colourField("Text on the accent", ink, setInk, "accentText")}
          </div>
          {error && <Notice tone="error">{error}</Notice>}
          {saved && <Notice tone="success">Colours saved — everyone sees them from their next page.</Notice>}
          <div className="flex flex-wrap items-center gap-3">
            <Button type="submit" variant="primary" loading={saving}>
              Save colours
            </Button>
            <span className="text-xs text-ink-muted">
              Buttons, highlights and the browser tab icon follow the accent.
            </span>
          </div>
        </div>

        {/* The two colours together, before anyone else sees them. */}
        <div className="rounded-lg border border-line/10 bg-bg-page p-4">
          <p className="text-[11px] font-medium uppercase tracking-wider text-ink-muted">Preview</p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <span
              className="inline-flex h-10 items-center rounded-md px-4 text-sm font-medium shadow-sm"
              style={{ background: accentHex || "transparent", color: inkHex || "inherit" }}
            >
              Reserve this {org?.terminology?.resourceNoun || "resource"}
            </span>
            <span
              className="grid h-8 w-8 place-items-center rounded-lg text-sm font-bold"
              style={{ background: accentHex || "transparent", color: inkHex || "inherit" }}
            >
              {String(org?.name || "?").trim().charAt(0).toUpperCase()}
            </span>
            <span className="text-sm font-medium" style={{ color: accentHex || "inherit" }}>
              A link in the accent
            </span>
          </div>
          <dl className="mt-4 grid grid-cols-2 gap-3 text-xs">
            <ContrastReading label="Text on the accent" ratio={textContrast} needed={4.5} />
            <ContrastReading label="Accent on the page" ratio={pageContrast} needed={3} />
          </dl>
        </div>
      </form>
    </Panel>
  );
}

/** "7.4:1 · reads well" — the figure, and what it means, never colour alone. */
function ContrastReading({ label, ratio, needed }) {
  const ok = ratio !== null && ratio >= needed;
  return (
    <div>
      <dt className="text-ink-muted">{label}</dt>
      <dd className="mt-0.5 tabular-nums text-ink-primary">
        {ratio === null ? "—" : `${ratio.toFixed(1)}:1`}
        <span className="ml-1.5 text-ink-muted">
          {ratio === null ? "" : ok ? "· reads well" : `· needs ${needed}:1`}
        </span>
      </dd>
    </div>
  );
}

function Swatch({ color }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-3.5 w-3.5 shrink-0 rounded border border-line/20 align-[-2px]"
      style={{ background: toHex(color) || "transparent" }}
    />
  );
}

/* ───────────────────────── RPT-1 ───────────────────────── */

function Reports() {
  const { org, entitlements } = useOrg();
  // Vertical-neutral fallback: a default of "seat" would quietly make
  // every unconfigured deployment a library.
  const resourceNoun = org?.terminology?.resourceNoun || "resource";
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  // Reports and the CSV export are a plan feature (`reports`).
  const included = entitlements.hasFeature("reports");

  useEffect(() => {
    if (!included) return;
    api
      .adminReports(days)
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e) => setError(e));
  }, [days, included]);

  const exportCsv = async () => {
    setExporting(true);
    setExportError(null);
    try {
      const { blob, filename } = await api.adminExport(days);
      const url = URL.createObjectURL(blob);
      const link = Object.assign(document.createElement("a"), { href: url, download: filename });
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      setExportError(err.message);
    } finally {
      setExporting(false);
    }
  };

  // Without the feature, or refused it by a server that knows better than
  // this page's copy of the plan: say so, rather than a page that fails.
  if (!included || error?.code === "PLAN_FEATURE") {
    return (
      <UpgradePrompt icon={BarChart3} title="Reports aren't included in your plan">
        Reports show when {org?.name || "your organization"} is busiest, how often bookings go unused and how
        often people overstay, with a CSV of every reservation behind them. Ask SILLA to add reports to your
        plan.
      </UpgradePrompt>
    );
  }
  if (error) return <Notice tone="error">{error.message}</Notice>;
  if (!data) {
    return (
      <div className="space-y-4">
        <SkeletonStats />
        <SkeletonRows count={3} />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 items-center">
        <Segmented
          className="reportrange"
          size="sm"
          value={days}
          onChange={setDays}
          options={[7, 30, 90].map((d) => ({ value: d, label: `${d} days` }))}
        />
        <Button size="sm" icon={Download} loading={exporting} onClick={exportCsv} className="ml-auto">
          Export CSV
        </Button>
      </div>

      {exportError && <Notice tone="error">{exportError}</Notice>}

      <motion.div {...listContainer()} className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="Reservations" value={data.totalReservations} />
        <Stat label="Peak hour" value={data.peakHour || "—"} />
        <Stat label="No-show rate" value={`${Math.round(data.noShowRate * 100)}%`} />
        <Stat label="Overstay rate" value={`${Math.round(data.overstayRate * 100)}%`} tone="overstay" />
      </motion.div>

      <Panel title="Reservations by hour">
        <HourHistogram counts={data.reservationsByHour} label={`${resourceNoun} bookings`} />
        <p className="text-xs text-ink-muted mt-3">
          Average session {data.averageSessionMinutes} min
        </p>
      </Panel>
    </div>
  );
}

/* ── admin-only helpers (the rest now come from components/ui) ── */

/** A quiet group heading. Gives a block of stats a reason to be a block. */
function SectionLabel({ children }) {
  return (
    <h3 className="text-[11px] font-medium uppercase tracking-wider text-ink-muted mb-2">
      {children}
    </h3>
  );
}

function KV({ label, value, swatch }) {
  return (
    <div>
      <div className="text-xs text-ink-muted">{label}</div>
      <div className="text-ink-primary flex items-center gap-2">
        {swatch && <span className="w-3 h-3 rounded" style={{ background: swatch }} />}
        {value || "—"}
      </div>
    </div>
  );
}
