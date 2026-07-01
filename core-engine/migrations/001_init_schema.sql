-- ==========================================
-- 1. EXTENSIONS & PRIMARIES
-- ==========================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TABLE merchants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    business_name VARCHAR(255) NOT NULL,
    nomba_client_id VARCHAR(255) NOT NULL,
    nomba_client_secret VARCHAR(255) NOT NULL,
    nomba_account_id UUID NOT NULL,
    webhook_secret VARCHAR(255) NOT NULL,
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
    status VARCHAR(20) NOT NULL DEFAULT 'PENDING', -- PENDING, ACTIVE, PAST_DUE, UNPAID, CANCELLED
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
-- 3. ROW-LEVEL SECURITY (RLS) POLICIES
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




-- ==========================================================
-- SCHEMA REFINEMENT MIGRATION
-- ==========================================================

-- 1. Explicitly tie a subscription instance to a specific tokenized card
ALTER TABLE subscriptions 
ADD COLUMN IF NOT EXISTS saved_card_id UUID REFERENCES saved_cards(id) ON DELETE SET NULL;

ALTER TABLE subscriptions 
ADD COLUMN retry_count INT DEFAULT 0 NOT NULL;

-- 2. Add structural indexing for rapid background cron engine scans
CREATE INDEX IF NOT EXISTS idx_subscriptions_billing_sweep 
ON subscriptions (status, current_period_end) 
WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_saved_cards_customer
ON saved_cards (customer_id);