/**
 * INF-4 — RFID read spike. Run with: npm run spike:rfid
 *
 * AC: "A tapped UID is captured and stored via the interface; Timeboxed;
 *      go / no-go recorded."
 *
 * This harness proves the SOFTWARE half end to end against the real
 * database: a UID goes in, travels through the check-in interface
 * (INF-3), gets bound to an account by registration (ID-1), and resolves
 * back to that member on the next tap. It does NOT prove the hardware
 * read — see docs/INF-4-rfid-spike.md for exactly what was and was not
 * verified, and the go/no-go call.
 *
 * Reading a physical card:
 *   Most USB RFID readers (and the common ACR122U / RC522 units) present
 *   as HID keyboard-wedge devices — they "type" the UID followed by
 *   Enter into whatever field has focus. That means the kiosk needs no
 *   driver and no serial code: a focused text input receives the UID.
 *   Run this script with --stdin to feed it a real tap that way.
 */
import "dotenv/config";
import mongoose from "mongoose";
import { connectDB } from "../config/db.js";
import Organization from "../models/Organization.js";
import User from "../models/User.js";
import { resolveCheckIn, supportedMethods } from "../services/checkin/index.js";
import { OUTCOME } from "../services/checkin/outcomes.js";
import { normalizeCardUid } from "../services/checkin/rfid.js";

const SPIKE_UID_RAW = "04:a2:2b:9c"; // lowercase, colon-separated — deliberately messy
const useStdin = process.argv.includes("--stdin");

function readTapFromStdin() {
  process.stdout.write("\nTap a card on the reader now (it will type the UID + Enter): ");
  return new Promise((resolve) => {
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => resolve(data.trim()));
  });
}

const results = [];
const check = (name, passed, detail) => {
  results.push({ name, passed, detail });
  console.log(`  ${passed ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};

async function main() {
  await connectDB();
  const org = await Organization.findOne().sort({ createdAt: 1 });
  if (!org) throw new Error("No organization found. Run `npm run seed` first.");

  console.log(`\nINF-4 RFID read spike — organization "${org.name}"`);
  console.log(`Implementations registered behind the check-in interface: ${supportedMethods().join(", ")}\n`);

  const raw = useStdin ? await readTapFromStdin() : SPIKE_UID_RAW;
  console.log(`Using UID: ${JSON.stringify(raw)}${useStdin ? " (live reader)" : " (simulated)"}\n`);

  // --- 1. Normalisation: the same card typed differently is one card ---
  const canonical = normalizeCardUid(raw);
  const variants = [raw.toUpperCase(), raw.replace(/:/g, ""), raw.replace(/:/g, " "), `${raw}\r`];
  const allMatch = variants.every((v) => {
    try {
      return normalizeCardUid(v) === canonical;
    } catch {
      return false;
    }
  });
  check("UID normalises to one canonical form across reader formats", allMatch, canonical);

  // --- 2. Unknown card resolves as UNREGISTERED, not an error ---
  await User.deleteOne({ organization: org._id, cardUid: canonical }); // keep the spike re-runnable
  const first = await resolveCheckIn({ organizationId: org._id.toString(), method: "rfid", credential: raw });
  check("Unknown card returns UNREGISTERED (triggers ID-1)", first.outcome === OUTCOME.UNREGISTERED, first.outcome);

  // --- 3. The UID is captured and STORED via the interface's own
  //        normalisation — this is the AC's "captured and stored" ---
  const spikeUser = await User.create({
    organization: org._id,
    role: "member",
    firstName: "Spike",
    lastName: "Tester",
    email: `rfid-spike-${Date.now()}@example.test`,
    memberId: `9999-${String(Date.now()).slice(-6)}`,
    cardUid: canonical,
    pinHash: "x".repeat(60), // never used — this account is deleted below
    verified: true,
  });
  const stored = await User.findById(spikeUser._id).select("cardUid");
  check("Tapped UID persisted to the database", stored?.cardUid === canonical, stored?.cardUid);

  // --- 4. The same tap now resolves to that member ---
  const second = await resolveCheckIn({ organizationId: org._id.toString(), method: "rfid", credential: raw });
  check(
    "Second tap resolves the stored UID to the member",
    second.outcome === OUTCOME.MEMBER && second.member?._id?.toString() === spikeUser._id.toString(),
    second.outcome
  );

  // --- 5. Unverified accounts are held back (spec §4) ---
  await User.updateOne({ _id: spikeUser._id }, { verified: false });
  const third = await resolveCheckIn({ organizationId: org._id.toString(), method: "rfid", credential: raw });
  check("Unverified member resolves as PENDING, not MEMBER", third.outcome === OUTCOME.PENDING, third.outcome);

  // --- 6. Garbage input is rejected by the interface, not the caller ---
  let rejected = false;
  try {
    await resolveCheckIn({ organizationId: org._id.toString(), method: "rfid", credential: "not-a-uid!!" });
  } catch (err) {
    rejected = err.name === "ValidationError";
  }
  check("Malformed UID rejected by the interface", rejected);

  // --- 7. QR is NOT implemented in v1 (INF-3's AC) ---
  let qrRefused = false;
  try {
    await resolveCheckIn({ organizationId: org._id.toString(), method: "qr", credential: canonical });
  } catch (err) {
    qrRefused = err.name === "ValidationError";
  }
  check("QR check-in refused — RFID is the only v1 implementation", qrRefused);

  await User.deleteOne({ _id: spikeUser._id });

  const passed = results.filter((r) => r.passed).length;
  const verdict = passed === results.length ? "GO (software path)" : "NO-GO";
  console.log(`\n  ${passed}/${results.length} checks passed`);
  console.log(`  Verdict: ${verdict}`);
  console.log(`  ${useStdin ? "Live reader used." : "Simulated UID — re-run with --stdin against a real reader."}`);
  console.log(`  Full record: docs/INF-4-rfid-spike.md\n`);

  await mongoose.disconnect();
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
