import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { motion } from "framer-motion";
import {
  ArrowRight, ContactRound, LayoutDashboard, LogIn, Map as MapIcon, PencilRuler,
} from "lucide-react";
import { api } from "../lib/api.js";
import SpaceMap from "../components/SpaceMap.jsx";
import { effectiveStatus } from "../lib/rooms.js";
import { resolveStatePalette } from "../theme/applyOrgTheme.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { useAuth } from "../lib/AuthContext.jsx";
import {
  Card, Notice, Page, Skeleton, StatusDot, listContainer, listItem, pageEnter, pressable,
} from "../components/ui/index.jsx";

/**
 * The home screen of a buyer's deployment.
 *
 * This was the original scaffold page and it showed: a "Powered by
 * SILLA" byline on a WHITE-LABEL product, a panel captioned "This
 * deployment's configuration" listing internal field names (Resource
 * noun, Check-in method) to whoever walked up, and an error state that
 * told a member to run `npm run seed`. All three are vendor-facing
 * debugging left in a customer's product.
 *
 * What it does now is answer the only question anyone opening this page
 * actually has — is there anywhere to sit — and then get out of the way.
 * The live count is the same status half the map streams, so this page
 * is honest the moment it loads rather than decorative.
 */

const article = (word) => (/^[aeiou]/i.test(String(word).trim()) ? "an" : "a");

/** Aggregates open/total across every floor, so the number means the building. */
function useAvailability(organizationId) {
  const [state, setState] = useState({ loading: true, open: 0, total: 0, breakdown: {}, preview: null });

  useEffect(() => {
    if (!organizationId) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const { floors } = await api.getFloors(organizationId);
        const layouts = await Promise.all(floors.map((floor) => api.getFloorLayout(floor.id)));
        if (cancelled) return;

        const breakdown = {};
        let total = 0;
        for (const layout of layouts) {
          for (const resource of layout.layout.resources) {
            const units = layout.status[resource.id] || [];
            for (const unit of units) {
              total += 1;
              const shown = effectiveStatus(resource, unit, layout.layout.rooms || [], layout.status);
              const key = shown.serviceStatus === "out_of_service" ? "out_of_service" : shown.status;
              breakdown[key] = (breakdown[key] || 0) + 1;
            }
          }
        }
        setState({
          loading: false,
          open: breakdown.available || 0,
          total,
          breakdown,
          // The first floor, kept for the preview below. Already fetched
          // for the count, so this costs no extra request.
          preview: layouts[0] ? { ...layouts[0], floorId: floors[0].id } : null,
        });
      } catch {
        // A failed count is not worth an error screen — the page still
        // does its job as a way in. Fall back to hiding the figure.
        if (!cancelled) setState({ loading: false, open: 0, total: 0, breakdown: {}, preview: null });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  return state;
}

function ActionCard({ to, icon: Icon, title, body, primary }) {
  return (
    <motion.div {...listItem()} {...pressable()}>
      <Link
        to={to}
        className="block h-full rounded-lg border p-5 transition-colors duration-fast ease-out"
        style={
          primary
            ? {
                background: "var(--color-accent)",
                color: "var(--color-accent-ink)",
                borderColor: "transparent",
              }
            : undefined
        }
      >
        <span
          className={primary ? "" : "text-ink-primary"}
          style={primary ? undefined : { color: "var(--color-accent)" }}
        >
          <Icon size={22} />
        </span>
        <h2 className="mt-3 text-lg font-semibold">{title}</h2>
        <p className={`mt-1.5 text-sm ${primary ? "opacity-80" : "text-ink-secondary"}`}>{body}</p>
        <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium">
          Open
          <ArrowRight size={15} />
        </span>
      </Link>
    </motion.div>
  );
}

export default function StarterPage() {
  const { org, error, entitlements } = useOrg();
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const availability = useAvailability(org?.id || org?._id);
  const palette = useMemo(() => resolveStatePalette(org), [org]);

  if (error) {
    // Deliberately says nothing about seeds, servers or scripts: whoever
    // reads this is a member standing at a screen, not an engineer.
    return (
      <Page width="medium">
        <Notice tone="error">
          This service is temporarily unavailable. Please try again shortly, or ask a member of staff.
        </Notice>
      </Page>
    );
  }

  if (!org) {
    return (
      <Page width="medium">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="mt-3 h-5 w-96" />
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Skeleton className="h-40" />
          <Skeleton className="h-40" />
        </div>
      </Page>
    );
  }

  const resourceNoun = org.terminology?.resourceNoun || "resource";
  const memberNoun = org.terminology?.memberNoun || "member";
  const hours = org.policy?.operatingHours;
  const isStaff = user?.role === "staff" || user?.role === "superadmin";
  const { loading, open, total, breakdown, preview } = availability;
  // Paused or ended: the map is still worth opening, booking is not.
  const paused = !entitlements.operational;

  return (
    <Page>
      <motion.div {...pageEnter()}>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight">{org.name}</h1>
        <p className="mt-2 text-ink-secondary">
          {isAuthenticated
            ? `Welcome back, ${user.firstName}.`
            : entitlements.hasFeature("kiosk")
              ? `Find ${article(resourceNoun)} ${resourceNoun}, or check in at the door.`
              : `Find ${article(resourceNoun)} ${resourceNoun} and see what's free right now.`}
        </p>
      </motion.div>

      {/* The answer to the only question anyone has on arrival. */}
      <motion.div {...pageEnter()} className="mt-7">
        <Card className="flex flex-wrap items-center gap-x-10 gap-y-5">
          <div>
            {loading ? (
              <Skeleton className="h-12 w-40" />
            ) : total > 0 ? (
              <>
                <div className="flex items-baseline gap-2">
                  <span className="text-5xl font-semibold tabular-nums leading-none">{open}</span>
                  <span className="text-lg text-ink-secondary">of {total} open</span>
                </div>
                <p className="mt-1.5 text-sm text-ink-muted">
                  {resourceNoun}s free right now
                  {hours ? ` · open ${hours.open}–${hours.close}` : ""}
                </p>
              </>
            ) : (
              <p className="text-ink-secondary">Live availability is unavailable right now.</p>
            )}
          </div>

          {!loading && total > 0 && (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 ml-auto">
              {[
                ["available", "Free"],
                ["reserved", "Reserved"],
                ["occupied", "In use"],
                ["unavailable", "Unavailable"],
              ].map(([key, label]) =>
                breakdown[key] ? (
                  <StatusDot key={key} tone={key} label={label} count={breakdown[key]} />
                ) : null
              )}
            </div>
          )}
        </Card>
      </motion.div>

      {/*
        The floor itself, live.
        The page ended after two link cards and left half a screen of
        nothing under them, which is what made it read as unfinished.
        The honest fill is the product: this is the real plan with real
        statuses, not an illustration, and it is the fastest answer to
        "is there anywhere to sit" that a page can give. Non-interactive
        here — the whole panel is one link through to the real map.
      */}
      {preview && (
        <motion.div {...pageEnter()} className="mt-4">
          <Link
            to={`/map/${preview.floorId}`}
            className="group block rounded-lg border border-line/10 bg-bg-card overflow-hidden
                       transition-colors duration-fast ease-out hover:border-line/25"
          >
            <div className="flex items-center gap-3 px-5 pt-4">
              <span className="font-medium">{preview.floor?.name}</span>
              <span className="text-sm text-ink-muted">{preview.floor?.site?.name}</span>
              <span className="ml-auto inline-flex items-center gap-1.5 text-sm text-ink-secondary
                               transition-colors duration-fast group-hover:text-ink-primary">
                Open the map
                <ArrowRight size={15} />
              </span>
            </div>
            <div className="pointer-events-none px-2 pb-2">
              <SpaceMap
                floor={preview.floor}
                layout={preview.layout}
                resourceTypes={preview.resourceTypes}
                status={preview.status}
                resourceNoun={resourceNoun}
                palette={palette}
              />
            </div>
          </Link>
        </motion.div>
      )}

      <motion.div {...listContainer()} className="mt-4 grid gap-4 sm:grid-cols-2">
        {isAuthenticated ? (
          <ActionCard
            to="/map"
            icon={MapIcon}
            primary
            title={paused ? "See the floor plan" : `Find ${article(resourceNoun)} ${resourceNoun}`}
            body={
              paused
                ? `What's free and what's in use, live. Booking is paused for now.`
                : `See the live floor plan and reserve ${article(resourceNoun)} ${resourceNoun} for later.`
            }
          />
        ) : (
          <ActionCard
            to="/login"
            icon={LogIn}
            primary
            title="Sign in"
            body={`Email and a 6-digit PIN — the same login for ${memberNoun}s and staff.`}
          />
        )}

        {!paused && entitlements.hasFeature("kiosk") && (
          <ActionCard
            to="/kiosk"
            icon={ContactRound}
            title="Check in at the kiosk"
            body={`Tap a card to check in, check out, or enrol a new ${memberNoun} on the spot.`}
          />
        )}

        {isStaff && (
          <ActionCard
            to="/admin"
            icon={LayoutDashboard}
            title="Console"
            body="Who's in, what's free, what's overdue, and the reports behind it."
          />
        )}

        {user?.role === "superadmin" && (
          <ActionCard
            to="/editor"
            icon={PencilRuler}
            title="Map editor"
            body="Place furniture, draw zones, add and resize floors."
          />
        )}
      </motion.div>
    </Page>
  );
}
