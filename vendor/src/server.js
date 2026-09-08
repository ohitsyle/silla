import "dotenv/config";
import { createApp } from "./app.js";
import { connectDB } from "./config/db.js";

const PORT = process.env.VENDOR_PORT || 4100;

async function main() {
  await connectDB();
  createApp().listen(PORT, () => console.log(`[vendor] SILLA commerce API on :${PORT}`));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
