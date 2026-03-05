# Leads ↔ Contacts Auto-Sync

Automatically syncs contact name, title, email, and phone number from your
**Contacts - United Arab Emirates** board into your **Leads** board —
whenever a contact is linked to a lead.

Runs on a recurring schedule: **8am, 12pm, 4pm, and 8pm Dubai time**.

---

## What it does

Every run:
1. Scans all leads on the Leads board
2. For each lead that has a linked contact, fetches that contact's data
3. Writes name, title, email, and phone into the lead's columns
4. Skips leads where the data is already up to date (no unnecessary API calls)
5. Logs every update to the console

---

## Setup

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18 or higher
- A monday.com account with API access

### 2. Get your API key

1. Go to monday.com → click your avatar (top right) → **Administration**
2. Go to **API** section
3. Copy your **Personal API Token** (or generate one)

### 3. Install & configure

```bash
# Clone or copy this folder to your machine
cd leads-contacts-sync

# Install dependencies
npm install

# Add your API key
cp .env.example .env
# Edit .env and paste your API key
```

Your `.env` file should look like:
```
MONDAY_API_KEY=eyJhbGciOiJIUzI1NiJ9.your_actual_key_here
```

### 4. Run it

```bash
# Start (runs immediately, then on schedule)
npm start

# Development mode (restarts on file changes)
npm run dev
```

---

## Deployment options

### Option A — Keep it running on your Mac/PC

Use [PM2](https://pm2.keymetrics.io/) to keep it running in the background:

```bash
npm install -g pm2
pm2 start sync.js --name "leads-sync"
pm2 save
pm2 startup   # makes it restart on machine reboot
```

### Option B — Deploy to a cloud server (recommended)

Any small VPS works. Example with a $4/month DigitalOcean or Hetzner droplet:

```bash
# On the server
git clone <your-repo> leads-sync
cd leads-sync
npm install
cp .env.example .env
nano .env   # add your API key

# Run with PM2
npm install -g pm2
pm2 start sync.js --name "leads-sync"
pm2 save && pm2 startup
```

### Option C — Railway / Render (zero-server)

1. Push this folder to a GitHub repo
2. Connect to [Railway](https://railway.app) or [Render](https://render.com)
3. Set `MONDAY_API_KEY` as an environment variable in the dashboard
4. Deploy — it will run 24/7 for free or ~$5/month

---

## Customising the schedule

Edit the `SCHEDULES` array in `sync.js`. Times are in UTC (Dubai = UTC+4):

```js
const SCHEDULES = [
  "0 4 * * *",   //  8:00am Dubai
  "0 8 * * *",   // 12:00pm Dubai
  "0 12 * * *",  //  4:00pm Dubai
  "0 16 * * *",  //  8:00pm Dubai
];
```

Use [crontab.guru](https://crontab.guru) to build custom cron expressions.

---

## Board & column IDs

Hardcoded in `sync.js` — update these if you ever restructure your boards:

| Variable | ID |
|---|---|
| `LEADS_BOARD_ID` | `1634744525` |
| `CONTACTS_BOARD_ID` | `1634744523` |
| Lead: Contact Name column | `text_mkwfsm3m` |
| Lead: Title column | `text` |
| Lead: Email column | `lead_email` |
| Lead: Phone column | `lead_phone` |
| Lead: Contact relation column | `board_relation_mm0173f` |

---

## Logs

Console output example:

```
🚀 Leads ↔ Contacts sync service starting...
   Leads board:    1634744525
   Contacts board: 1634744523
   Schedule:       8am, 12pm, 4pm, 8pm (Dubai time)

[2026-03-05T08:00:00.000Z] 🔄 Starting Leads ↔ Contacts sync...
  ✅ Updated "Iron Mountain" → Ako Djaf +971506529210
  ✅ Updated "M.H. Alshaya Co." → James Dean James.dean@alshaya.com
  ✅ Updated "Momentum Logistics" → Salija Varma +971507193689

[2026-03-05T08:00:04.000Z] ✅ Sync complete.
   Total leads scanned: 104
   Leads updated:       3
   Leads skipped:       101 (no change needed / no contact data)
```
