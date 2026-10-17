import { useState } from "react";
import { ChevronDown, MailPlus, Power, RotateCcw, Send, ShieldCheck, UserPlus, Users } from "lucide-react";

import { Button, EmptyState, Modal, Notice, Panel, Skeleton } from "../../components/ui.jsx";
import { TextInput } from "../../account/kit.jsx";
import { staffApi } from "../../lib/staffApi.js";
import { useToast } from "../../lib/toast.jsx";
import { shortDate } from "../../billing/format.js";
import { ReasonDialog } from "../../billing/console.jsx";
import { ToneBadge } from "../../billing/ui.jsx";
import { Ago, Avatar, ROLE_WORDS, RoleBadge, useLoad } from "../kit.jsx";

/**
 * Staff console — Staff. Owners only (staff.manage).
 *
 * The first owner comes from `npm run seed:staff`; everyone after is
 * invited from here. An invitation does not let anyone in: it emails a
 * one-time code to the invited ADDRESS, and only someone who reads that
 * inbox can set a password with it (three days, once). Every invite,
 * re-send, acceptance, role change and deactivation is on the activity log.
 *
 * Two rules the server enforces and this page explains rather than hides:
 * nobody changes their own role or access, and the last active owner can
 * never be demoted or deactivated.
 */

const ROLES = ["owner", "admin", "billing", "support"];

function statusOf(s) {
  if (s.status === "deactivated") return { label: `Deactivated${s.deactivatedAt ? ` ${shortDate(s.deactivatedAt)}` : ""}`, tone: "neutral" };
  if (s.status === "invited") {
    const expired = s.inviteExpiresAt && new Date(s.inviteExpiresAt) < new Date();
    return expired || !s.inviteExpiresAt ? { label: "Invitation lapsed", tone: "bad" } : { label: "Invited", tone: "waiting" };
  }
  return { label: "Active", tone: "good" };
}

function InviteDialog({ open, onClose, onInvited }) {
  const blank = { firstName: "", lastName: "", email: "", staffRole: "" };
  const [form, setForm] = useState(blank);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    const f = {};
    if (!form.firstName.trim()) f.firstName = "Enter their first name.";
    if (!form.lastName.trim()) f.lastName = "Enter their last name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) f.email = "Enter the address the invitation goes to.";
    if (!form.staffRole) f.staffRole = "Choose what they may do.";
    setFields(f);
    if (Object.keys(f).length) return;
    setBusy(true);
    try {
      const { staff } = await staffApi.invite({ ...form, email: form.email.trim(), firstName: form.firstName.trim(), lastName: form.lastName.trim() });
      setForm(blank);
      onInvited(staff);
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? undefined : onClose}
      icon={UserPlus}
      title="Invite someone to the console"
      subtitle="They're emailed a one-time code that sets their password. Nobody gets in without the inbox it's sent to."
      width="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" icon={Send} loading={busy} onClick={submit}>
            Send the invitation
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="First name" value={form.firstName} onChange={set("firstName")} error={fields.firstName} data-autofocus autoComplete="off" />
          <TextInput label="Last name" value={form.lastName} onChange={set("lastName")} error={fields.lastName} autoComplete="off" />
        </div>
        <TextInput label="Work email" type="email" value={form.email} onChange={set("email")} error={fields.email} autoComplete="off" />
        <fieldset>
          <legend className="text-sm text-ink-secondary">What they may do</legend>
          <div className="mt-1.5 grid gap-2 sm:grid-cols-2" role="radiogroup">
            {ROLES.map((role) => {
              const on = form.staffRole === role;
              return (
                <button
                  key={role}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => setForm((f) => ({ ...f, staffRole: role }))}
                  className={`rounded-xl border-2 px-3.5 py-3 text-left transition-colors ${
                    on ? "" : fields.staffRole ? "border-state-unavailable/40" : "border-line/10 hover:border-line/25"
                  }`}
                  style={on ? { borderColor: "var(--color-accent)", background: "rgb(var(--c-accent) / 0.07)" } : undefined}
                >
                  <span className="block text-sm font-bold">{ROLE_WORDS[role].label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed text-ink-secondary">{ROLE_WORDS[role].summary}</span>
                </button>
              );
            })}
          </div>
          {fields.staffRole && (
            <span data-field-error="" className="mt-1 block text-xs font-medium text-state-unavailable">
              {fields.staffRole}
            </span>
          )}
        </fieldset>
        {fields._form && <Notice tone="error">{fields._form}</Notice>}
      </div>
    </Modal>
  );
}

function StaffRow({ s, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null); // "deactivate" | { role }
  const status = statusOf(s);

  const update = async (patch, message) => {
    setBusy(Object.keys(patch)[0]);
    try {
      const { staff } = await staffApi.updateStaff(s.id, patch);
      onChanged(staff);
      toast(message(staff));
      setConfirm(null);
    } catch (err) {
      if (confirm) throw err;
      toast(err.message, { tone: "error", duration: 6000 });
    } finally {
      setBusy(null);
    }
  };

  const resend = async () => {
    setBusy("resend");
    try {
      const { staff } = await staffApi.resendInvite(s.id);
      onChanged(staff);
      toast(`A new invitation is on its way to ${s.email}`);
    } catch (err) {
      toast(err.message, { tone: "error", duration: 6000 });
    } finally {
      setBusy(null);
    }
  };

  return (
    <li className="grid items-center gap-x-6 gap-y-3 px-5 py-4 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.3fr)]">
      <span className="flex min-w-0 items-center gap-3">
        <Avatar name={s.name} email={s.email} tone="staff" size={38} className={s.status === "deactivated" ? "opacity-40" : ""} />
        <span className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className={`truncate font-bold ${s.status === "deactivated" ? "text-ink-muted" : ""}`}>{s.name}</span>
            {s.isYou && <span className="text-xs font-semibold text-ink-muted">you</span>}
          </span>
          <span className="block truncate text-sm text-ink-muted">{s.email}</span>
        </span>
      </span>

      <span className="flex min-w-0 flex-col gap-1 text-xs text-ink-muted">
        <span className="flex flex-wrap items-center gap-1.5">
          <ToneBadge tone={status.tone} size="sm">
            {status.label}
          </ToneBadge>
          {s.status === "invited" && s.inviteExpiresAt && new Date(s.inviteExpiresAt) > new Date() && (
            <span>until {shortDate(s.inviteExpiresAt)}</span>
          )}
        </span>
        <span>
          {s.lastLoginAt ? (
            <>
              Last signed in <Ago value={s.lastLoginAt} />
            </>
          ) : s.invitedBy ? (
            `Invited by ${s.invitedBy.name}`
          ) : (
            "Seeded owner"
          )}
        </span>
      </span>

      <span className="flex flex-wrap items-center gap-2 md:col-span-2 xl:col-span-1 xl:justify-end">
        {s.isYou ? (
          <>
            <RoleBadge role={s.staffRole} size="md" />
            <span className="text-xs text-ink-muted">Another owner changes your access.</span>
          </>
        ) : (
          <>
            <label className="relative">
              <span className="sr-only">Role for {s.name}</span>
              <select
                value={s.staffRole}
                disabled={Boolean(busy) || s.status === "deactivated"}
                onChange={(e) => setConfirm({ role: e.target.value })}
                className="h-9 appearance-none rounded-full border border-line/10 bg-bg-card pl-3.5 pr-8 text-[13px] font-semibold outline-none focus:border-line/30 disabled:opacity-60"
              >
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {ROLE_WORDS[role].label}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-muted" />
            </label>
            {s.status === "invited" && (
              <Button size="sm" variant="ghost" icon={MailPlus} loading={busy === "resend"} onClick={resend}>
                Re-send
              </Button>
            )}
            {s.status === "deactivated" ? (
              <Button size="sm" icon={RotateCcw} loading={busy === "active"} onClick={() => update({ active: true }, () => `${s.name} can sign in again`)}>
                Reactivate
              </Button>
            ) : (
              <Button size="sm" variant="ghost" icon={Power} onClick={() => setConfirm("deactivate")} aria-label={`Deactivate ${s.name}`}>
                Deactivate
              </Button>
            )}
          </>
        )}
      </span>

      <ReasonDialog
        open={confirm === "deactivate"}
        onClose={() => setConfirm(null)}
        icon={Power}
        title={`Deactivate ${s.name}?`}
        subtitle={
          s.status === "invited"
            ? "Their invitation code stops working at once. Reactivate them later and send a new one if you change your mind."
            : "They're signed out everywhere at once and can't sign back in. Their open conversations go back to the shared inbox. Nothing they did is undone."
        }
        noReason
        confirmLabel="Deactivate"
        onConfirm={() => update({ active: false }, () => `${s.name} is deactivated`)}
      />
      <ReasonDialog
        open={Boolean(confirm?.role)}
        onClose={() => setConfirm(null)}
        icon={ShieldCheck}
        title={`Make ${s.name} ${confirm?.role === "admin" || confirm?.role === "owner" ? "an" : "a"} ${ROLE_WORDS[confirm?.role]?.label?.toLowerCase() || ""}?`}
        subtitle={`${ROLE_WORDS[confirm?.role]?.summary || ""} It takes effect on their next click — no need to sign in again.`}
        noReason
        confirmLabel="Change role"
        confirmVariant="primary"
        onConfirm={() => update({ staffRole: confirm.role }, (staff) => `${staff.name} is now ${ROLE_WORDS[staff.staffRole].label.toLowerCase()}`)}
      />
    </li>
  );
}

export default function Staff() {
  const { data, error, setData } = useLoad(() => staffApi.staff(), []);
  const [inviting, setInviting] = useState(false);
  const toast = useToast();

  const replace = (staff) =>
    setData((d) => ({
      ...d,
      staff: d.staff.some((x) => x.id === staff.id) ? d.staff.map((x) => (x.id === staff.id ? staff : x)) : [...d.staff, staff],
    }));

  const rows = data?.staff || [];
  const owners = rows.filter((s) => s.staffRole === "owner" && s.status === "active").length;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-2xl text-sm text-ink-secondary">
          Who can use this console, and what they may do. Invitations are emailed and work once; every change here is on the activity log.
        </p>
        <Button variant="primary" icon={UserPlus} onClick={() => setInviting(true)}>
          Invite someone
        </Button>
      </div>

      {error && <Notice tone="error">{error.message}</Notice>}
      {!data && !error && <Skeleton className="h-64" rounded="rounded-xl" />}
      {data && rows.length === 0 && <EmptyState icon={Users} title="Nobody yet" />}
      {rows.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-line/10 bg-bg-card shadow-sm">
          <ul className="divide-y divide-line/[0.07]">
            {rows.map((s) => (
              <StaffRow key={s.id} s={s} onChanged={replace} />
            ))}
          </ul>
        </div>
      )}
      {owners === 1 && (
        <p className="text-xs text-ink-muted">
          There is one active owner. SILLA always keeps at least one: make someone else an owner before that person steps back.
        </p>
      )}

      <Panel title="What each role may do" className="max-w-3xl">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {ROLES.map((role) => (
            <div key={role}>
              <dt>
                <RoleBadge role={role} />
              </dt>
              <dd className="mt-1 text-sm text-ink-secondary">{ROLE_WORDS[role].summary}</dd>
            </div>
          ))}
        </dl>
      </Panel>

      <InviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        onInvited={(staff) => {
          setInviting(false);
          replace(staff);
          toast(`Invitation sent to ${staff.email}`);
        }}
      />
    </div>
  );
}
