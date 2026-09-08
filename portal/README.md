# SILLA Portal

SILLA's sales and onboarding surface — the vendor's storefront, not a
buyer's system.

A buyer walks a wizard here (name, colours, terminology, identity format,
policy, catalog, floors, terms) with a live preview of the system they
are configuring, and the portal emits a **provisioning profile**: the
JSON object `server/src/scripts/profiles.js` already defines and the
seed script already consumes.

It is a separate Vite app on purpose. A buyer's deployment ships their
system and nothing else — never the vendor's order-taking UI.

## Run it

```bash
cd portal
npm install
npm run dev          # http://localhost:5174
```

Port 5174, so it can run beside the buyer app on 5173 while you check
that a profile produces the system it promised.

## Hand-off

The buyer downloads the profile from the last step of the wizard and
sends it to SILLA. The emitted JSON is the same shape as the built-in
`library` and `office` profiles, so it drops straight into the seeder's
profile registry — add it to `VERTICAL_PROFILES` in
`server/src/scripts/profiles.js` under its own `key`, then:

```bash
cd server
npm run seed -- acme-library      # provision a new deployment
npm run profile acme-library      # or re-skin an existing one in place
```

Both server scripts today take a profile KEY, not a path: there is no
`seed:file` in `server/package.json`. Reading the downloaded JSON
directly is a small addition on the server side, and worth making once
buyers are onboarded often enough that editing a source file to
provision one stops being reasonable.

The profile is plain data. Nothing in the engine, API, or components
differs between one buyer and the next; if a portal change makes one
profile work and another break, the change hardcoded something it
shouldn't have.

## Design

The portal shares the buyer app's design system: the same token names,
the same Tailwind mapping (`rgb(var(--c-*) / <alpha-value>)`), the same
motion vocabulary. `src/index.css` declares those tokens twice — once on
`:root` for SILLA's own chrome, and once under `.silla-preview` so the
preview can wear the buyer's colours while the wizard around it stays
SILLA's. Set the buyer's `--c-*` channels on the preview element; the
`--color-*` forms recompute from them.
