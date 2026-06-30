import { Pool, PoolClient } from 'pg';
import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { persistSession: false },
  global: { headers: { 'x-my-custom-header': 'nomba-infra' } },
  realtime: { transport: ws as any },
});

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Regular expression to strictly validate UUID format before injection
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Executes multi-tenant isolated database queries by binding the merchant session context
 * Optimized completely to support Supabase's Transaction Pooler protocol.
 */
export async function executeTenantQuery<T>(
  merchantId: string,
  operations: (client: PoolClient) => Promise<T>
): Promise<T> {
  // Guard clause against injection: Ensure the string is explicitly a valid UUIDv4
  if (!UUID_REGEX.test(merchantId)) {
    throw new Error(`Security Exception: Invalid Tenant Identifier Format (${merchantId})`);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    
    // Using explicit string interpolation. Transaction poolers accept this 100% of the time 
    // inside transaction boundaries (BEGIN ... COMMIT)
    await client.query(`SET LOCAL app.current_merchant_id = '${merchantId}'`);
    
    const result = await operations(client);
    
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export default pool;