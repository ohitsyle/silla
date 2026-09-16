/**
 * The HTML shell every product email is rendered into.
 *
 * These go to a buyer's members and staff, AS the buyer's organization —
 * so unlike the storefront's copy of this file (vendor/src/services/
 * email/layout.js) there is no SILLA anywhere in it. The header band, the
 * mark, the pills and the buttons are painted from the organization's own
 * branding, the same values the client themes itself with. A white-label
 * product that signs its emails "SILLA" is not white-label.
 *
 * The one exception is founderWelcomeEmail, which is SILLA handing a
 * finished deployment to its buyer; it passes SILLA_BRAND explicitly.
 *
 * Every message still ships a plain-text part generated from the same
 * blocks, so a client that refuses HTML, a screen reader and a spam filter
 * all get the real content, and the two parts can never disagree.
 *
 * Email HTML is its own dialect: tables for layout, every style inline, no
 * web fonts, no flexbox, no CSS variables. Outlook ignores border radius
 * and that is fine — it degrades to square corners, not a broken layout.
 */

const NEUTRAL = {
  page: "#F2F2EF",
  card: "#FFFFFF",
  ink: "#16181D",
  soft: "#4A4F59",
  faint: "#8A8F99",
  rule: "#E6E6E1",
  well: "#F6F6F3",
};

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',ui-monospace,Menlo,Consolas,'Courier New',monospace";

/**
 * Everything interpolated here is user-supplied somewhere — a first name,
 * the organization's name, a closure reason typed by staff. An unescaped
 * "<a href=...>" in a name would render as a live link in someone's inbox,
 * inside a message carrying the organization's brand.
 */
export const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/* ─────────────────────────────── colour ─────────────────────────────── */

/**
 * Branding colours are typed into the admin console, and they land inside
 * style="" attributes. Only plain hex gets through; anything else — rgb(),
 * a named colour, or an attempt to close the attribute — falls back.
 */
function hex(value) {
  const v = String(value || "").trim();
  if (/^#[0-9a-f]{6}$/i.test(v)) return v.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(v)) return `#${v.slice(1).replace(/./g, (c) => c + c)}`.toUpperCase();
  return null;
}

function luminance(color) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(color.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Whichever of near-black and white reads better on this background. */
const inkOn = (background) => (contrast(background, "#16181D") >= contrast(background, "#FFFFFF") ? "#16181D" : "#FFFFFF");

/** Keep the organization's chosen text colour only if it is actually legible there. */
const legible = (preferred, background) => (preferred && contrast(preferred, background) >= 4.5 ? preferred : inkOn(background));

/* ─────────────────────────────── brands ─────────────────────────────── */

/**
 * An organization's branding, reduced to what an email can carry.
 *
 * The header band takes the organization's page surface, so a deployment
 * with a navy product gets a navy masthead. An organization that never
 * set one gets a dark neutral band rather than a guess at a palette.
 */
export function orgBrand(org) {
  const b = org?.branding || {};
  const accent = hex(b.primaryColor) || "#16181D";
  const header = hex(b.surface?.page) || "#16181D";
  return {
    name: org?.name || "Your organization",
    initial: String(org?.name || "?").trim().charAt(0).toUpperCase() || "?",
    logoUrl: /^https:\/\//i.test(b.logoUrl || "") ? b.logoUrl : null,
    header,
    headerInk: legible(hex(b.ink?.primary), header),
    accent,
    accentInk: legible(hex(b.accentTextColor), accent),
  };
}

/** SILLA itself — used only where SILLA, not the organization, is speaking. */
export const SILLA_BRAND = {
  name: "SILLA",
  initial: "S",
  logoUrl: null,
  header: "#F6F0E5",
  headerInk: "#1A1612",
  // White on the terracotta itself is 2.9:1; the deep shade carries text.
  accent: "#C05C44",
  accentInk: "#FFFFFF",
  mark: "#E07A5F",
};

/* ─────────────────────────────── blocks ─────────────────────────────── */

export const p = (text) => ({ kind: "p", text });
export const code = (value, caption) => ({ kind: "code", value: String(value), caption });
export const details = (rows) => ({ kind: "details", rows: rows.filter(([, v]) => v != null && v !== "") });
export const button = (label, href) => ({ kind: "button", label, href });
export const note = (text, tone = "neutral") => ({ kind: "note", text, tone });

function blockHtml(b, brand) {
  switch (b.kind) {
    case "p":
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${NEUTRAL.soft};">${esc(b.text)}</p>`;

    case "code": {
      // One cell per digit. A code in running type is the most misread
      // thing we send; separate boxes make each digit something you look at.
      const cells = b.value
        .split("")
        .map(
          (d) =>
            `<td style="padding:0 4px;"><div style="width:44px;height:54px;line-height:54px;border-radius:12px;` +
            `background:${NEUTRAL.card};border:2px solid ${NEUTRAL.rule};border-bottom:3px solid ${brand.accent};` +
            `text-align:center;font-family:${MONO};font-size:26px;font-weight:700;color:${NEUTRAL.ink};">${esc(d)}</div></td>`
        )
        .join("");
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 10px;"><tr>${cells}</tr></table>` +
        (b.caption
          ? `<p style="margin:0 0 20px;text-align:center;font-size:13px;color:${NEUTRAL.faint};">${esc(b.caption)}</p>`
          : "")
      );
    }

    case "details": {
      const rows = b.rows
        .map(
          ([label, value], i) =>
            `<tr><td width="130" style="width:130px;padding:10px 16px;font-size:13px;color:${NEUTRAL.faint};white-space:nowrap;vertical-align:top;` +
            `${i ? `border-top:1px solid ${NEUTRAL.rule};` : ""}">${esc(label)}</td>` +
            `<td style="padding:10px 16px;font-size:14px;color:${NEUTRAL.ink};font-weight:600;` +
            `${i ? `border-top:1px solid ${NEUTRAL.rule};` : ""}">${esc(value)}</td></tr>`
        )
        .join("");
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
        `style="margin:4px 0 20px;background:${NEUTRAL.well};border-radius:14px;">${rows}</table>`
      );
    }

    case "button":
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;"><tr>` +
        `<td style="border-radius:999px;background:${brand.accent};">` +
        `<a href="${esc(b.href)}" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:15px;` +
        `font-weight:700;color:${brand.accentInk};text-decoration:none;border-radius:999px;">${esc(b.label)} &rarr;</a>` +
        `</td></tr></table>`
      );

    case "note": {
      const bar = b.tone === "warning" ? brand.accent : NEUTRAL.rule;
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;"><tr>` +
        `<td style="border-left:3px solid ${bar};padding:4px 0 4px 14px;font-size:13.5px;line-height:1.6;color:${NEUTRAL.soft};">` +
        `${esc(b.text)}</td></tr></table>`
      );
    }

    default:
      return "";
  }
}

function blockText(b) {
  switch (b.kind) {
    case "p":
      return b.text;
    case "code":
      return `    ${b.value.split("").join(" ")}${b.caption ? `\n    ${b.caption}` : ""}`;
    case "details": {
      const width = Math.max(...b.rows.map(([l]) => l.length));
      return b.rows.map(([l, v]) => `  ${l.padEnd(width)}   ${v}`).join("\n");
    }
    case "button":
      return `${b.label}: ${b.href}`;
    case "note":
      return b.text;
    default:
      return "";
  }
}

/* ─────────────────────────────── shell ─────────────────────────────── */

function masthead(brand) {
  const mark = brand.logoUrl
    ? `<img src="${esc(brand.logoUrl)}" alt="" width="34" height="34" style="display:block;width:34px;height:34px;border-radius:10px;border:0;">`
    : `<div style="width:34px;height:34px;line-height:34px;border-radius:10px;background:${brand.mark || brand.accent};` +
      `text-align:center;font-size:16px;font-weight:800;color:${brand.mark ? "#FFFDF9" : brand.accentInk};font-family:${FONT};">${esc(brand.initial)}</div>`;
  return (
    `<tr><td style="background:${brand.header};border-radius:20px 20px 0 0;padding:20px 28px;">` +
    `<table role="presentation" cellpadding="0" cellspacing="0"><tr>` +
    `<td style="vertical-align:middle;">${mark}</td>` +
    `<td style="padding-left:12px;vertical-align:middle;font-size:18px;font-weight:800;letter-spacing:-0.3px;color:${brand.headerInk};font-family:${FONT};">${esc(brand.name)}</td>` +
    `</tr></table></td></tr>`
  );
}

/**
 * @param {object}   o
 * @param {object}   o.brand      orgBrand(org), or SILLA_BRAND
 * @param {string}   o.preheader  the grey preview line an inbox shows beside the subject
 * @param {string}   o.eyebrow    small label above the title — what KIND of message this is
 * @param {string}   o.title
 * @param {string}   [o.greeting]
 * @param {object[]} o.blocks
 * @param {string}   o.reason     why they received it, for the footer
 */
export function renderEmail({ brand, preheader, eyebrow, title, greeting, blocks, reason }) {
  const year = new Date().getFullYear();
  const body = [greeting ? p(greeting) : null, ...blocks].filter(Boolean);
  const automated = `This is an automated message from ${brand.name}, sent ${reason}.`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${NEUTRAL.page};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${NEUTRAL.page};">
<tr><td align="center" style="padding:32px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};border:1px solid ${NEUTRAL.rule};border-radius:20px;">

    ${masthead(brand)}

    <tr><td style="background:${NEUTRAL.card};border-radius:0 0 20px 20px;padding:30px 28px 16px;">
      ${
        eyebrow
          ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 14px;"><tr><td style="background:${brand.accent};border-radius:999px;padding:4px 11px;` +
            `font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${brand.accentInk};">${esc(eyebrow)}</td></tr></table>`
          : ""
      }
      <h1 style="margin:0 0 18px;font-size:25px;line-height:1.25;font-weight:800;letter-spacing:-0.5px;color:${NEUTRAL.ink};">${esc(title)}</h1>
      ${body.map((block) => blockHtml(block, brand)).join("\n      ")}
    </td></tr>

  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};">
    <tr><td style="padding:20px 12px 0;text-align:center;">
      <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${NEUTRAL.faint};">${esc(automated)}</p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:${NEUTRAL.faint};">&copy; ${year} ${esc(brand.name)}</p>
    </td></tr>
  </table>
</td></tr>
</table>
</body>
</html>`;

  const text = [
    title,
    "=".repeat(Math.min(title.length, 60)),
    "",
    ...body.map(blockText).flatMap((t) => [t, ""]),
    "—",
    automated,
    `© ${year} ${brand.name}`,
  ].join("\n");

  return { html, text };
}
