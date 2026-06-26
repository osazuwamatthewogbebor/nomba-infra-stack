export interface Env {
    BACK4APP_URL?: string;
}

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        if (request.method !== "POST") {
            return new Response(JSON.stringify({error: "Method Not Allowed"}), {
                status: 405,
                headers: { "Content-Type": "applicaition/json" }
            });
        }
        
        const clonedRequest = request.clone();

        // Dynamically reads the URL from your Cloudflare environmental bindings
        const BACK4APP_TARGET_URL = env.BACK4APP_URL || "http://localhost:8080/webhook";

        ctx.waitUntil(
            fetch(BACK4APP_TARGET_URL, {
                method: "POST",
                headers: request.headers,
                body: clonedRequest.body,
                redirect: "follow"
            })
            .then(async (response) => {
                if (!response.ok) {
                    console.error(`Core Engine flagged error status: ${response.status}`)
                }
            })
            .catch((error) => {
                console.error("Core Engine network execution fialed:", error.message)
            })
        );

        return new Response(JSON.stringify({ accepted: true, status: "queued" }), {
            status: 200,
            headers: { "Content-Type": "application/json"}
        });
    }
}