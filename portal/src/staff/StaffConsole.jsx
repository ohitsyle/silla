import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUpRight, Menu, ShieldAlert, X } from "lucide-react";

import { Button, EmptyState, Skeleton } from "../components/ui.jsx";
import { AccountMenu } from "../account/kit.jsx";
import { useAccount } from "../lib/AccountContext.jsx";
import { staffApi } from "../lib/staffApi.js";
import { ROUTES } from "../lib/useHashRoute.js";
import { STAFF_SECTIONS, sectionFor } from "./sections.js";

/**
 * The SILLA staff console: #/staff/<section>[/<id>].
 *
 * Its own surface rather than a page among the buyer's ones. A support
 * agent spends the day here, so it is laid out like a tool — a sidebar
 * that stays put and a content area that changes — not like a page of
 * the storefront with a queue on it.
 *
 * Sections come from sections.js, filtered by the permissions the server
 * reports for THIS person (GET /api/vendor/staff/me). An unknown or
 * forbidden section falls back to the first one they may open rather
 * than rendering nothing, the same rule as the product's admin console.
 */
export default function StaffConsole({ section, id, navigate }) {
  const { account } = useAccount();
  const [me, setMe] = useState(null);
  const [error, setError] = useState(null);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    let live = true;
    staffApi
      .me()
      .then((data) => live && setMe(data))
      .catch((err) => live && setError(err));
    return () => {
      live = false;
    };
  }, [account?.id]);

  const permissions = useMemo(() => new Set(me?.permissions || []), [me]);
  const can = (permission) => permissions.has(permission);
  const visible = STAFF_SECTIONS.filter((s) => can(s.permission));

  const requested = sectionFor(section);
  const current = requested && can(requested.permission) ? requested : visible[0] || null;

  // Correct the address when we fell back, so Back and bookmarks agree with the screen.
  useEffect(() => {
    if (me && current && current.key !== section) navigate(`${ROUTES.staff}/${current.key}`, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, current?.key, section]);

  useEffect(() => setNavOpen(false), [section, id]);

  if (error) {
    return (
      <div className="silla-marketing grid min-h-screen place-items-center px-6">
        <EmptyState
          icon={ShieldAlert}
          title={error.status === 403 ? "This area is for SILLA staff" : "The staff console didn't load"}
          action={
            <Button variant="primary" onClick={() => navigate(ROUTES.home)}>
              Back to the site
            </Button>
          }
        >
          {error.status === 403 ? "You're signed in with a customer account." : error.message}
        </EmptyState>
      </div>
    );
  }

  const Section = current?.component;

  return (
    <div className="silla-marketing min-h-screen lg:grid lg:grid-cols-[248px_minmax(0,1fr)]">
      {/* ── sidebar ── */}
      <aside
        className={`fixed inset-y-0 left-0 z-40 w-[248px] border-r border-line/[0.08] bg-bg-panel/95 backdrop-blur
                    transition-transform duration-300 lg:sticky lg:top-0 lg:h-screen lg:translate-x-0
                    ${navOpen ? "translate-x-0" : "-translate-x-full"}`}
        style={{ paddingTop: "env(safe-area-inset-top, 0px)" }}
      >
        <div className="flex h-[72px] items-center gap-2.5 px-5">
          <span
            className="grid h-8 w-8 place-items-center rounded-[10px] text-sm font-extrabold"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          >
            S
          </span>
          <span className="text-lg font-extrabold tracking-tight">SILLA</span>
          <span className="rounded-full bg-line/[0.07] px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.14em] text-ink-muted">
            Staff
          </span>
          <button
            type="button"
            className="ml-auto rounded-lg p-1.5 text-ink-muted hover:text-ink-primary lg:hidden"
            onClick={() => setNavOpen(false)}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav aria-label="Staff console" className="px-3 pb-6">
          {!me
            ? Array.from({ length: 7 }, (_, i) => <Skeleton key={i} className="mx-2 my-2 h-8" />)
            : visible.map((s) => {
                const active = current?.key === s.key;
                const Icon = s.icon;
                return (
                  <button
                    key={s.key}
                    type="button"
                    onClick={() => navigate(`${ROUTES.staff}/${s.key}`)}
                    aria-current={active ? "page" : undefined}
                    className={`relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-[14.5px] font-semibold
                                transition-colors ${active ? "text-ink-primary" : "text-ink-secondary hover:bg-line/[0.05] hover:text-ink-primary"}`}
                  >
                    {active && (
                      <motion.span
                        layoutId="staff-nav-active"
                        className="absolute inset-0 rounded-xl bg-bg-card shadow-sm ring-1 ring-line/[0.08]"
                        transition={{ type: "spring", stiffness: 500, damping: 40 }}
                      />
                    )}
                    <Icon size={17} className="relative" />
                    <span className="relative">{s.label}</span>
                  </button>
                );
              })}
        </nav>

        <div className="absolute inset-x-0 bottom-0 border-t border-line/[0.08] p-4">
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault();
              navigate(ROUTES.home);
            }}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-muted hover:text-ink-primary"
          >
            Open the storefront <ArrowUpRight size={14} />
          </a>
        </div>
      </aside>

      <AnimatePresence>
        {navOpen && (
          <motion.div
            className="fixed inset-0 z-30 bg-black/20 lg:hidden"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setNavOpen(false)}
          />
        )}
      </AnimatePresence>

      {/* ── content ── */}
      <div className="min-w-0">
        <header
          className="sticky top-0 z-20 flex h-[72px] items-center gap-3 border-b border-line/[0.08] px-4 sm:px-8"
          style={{
            background: "rgb(var(--c-bg-page) / 0.86)",
            backdropFilter: "saturate(180%) blur(12px)",
            top: "env(safe-area-inset-top, 0px)",
          }}
        >
          <button
            type="button"
            className="rounded-lg p-2 text-ink-secondary hover:bg-line/[0.06] lg:hidden"
            onClick={() => setNavOpen(true)}
            aria-label="Open menu"
          >
            <Menu size={20} />
          </button>
          <h1 className="text-lg font-extrabold tracking-tight">{current?.label || "Staff console"}</h1>
          {me?.staffRole && (
            <span className="hidden rounded-full bg-line/[0.07] px-2.5 py-1 text-xs font-semibold capitalize text-ink-secondary sm:inline">
              {me.staffRole}
            </span>
          )}
          <div className="ml-auto">
            <AccountMenu navigate={navigate} />
          </div>
        </header>

        <main className="px-4 py-8 sm:px-8">
          {!me ? (
            <div className="space-y-3">
              <Skeleton className="h-8 w-48" />
              <Skeleton className="h-40" />
            </div>
          ) : Section ? (
            <motion.div
              key={current.key}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            >
              <Section navigate={navigate} id={id} permissions={permissions} can={can} me={me} />
            </motion.div>
          ) : (
            <EmptyState title="Nothing here for your role">Ask a SILLA owner for access.</EmptyState>
          )}
        </main>
      </div>
    </div>
  );
}
