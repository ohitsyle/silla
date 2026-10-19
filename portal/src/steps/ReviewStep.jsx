import { useMemo } from "react";
import { ArrowRight, Boxes, CircleCheck, Download, Layers, ListChecks } from "lucide-react";
import { Badge, Button, Notice, Panel } from "../components/ui.jsx";
import { buildProfile } from "../lib/profile.js";

/**
 * Step 8 — read it back, see what it costs, then save it and order it.
 *
 * Every summary here reads the BUILT profile rather than the config, so
 * what the buyer checks is what SILLA will build from — including the
 * starter layout buildProfile generates.
 *
 * The way forward is the account: "Save to my account" (the wizard's
 * floating bar), then "Submit" on the order page, which sends the first
 * invoice. This step used to end in "Hand it over — Download profile…
 * send it to SILLA" with a "Copy JSON" button and the raw profile beside
 * the real path, so a buyer could reasonably think they had to email us
 * a file. The download is still here for anyone who needs a copy, as the
 * last and quietest thing on the page.
 */

const article = (word) => (/^[aeiou]/i.test(String(word).trim()) ? "an" : "a");
const capitalize = (word) => String(word).charAt(0).toUpperCase() + String(word).slice(1);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** How a member checks in, in words — the profile carries a method key ("rfid"). */
const CHECK_IN = { rfid: "an RFID card", qr: "a QR code" };

function Row({ label, children }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 py-1.5 border-b border-line/5 last:border-0 text-sm">
      <span className="w-44 shrink-0 text-ink-muted">{label}</span>
      <span className="text-ink-primary min-w-0 break-words">{children}</span>
    </div>
  );
}

function Swatch({ colour }) {
  if (!colour) return null;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-ink-secondary mr-3">
      <span className="w-3.5 h-3.5 rounded-[4px] border border-line/20" style={{ background: colour }} />
      <span className="font-mono">{colour}</span>
    </span>
  );
}

/** One numbered step of what happens after this page. */
function NextStep({ n, title, children }) {
  return (
    <li className="flex gap-3.5">
      <span
        className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-[10px] text-xs font-bold"
        style={{ background: "rgb(var(--c-accent) / 0.14)", color: "var(--color-accent)" }}
      >
        {n}
      </span>
      <span className="text-sm leading-relaxed">
        <span className="font-semibold text-ink-primary">{title}</span>{" "}
        <span className="text-ink-secondary">{children}</span>
      </span>
    </li>
  );
}

/**
 * @param problems  what still stops the order — [{ path, message, step: { index, label } }]
 * @param onJump    takes the buyer to the step a problem lives on
 * @param signedIn  whether saving needs an account first
 * @param trialDays the free trial, said where the order is explained
 */
export default function ReviewStep({
  config, problems = [], onJump, onDownload, downloaded, preview, quote, signedIn, trialDays = 0,
}) {
  const profile = useMemo(() => buildProfile(config), [config]);
  const { terminology, identity, policy, branding, catalog, floors } = profile;

  const seatsByKey = new Map(catalog.map((type) => [type.key, type.seatCount]));
  const unitsOn = (floor) =>
    floor.resources.reduce((sum, piece) => sum + (seatsByKey.get(piece.type) || 0), 0);

  const totalPieces = floors.reduce((total, floor) => total + floor.resources.length, 0);
  const totalUnits = floors.reduce((total, floor) => total + unitsOn(floor), 0);
  const owner = [config.owner?.firstName, config.owner?.lastName].filter((part) => part?.trim()).join(" ");

  return (
    <div className="space-y-4">
      {/* What is left, at the top where the step opens, each with a way to
          the step that fixes it. It used to sit at the bottom as "Not
          ready to provision", under a "Complete. This profile is ready
          for the seeder" notice that showed whatever the state. */}
      {problems.length > 0 ? (
        <div data-review-problems tabIndex={-1} className="outline-none">
          <Notice tone="error">
            <span className="font-medium">
              {problems.length === 1 ? "One thing to finish" : `${problems.length} things to finish`} before you can
              save this:
            </span>
            <ul className="mt-2 space-y-1.5">
              {problems.map((problem) => (
                <li key={problem.path} className="flex flex-wrap items-baseline gap-x-2">
                  <span>{problem.message}</span>
                  {problem.step && onJump && (
                    <button
                      type="button"
                      onClick={() => onJump(problem.step.index)}
                      className="inline-flex items-center gap-1 text-sm font-semibold underline underline-offset-2"
                    >
                      Fix in {problem.step.label}
                      <ArrowRight size={13} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Notice>
        </div>
      ) : (
        <Notice tone="success">
          Everything is in place — {plural(totalPieces, "piece")} across {plural(floors.length, "floor")},{" "}
          {plural(totalUnits, "bookable unit")}.
        </Notice>
      )}

      {preview}

      {/* The same quote the Hardware step added up, and the one the saved
          order will show — the server prices it again on save. */}
      {quote}

      <Panel title="What happens next" icon={ListChecks}>
        <ol className="space-y-3.5">
          <NextStep n={1} title="Save it to your account.">
            {signedIn
              ? "Nothing is charged, and you can come back and change it until you submit."
              : "You'll make a free account first, and this configuration comes with you. Nothing is charged."}
          </NextStep>
          <NextStep n={2} title="Submit it as your order.">
            From your order page, when you're ready. We send your first invoice
            {trialDays > 0 ? `, and your ${trialDays}-day free trial starts the day your system goes live` : ""}.
          </NextStep>
          <NextStep n={3} title="We build it.">
            Usually the same day. {owner || "Whoever you named to run it"} gets an email with the sign-in
            link and a one-time PIN.
          </NextStep>
        </ol>
      </Panel>

      <Panel title="What you're getting" icon={CircleCheck}>
        <Row label="Organization">{profile.organizationName}</Row>
        <Row label="Site">{profile.siteName}</Row>
        <Row label="Reads as">
          {capitalize(article(terminology.memberNoun))} {terminology.memberNoun} at this{" "}
          {terminology.facilityLabel} reserves {article(terminology.resourceNoun)}{" "}
          {terminology.resourceNoun}.
        </Row>
        <Row label="Member ID">
          <span className="font-mono">{identity.memberIdFormat}</span>
          <span className="text-ink-muted">
            {" "}· they check in with {CHECK_IN[identity.checkInMethod] || "their card"}
          </span>
        </Row>
        <Row label="Registration">
          {identity.selfServiceRegistration
            ? `${capitalize(terminology.memberNoun)}s enrol themselves at the kiosk`
            : `Staff enrol ${terminology.memberNoun}s`}
        </Row>
        <Row label="Palette">
          <Swatch colour={branding.primaryColor} />
          <Swatch colour={branding.surface.page} />
          <Swatch colour={branding.surface.card} />
          <Swatch colour={branding.ink.primary} />
        </Row>
        <Row label="Rules">
          {policy.gracePeriodMinutes} min to check in · {policy.maxStayHours} h maximum stay · locked after{" "}
          {policy.pinLockoutThreshold} wrong PINs · codes last {policy.verificationCodeExpiryMinutes} min
        </Row>
        <Row label="Open">
          {policy.operatingHours.open} to {policy.operatingHours.close}
        </Row>

        <details className="mt-3">
          <summary className="text-sm text-ink-secondary cursor-pointer select-none">
            Read the terms {terminology.memberNoun}s accept the first time they sign in
          </summary>
          <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-bg-panel border border-line/10 p-3 text-xs whitespace-pre-wrap font-sans text-ink-secondary">
            {profile.termsText}
          </pre>
        </details>
      </Panel>

      <Panel title={`Furniture — ${plural(catalog.length, "type")}`} icon={Boxes}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="font-normal pb-2 pr-4">Type</th>
                <th className="font-normal pb-2 pr-4">Footprint</th>
                <th className="font-normal pb-2 pr-4">Units</th>
                <th className="font-normal pb-2">Can be out of service</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((type) => (
                <tr key={type.key} className="border-t border-line/5">
                  <td className="py-1.5 pr-4 text-ink-primary">{type.label}</td>
                  <td className="py-1.5 pr-4 text-ink-secondary tabular-nums">
                    {type.footprint.w} × {type.footprint.h}
                  </td>
                  <td className="py-1.5 pr-4 text-ink-secondary tabular-nums">{type.seatCount}</td>
                  <td className="py-1.5 text-ink-secondary">{type.hasServiceStatus ? "Yes" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={`Floors — ${floors.length}`} icon={Layers}>
        <div className="space-y-2">
          {floors.map((floor) => (
            <div key={floor.order} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-primary w-44">{floor.name}</span>
              <Badge>
                {floor.grid.cols} × {floor.grid.rows}
              </Badge>
              <Badge>{plural(floor.resources.length, "piece")}</Badge>
              <Badge>{plural(unitsOn(floor), "unit")}</Badge>
              {floor.zones.length > 0 && <Badge>{plural(floor.zones.length, "zone")}</Badge>}
              {floor.labels.length > 0 && <Badge>{plural(floor.labels.length, "label")}</Badge>}
            </div>
          ))}
        </div>
      </Panel>

      {/* The file, for whoever needs one — an IT department, a records
          folder. Last and quiet on purpose: it is not how anyone orders. */}
      {onDownload && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-sm text-ink-muted">
          <span>Need a copy for your records?</span>
          <Button variant="ghost" size="sm" icon={Download} onClick={onDownload}>
            Download your setup as a file
          </Button>
          {downloaded && (
            <span role="status">Saved to your downloads. Saving to your account is still how you order.</span>
          )}
        </div>
      )}
    </div>
  );
}
