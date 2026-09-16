import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  AtSign, BadgeCheck, Building2, CreditCard, KeyRound, LogOut, MailWarning, Receipt, ShieldCheck, UserRound,
} from "lucide-react";

import { Button } from "../components/ui.jsx";
import { initialsOf, useAccount } from "../lib/AccountContext.jsx";
import { useToast } from "../lib/toast.jsx";
import { ROUTES } from "../lib/useHashRoute.js";
import { vendorApi } from "../lib/vendorApi.js";
import { SelectInput, TextInput } from "./kit.jsx";
import { ChangeEmailModal, ChangePasswordModal, VerifyEmailModal } from "./modals.jsx";
import { AccountLayout, PLAN_LABEL, StatusBadge, money, when } from "./shared.jsx";

/**
 * The signed-in person's own page: who they are, how they sign in, and
 * where invoices go.
 *
 * Each section saves on its own. One "Save" for the whole page means a
 * typo in a billing field blocks a name change, and nobody can tell which
 * of eight edits failed.
 */

const SUFFIXES = ["Jr.", "Sr.", "II", "III", "IV", "V"];

const SECTIONS = [
  { id: "details", label: "Personal details", icon: UserRound },
  { id: "security", label: "Email & password", icon: ShieldCheck },
  { id: "billing", label: "Billing & payment", icon: CreditCard },
];

function Section({ id, icon: Icon, title, subtitle, children, delay = 0 }) {
  return (
    <motion.section
      id={id}
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: [0.22, 1, 0.36, 1] }}
      className="scroll-mt-24 rounded-xl border border-line/10 bg-bg-card p-6 shadow-sm sm:p-7"
    >
      <div className="mb-6 flex items-start gap-3">
        <span
          className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px]"
          style={{ background: "rgb(var(--c-accent) / 0.11)", color: "var(--color-accent)" }}
        >
          <Icon size={19} strokeWidth={2.2} />
        </span>
        <div>
          <h2 className="text-lg font-extrabold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-sm text-ink-secondary">{subtitle}</p>}
        </div>
      </div>
      {children}
    </motion.section>
  );
}

/** Appears only when a section has unsaved edits, so an untouched page has no idle buttons. */
function SaveBar({ dirty, busy, onSave, onDiscard }) {
  return (
    <AnimatePresence initial={false}>
      {dirty && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="overflow-hidden"
        >
          <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line/[0.08] pt-5">
            <span className="mr-auto flex items-center gap-2 text-sm text-ink-secondary">
              <span className="h-2 w-2 rounded-full" style={{ background: "rgb(var(--c-state-reserved))" }} />
              Unsaved changes
            </span>
            <Button variant="ghost" onClick={onDiscard} disabled={busy}>
              Discard
            </Button>
            <Button variant="primary" loading={busy} onClick={onSave}>
              Save changes
            </Button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Tracks a copy of some fields against what's saved, with save/discard. */
function useEditable(source, save) {
  const [draft, setDraft] = useState(source);
  const [fields, setFields] = useState({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDraft(source);
    setFields({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(source)]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(source);
  const set = (key) => (e) => setDraft((d) => ({ ...d, [key]: e.target.value }));

  const commit = async () => {
    setBusy(true);
    setFields({});
    try {
      await save(draft);
    } catch (err) {
      setFields(Object.keys(err.fields || {}).length ? err.fields : { _form: err.message });
    } finally {
      setBusy(false);
    }
  };

  return { draft, set, dirty, busy, fields, commit, discard: () => { setDraft(source); setFields({}); } };
}

/* ─────────────────────────────── sections ─────────────────────────────── */

function DetailsSection({ account }) {
  const { applySession } = useAccount();
  const toast = useToast();
  const source = useMemo(
    () => ({
      firstName: account.firstName || "",
      middleName: account.middleName || "",
      lastName: account.lastName || "",
      suffix: account.suffix || "",
      organizationName: account.organizationName || "",
    }),
    [account]
  );
  const e = useEditable(source, async (draft) => {
    const f = {};
    if (!draft.firstName.trim()) f.firstName = "Enter your first name.";
    if (!draft.lastName.trim()) f.lastName = "Enter your last name.";
    if (Object.keys(f).length) throw Object.assign(new Error("Check the highlighted fields."), { fields: f });
    applySession(await vendorApi.updateProfile(draft));
    toast("Personal details saved");
  });

  return (
    <Section id="details" icon={UserRound} title="Personal details" subtitle="How you appear on orders and in emails from us." delay={0.05}>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label="First name" autoComplete="given-name" value={e.draft.firstName} onChange={e.set("firstName")} error={e.fields.firstName} />
        <TextInput label="Middle name" optional autoComplete="additional-name" value={e.draft.middleName} onChange={e.set("middleName")} />
        <TextInput label="Last name" autoComplete="family-name" value={e.draft.lastName} onChange={e.set("lastName")} error={e.fields.lastName} />
        <SelectInput label="Suffix" optional value={e.draft.suffix} onChange={e.set("suffix")}>
          <option value="">None</option>
          {SUFFIXES.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </SelectInput>
        <TextInput
          label="Organization"
          optional
          className="sm:col-span-2"
          autoComplete="organization"
          value={e.draft.organizationName}
          onChange={e.set("organizationName")}
          hint="The place you're buying SILLA for."
        />
      </div>
      {e.fields._form && <p className="mt-3 text-sm font-medium text-state-unavailable">{e.fields._form}</p>}
      <SaveBar dirty={e.dirty} busy={e.busy} onSave={e.commit} onDiscard={e.discard} />
    </Section>
  );
}

function Row({ icon: Icon, label, value, extra, action }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 py-4 first:pt-0 last:pb-0">
      <Icon size={18} className="shrink-0 text-ink-muted" />
      <div className="mr-auto min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wider text-ink-muted">{label}</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          <span className="truncate font-semibold">{value}</span>
          {extra}
        </div>
      </div>
      <div className="flex gap-2">{action}</div>
    </div>
  );
}

function SecuritySection({ account, onVerify, onChangeEmail, onChangePassword }) {
  const verified = account.emailVerified;
  return (
    <Section id="security" icon={ShieldCheck} title="Email & password" subtitle="How you sign in. Both changes ask you to prove it's you." delay={0.1}>
      <div className="divide-y divide-line/[0.08]">
        <Row
          icon={AtSign}
          label="Email"
          value={account.email}
          extra={
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-bold"
              style={
                verified
                  ? { background: "rgb(var(--c-state-available) / 0.14)", color: "rgb(var(--c-state-available))" }
                  : { background: "rgb(var(--c-state-reserved) / 0.16)", color: "rgb(var(--c-state-reserved))" }
              }
            >
              {verified ? <BadgeCheck size={12} /> : <MailWarning size={12} />}
              {verified ? "Verified" : "Not verified"}
            </span>
          }
          action={
            <>
              {!verified && (
                <Button variant="primary" size="sm" onClick={onVerify}>
                  Verify
                </Button>
              )}
              <Button size="sm" onClick={onChangeEmail}>
                Change
              </Button>
            </>
          }
        />
        {account.pendingEmail && (
          <div className="rounded-lg px-4 py-3 text-sm" style={{ background: "rgb(var(--c-state-reserved) / 0.1)" }}>
            Waiting to confirm <span className="font-semibold">{account.pendingEmail}</span>.{" "}
            <button type="button" onClick={onChangeEmail} className="font-bold underline underline-offset-2">
              Enter the code
            </button>
          </div>
        )}
        <Row
          icon={KeyRound}
          label="Password"
          value="••••••••••••"
          extra={
            <span className="text-xs text-ink-muted">
              {account.passwordChangedAt ? `Changed ${when(account.passwordChangedAt)}` : `Set ${when(account.createdAt)}`}
            </span>
          }
          action={
            <Button size="sm" onClick={onChangePassword}>
              Change
            </Button>
          }
        />
      </div>
    </Section>
  );
}

const BILLING_KEYS = ["name", "company", "email", "phone", "address1", "address2", "city", "region", "postalCode", "country", "taxId"];

function BillingSection({ account, orders }) {
  const { applySession } = useAccount();
  const toast = useToast();
  const source = useMemo(() => {
    const b = account.billing || {};
    return Object.fromEntries(BILLING_KEYS.map((k) => [k, b[k] || (k === "country" ? "Philippines" : "")]));
  }, [account]);

  const e = useEditable(source, async (draft) => {
    applySession(await vendorApi.updateBilling(draft));
    toast("Billing details saved");
  });

  const quoted = orders.filter((o) => o.status !== "draft");

  return (
    <Section id="billing" icon={CreditCard} title="Billing & payment" subtitle="Where invoices are addressed, and how you'll pay." delay={0.15}>
      <h3 className="mb-3 flex items-center gap-2 text-sm font-bold">
        <Building2 size={15} className="text-ink-muted" /> Billing details
      </h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextInput label="Billing name" autoComplete="name" value={e.draft.name} onChange={e.set("name")} error={e.fields.name} />
        <TextInput label="Company" optional autoComplete="organization" value={e.draft.company} onChange={e.set("company")} />
        <TextInput label="Billing email" type="email" autoComplete="email" value={e.draft.email} onChange={e.set("email")} error={e.fields.email} hint="Invoices go here." />
        <TextInput label="Phone" optional type="tel" autoComplete="tel" placeholder="+63 917 123 4567" value={e.draft.phone} onChange={e.set("phone")} error={e.fields.phone} />
        <TextInput label="Address" className="sm:col-span-2" autoComplete="address-line1" placeholder="Street, building, unit" value={e.draft.address1} onChange={e.set("address1")} />
        <TextInput label="Address line 2" optional className="sm:col-span-2" autoComplete="address-line2" placeholder="Barangay, district" value={e.draft.address2} onChange={e.set("address2")} />
        <TextInput label="City" autoComplete="address-level2" value={e.draft.city} onChange={e.set("city")} />
        <TextInput label="Province / region" autoComplete="address-level1" value={e.draft.region} onChange={e.set("region")} />
        <TextInput label="Postal code" autoComplete="postal-code" value={e.draft.postalCode} onChange={e.set("postalCode")} />
        <TextInput label="Country" autoComplete="country-name" value={e.draft.country} onChange={e.set("country")} />
        <TextInput label="TIN" optional className="sm:col-span-2" placeholder="000-000-000-00000" value={e.draft.taxId} onChange={e.set("taxId")} hint="Tax Identification Number, if invoices should carry it." />
      </div>
      {e.fields._form && <p className="mt-3 text-sm font-medium text-state-unavailable">{e.fields._form}</p>}
      <SaveBar dirty={e.dirty} busy={e.busy} onSave={e.commit} onDiscard={e.discard} />

      <div className="mt-8 grid gap-4 lg:grid-cols-2">
        {/* Payment method — honestly empty. No card form, because a card
            number must never reach our database; when online payment
            arrives it goes through the provider's own secure fields. */}
        <div className="rounded-xl border border-dashed border-line/15 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <CreditCard size={15} className="text-ink-muted" /> Payment method
          </h3>
          <div className="mt-4 flex items-center gap-3">
            <span className="grid h-10 w-14 place-items-center rounded-md bg-bg-panel text-ink-muted">
              <CreditCard size={18} />
            </span>
            <div>
              <div className="font-semibold">No payment method on file</div>
              <div className="text-sm text-ink-muted">Nothing is charged until we confirm an order with you.</div>
            </div>
          </div>
          <p className="mt-4 text-xs leading-relaxed text-ink-muted">
            Online card payment is coming. When it arrives, your card is held by our payment provider — SILLA never
            sees or stores the number.
          </p>
          <Button size="sm" className="mt-4" disabled>
            Add a card · coming soon
          </Button>
        </div>

        <div className="rounded-xl border border-line/10 p-5">
          <h3 className="flex items-center gap-2 text-sm font-bold">
            <Receipt size={15} className="text-ink-muted" /> Billing history
          </h3>
          {quoted.length === 0 ? (
            <p className="mt-4 text-sm text-ink-muted">No invoices yet. Submitted orders and their quotes will appear here.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line/[0.08]">
              {quoted.slice(0, 5).map((o) => (
                <li key={o.id} className="flex items-center gap-3 py-2.5 text-sm">
                  <div className="mr-auto min-w-0">
                    <div className="truncate font-semibold">{o.organizationName}</div>
                    <div className="text-xs text-ink-muted">
                      {PLAN_LABEL[o.plan]} · quoted {money(o.quotedAmount, o.currency)}/mo · {when(o.createdAt)}
                    </div>
                  </div>
                  <StatusBadge status={o.status} />
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-ink-muted">Quotes, not charges — nothing has been billed.</p>
        </div>
      </div>
    </Section>
  );
}

/* ─────────────────────────────── page ─────────────────────────────── */

export default function ProfilePage({ navigate }) {
  const { account, signOut, isSilla } = useAccount();
  const [orders, setOrders] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [active, setActive] = useState("details");

  useEffect(() => {
    vendorApi.myOrders().then((d) => setOrders(d.orders || [])).catch(() => {});
  }, []);

  // Highlight the section in view.
  useEffect(() => {
    const els = SECTIONS.map((s) => document.getElementById(s.id)).filter(Boolean);
    if (!els.length) return undefined;
    const io = new IntersectionObserver(
      (entries) => {
        const top = entries.filter((en) => en.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id);
      },
      { rootMargin: "-20% 0px -60% 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [account?.id]);

  if (!account) return null;

  const jump = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <AccountLayout navigate={navigate} title="Your profile" subtitle="Your details, sign-in and billing.">
      {/* identity card */}
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
        className="mb-8 flex flex-wrap items-center gap-5 rounded-xl p-6"
        style={{ background: "linear-gradient(120deg, rgb(var(--c-accent) / 0.13), rgb(var(--c-bg-page-end)))" }}
      >
        <span
          className="grid h-16 w-16 place-items-center rounded-[20px] text-2xl font-extrabold"
          style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)", boxShadow: "0 5px 0 0 rgb(192 92 68)" }}
        >
          {initialsOf(account)}
        </span>
        <div className="mr-auto min-w-0">
          <div className="display truncate text-[1.7rem]">{account.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-secondary">
            <span className="truncate">{account.email}</span>
            <span className="text-ink-muted">·</span>
            <span>Member since {when(account.createdAt)}</span>
            {isSilla && (
              <span className="rounded-full bg-ink-primary px-2 py-0.5 text-[11px] font-bold text-bg-card">SILLA staff</span>
            )}
          </div>
        </div>
        <Button icon={Receipt} onClick={() => navigate(ROUTES.orders)}>
          My orders
        </Button>
      </motion.div>

      {!account.emailVerified && !isSilla && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="mb-8 flex flex-wrap items-center gap-4 rounded-xl border-2 px-5 py-4"
          style={{ borderColor: "rgb(var(--c-state-reserved) / 0.45)", background: "rgb(var(--c-state-reserved) / 0.08)" }}
        >
          <MailWarning size={22} style={{ color: "rgb(var(--c-state-reserved))" }} />
          <div className="mr-auto">
            <div className="font-bold">Verify your email to place orders</div>
            <div className="text-sm text-ink-secondary">You can keep configuring — only checking out needs it.</div>
          </div>
          <Button variant="primary" onClick={() => setDialog("verify")}>
            Verify now
          </Button>
        </motion.div>
      )}

      <div className="grid gap-8 lg:grid-cols-[210px_minmax(0,1fr)]">
        <nav className="hidden lg:block">
          <div className="sticky top-24 space-y-1">
            {SECTIONS.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => jump(id)}
                className="relative flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-semibold transition-colors"
                style={{ color: active === id ? "var(--color-ink-primary)" : "var(--color-ink-muted)" }}
              >
                {active === id && (
                  <motion.span
                    layoutId="profile-nav"
                    className="absolute inset-0 rounded-lg bg-bg-card shadow-sm"
                    transition={{ type: "spring", stiffness: 480, damping: 38 }}
                  />
                )}
                <Icon size={16} className="relative" />
                <span className="relative">{label}</span>
              </button>
            ))}
            <div className="my-3 border-t border-line/[0.08]" />
            <button
              type="button"
              onClick={() => {
                signOut();
                navigate(ROUTES.home);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-semibold text-ink-muted
                         transition-colors hover:bg-line/[0.05] hover:text-ink-primary"
            >
              <LogOut size={16} />
              Sign out
            </button>
          </div>
        </nav>

        <div className="space-y-6">
          <DetailsSection account={account} />
          <SecuritySection
            account={account}
            onVerify={() => setDialog("verify")}
            onChangeEmail={() => setDialog("email")}
            onChangePassword={() => setDialog("password")}
          />
          <BillingSection account={account} orders={orders} />

          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line/10 p-5 lg:hidden">
            <span className="mr-auto text-sm text-ink-secondary">Signed in as {account.email}</span>
            <Button
              icon={LogOut}
              onClick={() => {
                signOut();
                navigate(ROUTES.home);
              }}
            >
              Sign out
            </Button>
          </div>
        </div>
      </div>

      <VerifyEmailModal open={dialog === "verify"} onClose={() => setDialog(null)} onVerified={() => setDialog(null)} />
      <ChangeEmailModal open={dialog === "email"} onClose={() => setDialog(null)} />
      <ChangePasswordModal open={dialog === "password"} onClose={() => setDialog(null)} />
    </AccountLayout>
  );
}
