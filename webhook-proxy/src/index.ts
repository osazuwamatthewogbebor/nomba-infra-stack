export interface Env {
    BACK4APP_URL?: string;
    NOMBA_WEBHOOK_SECRET: string;
}

/**
 * Reconstructs Nomba's custom signature format and signs it using Web Crypto (SubtleCrypto)
 */
async function verifyNombaSignature(
    payloadObj: any, 
    receivedSignature: string | null, 
    secret: string, 
    timestamp: string | null
): Promise<boolean> {
    if (!receivedSignature || !timestamp) return false;

    const data = payloadObj.data || {};
    const merchant = data.merchant || {};
    const transaction = data.transaction || {};

    const eventType = payloadObj.event_type || "";
    const requestId = payloadObj.requestId || "";
    const userId = merchant.userId || "";
    const walletId = merchant.walletId || "";
    const transactionId = transaction.transactionId || "";
    const transactionType = transaction.type || "";
    const transactionTime = transaction.time || "";
    
    let transactionResponseCode = transaction.responseCode || "";
    if (transactionResponseCode === "null") {
        transactionResponseCode = "";
    }

    // 1. Construct the exact colon-delimited string specified by Nomba
    const hashingPayload = `${eventType}:${requestId}:${userId}:${walletId}:${transactionId}:${transactionType}:${transactionTime}:${transactionResponseCode}:${timestamp}`;

    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);

    // 2. Import the secret key into Web Crypto
    const cryptoKey = await crypto.subtle.importKey(
        "raw",
        keyData,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
    );

    // 3. Compute the HMAC-SHA256 signature
    const signedBuffer = await crypto.subtle.sign(
        "HMAC",
        cryptoKey,
        encoder.encode(hashingPayload)
    );

    // 4. Convert the buffer to a Base64 string (Nomba uses Base64, not Hex)
    const uint8Array = new Uint8Array(signedBuffer);
    const binaryString = String.fromCharCode(...uint8Array);
    const calculatedSignature = btoa(binaryString);
    
    // 5. Securely compare signatures (case-insensitive fallback matching Nomba specs)
    return calculatedSignature.toLowerCase() === receivedSignature.toLowerCase();
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // Only accept POST requests from Nomba
        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
                status: 405,
                headers: { "Content-Type": "application/json" }
            });
        }
        
        try {
            // 1. Capture the raw text body and essential Nomba authentication headers
            const rawBody = await request.text();
            const incomingSignature = request.headers.get("nomba-signature");
            const incomingTimestamp = request.headers.get("nomba-timestamp");

            // 2. Parse the body safely to extract fields for custom delimiter mapping
            const payloadObj = JSON.parse(rawBody);

            // 3. Run the Nomba-compliant HMAC Base64 validation check
            const isAuthentic = await verifyNombaSignature(
                payloadObj, 
                incomingSignature, 
                env.NOMBA_WEBHOOK_SECRET, 
                incomingTimestamp
            );

            if (!isAuthentic) {
                return new Response(JSON.stringify({ error: "Unauthorized: Signature validation failed" }), { 
                    status: 401, 
                    headers: { "Content-Type": "application/json" } 
                });
            }

            // 4. Signature is valid! Forward the payload directly to your Back4app backend / core engine
            const backendResponse = await fetch(env.BACK4APP_URL || "http://localhost:8080/webhook", {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Nomba-Signature": incomingSignature || "",
                    "X-Nomba-Timestamp": incomingTimestamp || ""
                },
                body: rawBody // Forwarding the exact raw body intact
            });

            return backendResponse;

        } catch (error: any) {
            return new Response(JSON.stringify({ error: "Failed to process or route webhook event stream", details: error.message }), {
                status: error instanceof SyntaxError ? 400 : 502, // 400 if JSON parsing failed
                headers: { "Content-Type": "application/json" }
            });
        }
    }
};