import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Check, FileText } from "lucide-react";

import { Button, Modal } from "../components/ui.jsx";
import { ROUTES } from "../lib/useHashRoute.js";

/**
 * SILLA's Terms & Conditions — one source, shown two ways.
 *
 * As a page at #/terms, linked from the storefront footer, for anyone
 * who wants to read them. And in a dialog from the sign-up form, so
 * reading them doesn't throw away a half-filled form.
 *
 * Keep TERMS_UPDATED in step with TERMS_VERSION in
 * vendor/src/routes/auth.routes.js — that is the version recorded
 * against each account that agrees.
 *
 * This is plain-language operating text, NOT reviewed legal advice. Have
 * it reviewed before it governs real money.
 */
export const TERMS_UPDATED = "17 September 2026";
const CONTACT = "officialsillasystem@gmail.com";

const SECTIONS = [
  {
    id: "about",
    title: "About these terms",
    body: [
      "These terms govern your use of the SILLA website, your SILLA account, the configurator, and any order you place with us. By creating an account you agree to them.",
      "SILLA (Space Intelligence & Live Layout Administration) builds and provides resource-reservation and occupancy systems — for libraries, offices and other shared spaces — deployed under your organization's own name and branding.",
    ],
  },
  {
    id: "account",
    title: "Your account",
    body: [
      "You must give accurate details when you create an account and keep them up to date. An account belongs to one person; don't share your password.",
      "We ask you to verify your email address before you can place an order, because that address is where we send every update about it. You can explore and configure before verifying.",
      "You're responsible for activity on your account. If you think someone else has access to it, change your password and tell us straight away.",
    ],
  },
  {
    id: "configuring",
    title: "Configuring and ordering",
    body: [
      "A configuration you build and save is a draft. It is not an order, and nothing is committed or charged until you submit it.",
      "When you submit an order, we review the configuration with you before building it. We may contact you to confirm details, suggest changes, or explain anything that can't be built as described.",
      "Once submitted, an order can't be edited from your account. Contact us if something needs to change.",
    ],
  },
  {
    id: "pricing",
    title: "Pricing, billing and payment",
    body: [
      "Prices shown on the website are indicative. The price that applies to your order is the one we confirm with you in writing before billing begins, and it may differ where your configuration or requirements call for it.",
      "The quote recorded against your order is kept as a record of what you were shown when you submitted it.",
      "SILLA never stores card numbers. When online payment is available, card details are handled by our payment provider, and we keep only a reference to your customer record with them.",
      "Prices exclude taxes unless we say otherwise. You're responsible for any taxes that apply to your purchase.",
    ],
  },
  {
    id: "deployment",
    title: "Your deployment",
    body: [
      "Each organization receives its own deployment, configured from the profile you built. Your branding, terminology, floor plans and settings are yours, and you can change them after the system goes live.",
      "The person you name as the system's owner receives the first administrator account. You're responsible for who you give access to, and for how the people in your organization use the system.",
      "Your organization's operational data — members, reservations, check-ins — belongs to your organization. We process it only to provide and support the service.",
    ],
  },
  {
    id: "use",
    title: "Acceptable use",
    body: [
      "Don't use SILLA to break the law, to collect people's information without a lawful basis, to interfere with the service or other customers, or to attempt to access data that isn't yours.",
      "We may suspend an account or deployment that puts the service, other customers, or the people using it at risk.",
    ],
  },
  {
    id: "privacy",
    title: "Your data and privacy",
    body: [
      "We collect the details you give us — your name, email address, organization and billing details — and records of the orders you place. We use them to run your account, fulfil and support your orders, and contact you about them.",
      "We handle personal information in accordance with the Data Privacy Act of 2012 (Republic Act No. 10173) of the Philippines. We don't sell your personal information.",
      "You can update your details from your profile at any time, and ask us to access, correct or delete the personal information we hold about you by contacting us.",
    ],
  },
  {
    id: "availability",
    title: "Service availability and changes",
    body: [
      "We work to keep SILLA available and reliable, but we can't promise uninterrupted service. We may carry out maintenance, and we may change or improve features over time.",
    ],
  },
  {
    id: "termination",
    title: "Cancellation and closing your account",
    body: [
      "You can ask us to cancel an order that hasn't gone live, or to close your account, at any time.",
      "We may cancel an order we're unable to fulfil, and will tell you why when we do.",
    ],
  },
  {
    id: "liability",
    title: "Limitation of liability",
    body: [
      "To the extent the law allows, SILLA is not liable for indirect or consequential losses arising from your use of the website or the service. Nothing in these terms limits liability that cannot be limited by law.",
    ],
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: [
      `We may update these terms. The date at the top shows when they last changed. If a change materially affects you, we'll let you know before it takes effect. These terms were last updated on ${TERMS_UPDATED}.`,
    ],
  },
  {
    id: "law",
    title: "Governing law",
    body: ["These terms are governed by the laws of the Republic of the Philippines."],
  },
  {
    id: "contact",
    title: "Contact us",
    body: [`Questions about these terms, your account or your data: ${CONTACT}.`],
  },
];

/** The terms themselves, with a contents list. Numbered, because clauses get cited. */
export function TermsContent({ compact = false }) {
  return (
    <div>
      {!compact && (
        <nav aria-label="Contents" className="mb-10 rounded-xl border border-line/10 bg-bg-card p-5">
          <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.14em] text-ink-muted">Contents</p>
          <ol className="grid gap-x-8 gap-y-1.5 text-sm sm:grid-cols-2">
            {SECTIONS.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#terms-${s.id}`}
                  onClick={(e) => {
                    e.preventDefault();
                    document.getElementById(`terms-${s.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }}
                  className="text-ink-secondary transition-colors hover:text-ink-primary"
                >
                  <span className="mr-2 font-mono text-xs text-ink-muted tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      )}

      <div className="space-y-9">
        {SECTIONS.map((s, i) => (
          <section key={s.id} id={`terms-${s.id}`} className="scroll-mt-28">
            <h2 className={`flex items-baseline gap-3 font-extrabold tracking-tight ${compact ? "text-base" : "text-xl"}`}>
              <span className="font-mono text-sm font-bold text-[color:var(--color-accent)] tabular-nums">
                {String(i + 1).padStart(2, "0")}
              </span>
              {s.title}
            </h2>
            <div className={`mt-3 space-y-3 leading-relaxed text-ink-secondary ${compact ? "text-sm" : "text-[15px]"}`}>
              {s.body.map((para, j) => (
                <p key={j}>{para}</p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

/** The standalone page, linked from the storefront footer. */
export function TermsPage({ navigate }) {
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <div className="silla-marketing min-h-screen">
      <header
        className="sticky top-0 z-40 border-b border-line/[0.07]"
        style={{ background: "rgb(var(--c-bg-page) / 0.86)", backdropFilter: "saturate(180%) blur(12px)" }}
      >
        <div className="mx-auto flex h-[72px] max-w-3xl items-center gap-4 px-6">
          <button
            type="button"
            onClick={() => navigate(ROUTES.home)}
            className="flex items-center gap-2.5 text-xl font-extrabold tracking-tight transition-opacity hover:opacity-70"
          >
            <span
              className="grid h-8 w-8 place-items-center rounded-[10px] text-sm"
              style={{ background: "var(--color-accent)", color: "var(--color-accent-ink)" }}
            >
              S
            </span>
            SILLA
          </button>
          <button
            type="button"
            onClick={() => navigate(ROUTES.home)}
            className="ml-auto inline-flex items-center gap-1.5 text-sm font-medium text-ink-secondary transition-colors hover:text-ink-primary"
          >
            <ArrowLeft size={15} />
            Back to the site
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-24 pt-14">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
        >
          <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-[color:var(--color-accent)]">Legal</p>
          <h1 className="display mt-3 text-[clamp(2.4rem,6vw,3.6rem)]">Terms &amp; Conditions</h1>
          <p className="mt-4 max-w-xl text-lg leading-relaxed text-ink-secondary">
            The agreement between you and SILLA — written to be read, not skimmed past.
          </p>
          <p className="mt-5 inline-flex items-center gap-2 rounded-full bg-bg-panel px-3.5 py-1.5 text-sm text-ink-secondary">
            <FileText size={15} />
            Last updated {TERMS_UPDATED}
          </p>

          <div className="mt-12">
            <TermsContent />
          </div>
        </motion.div>
      </main>
    </div>
  );
}

/**
 * The terms in a dialog, from the sign-up form. "I agree" is only
 * offered once they've scrolled to the end — agreeing from the first
 * paragraph is agreeing without reading, which is what a checkbox
 * already allows. The checkbox on the form stays the quick path.
 */
export function TermsModal({ open, onClose, onAgree, agreed }) {
  const scroller = useRef(null);
  const [reachedEnd, setReachedEnd] = useState(false);

  useEffect(() => {
    if (open) setReachedEnd(false);
  }, [open]);

  const onScroll = () => {
    const el = scroller.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 40) setReachedEnd(true);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon={FileText}
      title="Terms & Conditions"
      subtitle={`Last updated ${TERMS_UPDATED}`}
      width="max-w-2xl"
      footer={
        <>
          <span className="mr-auto text-xs text-ink-muted">
            {agreed ? "You've agreed to these terms." : reachedEnd ? "You've reached the end." : "Scroll to the end to agree here."}
          </span>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {!agreed && (
            <Button
              variant="primary"
              icon={Check}
              disabled={!reachedEnd}
              onClick={() => {
                onAgree();
                onClose();
              }}
            >
              I agree
            </Button>
          )}
        </>
      }
    >
      <div
        ref={scroller}
        onScroll={onScroll}
        className="-mx-5 -my-5 max-h-[58vh] overflow-y-auto px-6 py-6"
        tabIndex={0}
        aria-label="Terms and Conditions text"
      >
        <TermsContent compact />
      </div>
    </Modal>
  );
}
