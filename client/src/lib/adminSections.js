import { BarChart3, LayoutDashboard, Settings as SettingsIcon, ShieldCheck, Users, Wrench } from "lucide-react";

/**
 * The console's sections, shared by the page that renders them and the
 * shell that navigates to them.
 *
 * They used to be a row of tab pills held in local state, which meant
 * they could not be linked, bookmarked or reached from the sidebar, and
 * every section change was invisible to the browser's back button. As
 * routes they are addressable — `/admin/reports` is a URL you can send
 * someone — and the shell can list them as nested navigation, which is
 * where a tool puts them.
 *
 * Kept in its own module so the list has one definition: the shell and
 * the page reading two copies is how they drift apart.
 */
export const ADMIN_SECTIONS = [
  { key: "dashboard", label: "Dashboard", Icon: LayoutDashboard, story: "ADM-1" },
  { key: "resources", label: "Resources & Rules", Icon: Wrench, story: "ADM-2" },
  { key: "members", label: "Members & Cards", Icon: Users, story: "ADM-3" },
  { key: "staff", label: "Staff", Icon: ShieldCheck, story: "ADM-4", superadminOnly: true },
  { key: "settings", label: "Settings", Icon: SettingsIcon, story: "ADM-5", superadminOnly: true },
  { key: "reports", label: "Reports", Icon: BarChart3, story: "RPT-1" },
];

export const DEFAULT_ADMIN_SECTION = "dashboard";

/** Sections this role may see. The server gates the data regardless. */
export const sectionsFor = (role) =>
  ADMIN_SECTIONS.filter((section) => !section.superadminOnly || role === "superadmin");
