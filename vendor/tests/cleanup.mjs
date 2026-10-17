/**
 * Removes everything the suites created. Test accounts all use
 * @test.silla, so this deletes exactly what the tests made and never a
 * real customer's records.
 *
 * Not only the accounts and their orders: a submitted test order also
 * leaves a subscription and its invoices (billing), a conversation leaves
 * its messages, and every staff action on any of it leaves an activity
 * entry. Each of those used to outlive the run — on the shared database
 * that meant test invoices in the staff console's money totals and test
 * threads in the inbox. Everything is found FROM the test accounts, so a
 * real record is never in scope.
 *
 *   npm run test:clean      (or node tests/cleanup.mjs)
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../src/config/db.js";
import Account from "../src/models/Account.js";
import Order from "../src/models/Order.js";
import Subscription from "../src/models/Subscription.js";
import Invoice from "../src/models/Invoice.js";
import Conversation from "../src/models/Conversation.js";
import Message from "../src/models/Message.js";
import AuditEvent from "../src/models/AuditEvent.js";

export const TEST_EMAIL = /@test\.silla$/;

/**
 * Every record a test account made, by id — accounts, then what hangs off
 * them. Plus the strays earlier runs left: this script used to delete the
 * accounts and orders only, so their subscriptions and invoices outlived
 * them, unreachable from any account. Those are still provably a test's:
 * an invoice numbered in the TEST sequence is only ever issued to an
 * address the mail transport refuses (services/billing.js), and a
 * subscription it bills whose account no longer exists is gone with it.
 */
async function testRecords() {
  const accounts = await Account.find({ email: TEST_EMAIL }).distinct("_id");
  const orders = await Order.find({ account: { $in: accounts } }).distinct("_id");

  const strayInvoices = await Invoice.find({ number: /^TEST-/ }).select("_id subscription").lean();
  const billed = strayInvoices.map((i) => i.subscription).filter(Boolean);
  const billedAccounts = await Subscription.find({ _id: { $in: billed } }).distinct("account");
  const living = new Set((await Account.find({ _id: { $in: billedAccounts } }).distinct("_id")).map(String));
  const strays = (await Subscription.find({ _id: { $in: billed } }).select("_id account").lean())
    .filter((sub) => !living.has(String(sub.account)))
    .map((sub) => sub._id);

  const subscriptions = await Subscription.find({
    $or: [{ account: { $in: accounts } }, { order: { $in: orders } }, { _id: { $in: strays } }],
  }).distinct("_id");
  const invoices = await Invoice.find({
    $or: [{ account: { $in: accounts } }, { subscription: { $in: subscriptions } }, { number: /^TEST-/ }],
  }).distinct("_id");
  const conversations = await Conversation.find({ account: { $in: accounts } }).distinct("_id");
  // Audit targets are stored as strings (lib/audit.js). A deployment is
  // addressed by its order's id, and a staff member by their account's.
  const targets = [...accounts, ...orders, ...subscriptions, ...invoices, ...conversations].map(String);
  return { accounts, orders, subscriptions, invoices, conversations, targets };
}

const auditFilter = (r) => ({ $or: [{ actor: { $in: r.accounts } }, { "target.id": { $in: r.targets } }] });
/** A test thread's messages, and anything a test account wrote anywhere. */
const messageFilter = (r) => ({ $or: [{ conversation: { $in: r.conversations } }, { author: { $in: r.accounts } }] });

export async function cleanup({ quiet = false } = {}) {
  const already = mongoose.connection.readyState === 1;
  if (!already) await connectDB();

  const r = await testRecords();
  // Children before parents, so a crash part-way leaves nothing whose
  // parent is already gone and can no longer be found from a test account.
  const audit = await AuditEvent.deleteMany(auditFilter(r));
  const messages = await Message.deleteMany(messageFilter(r));
  const conversations = await Conversation.deleteMany({ _id: { $in: r.conversations } });
  const invoices = await Invoice.deleteMany({ _id: { $in: r.invoices } });
  const subscriptions = await Subscription.deleteMany({ _id: { $in: r.subscriptions } });
  const orders = await Order.deleteMany({ _id: { $in: r.orders } });
  // A thread a test staff member was handed must not keep pointing at them.
  await Conversation.updateMany({ assignee: { $in: r.accounts } }, { $set: { assignee: null } });
  const accounts = await Account.deleteMany({ _id: { $in: r.accounts } });

  const counts = {
    accounts: accounts.deletedCount,
    orders: orders.deletedCount,
    subscriptions: subscriptions.deletedCount,
    invoices: invoices.deletedCount,
    conversations: conversations.deletedCount,
    messages: messages.deletedCount,
    auditEvents: audit.deletedCount,
  };
  if (!quiet) {
    console.log(
      `  cleaned ${counts.accounts} account(s), ${counts.orders} order(s), ${counts.subscriptions} subscription(s), ` +
        `${counts.invoices} invoice(s), ${counts.conversations} conversation(s), ${counts.messages} message(s), ` +
        `${counts.auditEvents} activity entr${counts.auditEvents === 1 ? "y" : "ies"}`
    );
  }
  if (!already) await mongoose.disconnect();
  return counts;
}

/** What tests still have in the database, by kind — every figure should be zero after cleanup(). */
export async function leftovers() {
  const already = mongoose.connection.readyState === 1;
  if (!already) await connectDB();
  const r = await testRecords();
  const found = {
    accounts: r.accounts.length,
    orders: r.orders.length,
    subscriptions: r.subscriptions.length,
    invoices: r.invoices.length,
    conversations: r.conversations.length,
    messages: await Message.countDocuments(messageFilter(r)),
    auditEvents: await AuditEvent.countDocuments(auditFilter(r)),
  };
  if (!already) await mongoose.disconnect();
  return found;
}

if (process.argv[1]?.endsWith("cleanup.mjs")) {
  await cleanup();
  await mongoose.disconnect();
}
