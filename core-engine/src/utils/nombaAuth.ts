import axios from 'axios';
import logger from './logger';

interface NombaTokenCache {
    accessToken: string | null;
    refreshtoken: string | null;
    expiresAt: number | null;
}

// In-memory token vault to store credentials securely during the process lifespan
const tokenVault: NombaTokenCache = {
    accessToken: null,
    refreshtoken: null,
    expiresAt: null,
};

// Mint a completely fresh access token and refresh token from Nomba API
async function issueNewTokenPair(): Promise<string> {
    try {
        const clientId = process.env.LIVE_CLIENT_ID || process.env.NOMBA_CLIENT_ID;
        const clientSecret = process.env.LIVE_PRIVATE_KEY || process.env.NOMBA_CLIENT_SECRET;

        if (!clientId || !clientSecret) {
            throw new Error('Missing primary gateway authorization keys inside configurations.');
        }

        const response = await axios.post(
            `${process.env.NOMBA_API_URL}/v1/auth/token/issue`,
            {
                grant_type: 'client_credentials',
                client_id: clientId,
                client_secret: clientSecret,
            },{
                headers: {
                    'Content-Type': 'application/json',
                    'accountId': process.env.NOMBA_PARENT_ACCOUNT_ID,
                },
            }
        );

        if (response.data?.code === '00' ) {
            const { access_token, refresh_token, expiresAt } = response.data.data;

            tokenVault.accessToken = access_token;
            tokenVault.refreshtoken = refresh_token;
            // Always normalize timestamps to Unix epoch milliseconds
            tokenVault.expiresAt = new Date(expiresAt).getTime();

            logger.info('Successfully minted fresh primary Nomba Token Pair via Client Credentials');
            return tokenVault.accessToken as string;
        }
        throw new Error(response.data?.description || 'Unknown authorisation rejection');
    } catch (error: any) {
        logger.error('Critical Nomba Token Issue Exception:', error.response?.data || error.message);
        throw new Error('Failed to authorise with Nomba gateway root parameters.');
    }
}

/**
 * Resolves current active access token, executing sliding-window rotation if needed
 */
export async function getNombaAccessToken(): Promise<string> {
    const currentTime = Date.now();

    // 1. Get token on startup or if token data points are missing
    if (!tokenVault.accessToken || !tokenVault.refreshtoken || !tokenVault.expiresAt) {
        return await issueNewTokenPair();
    }

    // 2. Refresh token within 5 minutes of token expiration boundary window
    const fiveMinutesInMs = 5 * 60 * 1000;
    if (currentTime >= (tokenVault.expiresAt - fiveMinutesInMs)) {
        logger.info('Token entry approaching expiration boundary. Executing gateway refresh token rotation...');

        try {
            const response = await axios.post(
                `${process.env.NOMBA_API_URL}/v1/auth/token/refresh`,
                {
                    grant_type: 'refresh_token',
                    refresh_token: tokenVault.refreshtoken,
                },
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${tokenVault.accessToken}`,
                        'accountId': process.env.NOMBA_PARENT_ACCOUNT_ID,
                    }
                }
            );

            if (response.data?.code === '00') {
                const { access_token, refresh_token, expiresAt } = response.data.data;

                tokenVault.accessToken = access_token;
                tokenVault.refreshtoken = refresh_token;
                // Enforce millisecond timestamp normalization on refresh updates too!
                tokenVault.expiresAt = new Date(expiresAt).getTime();

                logger.info(`Successfully rotated Nomba keys using sliding-window OAuth rotation`);
                return tokenVault.accessToken as string;
            }

            logger.warn('Refresh token rejected by gateway proxy. Falling back to primary credentials...');
            return await issueNewTokenPair();

        } catch (error: any) {
            logger.error('Token refresh execution failed. Attempting primary credential recovery...', error.message);
            return await issueNewTokenPair();
        }
    } 
    
    // 3. Token is fresh and fully valid, serve from memory cache vault
    return tokenVault.accessToken as string;
}