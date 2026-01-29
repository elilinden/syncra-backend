require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 1. Setup Dynamic Plaid Configuration
const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(configuration);

// --- GLOBAL STORAGE (Multi-Bank Support) ---
// We now store an ARRAY of tokens to support connecting multiple banks at once.
if (!global.ACCESS_TOKENS) {
  global.ACCESS_TOKENS = [];
}

// --- API ENDPOINTS ---

// A. Create Link Token
app.get('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'syncra_user_001' },
      client_name: 'Syncra',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
      // Ensure this matches your Render Environment Variables exactly
      redirect_uri: process.env.PLAID_REDIRECT_URI, 
    });
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error("Link Token Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// B. Exchange Token (Adds to the list instead of overwriting)
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: req.body.public_token,
    });
    
    const newToken = response.data.access_token;
    
    // Prevent duplicates: Only add if we don't have it already
    if (!global.ACCESS_TOKENS.includes(newToken)) {
      global.ACCESS_TOKENS.push(newToken);
      console.log(`New Bank Linked. Total connected banks: ${global.ACCESS_TOKENS.length}`);
    } else {
        console.log("Bank already linked.");
    }

    res.json({ success: true });
  } catch (error) {
    console.error("Exchange Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// C. Get Transactions (Loops through ALL banks and merges data)
app.get('/api/transactions', async (req, res) => {
  // 1. Check if we have ANY banks linked
  if (!global.ACCESS_TOKENS || global.ACCESS_TOKENS.length === 0) {
      return res.status(400).json({ error: "No active bank links found" });
  }
  
  const now = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(now.getDate() - 30);
  
  let mergedTransactions = [];
  
  try {
    // 2. Loop through every token (Promise.all for speed)
    const promises = global.ACCESS_TOKENS.map(async (token) => {
        const response = await plaidClient.transactionsGet({
            access_token: token,
            start_date: thirtyDaysAgo.toISOString().split('T')[0],
            end_date: now.toISOString().split('T')[0],
        });
        
        // Map accounts for THIS specific bank
        const accountsMap = {};
        response.data.accounts.forEach(acc => {
            accountsMap[acc.account_id] = acc;
        });

        // Format Transactions
        return response.data.transactions.map(t => {
            const account = accountsMap[t.account_id];
            return {
                id: t.transaction_id,
                merchantName: t.merchant_name || t.name,
                amount: t.amount,
                date: t.date,
                category: t.category ? t.category[0] : "General",
                accountName: account ? account.name : "Unknown",
                accountMask: account ? account.mask : "0000"
            };
        });
    });

    // 3. Wait for all banks to reply
    const results = await Promise.all(promises);

    // 4. Merge results into one big list
    results.forEach(bankTransactions => {
        mergedTransactions = mergedTransactions.concat(bankTransactions);
    });
    
    // 5. Send the combined list
    res.json({ 
      transactions: mergedTransactions,
      lastSynced: new Date().toISOString() 
    });

  } catch (error) {
    console.error("Transaction Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// D. Get Accounts (Merged from all banks)
app.get('/api/accounts', async (req, res) => {
    if (!global.ACCESS_TOKENS || global.ACCESS_TOKENS.length === 0) {
        return res.json({ accounts: [] });
    }

    try {
        const promises = global.ACCESS_TOKENS.map(async (token) => {
            const response = await plaidClient.accountsGet({ access_token: token });
            return response.data.accounts.map(a => ({
                id: a.account_id,
                name: a.name,
                mask: a.mask,
                balance: a.balances.current,
                type: a.type
            }));
        });

        const results = await Promise.all(promises);
        const allAccounts = results.flat(); // Flattens array of arrays

        res.json({ accounts: allAccounts });
    } catch (error) {
        console.error("Accounts Error:", error.response ? error.response.data : error.message);
        res.status(500).json({ error: error.message });
    }
});

// E. Health Check
app.get('/api/status', (req, res) => {
  res.json({ 
    status: "online", 
    environment: process.env.PLAID_ENV || 'sandbox',
    banks_connected: global.ACCESS_TOKENS ? global.ACCESS_TOKENS.length : 0
  });
});

// F. Unlink (Clears ALL banks)
app.post('/api/unlink', (req, res) => {
    global.ACCESS_TOKENS = [];
    console.log("All banks unlinked.");
    res.json({ success: true });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Syncra Backend: Running on port ${PORT}`);
  console.log(`Syncra Backend: Plaid initialized in ${process.env.PLAID_ENV || 'sandbox'} mode.`);
});
