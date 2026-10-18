import { useMemo, useState } from "react";
import {
  CircleCheck, ClipboardCheck, Copy, Download, FileJson, Send, TriangleAlert,
} from "lucide-react";
import { Badge, Button, Notice, Panel } from "../components/ui.jsx";
import { buildProfile } from "../lib/profile.js";

/**
 * Step 8 — read it back, see what it costs, then hand it over.
 *
 * The JSON below is the deliverable: the wizard's whole job is to
 * produce a file the existing seeder already knows how to consume, which
 * is why it is shown in full rather than summarised away. A buyer who
 * wants to diff two profiles, or an engineer provisioning without the
 * portal, needs the bytes.
 *
 * Every summary here reads the BUILT profile rather than the config, so
 * what the buyer checks is what the seeder will receive — including the
 * fields buildProfile derives, like the key and the starter layout.
 */

const article = (word) => (/^[aeiou]/i.test(String(word).trim()) ? "an" : "a");
const capitalize = (word) => String(word).charAt(0).toUpperCase() + String(word).slice(1);

/** App hands errors down keyed by field; listed here as the last safety net. */
const problemsOf = (errors) =>
  Object.entries(errors || {}).map(([field, message]) => ({ field, message }));

function CopyButton({ value, label = "Copy" }) {
  const [state, setState] = useState("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  };

  return (
    <Button size="sm" icon={state === "copied" ? ClipboardCheck : Copy} onClick={copy}>
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </Button>
  );
}

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

export default function ReviewStep({ config, errors, onDownload, preview, quote }) {
  const profile = useMemo(() => buildProfile(config), [config]);
  const json = useMemo(() => JSON.stringify(profile, null, 2), [profile]);

  const { terminology, identity, policy, branding, catalog, floors } = profile;
  const problems = problemsOf(errors);

  const seatsByKey = new Map(catalog.map((type) => [type.key, type.seatCount]));
  const unitsOn = (floor) =>
    floor.resources.reduce((sum, piece) => sum + (seatsByKey.get(piece.type) || 0), 0);

  const totalPieces = floors.reduce((total, floor) => total + floor.resources.length, 0);
  const totalUnits = floors.reduce((total, floor) => total + unitsOn(floor), 0);

  return (
    <div className="space-y-4">
      {problems.length > 0 ? (
        <Notice tone="error">
          <span className="font-medium">
            {problems.length} thing{problems.length === 1 ? "" : "s"} to fix before this profile can be
            provisioned:
          </span>
          <ul className="mt-2 space-y-1">
            {problems.map((problem) => (
              <li key={problem.field}>
                <span className="font-mono text-xs">{problem.field}</span> — {problem.message}
              </li>
            ))}
          </ul>
        </Notice>
      ) : (
        <Notice tone="success">
          Complete. This profile is ready for the seeder — {totalPieces} pieces across{" "}
          {floors.length} floor{floors.length === 1 ? "" : "s"}, {totalUnits} bookable units.
        </Notice>
      )}

      {preview}

      {/* The same quote the Hardware step added up, and the one the saved
          order will show — the server prices it again on save. */}
      {quote}

      <Panel title="What this deployment will be" icon={CircleCheck}>
        <Row label="Organization">{profile.organizationName}</Row>
        <Row label="Site">{profile.siteName}</Row>
        <Row label="Profile key">
          <span className="font-mono">{profile.key}</span>
        </Row>
        <Row label="Reads as">
          {capitalize(article(terminology.memberNoun))} {terminology.memberNoun} at this{" "}
          {terminology.facilityLabel} reserves {article(terminology.resourceNoun)}{" "}
          {terminology.resourceNoun}.
        </Row>
        <Row label="Member ID">
          <span className="font-mono">{identity.memberIdFormat}</span>
          <span className="text-ink-muted"> · check-in by {identity.checkInMethod}</span>
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
        <Row label="Policy">
          {policy.gracePeriodMinutes} min grace · {policy.maxStayHours} h maximum stay ·{" "}
          {policy.pinLockoutThreshold} PIN attempts · {policy.verificationCodeExpiryMinutes} min codes
        </Row>
        <Row label="Open">
          {policy.operatingHours.open} to {policy.operatingHours.close}
        </Row>
      </Panel>

      <Panel title={`Catalog — ${catalog.length} types`} icon={FileJson}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-ink-muted">
                <th className="font-normal pb-2 pr-4">Type</th>
                <th className="font-normal pb-2 pr-4">Key</th>
                <th className="font-normal pb-2 pr-4">Footprint</th>
                <th className="font-normal pb-2 pr-4">Units</th>
                <th className="font-normal pb-2">Service status</th>
              </tr>
            </thead>
            <tbody>
              {catalog.map((type) => (
                <tr key={type.key} className="border-t border-line/5">
                  <td className="py-1.5 pr-4 text-ink-primary">{type.label}</td>
                  <td className="py-1.5 pr-4 font-mono text-xs text-ink-secondary">{type.key}</td>
                  <td className="py-1.5 pr-4 text-ink-secondary tabular-nums">
                    {type.footprint.w} × {type.footprint.h}
                  </td>
                  <td className="py-1.5 pr-4 text-ink-secondary tabular-nums">{type.seatCount}</td>
                  <td className="py-1.5 text-ink-secondary">{type.hasServiceStatus ? "tracked" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel title={`Floors — ${floors.length}`} icon={FileJson}>
        <div className="space-y-2">
          {floors.map((floor) => (
            <div key={floor.order} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-ink-primary w-44">{floor.name}</span>
              <Badge>
                {floor.grid.cols} × {floor.grid.rows}
              </Badge>
              <Badge>{floor.resources.length} pieces</Badge>
              <Badge>{unitsOn(floor)} units</Badge>
              {floor.zones.length > 0 && <Badge>{floor.zones.length} zones</Badge>}
              {floor.labels.length > 0 && <Badge>{floor.labels.length} labels</Badge>}
            </div>
          ))}
        </div>
      </Panel>

      {/*
        The buyer's hand-off, not ours.
        This panel used to print `cd server && npm run seed:file ...` and
        tell the reader to "save the file into the repository" — SILLA's
        own provisioning step, shown to the customer who is buying the
        result of it. It made sense when the portal was an internal tool;
        it contradicts the storefront in front of it now, and asks a
        librarian to think about a terminal. The command lives in
        CLAUDE.md and in importProfile.js, where the people who run it
        will look.
      */}
      <Panel
        title="Hand it over"
        icon={Send}
        action={
          onDownload && (
            <Button variant="primary" icon={Download} onClick={onDownload}>
              Download profile
            </Button>
          )
        }
      >
        <p className="text-sm text-ink-secondary">
          Download the file and send it to SILLA. Your deployment is built from exactly what is below —
          the same names, the same colours, the same floors — and handed back with a link and a
          superadmin login. Nothing here is final: change your mind, come back, download again.
        </p>
      </Panel>

      <Panel title="Provisioning profile" icon={FileJson} action={<CopyButton value={json} label="Copy JSON" />}>
        <details>
          <summary className="text-sm text-ink-secondary cursor-pointer select-none">
            Show the emitted JSON ({(json.length / 1024).toFixed(1)} KB)
          </summary>
          <pre className="mt-3 max-h-96 overflow-auto rounded-md bg-bg-panel border border-line/10 p-3 text-xs font-mono text-ink-secondary">
            {json}
          </pre>
        </details>

        <details className="mt-3">
          <summary className="text-sm text-ink-secondary cursor-pointer select-none">
            Show the terms {terminology.memberNoun}s accept on first login
          </summary>
          <pre className="mt-3 max-h-72 overflow-auto rounded-md bg-bg-panel border border-line/10 p-3 text-xs whitespace-pre-wrap text-ink-secondary">
            {profile.termsText}
          </pre>
        </details>
      </Panel>

      {problems.length > 0 && (
        <p className="text-sm text-ink-secondary flex items-start gap-2">
          <TriangleAlert size={16} className="shrink-0 mt-0.5" />
          The profile can still be downloaded while it has problems — the seeder, not the portal, is
          the thing that will refuse it.
        </p>
      )}
    </div>
  );
}
