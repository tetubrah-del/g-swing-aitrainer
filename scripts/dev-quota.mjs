import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const USERS_PATH = path.join(os.tmpdir(), "golf-users.json");
const ANON_QUOTA_PATH = path.join(os.tmpdir(), "golf-anonymous-quota.json");

function parseArgs(argv) {
  const args = { email: null, userId: null, reset: false, setFreeCount: null, resetAnonymous: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--email") args.email = (argv[++i] ?? "").trim().toLowerCase();
    else if (a === "--userId") args.userId = (argv[++i] ?? "").trim();
    else if (a === "--reset") args.reset = true;
    else if (a === "--set-free-count") args.setFreeCount = Number(argv[++i]);
    else if (a === "--keep-anon-quota") args.resetAnonymous = false;
    else if (a === "--help" || a === "-h") return { ...args, help: true };
  }
  return args;
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj), "utf8");
}

function findUser(usersObj, { email, userId }) {
  if (!usersObj || typeof usersObj !== "object") return null;
  if (userId && usersObj[userId]) return usersObj[userId];
  if (!email) return null;
  for (const value of Object.values(usersObj)) {
    if (value && typeof value === "object" && typeof value.email === "string" && value.email.toLowerCase() === email) {
      return value;
    }
  }
  return null;
}

function usage() {
  console.log(
    [
      "Usage:",
      "  node scripts/dev-quota.mjs --email <addr> [--reset] [--set-free-count <n>] [--keep-anon-quota]",
      "  node scripts/dev-quota.mjs --userId <id>  [--reset] [--set-free-count <n>] [--keep-anon-quota]",
      "",
      "Notes:",
      `  users: ${USERS_PATH}`,
      `  anon quota: ${ANON_QUOTA_PATH}`,
    ].join("\n")
  );
}

const args = parseArgs(process.argv.slice(2));
if (args.help || (!args.email && !args.userId)) {
  usage();
  process.exit(args.help ? 0 : 1);
}

const users = readJson(USERS_PATH);
if (!users) {
  console.error(`Missing users store: ${USERS_PATH}`);
  process.exit(1);
}

const account = findUser(users, args);
if (!account) {
  console.error("User not found.");
  process.exit(1);
}

const anonQuota = readJson(ANON_QUOTA_PATH) ?? {};
const anonymousIds = Array.isArray(account.anonymousIds) ? account.anonymousIds : [];
const anonCounts = Object.fromEntries(anonymousIds.map((id) => [id, Number(anonQuota[id] ?? 0)]));
const maxAnon = Object.values(anonCounts).reduce((m, v) => Math.max(m, v), 0);
const freeCount = Number(account.freeAnalysisCount ?? 0);
const effectiveUsed = Math.max(freeCount, maxAnon);
const plan = account.plan ?? (account.email ? "free" : "anonymous");

console.log(
  JSON.stringify(
    {
      userId: account.userId,
      email: account.email ?? null,
      plan,
      freeAnalysisCount: freeCount,
      anonymousIds,
      anonymousQuota: anonCounts,
      effectiveUsed,
    },
    null,
    2
  )
);

const now = Date.now();
let changed = false;

if (args.setFreeCount != null && Number.isFinite(args.setFreeCount)) {
  account.freeAnalysisCount = Math.max(0, Math.floor(args.setFreeCount));
  account.updatedAt = now;
  changed = true;
}

if (args.reset) {
  account.freeAnalysisCount = 0;
  account.updatedAt = now;
  changed = true;
  if (args.resetAnonymous) {
    for (const id of anonymousIds) {
      delete anonQuota[id];
    }
  }
}

if (changed) {
  users[account.userId] = account;
  writeJson(USERS_PATH, users);
  writeJson(ANON_QUOTA_PATH, anonQuota);
  console.log("Updated.");
}

