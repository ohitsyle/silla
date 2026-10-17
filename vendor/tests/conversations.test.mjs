/**
 * Conversations — a buyer and SILLA staff writing to each other.
 *
 * Asserted from the outside, against the running API, like the other
 * suites: whether one buyer can reach another's thread, and whether an
 * internal note can reach a buyer, are properties of the real routes and
 * their queries, not of a mock.
 *
 * The notification job (workers/conversation.jobs.js) is run here, in
 * this process, against the same database — with its clock stepped past
 * the quiet period instead of waiting ten minutes, its sender swapped for
 * a collector so what WOULD be emailed can be read without an inbox, and
 * the pass limited to this suite's own threads so a run against a shared
 * database never claims a real customer's email.
 *
 * Buyers and staff are made directly in the database, not through
 * /register and invitations — those have their own suites, and they spend
 * the per-address registration allowance this run shares.
 */
import bcrypt from "bcryptjs";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import Account from "../src/models/Account.js";
import Conversation from "../src/models/Conversation.js";
import Message from "../src/models/Message.js";
import AuditEvent from "../src/models/AuditEvent.js";
import { QUIET_MINUTES, notifyUnread } from "../src/workers/conversation.jobs.js";

export const name = "Conversations — buyers and staff";

const API = process.env.VENDOR_API_URL || "http://localhost:4100";
const PASSWORD = "a-long-enough-password";
const MINUTE = 60_000;

const unique = () => `${Date.now()}${Math.floor(Math.random() * 1e4)}`;

async function req(path, opts = {}) {
  const res = await fetch(API + path, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}
const auth = (token) => ({ Authorization: `Bearer ${token}` });
const get = (path, token) => req(path, { headers: token ? auth(token) : {} });
const post = (path, body, token) => req(path, { method: "POST", headers: token ? auth(token) : {}, body: JSON.stringify(body || {}) });
const patch = (path, body, token) => req(path, { method: "PATCH", headers: token ? auth(token) : {}, body: JSON.stringify(body || {}) });

async function ensureDb() {
  if (mongoose.connection.readyState !== 1) await connectDB();
}

async function person(email, { role = "buyer", staffRole = null, organizationName = "", firstName = "Test" } = {}) {
  await ensureDb();
  await Account.create({
    email,
    firstName,
    lastName: role === "buyer" ? "Buyer" : "Staff",
    organizationName,
    passwordHash: await bcrypt.hash(PASSWORD, 10),
    role,
    staffRole,
    emailVerified: true,
    emailVerifiedAt: new Date(),
    termsAcceptedAt: new Date(),
    termsVersion: "test",
  });
  const login = await post("/api/vendor/auth/login", { email, password: PASSWORD });
  return { email, token: login.body?.token, id: login.body?.account?.id };
}

const profileFor = (organizationName) => ({
  key: organizationName.toLowerCase().replace(/\W+/g, "-"),
  organizationName,
  siteName: "Main Site",
  terminology: { resourceNoun: "desk", memberNoun: "employee", facilityLabel: "Workplace" },
  floors: [{ name: "Level 1", order: 0, grid: { cols: 10, rows: 8 }, resources: [], zones: [], labels: [] }],
});

async function orderFor(buyer, organizationName, { submit = true } = {}) {
  const created = await post(
    "/api/vendor/orders",
    { profile: profileFor(organizationName), plan: "building", billingPeriod: "yearly", quotedAmount: 690000, currency: "PHP" },
    buyer.token
  );
  const id = created.body?.order?.id;
  if (submit) await post(`/api/vendor/orders/${id}/submit`, {}, buyer.token);
  return id;
}

/** The notification job, as the scheduler runs it, with the clock moved and the mail collected. */
async function runJob(minutesAhead, only) {
  const sent = [];
  const outcome = await notifyUnread({
    now: new Date(Date.now() + minutesAhead * MINUTE),
    send: (email) => sent.push(email),
    only,
  });
  return { sent, outcome };
}

export async function run(check) {
  const C = "CONV";
  const tag = unique();
  const threads = [];

  const ownerToken = (await post("/api/vendor/auth/login", {
    email: process.env.VENDOR_STAFF_EMAIL,
    password: process.env.VENDOR_STAFF_PASSWORD,
  })).body?.token;
  if (!ownerToken) {
    check(C, "The staff owner can sign in", false, "set VENDOR_STAFF_EMAIL / VENDOR_STAFF_PASSWORD");
    return;
  }
  const ownerId = (await get("/api/vendor/staff/me", ownerToken)).body?.id;

  const ana = await person(`conv-ana-${tag}@test.silla`, { organizationName: "Ana's Library", firstName: "Ana" });
  const ben = await person(`conv-ben-${tag}@test.silla`, { organizationName: "Ben's Office", firstName: "Ben" });
  const support = await person(`conv-support-${tag}@test.silla`, { role: "silla", staffRole: "support", firstName: "Sky" });
  const anaOrder = await orderFor(ana, `Conversation Library ${tag}`);
  const benOrder = await orderFor(ben, `Conversation Office ${tag}`);

  try {
    /* ── a buyer starts one ── */

    const blank = await post("/api/vendor/conversations", {}, ana.token);
    check(C, "Starting a thread with nothing in it names both missing fields",
      blank.status === 400 && Boolean(blank.body?.fields?.subject) && Boolean(blank.body?.fields?.body));

    const tooLong = await post("/api/vendor/conversations", { subject: "Long", body: "x".repeat(5001) }, ana.token);
    check(C, "A message over 5,000 characters is refused on its own field", tooLong.status === 400 && Boolean(tooLong.body?.fields?.body));

    const started = await post(
      "/api/vendor/conversations",
      { subject: `Which floor first? ${tag}`, body: `Hello — can the reading room go live before the stacks? ${tag}`, orderId: anaOrder },
      ana.token
    );
    const thread = started.body?.conversation?.id;
    threads.push(thread);
    check(C, "A buyer can start a conversation about their own order",
      started.status === 201 && started.body?.conversation?.order?.id === anaOrder && started.body?.conversation?.unread === 0,
      started.body?.error);
    check(C, "…and what they get back says nothing about who at SILLA has it",
      started.body?.conversation && !("assignee" in started.body.conversation) && !("notified" in started.body.conversation));

    const othersOrder = await post("/api/vendor/conversations", { subject: "Theirs", body: "Guessing an id", orderId: benOrder }, ana.token);
    check(C, "A buyer cannot file a thread under another buyer's order (404 by id)", othersOrder.status === 404);

    const asSomeoneElse = await post("/api/vendor/conversations", { subject: `Spoof ${tag}`, body: "Pretending", accountId: ben.id }, ana.token);
    threads.push(asSomeoneElse.body?.conversation?.id);
    const bensList = await get("/api/vendor/conversations/mine", ben.token);
    check(C, "A buyer naming another account still writes only to their own",
      asSomeoneElse.status === 201 && !(bensList.body?.conversations || []).some((c) => c.id === asSomeoneElse.body?.conversation?.id));

    /* ── another buyer cannot reach it ── */

    const peek = await get(`/api/vendor/conversations/${thread}`, ben.token);
    const write = await post(`/api/vendor/conversations/${thread}/messages`, { body: "Hijack" }, ben.token);
    const markRead = await post(`/api/vendor/conversations/${thread}/read`, {}, ben.token);
    const byOrder = await get(`/api/vendor/conversations/mine?orderId=${anaOrder}`, ben.token);
    check(C, "Another buyer gets 404 reading, replying to or marking someone else's thread",
      peek.status === 404 && write.status === 404 && markRead.status === 404, `${peek.status}/${write.status}/${markRead.status}`);
    check(C, "…and filtering their own list by someone else's order finds nothing",
      byOrder.status === 200 && byOrder.body?.conversations?.length === 0);
    const stillOne = await Message.countDocuments({ conversation: thread });
    check(C, "…and the refused reply was never written", stillOne === 1, `${stillOne} message(s)`);

    const buyerRefused = [];
    for (const [method, path] of [
      ["GET", "/api/vendor/conversations/inbox"],
      ["GET", "/api/vendor/conversations/inbox/counts"],
      ["PATCH", `/api/vendor/conversations/${thread}`],
    ]) {
      const r = await req(path, { method, headers: auth(ana.token), body: method === "GET" ? undefined : JSON.stringify({ status: "closed" }) });
      if (r.status !== 403) buyerRefused.push(`${method} ${path} → ${r.status}`);
    }
    check(C, "A buyer cannot open the staff inbox or close and assign threads", buyerRefused.length === 0, buyerRefused.join("; "));
    const staffMine = await get("/api/vendor/conversations/mine", support.token);
    check(C, "Staff are pointed at the inbox, not the customer side", staffMine.status === 403);

    /* ── the staff side ── */

    const inbox = await get(`/api/vendor/conversations/inbox?q=${encodeURIComponent(ana.email)}`, support.token);
    const row = inbox.body?.conversations?.find((c) => c.id === thread);
    check(C, "Support sees the new thread in the inbox, unread, unassigned, with its customer and order",
      row?.unread === 1 && row?.assignee === null && row?.account?.email === ana.email && row?.order?.id === anaOrder);

    const queue = await get(`/api/vendor/orders/queue/all?q=${encodeURIComponent(`Conversation Library ${tag}`)}`, support.token);
    check(C, "The order queue shows the order has an unread customer message",
      queue.body?.orders?.find((o) => o.id === anaOrder)?.conversations?.unread === 1);

    const secret = `INTERNAL-${tag} customer is a slow payer, check before promising dates`;
    const note = await post(`/api/vendor/conversations/${thread}/messages`, { body: secret, internal: true }, support.token);
    check(C, "Staff can add an internal note", note.status === 201 && note.body?.message?.internal === true);
    const afterNote = (await get(`/api/vendor/conversations/${thread}`, support.token)).body?.conversation;
    check(C, "…which claims nobody's thread and leaves the customer's unread count alone",
      afterNote?.assignee === null && afterNote?.buyerUnread === 0);

    const reply = `Yes — we'll bring the reading room up first. ${tag}`;
    const replied = await post(`/api/vendor/conversations/${thread}/messages`, { body: reply }, support.token);
    check(C, "Staff can reply publicly, and the first public reply assigns the thread to them",
      replied.status === 201 && replied.body?.conversation?.assignee?.email === support.email);

    // Written AFTER the reply, so a job that picked "the newest message"
    // rather than the newest PUBLIC one would quote it.
    await post(`/api/vendor/conversations/${thread}/messages`, { body: `${secret} (second note)`, internal: true }, support.token);

    /* ── what the buyer can see ── */

    const anaThread = await get(`/api/vendor/conversations/${thread}`, ana.token);
    const anaList = await get("/api/vendor/conversations/mine", ana.token);
    const anaBadge = await get("/api/vendor/conversations/mine/unread", ana.token);
    const body = JSON.stringify(anaThread.body);
    check(C, "The buyer's thread has the reply and never an internal note",
      anaThread.body?.messages?.some((m) => m.body === reply) && !body.includes(`INTERNAL-${tag}`) &&
        anaThread.body?.messages?.every((m) => !("internal" in m)));
    check(C, "…nor does their list's preview",
      !JSON.stringify(anaList.body).includes(`INTERNAL-${tag}`) &&
        anaList.body?.conversations?.find((c) => c.id === thread)?.lastMessagePreview === reply);
    check(C, "Their unread badge counts the reply and not the notes", anaBadge.body?.unread === 1 && anaBadge.body?.threads === 1,
      JSON.stringify(anaBadge.body));
    const storedNotes = await Message.countDocuments({ conversation: thread, internal: true });
    check(C, "…though both notes are in the database, so it is the query that keeps them out", storedNotes === 2);

    const filtered = await get(`/api/vendor/conversations/mine?orderId=${anaOrder}`, ana.token);
    check(C, "A buyer can list the threads about one of their orders",
      filtered.body?.conversations?.length === 1 && filtered.body.conversations[0].id === thread);

    /* ── the notification job ── */

    const early = await runJob(1, threads);
    check(C, "No email goes out while the thread is still active", !early.sent.length && !early.outcome.buyer.length);

    const settled = await runJob(QUIET_MINUTES + 1, threads);
    const toAna = settled.sent.filter((e) => e.to === ana.email);
    check(C, "Once it has gone quiet, the buyer is emailed once", toAna.length === 1, `${toAna.length} email(s)`);
    check(C, "…quoting the public reply and never an internal note",
      toAna[0]?.text?.includes("bring the reading room up first") && !toAna[0]?.text?.includes(`INTERNAL-${tag}`) &&
        !toAna[0]?.html?.includes(`INTERNAL-${tag}`));
    check(C, "…and a test address is reported as dropped by the transport, not delivered",
      settled.outcome.buyer.find((o) => o.conversation === thread)?.dropped === "test address");

    const again = await runJob(QUIET_MINUTES + 2, threads);
    check(C, "Running the job again sends nothing more about the same reply", !again.sent.some((e) => e.to === ana.email));

    for (const n of [1, 2, 3]) await post(`/api/vendor/conversations/${thread}/messages`, { body: `Follow-up ${n} ${tag}` }, support.token);
    const burst = await runJob(QUIET_MINUTES + 1, threads);
    const burstToAna = burst.sent.filter((e) => e.to === ana.email);
    check(C, "Three replies in a row become one email, not three", burstToAna.length === 1, `${burstToAna.length} email(s)`);
    check(C, "…which says how many are waiting", /4 replies/.test(burstToAna[0]?.subject + burstToAna[0]?.text || ""),
      burstToAna[0]?.text?.split("\n")[0]);

    const read = await post(`/api/vendor/conversations/${thread}/read`, {}, ana.token);
    const cleared = await get("/api/vendor/conversations/mine/unread", ana.token);
    check(C, "Reading the thread clears the buyer's badge", read.status === 200 && cleared.body?.unread === 0);

    // A note alone, to a buyer who has read everything: nothing to tell them.
    await post(`/api/vendor/conversations/${thread}/messages`, { body: `${secret} (third note)`, internal: true }, support.token);
    const noteOnly = await runJob(QUIET_MINUTES + 1, threads);
    check(C, "An internal note never makes a buyer's email fire", !noteOnly.sent.some((e) => e.to === ana.email));

    // Someone already looking reads it before the quiet period ends: no email.
    await post(`/api/vendor/conversations/${thread}/messages`, { body: `One more thing ${tag}` }, support.token);
    await post(`/api/vendor/conversations/${thread}/read`, {}, ana.token);
    const seenFirst = await runJob(QUIET_MINUTES + 1, threads);
    check(C, "A reply the buyer reads before the quiet period ends is never emailed", !seenFirst.sent.some((e) => e.to === ana.email));

    // The customer writes back: SILLA's side would be told — but this
    // customer is a test account, and that email goes to a real inbox.
    const back = await post(`/api/vendor/conversations/${thread}/messages`, { body: `Thanks! ${tag}` }, ana.token);
    const staffSide = await runJob(QUIET_MINUTES + 1, threads);
    check(C, "A test customer's message never emails a real SILLA inbox",
      back.status === 201 && !staffSide.sent.length && staffSide.outcome.staff.find((o) => o.conversation === thread)?.skipped === "test customer");

    /* ── handling it ── */

    const directory = await get("/api/vendor/staff/directory", support.token);
    check(C, "Any staff role can list colleagues to assign to", directory.status === 200 && directory.body?.staff?.some((s) => s.id === ownerId));

    const assign = await patch(`/api/vendor/conversations/${thread}`, { assignee: ownerId }, support.token);
    check(C, "A thread can be handed to a colleague", assign.status === 200 && assign.body?.conversation?.assignee?.id === ownerId);
    const notStaff = await patch(`/api/vendor/conversations/${thread}`, { assignee: ana.id }, support.token);
    check(C, "…but never to a customer", notStaff.status === 400);

    const closed = await patch(`/api/vendor/conversations/${thread}`, { status: "closed" }, support.token);
    check(C, "Staff can close a thread", closed.body?.conversation?.status === "closed" && Boolean(closed.body?.conversation?.closedAt));
    const reopenedByBuyer = await post(`/api/vendor/conversations/${thread}/messages`, { body: `Sorry, one last question ${tag}` }, ana.token);
    check(C, "A customer writing into a closed thread reopens it", reopenedByBuyer.body?.conversation?.status === "open");

    const counts = await get("/api/vendor/conversations/inbox/counts", support.token);
    check(C, "The inbox counts open, unread, unassigned and mine",
      ["open", "closed", "mine", "unassigned", "unread"].every((k) => typeof counts.body?.counts?.[k] === "number") && counts.body.counts.unread >= 1);

    /* ── staff writing first ── */

    const outreach = await post(
      "/api/vendor/conversations",
      { accountId: ben.id, subject: `Your layout ${tag}`, body: "We spotted two desks overlapping — shall we fix it?", orderId: benOrder },
      support.token
    );
    threads.push(outreach.body?.conversation?.id);
    check(C, "Staff can write to a customer first, about their order",
      outreach.status === 201 && outreach.body?.conversation?.startedBy === "staff" && outreach.body?.conversation?.assignee?.email === support.email);
    const benBadge = await get("/api/vendor/conversations/mine/unread", ben.token);
    check(C, "…and it lands in that customer's unread badge", benBadge.body?.unread === 1);
    const wrongOrder = await post("/api/vendor/conversations", { accountId: ben.id, subject: "Mixed up", body: "Hello", orderId: anaOrder }, support.token);
    check(C, "Staff cannot file one customer's thread under another customer's order", wrongOrder.status === 404);
    const toStaff = await post("/api/vendor/conversations", { accountId: ownerId, subject: "Hi", body: "Hello" }, support.token);
    check(C, "…nor 'write to a customer' who is staff", toStaff.status === 404);

    /* ── the trail ── */

    await ensureDb();
    const events = await AuditEvent.find({ "target.type": "conversation", "target.id": { $in: threads.filter(Boolean) } }).lean();
    const kinds = new Set(events.map((e) => e.action));
    const wanted = ["conversation.note", "conversation.reply", "conversation.assign", "conversation.status", "conversation.start"];
    const missing = wanted.filter((k) => !kinds.has(k));
    check(C, "Every staff action on a thread is on the activity log", missing.length === 0, missing.join(", "));
    check(C, "…and no log entry carries the text of an internal note", !events.some((e) => JSON.stringify(e).includes(`INTERNAL-${tag}`)));
  } finally {
    // This suite's own threads. cleanup.mjs sweeps whatever a crash leaves.
    await ensureDb();
    const ids = threads.filter(Boolean);
    const [buyers, staffIds] = await Promise.all([
      Account.find({ email: { $in: [ana.email, ben.email] } }).distinct("_id"),
      Account.find({ email: support.email }).distinct("_id"),
    ]);
    const all = await Conversation.find({ $or: [{ _id: { $in: ids } }, { account: { $in: buyers } }] }).distinct("_id");
    await Message.deleteMany({ conversation: { $in: all } });
    await AuditEvent.deleteMany({ $or: [{ "target.type": "conversation", "target.id": { $in: all.map(String) } }, { actor: { $in: staffIds } }] });
    await Conversation.deleteMany({ _id: { $in: all } });
  }
}
