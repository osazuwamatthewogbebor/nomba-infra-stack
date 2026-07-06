export interface Env {
    BACK4APP_URL: string; // Made mandatory for production safety
    NOMBA_WEBHOOK_SECRET: string;
}

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

    // Standardized payload mapping
    const hashingPayload = [
        payloadObj.event_type || "",
        payloadObj.requestId || "",
        merchant.userId || "",
        merchant.walletId || "",
        transaction.transactionId || "",
        transaction.type || "",
        transaction.time || "",
        transaction.responseCode === null ? "" : transaction.responseCode || "",
        timestamp
    ].join(':');

    const encoder = new TextEncoder();
    const cryptoKey = await crypto.subtle.importKey(
        "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
    );

    const signedBuffer = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(hashingPayload));
    
    // Efficient Base64 conversion
    const base64Signature = btoa(String.fromCharCode(...new Uint8Array(signedBuffer)));
    
    return base64Signature.toLowerCase() === receivedSignature.toLowerCase();
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method !== "POST") {
            return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405 });
        }
        
        try {
            const rawBody = await request.text();
            const signature = request.headers.get("nomba-signature");
            const timestamp = request.headers.get("nomba-timestamp");

            const isAuthentic = await verifyNombaSignature(JSON.parse(rawBody), signature, env.NOMBA_WEBHOOK_SECRET, timestamp);

            if (!isAuthentic) {
                return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
            }

            // FORWARDING: Ensure we pass through the original headers + our own markers
            const backendResponse = await fetch(env.BACK4APP_URL, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Nomba-Signature": signature || "",
                    "X-Nomba-Timestamp": timestamp || "",
                    "X-Forwarded-For": request.headers.get("cf-connecting-ip") || ""
                },
                body: rawBody
            });

            // Return the backend's result back to Nomba
            return new Response(backendResponse.body, {
                status: backendResponse.status,
                headers: backendResponse.headers
            });

        } catch (error: any) {
            return new Response(JSON.stringify({ error: "Routing failed", details: error.message }), { status: 502 });
        }
    }
};