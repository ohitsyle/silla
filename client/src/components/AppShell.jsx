import { useEffect, useState } from "react";
import { Link, NavLink, useLocation } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  ContactRound, LayoutDashboard, LogIn, LogOut, Map as MapIcon, Menu, PencilRuler, Wrench,
} from "lucide-react";
import { useAuth } from "../lib/AuthContext.jsx";
import { sectionsFor } from "../lib/adminSections.js";
import { useOrg } from "../lib/OrgContext.jsx";
import { DURATION, EASE_OUT, prefersReducedMotion } from "../lib/motion.js";

/**
 * The application shell.
 *
 * The product used to be laid out as a document: a top bar, then every
 * screen a centred `max-w-6xl` column of stacked cards. That is why it
 * read as a webpage rather than a tool — on a wide monitor it wasted
 * both margins, content grew downward forever, and the map (the actual
 * product) was a card sitting INSIDE a page rather than being the
 * surface itself.
 *
 * So: fixed chrome, scrolling content, and one viewport-height layout.
 * The sidebar is always there, which means navigation costs no vertical
 * space and never scrolls away. Pages opt into `fill` when they want
 * the whole area (the map) rather than a readable column (the console).
 *
 * The kiosk and the gate screens deliberately do NOT use this: a kiosk
 * is a single-purpose device, and a gate that offered navigation around
 * itself would not be a gate.
 */

/**
 * `roles` lists who may see a link. `public: true` means it is also
 * shown to a signed-out visitor — only the kiosk is, because it is the
 * one surface that deliberately has no session (a person registering
 * does not have an account yet).
 */
const LINKS = [
  { to: "/map", label: "Map", icon: MapIcon, roles: ["member", "staff", "superadmin"] },
  { to: "/admin", label: "Console", icon: LayoutDashboard, roles: ["staff", "superadmin"] },
  { to: "/editor", label: "Editor", icon: PencilRuler, roles: ["superadmin"] },
  { to: "/editor", label: "Space controls", icon: Wrench, roles: ["staff"] },
  { to: "/kiosk", label: "Kiosk", icon: ContactRound, roles: ["member", "staff", "superadmin"], public: true },
];

function OrgMark({ org }) {
  const initial = String(org?.name || "?").trim().charAt(0).toUpperCase();
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold"
      style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
    >
      {initial}
    </span>
  );
}

function SidebarContent({ org, user, logout, onNavigate }) {
  const role = user?.role;
  const location = useLocation();
  // `!role || …` showed EVERY link to a signed-out visitor, because
  // undefined passes the first branch — so the landing page advertised
  // Console and Editor to anyone. The route guards still bounced them to
  // /login, so nothing was exposed, but it read as "straight into the
  // superadmin app". A signed-out visitor sees only what they can use.
  const visible = LINKS.filter((link) => (role ? link.roles.includes(role) : link.public));
  const adminSections = sectionsFor(role);
  const inConsole = location.pathname.startsWith("/admin");

  return (
    <div className="flex h-full flex-col">
      <Link
        to="/"
        onClick={onNavigate}
        className="flex items-center gap-2.5 px-4 h-16 shrink-0 border-b border-line/10"
      >
        <OrgMark org={org} />
        <span className="min-w-0 truncate font-semibold">{org?.name || " "}</span>
      </Link>

      <nav className="flex-1 overflow-y-auto p-3">
        <ul className="space-y-1">
          {visible.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  [
                    "relative flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium",
                    "transition-colors duration-fast ease-out",
                    isActive ? "text-ink-primary" : "text-ink-secondary hover:text-ink-primary hover:bg-line/[0.06]",
                  ].join(" ")
                }
              >
                {({ isActive }) => (
                  <>
                    {isActive && (
                      // One marker that travels between items, so the
                      // change of place is felt and not just read.
                      <motion.span
                        layoutId="nav-active"
                        className="absolute inset-0 rounded-md"
                        style={{ background: "rgb(var(--c-accent) / 0.14)" }}
                        transition={{ type: "spring", stiffness: 520, damping: 38 }}
                      />
                    )}
                    <Icon size={17} className="relative shrink-0" />
                    <span className="relative">{label}</span>
                  </>
                )}
              </NavLink>

              {/* The console's sections, nested — this is where the tab
                  row used to be. Only expanded while you are in it, so
                  the rail does not carry six extra rows everywhere else. */}
              {to === "/admin" && inConsole && adminSections.length > 0 && (
                <ul className="mt-1 space-y-0.5 border-l border-line/10 pl-3 ml-4">
                  {adminSections.map((section) => (
                    <li key={section.key}>
                      <NavLink
                        to={`/admin/${section.key}`}
                        onClick={onNavigate}
                        end
                        className={({ isActive }) =>
                          [
                            "block rounded-md px-3 py-1.5 text-[13px] transition-colors duration-fast",
                            isActive ||
                            (section.key === "dashboard" && location.pathname === "/admin")
                              ? "text-ink-primary font-medium bg-line/[0.06]"
                              : "text-ink-muted hover:text-ink-secondary hover:bg-line/[0.04]",
                          ].join(" ")
                        }
                      >
                        {section.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </nav>

      {!user && (
        <div className="shrink-0 border-t border-line/10 p-3">
          <Link
            to="/login"
            onClick={onNavigate}
            className="flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-semibold
                       transition-opacity duration-fast hover:opacity-90"
            style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
          >
            <LogIn size={16} />
            Sign in
          </Link>
        </div>
      )}

      {user && (
        <div className="shrink-0 border-t border-line/10 p-3">
          <div className="flex items-center gap-2.5 px-2 pb-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium">
                {user.firstName} {user.lastName}
              </div>
              <div className="text-xs capitalize text-ink-muted">{user.role}</div>
            </div>
          </div>
          <button
            type="button"
            onClick={logout}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm font-medium
                       text-ink-secondary transition-colors duration-fast hover:bg-line/[0.06] hover:text-ink-primary"
          >
            <LogOut size={16} />
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * `fill` gives the page the entire content area with no padding and no
 * max width — for the map, which should BE the screen. Without it the
 * content is a readable column, which is right for the console's tables
 * and forms where full-bleed text would be unreadable on a wide display.
 */
export default function AppShell({ children, fill = false }) {
  const { org } = useOrg();
  const { user, logout } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);
  const location = useLocation();
  const reduced = prefersReducedMotion();

  // A route change must close the drawer, or navigating on a phone
  // leaves the menu sitting over the page you just asked for.
  useEffect(() => setMobileOpen(false), [location.pathname]);

  useEffect(() => {
    if (!mobileOpen) return undefined;
    const onKey = (e) => e.key === "Escape" && setMobileOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mobileOpen]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Desktop rail — always present, never scrolls away. */}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col border-r border-line/10 bg-bg-card">
        <SidebarContent org={org} user={user} logout={logout} />
      </aside>

      {/* Mobile drawer */}
      <AnimatePresence>
        {mobileOpen && (
          <div className="lg:hidden fixed inset-0 z-50 flex">
            <motion.div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: DURATION.fast }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              className="relative w-64 bg-bg-card border-r border-line/10"
              initial={reduced ? { opacity: 0 } : { x: -280 }}
              animate={reduced ? { opacity: 1 } : { x: 0 }}
              exit={reduced ? { opacity: 0 } : { x: -280 }}
              transition={{ duration: DURATION.base, ease: EASE_OUT }}
            >
              <SidebarContent
                org={org}
                user={user}
                logout={logout}
                onNavigate={() => setMobileOpen(false)}
              />
            </motion.aside>
          </div>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Only on small screens: the rail replaces this entirely above lg. */}
        <div className="lg:hidden flex h-14 shrink-0 items-center gap-3 border-b border-line/10 px-4">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
            className="grid h-9 w-9 place-items-center rounded-md text-ink-secondary
                       transition-colors duration-fast hover:bg-line/[0.06] hover:text-ink-primary"
          >
            <Menu size={19} />
          </button>
          <OrgMark org={org} />
          <span className="min-w-0 truncate font-semibold">{org?.name}</span>
        </div>

        <main className={fill ? "min-h-0 flex-1 overflow-hidden" : "min-h-0 flex-1 overflow-y-auto"}>
          {children}
        </main>
      </div>
    </div>
  );
}
