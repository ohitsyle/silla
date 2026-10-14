/**
 * The staff console's sections — the ONE list both the sidebar and the
 * router read, the same lesson as the product's adminSections.js: a
 * section that exists in one and not the other is either unreachable or
 * a dead link.
 *
 * `permission` is a key from vendor/src/middleware/staff.js. The console
 * shows a section only when GET /api/vendor/staff/me lists it, so nobody
 * is offered a page that would answer 403. The server checks again on
 * every request regardless.
 *
 * Owners: billing work = subscriptions, invoices, plans, settings.
 * Staff-operations work = everything else.
 */
import {
  Activity,
  Building2,
  CreditCard,
  Layers,
  LayoutDashboard,
  ListChecks,
  MessagesSquare,
  Receipt,
  Server,
  Settings,
  UserCog,
} from "lucide-react";

import Overview from "./sections/Overview.jsx";
import Orders from "./sections/Orders.jsx";
import Clients from "./sections/Clients.jsx";
import Conversations from "./sections/Conversations.jsx";
import Deployments from "./sections/Deployments.jsx";
import Subscriptions from "./sections/Subscriptions.jsx";
import Invoices from "./sections/Invoices.jsx";
import Plans from "./sections/Plans.jsx";
import Staff from "./sections/Staff.jsx";
import ActivityLog from "./sections/ActivityLog.jsx";
import SettingsSection from "./sections/Settings.jsx";

export const STAFF_SECTIONS = [
  { key: "dashboard", label: "Overview", icon: LayoutDashboard, permission: "orders.read", component: Overview },
  { key: "orders", label: "Orders", icon: ListChecks, permission: "orders.read", component: Orders },
  { key: "clients", label: "Clients", icon: Building2, permission: "clients.read", component: Clients },
  { key: "conversations", label: "Conversations", icon: MessagesSquare, permission: "conversations.read", component: Conversations },
  { key: "deployments", label: "Deployments", icon: Server, permission: "deployments.read", component: Deployments },
  { key: "subscriptions", label: "Subscriptions", icon: CreditCard, permission: "billing.read", component: Subscriptions },
  { key: "invoices", label: "Invoices", icon: Receipt, permission: "billing.read", component: Invoices },
  { key: "plans", label: "Plans", icon: Layers, permission: "plans.manage", component: Plans },
  { key: "staff", label: "Staff", icon: UserCog, permission: "staff.manage", component: Staff },
  { key: "activity", label: "Activity", icon: Activity, permission: "audit.read", component: ActivityLog },
  { key: "settings", label: "Settings", icon: Settings, permission: "settings.manage", component: SettingsSection },
];

export const sectionFor = (key) => STAFF_SECTIONS.find((s) => s.key === key) || null;
