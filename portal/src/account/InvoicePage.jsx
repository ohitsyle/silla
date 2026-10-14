import { EmptyState } from "../components/ui.jsx";
import { AccountLayout } from "./shared.jsx";

/**
 * Invoice — One invoice, ready to print.
 * Owner: the billing work. Props: { navigate, id }.
 */
export default function InvoicePage({ navigate }) {
  return (
    <AccountLayout navigate={navigate} title="Invoice" subtitle="One invoice, ready to print">
      <EmptyState title="Coming soon">This page is being built.</EmptyState>
    </AccountLayout>
  );
}
