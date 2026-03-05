/**
 * Monday.com Leads ↔ Contacts Auto-Sync
 * =======================================
 * Runs on a cron schedule and does TWO things:
 *
 * PHASE 1 — AUTO-MATCH
 *   Scans leads with no linked contact and tries to find a matching
 *   contact by comparing the lead's company name against contact names.
 *   If a confident match is found, it links them automatically.
 *
 * PHASE 2 — DATA SYNC
 *   For all leads that have a linked contact (including newly matched ones),
 *   copies name, title, email, and phone into the lead's columns.
 *
 * Schedule: 8am, 12pm, 4pm, 8pm Dubai time
 */

require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");

// ─── Config ────────────────────────────────────────────────────────────────

const MONDAY_API_URL = "https://api.monday.com/v2";
const API_KEY = process.env.MONDAY_API_KEY;

const LEADS_BOARD_ID    = 1634744525;
const CONTACTS_BOARD_ID = 1634744523;

// Column IDs on Leads board
const LEADS_COLS = {
  contactName:     "text_mkwfsm3m",
  title:           "text",
  email:           "lead_email",
  phone:           "lead_phone",
  contactRelation: "board_relation_mm0173f",
  companyName:     "lead_company",
};

// Column IDs on Contacts board
const CONTACTS_COLS = {
  firstName: "first_name__1",
  lastName:  "last_name__1",
  position:  "text_mktbyyy1",
  email:     "email_mkyw8fdq",
  phone:     "phone_mkyw7n",
  emailDup:  "text_mkyw2pw6",
  phoneDup:  "text_mkywnmn4",
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

// ─── Fetch all leads (paginated) ───────────────────────────────────────────

async function fetchAllLeads() {
  const query = `
    query ($boardId: ID!, $cursor: String, $columnIds: [String!]!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100, cursor: $cursor) {
          cursor
          items {
            id
            name
            column_values(ids: $columnIds) {
              id
              value
              text
            }
          }
        }
      }
    }
  `;

  let cursor = null;
  const allLeads = [];

  do {
    const data = await mondayQuery(query, {
      boardId: String(LEADS_BOARD_ID),
      cursor,
      columnIds: Object.values(LEADS_COLS),
    });
    const page = data.boards[0].items_page;
    allLeads.push(...page.items);
    cursor = page.cursor;
    await sleep(300);
  } while (cursor);

  return allLeads;
}

// ─── Fetch ALL contacts (paginated) ────────────────────────────────────────

async function fetchAllContacts() {
  const query = `
    query ($boardId: ID!, $cursor: String, $columnIds: [String!]!) {
      boards(ids: [$boardId]) {
        items_page(limit: 500, cursor: $cursor) {
          cursor
          items {
            id
            name
            column_values(ids: $columnIds) {
              id
              value
              text
            }
          }
        }
      }
    }
  `;

  let cursor = null;
  const allContacts = [];

  do {
    const data = await mondayQuery(query, {
      boardId: String(CONTACTS_BOARD_ID),
      cursor,
      columnIds: Object.values(CONTACTS_COLS),
    });
    const page = data.boards[0].items_page;
    allContacts.push(...page.items);
    cursor = page.cursor;
    await sleep(300);
  } while (cursor);

  return allContacts;
}

// ─── Normalise string for fuzzy matching ───────────────────────────────────
// Strips legal suffixes, punctuation, extra spaces so
// "Iron Mountain Incorporated (UAE)" matches "Ako - Iron Mountain"

function normalise(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/\b(llc|fze|fzco|fzc|l\.l\.c\.|w\.l\.l\.|q\.p\.s\.c\.|b\.s\.c|inc|ltd|limited|co\.|group|logistics|international|middle east|uae|dubai)\b/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── Build searchable index from contacts ──────────────────────────────────
// Contact names follow "Salija - MOMENTUM LOGISTICS - MOMENTUM LOGISTICS"
// We extract every meaningful part as a searchable token

function buildContactIndex(contacts) {
  return contacts.map((c) => {
    const parts  = c.name.split(/\s*[-–]\s*/);
    const tokens = parts
      .map((p) => normalise(p))
      .filter((p) => p.length > 2);
    return { contactId: c.id, tokens };
  });
}

// ─── Find best matching contact for a lead ─────────────────────────────────

function findMatch(lead, contactIndex) {
  const leadName    = normalise(lead.name);
  const leadCompany = normalise(
    lead.column_values.find((c) => c.id === LEADS_COLS.companyName)?.text || ""
  );

  const scored = contactIndex.map(({ contactId, tokens }) => {
    let score = 0;
    for (const token of tokens) {
      if (!token) continue;
      if (leadName.includes(token) || leadCompany.includes(token)) {
        score += token.length;
      }
      if (token.includes(leadName) || (leadCompany && token.includes(leadCompany))) {
        score += Math.min(leadName.length, leadCompany.length || leadName.length);
      }
    }
    return { contactId, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];

  // Minimum score of 5 to avoid false positives (5-char token matched)
  return best && best.score >= 5 ? best.contactId : null;
}

// ─── Link a contact to a lead ──────────────────────────────────────────────

async function linkContactToLead(leadId, contactId) {
  await mondayQuery(
    `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId, item_id: $itemId, column_values: $columnValues
      ) { id }
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

// ─── Parse contact into usable fields ─────────────────────────────────────

function parseContact(contact) {
  const cols = {};
  for (const cv of contact.column_values) {
    cols[cv.id] = { value: cv.value, text: cv.text };
  }

  const firstName  = cols[CONTACTS_COLS.firstName]?.text?.trim() || "";
  const lastName   = cols[CONTACTS_COLS.lastName]?.text?.trim()  || "";
  const cleanFirst = firstName.replace(/\s*[-–]\s*[A-Z].*$/, "").trim();
  const fullName   = [cleanFirst, lastName].filter(Boolean).join(" ")
                     || contact.name.split(/\s*[-–]\s*/)[0].trim();

  const position = cols[CONTACTS_COLS.position]?.text?.trim() || "";

  let email = cols[CONTACTS_COLS.email]?.text?.trim() || "";
  if (!email) {
    email = (cols[CONTACTS_COLS.emailDup]?.text || "").replace(/^["']|["']$/g, "").trim();
  }

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

// ─── Update lead's contact fields ──────────────────────────────────────────

async function updateLeadFields(leadId, { fullName, position, email, phone }) {
  const columnValues = {};
  if (fullName) columnValues[LEADS_COLS.contactName] = fullName;
  if (position) columnValues[LEADS_COLS.title]       = position;
  if (email)    columnValues[LEADS_COLS.email]       = { email, text: email };
  if (phone)    columnValues[LEADS_COLS.phone]       = { phone, countryShortName: "AE" };

  if (!Object.keys(columnValues).length) return false;

  await mondayQuery(
    `mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId, item_id: $itemId, column_values: $columnValues
      ) { id }
    }`,
    {
      boardId: String(LEADS_BOARD_ID),
      itemId:  String(leadId),
      columnValues: JSON.stringify(columnValues),
    }
  );
  return true;
}

function getLinkedContactIds(lead) {
  const rel = lead.column_values.find((c) => c.id === LEADS_COLS.contactRelation);
  if (!rel || !rel.value) return [];
  try {
    const parsed = JSON.parse(rel.value);
    return (parsed.linkedPulseIds || []).map((lp) => String(lp.linkedPulseId));
  } catch {
    return [];
  }
}

// ─── MAIN SYNC ─────────────────────────────────────────────────────────────

async function runSync() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🔄 Starting Leads ↔ Contacts sync...`);

  let autoMatched = 0;
  let dataUpdated = 0;
  let skipped     = 0;

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

    const unlinkedLeads = allLeads.filter(
      (l) => getLinkedContactIds(l).length === 0
    );

    for (const lead of unlinkedLeads) {
      const matchId = findMatch(lead, contactIndex);

      if (!matchId) {
        skipped++;
        continue;
      }

      const matchedContact = contactMap[matchId];
      console.log(`  🔗 Matched "${lead.name}" → "${matchedContact?.name}"`);

      await linkContactToLead(lead.id, matchId);
      autoMatched++;

      // Inject the link into the in-memory lead so Phase 2 picks it up now
      const relCol = lead.column_values.find((c) => c.id === LEADS_COLS.contactRelation);
      if (relCol) {
        relCol.value = JSON.stringify({ linkedPulseIds: [{ linkedPulseId: Number(matchId) }] });
      }

      await sleep(350);
    }

    // ── PHASE 2: Sync contact data into all linked leads ───────────────────
    console.log("\n  📝 Phase 2: Syncing contact data into leads...");

    const linkedLeads = allLeads.filter(
      (l) => getLinkedContactIds(l).length > 0
    );

    for (const lead of linkedLeads) {
      const contactIds     = getLinkedContactIds(lead);
      const primaryContact = contactMap[contactIds[0]];

      if (!primaryContact) {
        console.log(`  ⚠️  Lead "${lead.name}" — linked contact not found in board`);
        skipped++;
        continue;
      }

      const contactData = parseContact(primaryContact);

      const currentName  = lead.column_values.find((c) => c.id === LEADS_COLS.contactName)?.text || "";
      const currentEmail = lead.column_values.find((c) => c.id === LEADS_COLS.email)?.text  || "";
      const currentPhone = lead.column_values.find((c) => c.id === LEADS_COLS.phone)?.text  || "";

      const needsUpdate =
        (contactData.fullName && contactData.fullName !== currentName) ||
        (contactData.email    && contactData.email    !== currentEmail) ||
        (contactData.phone    && contactData.phone    !== currentPhone);

      if (!needsUpdate) {
        skipped++;
        continue;
      }

      const updated = await updateLeadFields(lead.id, contactData);
      if (updated) {
        console.log(`  ✅ Updated "${lead.name}" → ${contactData.fullName} ${contactData.phone || ""} ${contactData.email || ""}`.trim());
        dataUpdated++;
      }

      await sleep(350);
    }

    // ── Summary ────────────────────────────────────────────────────────────
    console.log(`\n[${new Date().toISOString()}] ✅ Sync complete.`);
    console.log(`   Leads scanned:   ${allLeads.length}`);
    console.log(`   Auto-matched:    ${autoMatched}  (contact linked automatically)`);
    console.log(`   Data updated:    ${dataUpdated}  (fields copied from contact)`);
    console.log(`   Skipped:         ${skipped}  (no match / already up to date)`);

  } catch (err) {
    console.error(`\n[${new Date().toISOString()}] ❌ Sync failed:`, err.message);
    console.error(err.stack);
  }
}

// ─── Cron schedule ─────────────────────────────────────────────────────────
// 8am, 12pm, 4pm, 8pm Dubai time (UTC+4 → subtract 4 for UTC)

const SCHEDULES = [
  "0 4  * * *",  //  8:00am Dubai
  "0 8  * * *",  // 12:00pm Dubai
  "0 12 * * *",  //  4:00pm Dubai
  "0 16 * * *",  //  8:00pm Dubai
];

console.log("🚀 Leads ↔ Contacts sync service starting...");
console.log(`   Leads board:    ${LEADS_BOARD_ID}`);
console.log(`   Contacts board: ${CONTACTS_BOARD_ID}`);
console.log(`   Schedule:       8am, 12pm, 4pm, 8pm (Dubai time)\n`);

for (const schedule of SCHEDULES) {
  cron.schedule(schedule, runSync, { timezone: "UTC" });
}

// Run immediately on startup
runSync();
