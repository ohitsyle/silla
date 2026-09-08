import { useEffect, useRef, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { ArrowDown, FileText } from "lucide-react";
import { motion } from "framer-motion";
import { api } from "../lib/api.js";
import { useAuth } from "../lib/AuthContext.jsx";
import AuthShell from "../components/AuthShell.jsx";
import { Button, Card, Loading, Notice, Skeleton } from "../components/ui/index.jsx";

/**
 * TermsPage — AUTH-3 (spec §5: "on first login the user must accept
 * terms before proceeding, after which the flag flips").
 *
 * AC: "First-login flag routes to terms; Cannot proceed until accepted."
 * The accept button stays disabled until the text has actually been
 * scrolled to the end — acknowledgement should require at least having
 * reached the bottom of what is being acknowledged. A progress bar makes
 * that requirement visible instead of leaving the button mysteriously
 * dead.
 */
export default function TermsPage() {
  const { user, isAuthenticated, requiresTermsAcceptance, acceptTerms, booting } = useAuth();
  const navigate = useNavigate();
  const scrollRef = useRef(null);

  const [terms, setTerms] = useState(null);
  const [readToEnd, setReadToEnd] = useState(false);
  const [progress, setProgress] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const organizationId = import.meta.env.VITE_DEMO_ORG_ID || "";

  useEffect(() => {
    api.getTerms(organizationId).then(setTerms).catch((err) => setError(err.message));
  }, [organizationId]);

  // If the text is short enough not to scroll, there is nothing to read
  // to the end of — don't trap the user behind a scroll that can't happen.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !terms) return;
    if (el.scrollHeight <= el.clientHeight + 4) {
      setReadToEnd(true);
      setProgress(1);
    }
  }, [terms]);

  // Wait for the session to resolve before deciding anything — a hard
  // reload has a token but no /me answer yet.
  if (booting) return <Loading className="min-h-screen" />;
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!requiresTermsAcceptance) return <Navigate to="/map" replace />;

  const onScroll = (e) => {
    const el = e.currentTarget;
    const max = el.scrollHeight - el.clientHeight;
    setProgress(max <= 0 ? 1 : Math.min(1, el.scrollTop / max));
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - 12) setReadToEnd(true);
  };

  const onAccept = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await acceptTerms();
      navigate("/map", { replace: true });
    } catch (err) {
      setError(err.message);
      setSubmitting(false);
    }
  };

  const body =
    terms?.termsOfServiceText?.trim() ||
    "This organization has not configured its terms of service text yet. " +
      "A superadmin sets it in Settings (ADM-5); until then there is nothing further to display.";

  return (
    <AuthShell
      width="max-w-2xl"
      icon={FileText}
      title="Terms of use"
      subtitle={`${terms?.organizationName ? `${terms.organizationName} · ` : ""}Please review before continuing${
        user?.firstName ? `, ${user.firstName}` : ""
      }.`}
      footer="Your acceptance is recorded once and kept with your account."
    >
      <Card padded={false} className="overflow-hidden">
        {/* Reading progress — makes the gate's requirement legible. */}
        <div className="h-0.5 bg-line/10">
          <motion.div
            className="h-full origin-left"
            style={{ background: "var(--color-accent)", scaleX: progress }}
            initial={false}
            animate={{ scaleX: progress }}
            transition={{ duration: 0.1, ease: "linear" }}
          />
        </div>

        <div
          ref={scrollRef}
          onScroll={onScroll}
          tabIndex={0}
          className="p-6 max-h-[48vh] overflow-y-auto text-sm text-ink-secondary whitespace-pre-wrap leading-relaxed"
        >
          {terms ? (
            body
          ) : (
            <div className="space-y-2">
              {Array.from({ length: 7 }, (_, i) => (
                <Skeleton key={i} className={`h-3 ${i % 3 === 2 ? "w-2/3" : "w-full"}`} />
              ))}
            </div>
          )}
        </div>
      </Card>

      {error && <Notice tone="error" className="mt-4">{error}</Notice>}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <Button variant="primary" size="lg" onClick={onAccept} disabled={!readToEnd} loading={submitting}>
          I accept these terms
        </Button>
        {!readToEnd && (
          <motion.span
            className="text-xs text-ink-muted flex items-center gap-1.5"
            animate={{ y: [0, 2, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
          >
            <ArrowDown size={13} />
            Scroll to the end to continue
          </motion.span>
        )}
      </div>
    </AuthShell>
  );
}
