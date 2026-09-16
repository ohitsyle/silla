/**
 * The one HTML shell every storefront email is rendered into.
 *
 * Emails were plain text. Text arrives intact everywhere, but a six-digit
 * code in a paragraph of prose is easy to misread, a verification email
 * with no visual identity is exactly what a phishing message looks like,
 * and nothing about "Hi Ana," tells the reader this came from a system
 * rather than a person typing.
 *
 * Every message still ships a plain-text part generated from the same
 * blocks, so a client that refuses HTML, a screen reader, and a spam
 * filter scoring the text/HTML ratio all get the real content.
 *
 * Email HTML is its own dialect: tables for layout, every style inline,
 * no web fonts, no flexbox, no CSS variables. Outlook ignores border
 * radius and that is fine — it degrades to square corners, not to a
 * broken layout.
 */

const BRAND = {
  paper: "#F6F0E5",
  card: "#FFFDF9",
  ink: "#1A1612",
  soft: "#5C5246",
  faint: "#94887A",
  rule: "#EAE2D5",
  accent: "#E07A5F",
  // White on #E07A5F is 2.9:1. The deep shade carries text on buttons.
  accentDeep: "#C05C44",
  well: "#F6F0E5",
};

const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Rounded','Nunito','Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "'SF Mono',ui-monospace,Menlo,Consolas,'Courier New',monospace";

/**
 * Everything interpolated into these templates is user-supplied
 * somewhere — a first name, an organization name, a cancellation note
 * typed by staff. An unescaped "<a href=...>" in a name would render as
 * a live link in someone's inbox, inside a message carrying our brand.
 */
export const esc = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

/* ─────────────────────────────── blocks ─────────────────────────────── */
/*
 * Each block renders to both HTML and text, so the two parts can never
 * say different things.
 */

export const p = (text) => ({ kind: "p", text });
export const code = (value, caption) => ({ kind: "code", value: String(value), caption });
export const details = (rows) => ({ kind: "details", rows: rows.filter(([, v]) => v != null && v !== "") });
export const button = (label, href) => ({ kind: "button", label, href });
export const note = (text, tone = "neutral") => ({ kind: "note", text, tone });

function blockHtml(b) {
  switch (b.kind) {
    case "p":
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.65;color:${BRAND.soft};">${esc(b.text)}</p>`;

    case "code": {
      // One cell per digit. A code written as "482913" in running type is
      // the most misread thing we send; separated boxes make each digit a
      // thing you look at, the way the OTP modal on the site presents it.
      const cells = b.value
        .split("")
        .map(
          (d) =>
            `<td style="padding:0 4px;"><div style="width:44px;height:54px;line-height:54px;border-radius:12px;` +
            `background:${BRAND.card};border:2px solid ${BRAND.rule};text-align:center;font-family:${MONO};` +
            `font-size:26px;font-weight:700;color:${BRAND.ink};">${esc(d)}</div></td>`
        )
        .join("");
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 10px;"><tr>${cells}</tr></table>` +
        (b.caption
          ? `<p style="margin:0 0 20px;text-align:center;font-size:13px;color:${BRAND.faint};">${esc(b.caption)}</p>`
          : "")
      );
    }

    case "details": {
      const rows = b.rows
        .map(
          ([label, value], i) =>
            `<tr><td width="130" style="width:130px;padding:10px 16px;font-size:13px;color:${BRAND.faint};white-space:nowrap;vertical-align:top;` +
            `${i ? `border-top:1px solid ${BRAND.rule};` : ""}">${esc(label)}</td>` +
            `<td style="padding:10px 16px;font-size:14px;color:${BRAND.ink};font-weight:600;` +
            `${i ? `border-top:1px solid ${BRAND.rule};` : ""}">${esc(value)}</td></tr>`
        )
        .join("");
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" ` +
        `style="margin:4px 0 20px;background:${BRAND.well};border-radius:14px;">${rows}</table>`
      );
    }

    case "button":
      return (
        `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 22px;"><tr>` +
        `<td style="border-radius:999px;background:${BRAND.accentDeep};">` +
        `<a href="${esc(b.href)}" style="display:inline-block;padding:14px 26px;font-family:${FONT};font-size:15px;` +
        `font-weight:700;color:#FFFFFF;text-decoration:none;border-radius:999px;">${esc(b.label)} &rarr;</a>` +
        `</td></tr></table>`
      );

    case "note": {
      const bar = b.tone === "warning" ? BRAND.accentDeep : BRAND.rule;
      return (
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:4px 0 18px;"><tr>` +
        `<td style="border-left:3px solid ${bar};padding:4px 0 4px 14px;font-size:13.5px;line-height:1.6;color:${BRAND.soft};">` +
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

/**
 * @param {object}   o
 * @param {string}   o.preheader  the grey preview line an inbox shows beside the subject
 * @param {string}   o.eyebrow    small label above the title — what KIND of message this is
 * @param {string}   o.title
 * @param {string}   [o.greeting]
 * @param {object[]} o.blocks
 * @param {string}   [o.reason]   why they received it, for the footer
 */
export function renderEmail({ preheader, eyebrow, title, greeting, blocks, reason }) {
  const year = new Date().getFullYear();
  const why = reason || "because of activity on your SILLA account";

  const body = [greeting ? p(greeting) : null, ...blocks].filter(Boolean);

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${BRAND.paper};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BRAND.paper};">
<tr><td align="center" style="padding:36px 16px;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;font-family:${FONT};">

    <tr><td style="padding:0 6px 20px;">
      <table role="presentation" cellpadding="0" cellspacing="0"><tr>
        <td style="width:34px;height:34px;border-radius:11px;background:${BRAND.accent};text-align:center;vertical-align:middle;
                   font-size:16px;font-weight:800;color:#FFFDF9;font-family:${FONT};">S</td>
        <td style="padding-left:10px;font-size:20px;font-weight:800;letter-spacing:-0.5px;color:${BRAND.ink};font-family:${FONT};">SILLA</td>
      </tr></table>
    </td></tr>

    <tr><td style="background:${BRAND.card};border-radius:22px;padding:34px 32px 18px;border:1px solid ${BRAND.rule};">
      ${eyebrow ? `<p style="margin:0 0 10px;font-size:11px;font-weight:700;letter-spacing:1.6px;text-transform:uppercase;color:${BRAND.accentDeep};">${esc(eyebrow)}</p>` : ""}
      <h1 style="margin:0 0 18px;font-size:26px;line-height:1.2;font-weight:800;letter-spacing:-0.6px;color:${BRAND.ink};">${esc(title)}</h1>
      ${body.map(blockHtml).join("\n      ")}
    </td></tr>

    <tr><td style="padding:22px 10px 0;text-align:center;">
      <p style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${BRAND.faint};">
        This is an automated message from SILLA, generated ${esc(why)}.
      </p>
      <p style="margin:0;font-size:12px;line-height:1.6;color:${BRAND.faint};">
        SILLA &middot; Space Intelligence &amp; Live Layout Administration &middot; &copy; ${year}
      </p>
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
    `This is an automated message from SILLA, generated ${why}.`,
    "SILLA · Space Intelligence & Live Layout Administration",
  ].join("\n");

  return { html, text };
}
