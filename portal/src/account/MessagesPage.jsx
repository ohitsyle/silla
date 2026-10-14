import { EmptyState } from "../components/ui.jsx";
import { AccountLayout } from "./shared.jsx";

/**
 * Messages — Your conversations with SILLA.
 * Owner: the staff-operations work. Props: { navigate, id }.
 */
export default function MessagesPage({ navigate }) {
  return (
    <AccountLayout navigate={navigate} title="Messages" subtitle="Your conversations with SILLA">
      <EmptyState title="Coming soon">This page is being built.</EmptyState>
    </AccountLayout>
  );
}
