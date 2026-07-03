# Nomba Recurring Billing Infrastructure Stack

An enterprise-grade, multi-tenant B2B subscription billing engine designed for complete tenant isolation and high-throughput transactional stability. This platform abstracts the complexities of the Nomba API ecosystem from downstream developers by providing programmatic sub-account provisioning, automated sliding-window OAuth rotation, and an autonomous database sweep engine built to survive real-world banking network failures.

**Author:** Osazuwa Matthew Ogbebor

---

## System Architecture & Money Routing

The platform separates real-time payment ingestion from heavy asynchronous database processing. Instead of forcing downstream merchants to provide individual gateway keys, the core platform provisions isolated **Nomba Sub-Accounts** programmatically, splitting financial ledgering trails cleanly while keeping authorization centralized.

```text
                  [ NOMBA PAYMENT GATEWAY ]
                   /                     \
    (1) Webhook   /                       \  (3) Recurrent Tokenized Charges
    Event Signals/                         \     via Isolated Sub-Account IDs
                v                           v
     +-------------------+         +------------------------+
     | Cloudflare Worker |         | Background Cron Engine |
     |   (Proxy Edge)    |         |    (billingWorker)     |
     +---------+---------+         +-----------+------------+
               |                               |
  (2) Proxy    |                               | (4) FOR UPDATE OF s
  Forwarding   v                               v     SKIP LOCKED Rows
     +------------------------------------------------------+
     |                CORE EXPRESS RUNTIME                  |
     |         (Signature Checking & Token Hashes)          |
     +-------------------------+----------------------------+
                               |
                               | (5) Session-Scoped Context 
                               v
                  +--------------------------+
                  |    SUPABASE POSTGRES     |
                  |  Row-Level Security Gate |
                  +--------------------------+

```

### Component Breakdown

* **The Cloudflare Worker Proxy:** Acts as an edge defense system. It captures incoming webhook notifications from Nomba, verifies signatures against your global parent configuration, and buffers execution loads before hitting the application tier.
* **The Core Express App:** The engine that processes requests, hashes downstream merchant API keys via SHA-256 for secure lookup, and initializes connection pools.
* **The Asynchronous Cron Engine:** Sweeps the database on a heartbeat ticker to process due subscription renewals using tokenized card data.
* **The Storage Layer (Supabase Postgres):** Houses multi-tenant logs underneath native database boundaries.

---

## The Security & Multi-Tenant Sandbox Model

Data privacy is strictly enforced directly inside **Postgres via Row-Level Security (RLS)** rather than relying on standard application-layer `WHERE` clauses.

```text
+--------------------------------------------------------------------------+
|                       DOWNSTREAM DEVELOPER REQUEST                       |
+--------------------------------------------------------------------------+
  |  1. Intercept Custom Bearer Key -> Match SHA-256 Cryptographic Hash
  |  2. SET LOCAL app.current_merchant_id = 'merchant-uuid-xxxx';
  |  3. Run generic query: SELECT * FROM plans;
  v
+--------------------------------------------------------------------------+
|                     DATABASE ROW-LEVEL SECURITY ENGINE                   |
+--------------------------------------------------------------------------+
  |  
  |--> [ RLS Gate Check ] -> Enforces WHERE merchant_id = current_setting(...)
  |
  v (Silently drops out all other merchant rows at the engine layer)
+--------------------------------------------------------------------------+
|                      ISOLATED TENANT RESULT SUBSET                       |
+--------------------------------------------------------------------------+

```

* **One-Time Token Exposure:** Merchants register and receive a raw token key (`nsb_live_...`). The platform stores only the one-way **SHA-256 hash** of this key. Even in the event of a database leak, active API keys remain completely unreadable.
* **Session Pinning:** Every pooled client connection runs `SET LOCAL app.current_merchant_id = 'uuid'` inside an isolated transaction block (`BEGIN ... COMMIT`).
* **Zero Leak Footprint:** If an engineer writes a broad `SELECT * FROM subscriptions` without filtering by tenant, the database interceptor automatically catches it and strictly exposes rows matching that transaction's context.

---

## Key Technical Highlights

### 1. Programmatic Sub-Account Provisioning

Eliminates onboarding friction. When a business signs up, the backend silently invokes Nomba's sub-account factory. The merchant receives a dedicated wallet routing slot mapped to their profile, allowing automated split payouts without the core platform taking direct custody of third-party funds.

### 2. High-Throughput Concurrency Defense (`SKIP LOCKED`)

To prevent multi-instance race conditions or accidental double-billing when background worker pods scale horizontally, the cron sweep utilizes:

```sql
SELECT ... FOR UPDATE OF s SKIP LOCKED

```

Active worker threads instantly place atomic locks on targeted overdue subscriptions, causing concurrent instances to seamlessly skip locked rows and eliminate operational bottlenecks.

### 3. Sliding-Window OAuth Resiliency

Keeps background batch transactions alive without service interruption. The authentication module maintains an in-memory token cache vault that tracks expiration bounds normalized to millisecond Unix epochs, transparently rotating token pairs before they expire.

### 4. Smart Localized Dunning & Recovery

Engineered specifically to handle payment failures gracefully without hitting network rate limits or causing customer subscription fatigue:

* **Network/Transient Timeouts:** Schedules an immediate fallback retry in 1 day.
* **Insufficient Funds (Decline Code 51):** Steps back dynamically to a 2-day interval window to align intelligently with standard consumer salary and wallet funding cycles.
* **Hard Threshold Caps:** Completely stops retrying after 5 failed consecutive attempts to preserve API resource limits.

---

## Environment & Local Configuration

Create a `.env` file in your root workspace:

```env
PORT=5000
DATABASE_URL="postgresql://postgres.[id]:[pass]@aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true"
ADMIN_TRIGGER_SECRET=your_secure_admin_passphrase

NOMBA_API_URL=https://dev.api.nomba.com
NOMBA_PARENT_ACCOUNT_ID=your_parent_account_reference
NOMBA_PARENT_WEBHOOK_SECRET=your_global_parent_webhook_secret_key

# Primary Master OAuth Keys
LIVE_CLIENT_ID=your_nomba_client_id
LIVE_PRIVATE_KEY=your_nomba_client_secret

```

### Execution Commands

```bash
# 1. Install dependencies
npm install

# 2. Fire up hot-reloading development server
npm run dev

# 3. Compile and launch production build
npm run build && npm start

```

---

## Out-of-Band Manual Verification

Test the automated asynchronous renewal runner instantly by sending a authenticated payload directly to the protected admin bridge:

```bash
curl --request POST \
  --url https://nomba-infra-stack.pxxl.run/v1/admin/trigger-billing \
  --header 'Content-Type: application/json' \
  --header 'x-admin-secret: your_secure_admin_passphrase'

```
