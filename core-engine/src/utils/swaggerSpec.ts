export const swaggerDocument = {
  openapi: "3.0.3",
  info: {
    title: "Subflow Multi-Tenant Core Billing Infrastructure Stack",
    description: "Enterprise-grade subscription engine featuring isolated tenant workspaces via PostgreSQL RLS, tokenized card sweeps, and hybrid persistent Virtual Account NUBAN routing powered by the Nomba API Core.",
    version: "1.0.0"
  },
  servers: [
    {
      url: "/v1",
      description: "Local Runtime Baseline Server"
    },
    {
      url: "/v1",
      description: "Production Environment Base Runtime Server"
    }
  ],
  components: {
    securitySchemes: {
      // 🔑 The actual security credential lock for authentication
      DeveloperApiKeyAuth: {
        type: "http",
        scheme: "bearer",
        bearerFormat: "API Key",
        description: "The plain-text authentication token (nsb_live_...) generated during onboarding used to verify authorization."
      }
    }
  },
  // Apply HTTP Bearer authentication globally across all endpoints unless overridden
  security: [
    {
      DeveloperApiKeyAuth: []
    }
  ],
  paths: {
    "/merchants/onboard": {
      post: {
        tags: ["Workspace Management"],
        summary: "Provision a Developer Workspace Profile",
        description: "Public registration endpoint. Creates an isolated workspace partition. Generates a secure, high-entropy plain text API token displayed exactly once, and hashes it using SHA-256 for secure DB mapping.",
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["businessName", "domain", "webhookSecret"],
                properties: {
                  businessName: { type: "string", example: "Acme Software Ltd" },
                  domain: { type: "string", example: "acme.com", description: "Globally unique company domain identifier." },
                  webhookUrl: { type: "string", example: "https://api.acme.com/subflow-receiver" },
                  webhookSecret: { type: "string", example: "whsec_prod_signing_secret_key_001" }
                }
              }
            }
          }
        },
        responses: {
          "201": {
            description: "Workspace configured successfully.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    success: { type: "boolean", example: true },
                    apiKey: { type: "string", example: "nsb_live_7f849a20bc..." },
                    merchant: {
                      type: "object",
                      properties: {
                        id: { type: "string", format: "uuid", description: "The unique public workspace tenant UUID used for the x-merchant-id header context." },
                        business_name: { type: "string" }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    },
    "/plans": {
      post: {
        tags: ["Billing Configurations"],
        summary: "Register a Tiered Billing Plan",
        description: "Creates an active pricing plan tier locked strictly inside the tenant partition.",
        parameters: [
          {
            in: "header",
            name: "x-merchant-id",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "The public tenant UUIDv4 handle used to map PostgreSQL Row-Level Security (RLS) execution context."
          }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "amountKobo", "billingInterval"],
                properties: {
                  name: { type: "string", example: "Premium Enterprise Tier" },
                  amountKobo: { type: "integer", example: 500000, description: "Amount in Kobo (e.g., ₦5,000.00)" },
                  currency: { type: "string", example: "NGN" },
                  billingInterval: { type: "string", enum: ["monthly", "annual"], example: "monthly" }
                }
              }
            }
          }
        },
        responses: {
          "201": { description: "Plan registered successfully inside tenant context." }
        }
      },
      get: {
        tags: ["Billing Configurations"],
        summary: "Fetch Workspace Specific Billing Tiers",
        description: "Retrieves active configurations. Enforced strictly against cross-workspace boundary leaks using PostgreSQL session-scoped Row-Level Security.",
        parameters: [
          {
            in: "header",
            name: "x-merchant-id",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "The public tenant UUIDv4 handle used to map PostgreSQL Row-Level Security (RLS) execution context."
          }
        ],
        responses: {
          "200": { description: "Isolated plan array compiled and returned." }
        }
      }
    },
    "/checkout/initialize": {
      post: {
        tags: ["Core Billing Operations"],
        summary: "Initialize Subscription Flow (Card Checkout Link or Persistent NUBAN)",
        description: "Dynamically spins up an automated billing lifecycle. If VIRTUAL_ACCOUNT is selected, a unique, persistent bank account is generated via the Nomba network using compliant sandbox KYC markers.",
        parameters: [
          {
            in: "header",
            name: "x-merchant-id",
            required: true,
            schema: { type: "string", format: "uuid" },
            description: "The public tenant UUIDv4 handle used to map PostgreSQL Row-Level Security (RLS) execution context."
          }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["planId", "customerEmail"],
                properties: {
                  planId: { type: "string", format: "uuid", example: "b3c8e4a1-0000-0000-0000-000000000000" },
                  customerEmail: { type: "string", example: "subscriber@customer.ng" },
                  paymentMethod: { type: "string", enum: ["CARD", "VIRTUAL_ACCOUNT"], example: "VIRTUAL_ACCOUNT" },
                  callbackUrl: { type: "string", example: "https://yourdeveloperapp.com/dashboard" },
                  customerBvn: { type: "string", example: "22222222222", description: "Required for Virtual Account generation (Compliant KYC verification anchor)." }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Returns checkoutLink if CARD, or bank account assignment payload if VIRTUAL_ACCOUNT." }
        }
      }
    },
    "Outbound Fan-out Payload Specification (For Downstream Developers)": {
      description: "This document section details the signed payloads dispatchDeveloperWebhook sends out to your registered developers' servers whenever a payment lifecycle mutation clears.",
      post: {
        tags: ["Outbound Developer Webhooks (Fan-out Engine)"],
        summary: "Downstream Event Ingestion Structure (Reference Spec)",
        security: [], // Incoming payloads to downstream developers do not consume internal bearer schemes
        parameters: [
          { in: "header", name: "X-Platform-Signature", required: true, schema: { type: "string" }, description: "HMAC-SHA256 signature calculated across the timestamp and body payload string using the workspace's webhookSecret." },
          { in: "header", name: "X-Platform-Timestamp", required: true, schema: { type: "string" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  event: { type: "string", enum: ["subscription.activated", "subscription.renewed", "subscription.failed"], example: "subscription.renewed" },
                  timestamp: { type: "integer", example: 1719922442000 },
                  data: {
                    type: "object",
                    properties: {
                      subscriptionId: { type: "string", format: "uuid" },
                      merchantId: { type: "string", format: "uuid" },
                      planId: { type: "string", format: "uuid" },
                      amountKobo: { type: "integer", example: 500000 },
                      currency: { type: "string", example: "NGN" },
                      transactionRef: { type: "string", example: "txn_01h3x84a..." },
                      paymentMethod: { type: "string", example: "VIRTUAL_ACCOUNT" }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Developer endpoint acknowledges receipt with HTTP 200 OK." }
        }
      }
    }
  }
};