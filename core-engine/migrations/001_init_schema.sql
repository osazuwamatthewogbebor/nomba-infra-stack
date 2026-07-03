-- ==========================================
-- 1. EXTENSIONS & PRIMARIES
-- ==========================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name VARCHAR(255) NOT NULL,
    api_key_hash VARCHAR(64) UNIQUE, -- SHA-256 hash of the generated platform api_key
    nomba_account_id VARCHAR(255), -- Maps programmatically to their unique Nomba sub-account/wallet string
    webhook_url TEXT, -- Downstream developer destination endpoint
    webhook_secret VARCHAR(255) NOT NULL, -- Key used to sign the outbound payload hash
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 2. TENANT-ISOLATED CORE TABLES
-- ==========================================
CREATE TABLE plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    name VARCHAR(100) NOT NULL,
    amount_kobo BIGINT NOT NULL, -- Stored in kobo to completely avoid float rounding errors
    currency VARCHAR(3) NOT NULL DEFAULT 'NGN',
    billing_interval VARCHAR(20) NOT NULL, -- 'monthly', 'annual', 'custom'
    custom_interval_days INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE customers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    email VARCHAR(255) NOT NULL,
    external_customer_id VARCHAR(255),
    account_balance_kobo BIGINT NOT NULL DEFAULT 0, -- Used to track and apply over-payment credits
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (merchant_id, email)
);

CREATE TABLE saved_cards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    token_key VARCHAR(255) NOT NULL,
    card_brand VARCHAR(50),
    masked_pan VARCHAR(20),
    expiry_month INTEGER,
    expiry_year INTEGER,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    plan_id UUID NOT NULL REFERENCES plans(id),
    saved_card_id UUID REFERENCES saved_cards(id) ON DELETE SET NULL, -- Explicitly ties instance to active card token
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, ACTIVE, PAST_DUE, UNPAID, CANCELLED
    retry_count INT DEFAULT 0 NOT NULL,
    current_period_start TIMESTAMP WITH TIME ZONE NOT NULL,
    current_period_end TIMESTAMP WITH TIME ZONE NOT NULL,
    idempotency_key VARCHAR(255),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT unique_merchant_idempotency UNIQUE (merchant_id, idempotency_key)
);

CREATE TABLE billing_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    merchant_id UUID NOT NULL REFERENCES merchants(id) ON DELETE CASCADE,
    subscription_id UUID NOT NULL REFERENCES subscriptions(id),
    amount_kobo BIGINT NOT NULL,
    entry_type VARCHAR(10) NOT NULL, -- 'DEBIT' (charge due), 'CREDIT' (payment made)
    transaction_ref VARCHAR(255) NOT NULL UNIQUE, -- maps to Nomba's unique merchantTxRef
    status VARCHAR(20) NOT NULL, -- PENDING, SUCCESS, FAILED
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- For webhook idempotency defense at the proxy edge
CREATE TABLE processed_webhooks (
    request_id VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- ==========================================
-- 3. SPEED & OPTIMIZATION INDEXING
-- ==========================================
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_sweep 
ON subscriptions (status, current_period_end) 
WHERE status IN ('ACTIVE', 'PAST_DUE'); -- Extended to track PAST_DUE collections smoothly

CREATE INDEX IF NOT EXISTS idx_saved_cards_customer
ON saved_cards (customer_id);

-- ==========================================
-- 4. ROW-LEVEL SECURITY (RLS) POLICIES
-- ==========================================
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_cards ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_ledger ENABLE ROW LEVEL SECURITY;

CREATE POLICY plan_isolation_policy ON plans
    FOR ALL USING (merchant_id = NULLIF(current_setting('app.current_merchant_id', true), '')::UUID);

CREATE POLICY customer_isolation_policy ON customers
    FOR ALL USING (merchant_id = NULLIF(current_setting('app.current_merchant_id', true), '')::UUID);

CREATE POLICY card_isolation_policy ON saved_cards
    FOR ALL USING (customer_id IN (SELECT id FROM customers WHERE merchant_id = NULLIF(current_setting('app.current_merchant_id', true), '')::UUID));

CREATE POLICY subscription_isolation_policy ON subscriptions
    FOR ALL USING (merchant_id = NULLIF(current_setting('app.current_merchant_id', true), '')::UUID);

CREATE POLICY ledger_isolation_policy ON billing_ledger
    FOR ALL USING (merchant_id = NULLIF(current_setting('app.current_merchant_id', true), '')::UUID);