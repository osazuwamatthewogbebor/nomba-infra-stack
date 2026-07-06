const crypto = require('crypto');

// 1. Matches process.env.NOMBA_PARENT_WEBHOOK_SECRET
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'your_test_secret_key'; 
const TARGET_URL = 'http://localhost:5000/v1/webhooks/nomba';

const timestamp = Date.now().toString();
// Shortened to safely stay under VARCHAR(20) boundaries
const requestId = 'rq_' + crypto.randomBytes(4).toString('hex'); // 11 characters
const transactionId = 'TX_' + crypto.randomBytes(4).toString('hex').toUpperCase(); // 11 characters

// 2. Updated clean mock payload with shortened values
const payload = {
  event_type: 'payment_success',
  requestId: requestId, 
  data: {
    merchant: {
      userId: 'user_01J2',
      walletId: 'wall_9982'
    },
    transaction: {
      transactionId: transactionId, // Uses the short 11-char string variable
      type: 'card_payment', 
      time: '2026-07-06T14:16:21Z',
      responseCode: '00',
      transactionAmount: 65000.00, 
      currency: 'NGN'
    },
    order: {
      orderReference: '69f59851-ff1a-4796-a0e4-7c24a550b767', 
      customerId: 'c0a80101-9c0b-4ef8-bb6d-6bb9bd380a22',     
      orderMetaData: {
        merchantId: 'a1b57ef6-a614-4ccb-be23-385b9f421169',   
        internalPlanRef: 'dfb68448-d05a-481f-8a64-8fc42f3d5578'
      }
    },
    tokenizedCardData: {
      tokenKey: 'tok_b98s23hjs', // 13 characters
      cardType: 'MASTERCARD',
      cardPan: '539983XXXX4297'  // Shortened to 14 characters (no spaces) to clear VARCHAR(20) limits
    }
  }
};

// 3. Reconstruct signature payload matching our router's verification function:
const hashingString = [
  payload.event_type,
  payload.requestId,
  payload.data.merchant.userId,
  payload.data.merchant.walletId,
  payload.data.transaction.transactionId,
  payload.data.transaction.type,
  payload.data.transaction.time,
  payload.data.transaction.responseCode,
  timestamp
].join(':');

const signature = crypto
  .createHmac('sha256', WEBHOOK_SECRET)
  .update(hashingString)
  .digest('base64');

// 4. Dispatch to local server
async function runTest() {
  try {
    const response = await fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'nomba-signature': signature,
        'nomba-timestamp': timestamp
      },
      body: JSON.stringify(payload)
    });
    
    console.log(`HTTP Status: ${response.status}`);
    const textResponse = await response.text();
    
    try {
      const jsonData = JSON.parse(textResponse);
      console.log('Response Payload (JSON):', jsonData);
    } catch (e) {
      console.log('Server returned non-JSON raw text (likely HTML error):');
      console.log(textResponse.slice(0, 500));
    }

  } catch (error) {
    console.error('Network or Execution error:', error);
  }
}

runTest();