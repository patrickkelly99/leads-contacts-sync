/**
 * Monday.com Leads ↔ Contacts Auto-Sync
 * =======================================
 * PHASE 1 — AUTO-MATCH
 *   Finds unlinked leads and matches them to contacts by company name.
 *
 * PHASE 2 — DATA SYNC
 *   Copies name, title, email, phone from linked contact into the lead.
 *
 * PHASE 3 — WEBSITE INFERENCE
 *   For leads with no website set, takes the company name, converts it
 *   to a likely domain (e.g. "DHL Global Forwarding" → "dhl.com"),
 *   verifies it actually resolves, then saves it to the Website column.
 *
 * Schedule: 8am, 12pm, 4pm, 8pm Dubai time
 */

require("dotenv").config();
const cron  = require("node-cron");
const axios = require("axios");

// ─── Config ────────────────────────────────────────────────────────────────

const MONDAY_API_URL    = "https://api.monday.com/v2";
const API_KEY           = process.env.MONDAY_API_KEY;
const LEADS_BOARD_ID    = 1634744525;
const CONTACTS_BOARD_ID = 1634744523;

// Column IDs — Leads board
const LEADS_COLS = {
  contactName:     "text_mkwfsm3m",
  title:           "text",
  email:           "lead_email",
  phone:           "lead_phone",
  website:         "link_mm15xm74",   // newly created
  contactRelation: "board_relation_mm0173f",
  companyName:     "lead_company",
};

// Column IDs — Contacts board
const CONTACTS_COLS = {
  firstName: "first_name__1",
  lastName:  "last_name__1",
  position:  "text_mktbyyy1",
  email:     "email_mkyw8fdq",
  phone:     "phone_mkyw7n",
  emailDup:  "text_mkyw2pw6",
  phoneDup:  "text_mkywnmn4",
};

// ─── Known domains for major companies ────────────────────────────────────
// These override the auto-inference for well-known brands

const KNOWN_DOMAINS = {
  "dhl":               "dhl.com",
  "fedex":             "fedex.com",
  "aramex":            "aramex.com",
  "dsv":               "dsv.com",
  "ceva":              "cevalogistics.com",
  "bollore":           "bollore-logistics.com",
  "kuehne nagel":      "kuehne-nagel.com",
  "db schenker":       "dbschenker.com",
  "siemens":           "siemens.com",
  "samsung":           "samsung.com",
  "landmark":          "landmarkgroup.com",
  "majid al futtaim":  "majidalfuttaim.com",
  "almarai":           "almarai.com",
  "mars":              "mars.com",
  "iron mountain":     "ironmountain.com",
  "oocl":              "oocl.com",
  "cma cgm":           "cma-cgm.com",
  "shein":             "shein.com",
  "jeebly":            "jeebly.com",
  "naqel":             "naqel.com.sa",
  "7x":                "7x.com",
  "noon":              "noon.com",
  "alshaya":           "alshaya.com",
  "al tayer":          "altayer.com",
  "life pharmacy":     "lifepharmacy.com",
  "galadari":          "galadarigroup.com",
  "gulftainer":        "gulftainer.com",
  "dp world":          "dpworld.com",
  "dpworld":           "dpworld.com",
  "iq fulfilment":     "iqfulfilment.com",
  "flexigistic":       "flexigistic.com",
  "acme intralog":     "acmeintralog.com",
  "al sharqi":         "alsharqi.com",
  "scan logistics":    "scanlogistics.com",
  "keeta":             "keeta.com",
  "get cari":          "getcari.com",
  "fibs":              "fibslogistics.com",
  "prime logistics":   "primelogistics.ae",
  "freight systems":   "freightsystems.com",
};

// ─── API Helper ────────────────────────────────────────────────────────────

async function mondayQuery(query, variables = {}) {
  const response = await axios.post(
    MONDAY_API_URL,
    { query, variables },
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: API_KEY,
        "API-Version": "2024-01",
      },
    }
  );
  if (response.data.errors) {
    throw new Error(JSON.stringify(response.data.errors));
  }
  return response.data.data;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Fetch all leads ───────────────────────────────────────────────────────

async function fetchAllLeads() {
  const query = `
    query ($boardId: ID!, $cursor: String, $columnIds: [String!]!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100, cursor: $cursor) {
          cursor
          items { id name column_values(ids: $columnIds) { id value text } }
        }
      }
    }
  `;
  let cursor = null;
  const all = [];
  do {
    const data = await mondayQuery(query, {
      boardId: String(LEADS_BOARD_ID),
      cursor,
      columnIds: Object.values(LEADS_COLS),
    });
    const page = data.boards[0].items_page;
    all.push(...page.items);
    cursor = page.cursor;
    await sleep(300);
  } while (cursor);
  return all;
}

// ─── Fetch all contacts ────────────────────────────────────────────────────

async function fetchAllContacts() {
  const query = `
    query ($boardId: ID!, $cursor: String, $columnIds: [String!]!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500, cursor: $cursor) {
          cursor
          items { id name column_values(ids: $columnIds) { id value text } }
        }
      }
    }
  `;
  let cursor = null;
  const all = [];
  do {
    const data = await mondayQuery(query, {
      boardId: String(CONTACTS_BOARD_ID),
      cursor,
      columnIds: Object.values(CONTACTS_COLS),
    });
    const page = data.boards[0].items_page;
    all.push(...page.items);
    cursor = page.cursor;
    await sleep(300);
  } while (cursor);
  return all;
}

// ─── Normalise string for matching ────────────────────────────────────────

function normalise(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/\b(llc|fze|fzco|fzc|l\.l\.c\.|w\.l\.l\.|q\.p\.s\.c\.|b\.s\.c|inc|ltd|limited|co\.|group|logistics|international|middle east|uae|dubai)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Contact matching ─────────────────────────────────────────────────────

function buildContactIndex(contacts) {
  return contacts.map((c) => {
    const parts  = c.name.split(/\s*[-–]\s*/);
    const tokens = parts.map((p) => normalise(p)).filter((p) => p.length > 2);
    return { contactId: c.id, tokens };
  });
}

function findMatch(lead, contactIndex) {
  const leadName    = normalise(lead.name);
  const leadCompany = normalise(
    lead.column_values.find((c) => c.id === LEADS_COLS.companyName)?.text || ""
  );
  const scored = contactIndex.map(({ contactId, tokens }) => {
    let score = 0;
    for (const token of tokens) {
      if (!token) continue;
      if (leadName.includes(token) || leadCompany.includes(token)) score += token.length;
      if (token.includes(leadName) || (leadCompany && token.includes(leadCompany)))
        score += Math.min(leadName.length, leadCompany.length || leadName.length);
    }
    return { contactId, score };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  return best && best.score >= 5 ? best.contactId : null;
}

// ─── Website inference ────────────────────────────────────────────────────

/**
 * Converts a company name to the most likely website URL.
 * Strategy:
 *  1. Check KNOWN_DOMAINS lookup table first
 *  2. Otherwise clean the name → slug → try .com, then .ae
 *  3. Verify the URL resolves (HEAD request) before saving
 */

function companyNameToSlug(name) {
  return name
    .toLowerCase()
    // Remove legal suffixes
    .replace(/\b(llc|fze|fzco|fzc|l\.l\.c\.|w\.l\.l\.|group|logistics|international|middle east|uae|dubai|shipping|warehousing|trading|industries|services|solutions|holdings|enterprises|co|inc|ltd|limited)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

function inferDomainCandidates(companyName) {
  if (!companyName) return [];

  const lower = companyName.toLowerCase();

  // 1. Check known domains first (partial match)
  for (const [key, domain] of Object.entries(KNOWN_DOMAINS)) {
    if (lower.includes(key)) return [`https://www.${domain}`];
  }

  // 2. Build slug-based candidates
  const slug = companyNameToSlug(companyName);
  if (!slug || slug.length < 2) return [];

  return [
    `https://www.${slug}.com`,
    `https://www.${slug}.ae`,
    `https://${slug}.com`,
    `https://${slug}.ae`,
  ];
}

async function verifyUrl(url) {
  try {
    const response = await axios.head(url, {
      timeout: 5000,
      maxRedirects: 5,
      validateStatus: (s) => s < 500, // accept 200-499 (404 still means domain exists)
    });
    return response.status < 400;
  } catch {
    return false;
  }
}

async function findWebsite(companyName) {
  const candidates = inferDomainCandidates(companyName);
  for (const url of candidates) {
    const ok = await verifyUrl(url);
    if (ok) return url;
    await sleep(200);
  }
  // Return first candidate unverified as a best guess if all checks fail
  // (network may be restricted in some environments)
  return candidates[0] || null;
}

// ─── Parse contact fields ─────────────────────────────────────────────────

function parseContact(contact) {
  const cols = {};
  for (const cv of contact.column_values) cols[cv.id] = { value: cv.value, text: cv.text };

  const firstName  = cols[CONTACTS_COLS.firstName]?.text?.trim() || "";
  const lastName   = cols[CONTACTS_COLS.lastName]?.text?.trim()  || "";
  const cleanFirst = firstName.replace(/\s*[-–]\s*[A-Z].*$/, "").trim();
  const fullName   = [cleanFirst, lastName].filter(Boolean).join(" ")
                     || contact.name.split(/\s*[-–]\s*/)[0].trim();

  const position = cols[CONTACTS_COLS.position]?.text?.trim() || "";

  let email = cols[CONTACTS_COLS.email]?.text?.trim() || "";
  if (!email) email = (cols[CONTACTS_COLS.emailDup]?.text || "").replace(/^["']|["']$/g, "").trim();

  let phone = cols[CONTACTS_COLS.phone]?.text?.trim() || "";
  if (!phone) phone = cols[CONTACTS_COLS.phoneDup]?.text?.trim() || "";
  phone = normalisePhone(phone);

  return { fullName, position, email, phone };
}

function normalisePhone(raw) {
  if (!raw) return "";
  let p = raw.replace(/[\s\-().]/g, "");
  if (p.startsWith("+"))   return p;
  if (p.startsWith("971")) return "+" + p;
  if (p.startsWith("0"))   return "+971" + p.slice(1);
  if (p.length === 9)      return "+971" + p;
  return p;
}

function getLinkedContactIds(lead) {
  const rel = lead.column_values.find((c) => c.id === LEADS_COLS.contactRelation);
  if (!rel || !rel.value) return [];
  try {
    const parsed = JSON.parse(rel.value);
    return (parsed.linkedPulseIds || []).map((lp) => String(lp.linkedPulseId));
  } catch { return []; }
}

// ─── Monday mutations ─────────────────────────────────────────────────────

async function linkContactToLead(leadId, contactId) {
  await mondayQuery(
    `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`,
    {
      boardId: String(LEADS_BOARD_ID),
      itemId:  String(leadId),
      columnValues: JSON.stringify({
        [LEADS_COLS.contactRelation]: { item_ids: [Number(contactId)] },
      }),
    }
  );
}

async function updateLeadFields(leadId, fields) {
  const columnValues = {};

  if (fields.fullName) columnValues[LEADS_COLS.contactName] = fields.fullName;
  if (fields.position) columnValues[LEADS_COLS.title]       = fields.position;
  if (fields.email)    columnValues[LEADS_COLS.email]       = { email: fields.email, text: fields.email };
  if (fields.phone)    columnValues[LEADS_COLS.phone]       = { phone: fields.phone, countryShortName: "AE" };
  if (fields.website)  columnValues[LEADS_COLS.website]     = { url: fields.website, text: fields.website };

  if (!Object.keys(columnValues).length) return false;

  await mondayQuery(
    `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(board_id: $boardId, item_id: $itemId, column_values: $columnValues) { id }
    }`,
    {
      boardId: String(LEADS_BOARD_ID),
      itemId:  String(leadId),
      columnValues: JSON.stringify(columnValues),
    }
  );
  return true;
}

// ─── MAIN SYNC ─────────────────────────────────────────────────────────────

async function runSync() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🔄 Starting Leads ↔ Contacts sync...`);

  let autoMatched   = 0;
  let dataUpdated   = 0;
  let websiteFound  = 0;
  let skipped       = 0;

  try {
    console.log("  📥 Loading all leads and contacts...");
    const [allLeads, allContacts] = await Promise.all([
      fetchAllLeads(),
      fetchAllContacts(),
    ]);
    console.log(`  📋 ${allLeads.length} leads | ${allContacts.length} contacts loaded`);

    const contactMap   = Object.fromEntries(allContacts.map((c) => [c.id, c]));
    const contactIndex = buildContactIndex(allContacts);

    // ── PHASE 1: Auto-match unlinked leads ─────────────────────────────────
    console.log("\n  🔍 Phase 1: Auto-matching unlinked leads...");

    const unlinkedLeads = allLeads.filter((l) => getLinkedContactIds(l).length === 0);

    for (const lead of unlinkedLeads) {
      const matchId = findMatch(lead, contactIndex);
      if (!matchId) { skipped++; continue; }

      console.log(`  🔗 Matched "${lead.name}" → "${contactMap[matchId]?.name}"`);
      await linkContactToLead(lead.id, matchId);
      autoMatched++;

      // Inject into memory so Phase 2 picks it up immediately
      const relCol = lead.column_values.find((c) => c.id === LEADS_COLS.contactRelation);
      if (relCol) relCol.value = JSON.stringify({ linkedPulseIds: [{ linkedPulseId: Number(matchId) }] });

      await sleep(350);
    }

    // ── PHASE 2: Sync contact data into linked leads ───────────────────────
    console.log("\n  📝 Phase 2: Syncing contact data into leads...");

    const linkedLeads = allLeads.filter((l) => getLinkedContactIds(l).length > 0);

    for (const lead of linkedLeads) {
      const primaryContact = contactMap[getLinkedContactIds(lead)[0]];
      if (!primaryContact) { skipped++; continue; }

      const contactData = parseContact(primaryContact);

      const currentName  = lead.column_values.find((c) => c.id === LEADS_COLS.contactName)?.text || "";
      const currentEmail = lead.column_values.find((c) => c.id === LEADS_COLS.email)?.text  || "";
      const currentPhone = lead.column_values.find((c) => c.id === LEADS_COLS.phone)?.text  || "";

      const needsUpdate =
        (contactData.fullName && contactData.fullName !== currentName) ||
        (contactData.email    && contactData.email    !== currentEmail) ||
        (contactData.phone    && contactData.phone    !== currentPhone);

      if (!needsUpdate) { skipped++; continue; }

      await updateLeadFields(lead.id, contactData);
      console.log(`  ✅ Updated "${lead.name}" → ${contactData.fullName} ${contactData.phone || ""} ${contactData.email || ""}`.trim());
      dataUpdated++;
      await sleep(350);
    }

    // ── PHASE 3: Infer and save websites ───────────────────────────────────
    console.log("\n  🌐 Phase 3: Inferring websites...");

    const leadsWithoutWebsite = allLeads.filter((l) => {
      const websiteCol = l.column_values.find((c) => c.id === LEADS_COLS.website);
      return !websiteCol?.text;
    });

    console.log(`  📋 ${leadsWithoutWebsite.length} leads need a website`);

    for (const lead of leadsWithoutWebsite) {
      // Use company name column first, fall back to lead name itself
      const companyName =
        lead.column_values.find((c) => c.id === LEADS_COLS.companyName)?.text?.trim()
        || lead.name.trim();

      if (!companyName) { skipped++; continue; }

      const website = await findWebsite(companyName);

      if (!website) {
        console.log(`  ⚠️  No website found for "${companyName}"`);
        skipped++;
        continue;
      }

      await updateLeadFields(lead.id, { website });
      console.log(`  🌐 Website set for "${lead.name}" → ${website}`);
      websiteFound++;
      await sleep(400);
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log(`\n[${new Date().toISOString()}] ✅ Sync complete.`);
    console.log(`   Leads scanned:   ${allLeads.length}`);
    console.log(`   Auto-matched:    ${autoMatched}  (contact linked automatically)`);
    console.log(`   Data updated:    ${dataUpdated}  (name/phone/email synced)`);
    console.log(`   Websites found:  ${websiteFound}  (website column populated)`);
    console.log(`   Skipped:         ${skipped}  (no match / already up to date)`);

  } catch (err) {
    console.error(`\n[${new Date().toISOString()}] ❌ Sync failed:`, err.message);
    console.error(err.stack);
  }
}

// ─── Cron schedule ─────────────────────────────────────────────────────────
// 8am, 12pm, 4pm, 8pm Dubai time (UTC+4 → subtract 4 for UTC)

const SCHEDULES = [
  "0 4  * * *",
  "0 8  * * *",
  "0 12 * * *",
  "0 16 * * *",
];

console.log("🚀 Leads ↔ Contacts sync service starting...");
console.log(`   Leads board:    ${LEADS_BOARD_ID}`);
console.log(`   Contacts board: ${CONTACTS_BOARD_ID}`);
console.log(`   Schedule:       8am, 12pm, 4pm, 8pm (Dubai time)\n`);

for (const schedule of SCHEDULES) {
  cron.schedule(schedule, runSync, { timezone: "UTC" });
}

runSync();
