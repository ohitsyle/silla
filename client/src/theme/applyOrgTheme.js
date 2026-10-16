/**
 * applyOrgTheme — the white-label mechanism on the client side
 * (spec §16). Call this once, after fetching an organization's
 * /api/organizations/:id/config, and the whole app re-colours to that
 * buyer's branding with no component-level changes.
 *
 * It sets only CSS variables, which index.css and tailwind.config.js
 * already read from. Don't reach for inline colour values elsewhere —
 * add a token here instead. A colour that isn't a token is a colour no
 * deployment can override, which is the bug this file exists to prevent.
 *
 * Every field is optional: an organization that configures nothing gets
 * the product's neutral defaults from index.css. An organization that
 * configures only `primaryColor` gets its accent applied and everything
 * else left alone — which is the common case.
 */

/**
 * Converts any CSS colour a buyer might put in their config into the
 * "R G B" channel form the tokens use. Accepts #rgb, #rrggbb, #rrggbbaa,
 * rgb()/rgba(), and already-channelised "R G B" strings.
 *
 * Returns null on anything it can't parse, so one malformed value in a
 * config record can never blank out the UI — that token simply keeps
 * its default.
 */
export function toRgbChannels(value) {
  if (typeof value !== "string") return null;
  const input = value.trim();
  if (!input) return null;

  // Already channels, e.g. "34 211 238"
  if (/^\d{1,3}(\s+\d{1,3}){2}$/.test(input)) return input;

  const hex = input.replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16));
    return `${r} ${g} ${b}`;
  }
  if (/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `${r} ${g} ${b}`;
  }

  const fn = input.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
  if (fn) {
    const [, r, g, b] = fn;
    return `${Math.round(+r)} ${Math.round(+g)} ${Math.round(+b)}`;
  }

  return null;
}

/** Maps a branding config path to the CSS channel variable it drives. */
const TOKEN_MAP = [
  ["primaryColor", "--c-accent"],
  ["accentTextColor", "--c-accent-ink"],
  ["surface.page", "--c-bg-page"],
  ["surface.pageEnd", "--c-bg-page-end"],
  ["surface.card", "--c-bg-card"],
  ["surface.panel", "--c-bg-panel"],
  ["surface.line", "--c-line"],
  ["ink.primary", "--c-ink-primary"],
  ["ink.secondary", "--c-ink-secondary"],
  ["ink.muted", "--c-ink-muted"],
  ["states.available", "--c-state-available"],
  ["states.reserved", "--c-state-reserved"],
  ["states.occupied", "--c-state-occupied"],
  ["states.unavailable", "--c-state-unavailable"],
  ["states.overstay", "--c-state-overstay"],
];

const read = (obj, path) => path.split(".").reduce((acc, key) => acc?.[key], obj);

export function applyOrgTheme(org) {
  if (!org?.branding) return;
  const root = document.documentElement;

  for (const [path, variable] of TOKEN_MAP) {
    const channels = toRgbChannels(read(org.branding, path));
    if (channels) root.style.setProperty(variable, channels);
  }

  if (org.name) document.title = org.name;
  applyFavicon(org);
}

/**
 * A tab icon drawn from the buyer's own branding.
 *
 * index.html deliberately declares no icon: a static file would either
 * be the vendor's mark sitting in a buyer's browser tab, or nothing at
 * all — and "nothing at all" meant a 404 on /favicon.ico on every page
 * load plus the generic globe next to a branded product. Generating it
 * here keeps the tab on the same footing as every other surface: the
 * colour comes from org config, so it changes with `npm run profile`
 * exactly like the rest of the UI, and no file has to ship per buyer.
 *
 * The glyph is the organization's first initial, which needs no asset
 * pipeline and reads at 16px far better than a shrunken logo would.
 */
function applyFavicon(org) {
  const accent = org.branding?.primaryColor;
  if (!accent) return;

  const initial = String(org.name || "").trim().charAt(0).toUpperCase() || "•";
  const ink = org.branding?.accentTextColor || "#000000";

  // Escaped rather than interpolated raw: an organization name is buyer
  // input, and this string becomes markup.
  const escape = (value) =>
    String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="8" fill="${escape(accent)}"/>` +
    `<text x="16" y="22" text-anchor="middle" font-family="system-ui,-apple-system,sans-serif" ` +
    `font-size="19" font-weight="700" fill="${escape(ink)}">${escape(initial)}</text>` +
    `</svg>`;

  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    document.head.appendChild(link);
  }
  link.type = "image/svg+xml";
  link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * The resource-state palette, resolved to concrete colours.
 *
 * SpaceMap needs real values rather than `var(--…)` for two reasons:
 * SVG presentation attributes don't resolve CSS variables, and Motion
 * cannot interpolate between them — a status change arriving over
 * Socket.io (MAP-2) would snap instead of cross-fading.
 *
 * `ink` is the colour drawn ON each state (the status icon and unit
 * label). It's computed from the state colour's luminance so a buyer
 * can set any palette without hand-picking readable foregrounds, and
 * without the map failing contrast on a dark or a light brand.
 */
export function resolveStatePalette(org) {
  const states = org?.branding?.states || {};
  const fallback = {
    available: "#34D399",
    reserved: "#FB923C",
    occupied: "#64748B",
    unavailable: "#F87171",
    overstay: "#C084FC",
  };

  const palette = {};
  for (const key of Object.keys(fallback)) {
    const color = typeof states[key] === "string" && states[key].trim() ? states[key] : fallback[key];
    palette[key] = { color, ink: readableInkFor(color) };
  }
  return palette;
}

/**
 * Picks a legible foreground for a background colour. Uses relative
 * luminance rather than a naive brightness average, so mid-tone greens
 * and oranges land on the right side of the threshold.
 */
export function readableInkFor(background) {
  const channels = toRgbChannels(background);
  if (!channels) return "#FFFFFF";
  const [r, g, b] = channels.split(/\s+/).map(Number);

  const linear = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

  // Contrast against white vs. against near-black; pick the better one,
  // darkened/lightened toward the source hue so chips don't look flat.
  if (luminance > 0.45) {
    return `rgb(${Math.round(r * 0.18)} ${Math.round(g * 0.18)} ${Math.round(b * 0.18)})`;
  }
  return `rgb(${Math.round(r + (255 - r) * 0.88)} ${Math.round(g + (255 - g) * 0.88)} ${Math.round(b + (255 - b) * 0.88)})`;
}

/**
 * WCAG contrast ratio between two colours, 1 to 21 — what the branding
 * settings check before saving an accent and the text drawn on it.
 * Accepts anything toRgbChannels does; null when either is unreadable.
 */
export function contrastRatio(a, b) {
  const luminance = (value) => {
    const channels = toRgbChannels(value);
    if (!channels) return null;
    const [r, g, bl] = channels.split(/\s+/).map(Number).map((c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const la = luminance(a);
  const lb = luminance(b);
  if (la === null || lb === null) return null;
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
