import { useEffect, useState } from "react";
import { ArrowRight, CloudOff, RefreshCw, Search, SearchX } from "lucide-react";
import { api } from "../lib/api.js";
import { LEGACY_ROUTES, addressFromInput, isSlugShaped } from "../lib/orgAddress.js";
import AuthShell from "../components/AuthShell.jsx";
import { Button, Card, Spinner } from "../components/ui/index.jsx";

/**
 * The screens shown BEFORE the app knows which organization it is for
 * (docs/control-plane.md §1) — so none of them carries anyone's branding.
 * They use the product's neutral palette and no vendor name either: the
 * person reading them is somebody's member who mistyped a link, and
 * "SILLA" would mean nothing to them.
 *
 * FindOrganizationPage  no address and no default organization; or, with
 *                       `attempted`, an address nobody has. `then` is the
 *                       page that was asked for, carried over once the
 *                       organization is found
 * ServiceUnavailable    the API could not be reached to find out
 * BootScreen            the moment while the address is being looked up
 *
 * There is deliberately no list of organizations to pick from. That list
 * is SILLA's customer list, and it never ships to customers.
 */

const cx = (...parts) => parts.filter(Boolean).join(" ");

export default function FindOrganizationPage({ attempted = null, then = "" }) {
  const [value, setValue] = useState(attempted || "");
  const [error, setError] = useState(null);
  const [checking, setChecking] = useState(false);
  const host = window.location.host;

  useEffect(() => {
    document.title = attempted ? "Organization not found" : "Find your organization";
  }, [attempted]);

  // Errors are revealed when the person asks to continue, never before:
  // an empty box on arrival is not a mistake yet.
  const submit = async (e) => {
    e.preventDefault();
    const slug = addressFromInput(value);
    if (!slug) {
      setError("Enter your organization's address.");
      return;
    }
    if (LEGACY_ROUTES.has(slug)) {
      setError(`"${slug}" is a page, not an organization. Enter the part of the link that names your organization.`);
      return;
    }
    if (!isSlugShaped(slug)) {
      setError("An address is made of lowercase letters, numbers and hyphens, with no spaces.");
      return;
    }

    setError(null);
    setChecking(true);
    try {
      await api.getOrgConfigBySlug(slug);
      // A full page load, not an in-app hop: the organization's colours,
      // session and router all start from its own address, so nothing
      // from this neutral screen can leak into it.
      window.location.assign(`/${slug}${then}`);
    } catch (err) {
      setChecking(false);
      setError(
        err.status === 404
          ? `There's no organization at "${slug}". Check the spelling, or ask whoever gave you the link.`
          : "We couldn't reach the service just now. Check your connection and try again."
      );
    }
  };

  return (
    <AuthShell
      width="max-w-md"
      icon={attempted ? SearchX : Search}
      title={attempted ? "We couldn't find that organization" : "Find your organization"}
      subtitle={
        attempted
          ? `Nothing is at /${attempted}. Check the address, or enter it below.`
          : "Enter its address to sign in, book or check in."
      }
      footer="Not sure of it? It's in the link or welcome email your organization sent you."
    >
      <Card elevation="floating">
        <form onSubmit={submit} noValidate className="space-y-4">
          <label className="block">
            <span className="text-sm font-medium text-ink-secondary">Organization address</span>
            <div
              className={cx(
                "mt-1.5 flex h-11 items-stretch overflow-hidden rounded-md border bg-bg-panel",
                "transition-colors duration-fast ease-out",
                error ? "border-state-unavailable/60" : "border-line/10 focus-within:border-line/40"
              )}
            >
              {/*
                The host the address hangs off, so "address" means
                something: this box is the end of a link. Truncated from
                the LEFT on a narrow screen, so the slash before the box —
                the part that explains it — always shows.
              */}
              <span
                aria-hidden="true"
                className="flex max-w-[55%] items-center overflow-hidden whitespace-nowrap pl-3 text-ink-muted select-none"
                style={{ direction: "rtl", textOverflow: "ellipsis" }}
              >
                <bdi>{host}/</bdi>
              </span>
              <input
                name="address"
                autoFocus
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  if (error) setError(null);
                }}
                // An address that led nowhere arrives selected: typing
                // replaces it, and the arrow keys still let you fix a typo.
                onFocus={attempted ? (e) => e.target.select() : undefined}
                aria-invalid={error ? "true" : undefined}
                aria-describedby="address-help"
                className="min-w-0 flex-1 bg-transparent pr-3 text-ink-primary outline-none placeholder:text-ink-muted/60"
                placeholder="your-organization"
              />
            </div>
            <span
              id="address-help"
              role={error ? "alert" : undefined}
              className={cx("mt-1 block text-xs", error ? "text-state-unavailable" : "text-ink-muted")}
            >
              {error || "Pasting the whole link works too."}
            </span>
          </label>

          <Button type="submit" variant="primary" size="lg" icon={ArrowRight} loading={checking} className="w-full">
            Continue
          </Button>
        </form>
      </Card>
    </AuthShell>
  );
}

/** The API did not answer, so we cannot tell which organization this is. */
export function ServiceUnavailablePage({ onRetry }) {
  useEffect(() => {
    document.title = "Can't connect";
  }, []);

  return (
    <AuthShell
      icon={CloudOff}
      title="Can't connect right now"
      subtitle="The service didn't answer. Check your connection, then try again."
    >
      <Card elevation="floating">
        <Button variant="primary" size="lg" icon={RefreshCw} onClick={onRetry} className="w-full">
          Try again
        </Button>
      </Card>
    </AuthShell>
  );
}

/**
 * While the address is looked up. Blank for the first moment on purpose:
 * the lookup usually answers in well under half a second, and a spinner
 * that flashes on every page load is noise. It only appears if the
 * network is genuinely slow.
 */
export function BootScreen() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 400);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-ink-secondary" aria-busy="true">
      {slow && (
        <>
          <Spinner />
          Loading…
        </>
      )}
    </div>
  );
}
