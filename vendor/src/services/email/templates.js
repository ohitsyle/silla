/**
 * What the storefront sends, and when.
 *
 * Plain text on purpose. These are transactional — an order moved, a
 * system is ready — and text arrives intact in every client, never
 * lands in a promotions tab for having a template, and cannot render
 * differently from what we wrote.
 *
 * SILLA is the sender here, unlike the product's own emails which are
 * sent AS the buyer's organization. This is the one place our name
 * belongs in a message.
 */

const SIGN_OFF = ["", "— SILLA", "Space Intelligence & Live Layout Administration"].join("\n");

const planName = { room: "One Room", building: "Whole Building", campus: "Campus" };
const money = (amount, currency = "USD") =>
  amount == null ? "to be confirmed" : `${currency === "USD" ? "$" : `${currency} `}${(amount / 100).toFixed(0)}/month`;

export const welcomeEmail = ({ account }) => ({
  to: account.email,
  subject: "Welcome to SILLA",
  text: [
    `Hi ${account.name.split(" ")[0]},`,
    "",
    "Your SILLA account is ready. Anything you configure is saved to it,",
    "so you can leave a system half-built and come back to it.",
    "",
    "Nothing is charged until you submit an order and we confirm it.",
    SIGN_OFF,
  ].join("\n"),
});

/** To the buyer, when they submit. */
export const orderSubmittedEmail = ({ account, order }) => ({
  to: account.email,
  subject: `We've got your order — ${order.organizationName}`,
  text: [
    `Hi ${account.name.split(" ")[0]},`,
    "",
    `We've received your configuration for ${order.organizationName}.`,
    "",
    `  Plan:     ${planName[order.plan] || order.plan}`,
    `  Billing:  ${order.billingPeriod}`,
    `  Quoted:   ${money(order.quotedAmount, order.currency)}`,
    "",
    "We'll build it from exactly what you configured — the same names,",
    "colours and floors — and email you a link when it's live. Usually",
    "the same day.",
    SIGN_OFF,
  ].join("\n"),
});

/** To SILLA, so a submitted order is not waiting on someone refreshing a page. */
export const orderSubmittedInternalEmail = ({ account, order, to }) => ({
  to,
  subject: `New order: ${order.organizationName} (${planName[order.plan] || order.plan})`,
  text: [
    "A buyer submitted a configuration.",
    "",
    `  Organization: ${order.organizationName}`,
    `  Buyer:        ${account.name} <${account.email}>`,
    `  Plan:         ${planName[order.plan] || order.plan}, ${order.billingPeriod}`,
    `  Quoted:       ${money(order.quotedAmount, order.currency)}`,
    "",
    "It's in the queue.",
  ].join("\n"),
});

export const orderProvisioningEmail = ({ account, order }) => ({
  to: account.email,
  subject: `We're building ${order.organizationName}`,
  text: [
    `Hi ${account.name.split(" ")[0]},`,
    "",
    `Work has started on ${order.organizationName}. You'll get a link as`,
    "soon as it's ready.",
    SIGN_OFF,
  ].join("\n"),
});

export const orderLiveEmail = ({ account, order }) => ({
  to: account.email,
  subject: `${order.organizationName} is live`,
  text: [
    `Hi ${account.name.split(" ")[0]},`,
    "",
    `${order.organizationName} is ready.`,
    "",
    `  ${order.deploymentUrl}`,
    "",
    "Sign in with the superadmin details we've sent separately, then add",
    "your staff and hand out cards. Everything in it — the wording, the",
    "colours, the floors — is yours to change from the console.",
    SIGN_OFF,
  ].join("\n"),
});

export const orderCancelledEmail = ({ account, order, reason }) => ({
  to: account.email,
  subject: `Order cancelled — ${order.organizationName}`,
  text: [
    `Hi ${account.name.split(" ")[0]},`,
    "",
    `Your order for ${order.organizationName} has been cancelled.`,
    // Only when one was given — an empty "Reason given:" line reads as
    // though someone deleted the explanation.
    reason ? `\nReason given: ${reason}` : null,
    "",
    "If that's not right, reply to this email and we'll sort it out.",
    SIGN_OFF,
  ]
    .filter((line) => line !== null)
    .join("\n"),
});
