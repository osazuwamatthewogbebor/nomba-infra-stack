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

## Interactive API Documentation Interfaces

The system serves interactive Swagger UI documentation manuals matching production configurations.

* **Local Development Environment:** `http://localhost:5000/docs`
* **Live Staging/Production Deployment:** `https://nomba-infra-stack.pxxl.run/docs`

### Decoupled Authentication Security Setup

To test protected workspace endpoints using the Swagger UI interface, supply parameters into the interface as follows:

1. **The Authorization Key (`DeveloperApiKeyAuth`):** Click the **Authorize** lock icon at the top of the interface and input the plain text bearer token string (`nsb_live_...`) generated during registration.
2. **The Context Identifier Header (`x-merchant-id`):** Provide the raw workspace UUIDv4 string into the header input field for the targeted endpoint to configure the session context for PostgreSQL Row-Level Security.

---

## Core System Transactional Flowcharts

### 1. Merchant Workspace Onboarding Flow

Creates the multi-tenant database partition boundary, returns credentials, and provisions an isolated accounting wallet structure via the gateway rails.

```text
Downstream Dev                     Subflow Core Engine                Nomba Core Rails
      |                                     |                                 |
      |--- POST /v1/merchants/onboard ----->|                                 |
      |    (Passes Brand & Webhook Details) |                                 |
      |                                     |---- Programmatic Provision ---->|
      |                                     |<--- Sub-Account Parameters -----|
      |                                     |                                 |
      |                                     |-- [SHA-256 Hash Secret Key]     |
      |                                     |-- [Commit Workspace Context]    |
      |<-- Return Text Key & Tenant UUID ---|                                 |
      |    (nsb_live_... & x-merchant-id)   |                                 |

```

### 2. Tiered Plan Creation & Discovery Flow

Demonstrates isolated configuration execution under database-enforced protection walls.

```text
Downstream Dev                     Subflow Core Engine                Supabase Postgres
      |                                     |                                 |
      |--- POST /v1/plans ----------------->|                                 |
      |    Headers: Authorization & ID      |--- SET LOCAL merchant_id ------>|
      |    Payload: { amountKobo, interval }|    (Pin Transaction Scope)      |
      |                                     |                                 |
      |                                     |--- INSERT INTO plans ---------->|
      |                                     |    (RLS intercepts & verifies)  |
      |<-- Status 201 Plan Created ---------|                                 |

```

### 3. Subscription Payment Order Initialization Flow

Deconstructs handling routes based on user payment preference parameters.

```text
Subscriber Client                 Downstream Dev                  Subflow Core Engine
      |                                 |                                 |
      |--- Trigger Checkout Action ---->|                                 |
      |                                 |--- POST /v1/checkout/initialize >|
      |                                 |    Headers: Auth & Tenant ID     |
      |                                 |                                 |
      |                                 |    [PATH A: VIRTUAL ACCOUNT]    |
      |                                 |    -> Requests Nomba NUBAN      |
      |<-- Return Assigned Bank NUBAN -------------------------------------|
      |                                 |                                 |
      |                                 |    [PATH B: CARD OPTION]        |
      |                                 |    -> Generates Checkout Link   |
      |<-- Return Active Payment Link -------------------------------------|

```

### 4. Real-Time Webhook Processing & Fan-Out Flow

Traces how event notifications map to downstream servers securely from edge interception nodes.

```text
Nomba Gateway Rails             Cloudflare Worker Edge            Subflow Core App             Downstream Dev Server
        |                                 |                              |                              |
        |-- Payment Success Notification >|                              |                              |
        |                                 |-- [Validate Parent Signature]|                              |
        |                                 |--- Proxy Request Forward --->|                              |
        |                                 |                              |-- [Resolve Sub Reference]    |
        |                                 |                              |-- [Update Database State]   |
        |                                 |                              |-- [Calculate Signature]     |
        |                                 |                              |--- dispatchDeveloperWebhook >|
        |                                 |                              |                              |<-- Returns 200 OK

```

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

* **One-Time Token Exposure:** Merchants register via `/merchants/onboard` and receive a raw token key (`nsb_live_...`). The platform stores only the one-way **SHA-256 hash** of this key. Even in the event of a database leak, active API keys remain completely unreadable.
* **Session Pinning:** Every pooled client connection runs `SET LOCAL app.current_merchant_id = 'uuid'` inside an isolated transaction block (`BEGIN ... COMMIT`).
* **Zero Leak Footprint:** If an engineer writes a broad `SELECT * FROM plans` without filtering by tenant, the database interceptor automatically catches it and strictly exposes rows matching that transaction's context.

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

### 5. Mathematical Proration Upgrade Logic

Allows customers to safely scale up or upgrade subscription tiers mid-cycle. The core system calculates elapsed and remaining value ratios across seconds using the formula:

$$\text{Prorated Charge} = \left( \frac{\text{Remaining Time}}{\text{Total Time}} \times \text{Target Plan Rate} \right) - \left( \frac{\text{Remaining Time}}{\text{Total Time}} \times \text{Current Plan Rate} \right)$$

This guarantees fair billing execution while avoiding downstream manual balance adjustments.

---

## Environment & Local Configuration

Create a `.env` file in your root workspace:

```env
PORT=5000
DATABASE_URL="postgresql://postgres.[id]:[pass]@[aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true](https://aws-0-eu-central-1.pooler.supabase.com:6543/postgres?pgbouncer=true)"
ADMIN_TRIGGER_SECRET=your_secure_admin_passphrase

NOMBA_API_URL=[https://dev.api.nomba.com](https://dev.api.nomba.com)
NOMBA_PARENT_ACCOUNT_ID=your_parent_account_reference
NOMBA_PARENT_WEBHOOK_SECRET=your_global_parent_webhook_secret_key

# Primary Master OAuth Keys
LIVE_CLIENT_ID=your_nomba_client_id
LIVE_PRIVATE_KEY=your_nomba_client_secret
SANDBOX_TEST_BVN=22222222222

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

Test the automated asynchronous renewal runner instantly by sending an authenticated payload directly to the protected admin bridge:

```bash
curl --request POST \
  --url [https://nomba-infra-stack.pxxl.run/v1/admin/trigger-billing](https://nomba-infra-stack.pxxl.run/v1/admin/trigger-billing) \
  --header 'Content-Type: application/json' \
  --header 'x-admin-secret: your_secure_admin_passphrase'

```
