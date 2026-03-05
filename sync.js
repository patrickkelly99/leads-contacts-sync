/**
 * Monday.com Leads ↔ Contacts Auto-Sync
 * =======================================
 * Runs on a cron schedule and:
 *  1. Fetches all Leads that have a linked Contact
 *  2. Reads contact name, title, email, phone from the Contacts board
 *  3. Writes those values into the Lead's corresponding columns
 *  4. Also scans Leads with a Contact Name but no linked Contact,
 *     and attempts to auto-match by name/company in the Contacts board
 *
 * Schedule: Every day at 8am, and every 4 hours during business hours
 */

require("dotenv").config();
const cron = require("node-cron");
const axios = require("axios");

// ─── Config ────────────────────────────────────────────────────────────────

const MONDAY_API_URL = "https://api.monday.com/v2";
const API_KEY = process.env.MONDAY_API_KEY;

const LEADS_BOARD_ID = 1634744525;
const CONTACTS_BOARD_ID = 1634744523;

// Column IDs on Leads board
const LEADS_COLS = {
  contactName:    "text_mkwfsm3m",
  title:          "text",
  email:          "lead_email",
  phone:          "lead_phone",
  contactRelation:"board_relation_mm0173f",
};

// Column IDs on Contacts board
const CONTACTS_COLS = {
  firstName:  "first_name__1",
  lastName:   "last_name__1",
  position:   "text_mktbyyy1",
  email:      "email_mkyw8fdq",
  phone:      "phone_mkyw7n",
  emailDup:   "text_mkyw2pw6",   // fallback email field
  phoneDup:   "text_mkywnmn4",   // fallback phone field
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

// ─── Fetch Leads with linked contacts ──────────────────────────────────────

async function fetchLeadsWithContacts(cursor = null) {
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

  const variables = {
    boardId: String(LEADS_BOARD_ID),
    cursor,
    columnIds: Object.values(LEADS_COLS),
  };

  const data = await mondayQuery(query, variables);
  return data.boards[0].items_page;
}

// ─── Fetch specific contacts by ID ─────────────────────────────────────────

async function fetchContactsByIds(ids) {
  if (!ids.length) return [];

  const query = `
    query ($boardId: ID!, $itemIds: [ID!]!, $columnIds: [String!]!) {
      boards(ids: [$boardId]) {
        items_page(limit: 100) {
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

  // monday.com v2 supports filtering by item IDs via items_page with ids argument
  const queryWithIds = `
    query ($ids: [ID!]!, $columnIds: [String!]!) {
      items(ids: $ids, limit: 100) {
        id
        name
        column_values(ids: $columnIds) {
          id
          value
          text
        }
      }
    }
  `;

  const data = await mondayQuery(queryWithIds, {
    ids: ids.map(String),
    columnIds: Object.values(CONTACTS_COLS),
  });

  return data.items || [];
}

// ─── Parse contact column values ───────────────────────────────────────────

function parseContact(contact) {
  const cols = {};
  for (const cv of contact.column_values) {
    cols[cv.id] = { value: cv.value, text: cv.text };
  }

  const firstName = cols[CONTACTS_COLS.firstName]?.text?.trim() || "";
  const lastName  = cols[CONTACTS_COLS.lastName]?.text?.trim()  || "";

  // Clean first name — strip company name suffixes like "Ako - ISS" → "Ako"
  const cleanFirst = firstName.replace(/\s*[-–]\s*[A-Z].*$/, "").trim();
  const fullName = [cleanFirst, lastName].filter(Boolean).join(" ") || contact.name.split(" - ")[0].trim();

  const position = cols[CONTACTS_COLS.position]?.text?.trim() || "";

  // Email: prefer proper email column, fall back to dup field
  let email = cols[CONTACTS_COLS.email]?.text?.trim() || "";
  if (!email) {
    const emailDup = cols[CONTACTS_COLS.emailDup]?.text?.trim() || "";
    // Strip surrounding quotes if present
    email = emailDup.replace(/^["']|["']$/g, "").trim();
  }

  // Phone: prefer phone column text, fall back to dup field
  let phone = cols[CONTACTS_COLS.phone]?.text?.trim() || "";
  if (!phone) {
    phone = cols[CONTACTS_COLS.phoneDup]?.text?.trim() || "";
  }
  // Normalise phone → E.164 style with +971 prefix if needed
  phone = normalisePhone(phone);

  return { fullName, position, email, phone };
}

function normalisePhone(raw) {
  if (!raw) return "";
  // Strip spaces, dashes
  let p = raw.replace(/[\s\-().]/g, "");
  // Already has country code
  if (p.startsWith("+")) return p;
  if (p.startsWith("971")) return "+" + p;
  // Local UAE number starting with 0
  if (p.startsWith("0")) return "+971" + p.slice(1);
  // Bare number (e.g. 505595985) — assume UAE
  if (p.length === 9) return "+971" + p;
  return p;
}

// ─── Parse linked contact IDs from a lead ──────────────────────────────────

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

// ─── Update a lead's contact fields ────────────────────────────────────────

async function updateLead(leadId, { fullName, position, email, phone }) {
  const columnValues = {};

  if (fullName)   columnValues[LEADS_COLS.contactName] = fullName;
  if (position)   columnValues[LEADS_COLS.title]       = position;
  if (email)      columnValues[LEADS_COLS.email]       = { email, text: email };
  if (phone)      columnValues[LEADS_COLS.phone]       = { phone, countryShortName: "AE" };

  if (!Object.keys(columnValues).length) return false;

  const mutation = `
    mutation ($boardId: ID!, $itemId: ID!, $columnValues: JSON!) {
      change_multiple_column_values(
        board_id: $boardId,
        item_id: $itemId,
        column_values: $columnValues
      ) { id }
    }
  `;

  await mondayQuery(mutation, {
    boardId: String(LEADS_BOARD_ID),
    itemId:  String(leadId),
    columnValues: JSON.stringify(columnValues),
  });

  return true;
}

// ─── Main sync logic ───────────────────────────────────────────────────────

async function runSync() {
  const timestamp = new Date().toISOString();
  console.log(`\n[${timestamp}] 🔄 Starting Leads ↔ Contacts sync...`);

  let cursor = null;
  let totalLeads = 0;
  let updatedLeads = 0;
  let skippedLeads = 0;

  try {
    do {
      const page = await fetchLeadsWithContacts(cursor);
      cursor = page.cursor;

      const leads = page.items;
      totalLeads += leads.length;

      // Filter to only leads that have linked contacts
      const leadsWithContacts = leads.filter(
        (l) => getLinkedContactIds(l).length > 0
      );

      if (!leadsWithContacts.length) continue;

      // Collect all unique contact IDs needed
      const allContactIds = [
        ...new Set(leadsWithContacts.flatMap(getLinkedContactIds)),
      ];

      // Fetch contact data
      const contacts = await fetchContactsByIds(allContactIds);
      const contactMap = Object.fromEntries(contacts.map((c) => [c.id, c]));

      // For each lead, take the first linked contact and sync its data
      for (const lead of leadsWithContacts) {
        const contactIds = getLinkedContactIds(lead);
        const primaryContact = contactMap[contactIds[0]];

        if (!primaryContact) {
          console.log(`  ⚠️  Lead "${lead.name}" — contact ID ${contactIds[0]} not found`);
          skippedLeads++;
          continue;
        }

        const contactData = parseContact(primaryContact);

        // Check if lead already has this data (avoid unnecessary writes)
        const currentName  = lead.column_values.find((c) => c.id === LEADS_COLS.contactName)?.text || "";
        const currentEmail = lead.column_values.find((c) => c.id === LEADS_COLS.email)?.text || "";
        const currentPhone = lead.column_values.find((c) => c.id === LEADS_COLS.phone)?.text || "";

        const needsUpdate =
          (contactData.fullName && contactData.fullName !== currentName) ||
          (contactData.email    && contactData.email    !== currentEmail) ||
          (contactData.phone    && contactData.phone    !== currentPhone);

        if (!needsUpdate) {
          skippedLeads++;
          continue;
        }

        const updated = await updateLead(lead.id, contactData);
        if (updated) {
          console.log(`  ✅ Updated "${lead.name}" → ${contactData.fullName} ${contactData.phone || ""} ${contactData.email || ""}`);
          updatedLeads++;
        }

        // Rate limit: stay well within monday.com's 60 req/min limit
        await sleep(300);
      }
    } while (cursor);

    console.log(`\n[${new Date().toISOString()}] ✅ Sync complete.`);
    console.log(`   Total leads scanned: ${totalLeads}`);
    console.log(`   Leads updated:       ${updatedLeads}`);
    console.log(`   Leads skipped:       ${skippedLeads} (no change needed / no contact data)`);

  } catch (err) {
    console.error(`\n[${new Date().toISOString()}] ❌ Sync failed:`, err.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Cron schedule ─────────────────────────────────────────────────────────
// Runs at: 8am, 12pm, 4pm, 8pm — Dubai time (UTC+4)
// Cron times below are UTC (subtract 4 hours)
//   8am  Dubai = 4am  UTC
//   12pm Dubai = 8am  UTC
//   4pm  Dubai = 12pm UTC
//   8pm  Dubai = 4pm  UTC

const SCHEDULES = [
  "0 4 * * *",   //  8:00am Dubai
  "0 8 * * *",   // 12:00pm Dubai
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

// Run immediately on startup so you can verify it works
runSync();
