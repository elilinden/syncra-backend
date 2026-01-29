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

// --- GLOBAL STORAGE ---
// We use a global array to store tokens in memory.
// Note: If the server restarts (Render free tier sleeps), this list is wiped.
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
      redirect_uri: process.env.PLAID_REDIRECT_URI, 
    });
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    console.error("Link Token Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// B. Exchange Token
app.post('/api/exchange_public_token', async (req, res) => {
  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: req.body.public_token,
    });
    
    const newToken = response.data.access_token;
    
    // Prevent duplicates
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

// C. Get Transactions (Merged)
app.get('/api/transactions', async (req, res) => {
  if (!global.ACCESS_TOKENS || global.ACCESS_TOKENS.length === 0) {
      return res.status(400).json({ error: "No active bank links found" });
  }
  
  const now = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(now.getDate() - 30);
  
  let mergedTransactions = [];
  
  try {
    const promises = global.ACCESS_TOKENS.map(async (token) => {
        const response = await plaidClient.transactionsGet({
            access_token: token,
            start_date: thirtyDaysAgo.toISOString().split('T')[0],
            end_date: now.toISOString().split('T')[0],
        });
        
        const accountsMap = {};
        response.data.accounts.forEach(acc => {
            accountsMap[acc.account_id] = acc;
        });

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

    const results = await Promise.all(promises);
    results.forEach(bankTransactions => {
        mergedTransactions = mergedTransactions.concat(bankTransactions);
    });
    
    res.json({ 
      transactions: mergedTransactions,
      lastSynced: new Date().toISOString() 
    });

  } catch (error) {
    console.error("Transaction Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// D. Get Accounts (Merged)
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
        res.json({ accounts: results.flat() });
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

// F. Unlink All (Wipe Everything)
app.post('/api/unlink', (req, res) => {
    global.ACCESS_TOKENS = [];
    console.log("All banks unlinked.");
    res.json({ success: true });
});

// G. NEW: List Connected Institutions (Names & IDs)
app.get('/api/institutions', async (req, res) => {
    if (!global.ACCESS_TOKENS || global.ACCESS_TOKENS.length === 0) {
        return res.json({ institutions: [] });
    }
    try {
        // Loop through tokens and fetch Item Metadata for each
        const promises = global.ACCESS_TOKENS.map(async (token, index) => {
            try {
                // 1. Get Item info to find Institution ID
                const itemResponse = await plaidClient.itemGet({ access_token: token });
                const instId = itemResponse.data.item.institution_id;
                
                // 2. Get readable Bank Name (e.g. "Chase")
                if (instId) {
                    const instResponse = await plaidClient.institutionsGetById({
                        institution_id: instId,
                        country_codes: ['US']
                    });
                    return { id: index, name: instResponse.data.institution.name };
                }
                return { id: index, name: "Unknown Bank" };
            } catch (err) {
                console.error("Error fetching institution name:", err.message);
                return { id: index, name: "Bank Connection Error" };
            }
        });
        
        const institutions = await Promise.all(promises);
        res.json({ institutions });
    } catch (error) {
        console.error("Institutions API Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

// H. NEW: Delete Specific Bank
app.post('/api/delete_institution', (req, res) => {
    const { index } = req.body;
    if (index !== undefined && index >= 0 && index < global.ACCESS_TOKENS.length) {
        // Remove the token at that index
        global.ACCESS_TOKENS.splice(index, 1);
        console.log(`Bank at index ${index} removed.`);
        res.json({ success: true });
    } else {
        res.status(400).json({ error: "Invalid index" });
    }
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Syncra Backend: Running on port ${PORT}`);
  console.log(`Syncra Backend: Plaid initialized in ${process.env.PLAID_ENV || 'sandbox'} mode.`);
});
