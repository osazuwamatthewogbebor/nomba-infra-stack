# Nomba Core Infrastructure Billing Stack

A resilient, multi-tenant B2B subscription billing engine designed for high-throughput transactional stability. Built on top of the Nomba API ecosystem, this stack implements advanced database isolation, automated sliding-window OAuth token rotation, and autonomous payment execution sweeps tailored to handle complex recurring card billing lifecycles.

**Author:** Osazuwa Matthew Ogbebor

---

## System Architecture & Data Flow

The platform utilizes a decoupled, event-driven architecture designed to separate immediate transactional webhook ingestion from heavy asynchronous batch processing operations.

```text
                  [ NOMBA PAYMENT GATEWAY ]
                   /                     \
    (1) Webhook   /                       \  (3) Recurrent Tokenized
    Event Signals/                         \     Card Charges
                v                           v
     +-------------------+         +------------------------+
     | Cloudflare Worker |         | Pxxl Background Worker |
     |   (Proxy Edge)    |         |     (Billing Sweep)    |
     +---------+---------+         +-----------+------------+
               |                               |
  (2) Proxy    |                               | (4) Locked Row Updates
  Forwarding   v                               v
     +------------------------------------------------------+
     |                CORE ENGINE RUNTIME                   |
     |          (Express Webhooks & Admin Handlers)         |
     +-------------------------+----------------------------+
                               |
                               | (5) Enforced Context Writes
                               v
                  +--------------------------+
                  |  SUPABASE POSTGRES DB    |
                  | (Row-Level Security/RLS) |
                  +--------------------------+

```

### Core Architectural Separation

1. **The Edge Proxy (Cloudflare Worker):** Intercepts live webhook signals directly from the Nomba gateway, defending the internal infrastructure by buffering input and forwarding traffic to the application tier.
2. **The Core Runtime Engine (Pxxl API Web Node):** Processes verified incoming webhooks and exposes authenticated administrative pathways.
3. **The Compute Loop Matrix (Pxxl Cron Engine):** Runs autonomously on a scheduled heartbeat ticker to query, lock, and execute recurrent billing batches via Nomba's tokenized endpoints.
4. **Data Isolation Tier (Supabase Postgres):** Houses the multi-tenant transactional records under strict database-level boundaries.

---

## Security & Tenant Isolation Model

Data privacy is enforced natively at the database layer using Postgres **Row-Level Security (RLS)**. Rather than relying solely on application-level filtering, every structural query automatically binds data constraints within isolated merchant tenants.

```text
+--------------------------------------------------------------------------+
|                       MERCHANT CLIENT APP CONTEXT                        |
+--------------------------------------------------------------------------+
  |  1. SET LOCAL app.current_merchant_id = 'merchant-uuid-xxxx';
  |  
  |  2. SELECT * FROM subscriptions;
  v
+--------------------------------------------------------------------------+
|                     DATABASE ROW-LEVEL SECURITY ENGINE                   |
+--------------------------------------------------------------------------+
  |  
  |--> [ RLS EVALUATION ] -> WHERE merchant_id = current_setting(...)
  |
  v (Filters out all other tenant records at the engine engine level)
+--------------------------------------------------------------------------+
|                     ISOLATED RESULT SUBSET (MERCHANT A)                  |
+--------------------------------------------------------------------------+

```

* **Tenant Scoping:** The global pool connection initializes a dynamic session context configuration (`SET LOCAL app.current_merchant_id = ...`) inside every atomic transaction boundary.
* **Leak Defense:** If a developer accidentally writes a generic `SELECT * FROM subscriptions` query without a `WHERE` clause, the database itself filters the data, returning only rows belonging to the active authenticated merchant session.

---

## Core Technical Features

### 1. Autonomous Concurrency Sweep Matrix (`FOR UPDATE OF s SKIP LOCKED`)

To eliminate the threat of double-billing or multi-instance race conditions when scaling out background workers, the polling engine uses advanced row-level locks. Overdue lines are locked atomically by the active execution thread, instructing concurrent processes to seamlessly bypass them.

### 2. Sliding-Window OAuth Resiliency

Implements an automated token vault engine that coordinates with the Nomba Auth ecosystem. It caches state tokens securely and manages predictive sliding-window rotation—refreshing access tokens automatically prior to expiry to guarantee 100% processing uptime.

### 3. Smart-Backoff Banking Recovery Matrix

Designed specifically to adapt to real-world banking network volatility (such as the Nigerian financial ecosystem):

* **Transient Outages:** Network timeouts default to an aggressive 1-day retry loop window.
* **Insufficient Balances:** Gateway responses returning insufficient balances dynamically step back to a 2-day interval window to smartly realign with typical consumer salary and funding cycles.
* **Retry Exhaustion:** Hard caps tracking threshold levels up to 5 validation loops prevent consumer account fatigue and safeguard API resource bandwidth.

---

## Tech Stack

* **Runtime Environment:** Node.js & TypeScript
* **Web Framework:** Express
* **Edge Routing:** Cloudflare Workers (Wrangler Ecosystem)
* **Compute Hosting:** Pxxl Core Node Engine
* **Database Infrastructure:** Postgres (Supabase Cloud Partition Instance)
* **Payment Gateway Interface:** Nomba B2B Core Dashboard API

---

## Local Development Setup

### 1. Environment Configurations

Create a `.env` configuration file in the core project root directory:

```env
PORT=5000
DATABASE_URL=postgresql://<user>:<password>@<host>:<port>/postgres
ADMIN_TRIGGER_SECRET=your_secure_admin_passphrase

NOMBA_API_URL=https://dev.api.nomba.com
NOMBA_CLIENT_ID=your_nomba_client_id
NOMBA_CLIENT_SECRET=your_nomba_client_secret
NOMBA_PARENT_ACCOUNT_ID=your_parent_account_reference

```

### 2. Install Project Dependencies

```bash
npm install

```

### 3. Run Application Server (Dev Mode)

```bash
npm run dev

```

### 4. Build Production Artifacts

```bash
npm run build
npm start

```

---

## Live Testing & Manual Verification

The background sweep routine can be triggered out-of-band using the protected administrative control route:

```bash
curl --request POST \
  --url https://nomba-infra-stack.pxxl.run/v1/admin/trigger-billing \
  --header 'Content-Type: application/json' \
  --header 'x-admin-secret: your_secure_admin_passphrase'

```