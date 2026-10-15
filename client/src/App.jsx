import { useEffect, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { OrgProvider } from "./lib/OrgContext.jsx";
import { AuthProvider, useAuth } from "./lib/AuthContext.jsx";
import { resolveAddress } from "./lib/orgAddress.js";
import { bindOrganization } from "./lib/api.js";
import { applyOrgTheme } from "./theme/applyOrgTheme.js";
import StarterPage from "./pages/StarterPage.jsx";
import MapPage from "./pages/MapPage.jsx";
import LoginPage from "./pages/LoginPage.jsx";
import TermsPage from "./pages/TermsPage.jsx";
import KioskPage from "./pages/KioskPage.jsx";
import AdminPage from "./pages/AdminPage.jsx";
import EditorPage from "./pages/EditorPage.jsx";
import ChangePinPage from "./pages/ChangePinPage.jsx";
import ResetPinPage from "./pages/ResetPinPage.jsx";
import FindOrganizationPage, { BootScreen, ServiceUnavailablePage } from "./pages/FindOrganizationPage.jsx";
import AppShell from "./components/AppShell.jsx";

/**
 * The default organization: the one served at the old unprefixed
 * addresses (/map, /kiosk, …) that kiosks and bookmarks still point at.
 * Optional — a deployment without one asks "Find your organization"
 * instead. See lib/orgAddress.js.
 */
const DEFAULT_ORGANIZATION_ID = import.meta.env.VITE_DEMO_ORG_ID || "";

/**
 * Wraps a page in the application shell. Deliberately NOT applied to the
 * kiosk, login, terms or change-PIN screens: the kiosk is a
 * single-purpose physical surface, and the gate screens must not offer a
 * way around themselves.
 *
 * `fill` hands the page the entire content area, for the map — which
 * should BE the screen rather than sit in a column on it.
 *
 * The editor deliberately does NOT use it: below its map sit the zone,
 * label and floor panels, and `fill` means overflow-hidden, so those
 * became unreachable. A page with content under the fold has to scroll.
 */
function Shell({ children, fill = false }) {
  return <AppShell fill={fill}>{children}</AppShell>;
}

/**
 * AUTH-3 — "First-login flag routes to terms; Cannot proceed until
 * accepted." The gate lives here rather than in each page so a new
 * authenticated route cannot forget to apply it.
 */
function RequireAuth({ children }) {
  const { isAuthenticated, requiresTermsAcceptance, mustChangePin, booting } = useAuth();
  const location = useLocation();

  if (booting) {
    return <div className="min-h-screen flex items-center justify-center text-ink-secondary">Loading…</div>;
  }
  // Each gate remembers where the person was going, so getting through
  // them lands on that page rather than the map.
  const from = `${location.pathname}${location.search}`;
  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from }} />;
  }
  // ADM-4 — a provisioned or staff-reset PIN must be replaced before the
  // account is usable, and that gate comes before the terms gate.
  if (mustChangePin) {
    return <Navigate to="/change-pin" replace state={{ from }} />;
  }
  if (requiresTermsAcceptance) {
    return <Navigate to="/terms" replace state={{ from }} />;
  }
  return children;
}

/**
 * Boot: work out which organization this address is for, THEN mount the
 * app for it (docs/control-plane.md §1).
 *
 * Every organization lives at <product>/<slug>/…, and the router is
 * mounted with basename "/<slug>" — so every route and link below is
 * exactly what it was before addresses existed ("/map", "/admin/reports")
 * and no page needed to learn about slugs. Nothing renders until the
 * organization is known, so no screen ever paints in the wrong
 * organization's colours or asks the wrong organization for a session.
 */
export default function App() {
  const [boot, setBoot] = useState({ phase: "resolving" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    const { pathname, search, hash } = window.location;
    resolveAddress({ pathname, search, hash }, DEFAULT_ORGANIZATION_ID).then((result) => {
      if (!current) return;
      if (result.replaceWith) window.history.replaceState(null, "", result.replaceWith);
      if (result.org) {
        // Every request from here on carries this organization's session
        // and no other (lib/session.js).
        bindOrganization(result.org._id);
        // Before the first paint of the app, so it never shows unbranded.
        applyOrgTheme(result.org);
      }
      setBoot(result);
    });
    return () => {
      current = false;
    };
  }, [attempt]);

  switch (boot.phase) {
    case "ready":
      return <OrganizationApp org={boot.org} basename={boot.basename} />;
    case "find":
      return <FindOrganizationPage />;
    case "not-found":
      return <FindOrganizationPage attempted={boot.attempted} />;
    case "unavailable":
      return (
        <ServiceUnavailablePage
          onRetry={() => {
            setBoot({ phase: "resolving" });
            setAttempt((n) => n + 1);
          }}
        />
      );
    default:
      return <BootScreen />;
  }
}

/** One organization's app. `basename` is "/<slug>", or "" for a default organization with no slug yet. */
function OrganizationApp({ org, basename }) {
  return (
    <OrgProvider initialOrg={org}>
      <BrowserRouter basename={basename || undefined}>
        <AuthProvider>
          <Routes>
            <Route path="/" element={<Shell><StarterPage /></Shell>} />
            <Route path="/login" element={<LoginPage />} />
            {/* AUTH-4 — "Forgot your PIN?". Under /login on purpose: a new
                top-level route would be a word no organization's address
                could use (lib/orgAddress.js). */}
            <Route path="/login/reset" element={<ResetPinPage />} />
            {/* The kiosk is an unauthenticated, physically-supervised
                surface — a person registering does not have an account
                yet (spec §4, ID-1). */}
            <Route path="/kiosk" element={<KioskPage />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/change-pin" element={<ChangePinPage />} />

            {/* MAP-1 — /map lands on the first floor, /map/:floorId is
                linkable so a floor can be shared or bookmarked. */}
            <Route
              path="/map"
              element={
                <RequireAuth>
                  <Shell fill><MapPage /></Shell>
                </RequireAuth>
              }
            />
            <Route
              path="/map/:floorId"
              element={
                <RequireAuth>
                  <Shell fill><MapPage /></Shell>
                </RequireAuth>
              }
            />

            {/* ADM-1..ADM-5, RPT-1 — staff console (spec §14, desktop) */}
            <Route path="/admin" element={<RequireAuth><Shell><AdminPage /></Shell></RequireAuth>} />
            {/* Sections are addressable: /admin/reports is a link you can send. */}
            <Route path="/admin/:section" element={<RequireAuth><Shell><AdminPage /></Shell></RequireAuth>} />
            {/* MAP-3/4/5 — the map editor, same layout model as the map */}
            <Route path="/editor" element={<RequireAuth><Shell><EditorPage /></Shell></RequireAuth>} />
            <Route path="/editor/:floorId" element={<RequireAuth><Shell><EditorPage /></Shell></RequireAuth>} />

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </AuthProvider>
      </BrowserRouter>
    </OrgProvider>
  );
}
