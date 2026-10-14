import { EmptyState } from "../components/ui.jsx";
import { AccountLayout } from "./shared.jsx";

/**
 * Billing — Your plan, subscription and invoices.
 * Owner: the billing work. Props: { navigate, id }.
 */
export default function BillingPage({ navigate }) {
  return (
    <AccountLayout navigate={navigate} title="Billing" subtitle="Your plan, subscription and invoices">
      <EmptyState title="Coming soon">This page is being built.</EmptyState>
    </AccountLayout>
  );
}
