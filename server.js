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
  // Dynamically switches between 'sandbox' and 'production' based on Render settings
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET, // Your production secret from Render
    },
  },
});
const plaidClient = new PlaidApi(configuration);

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
    global.ACCESS_TOKEN = response.data.access_token;
    console.log("Access Token securely stored for session");
    res.json({ success: true });
  } catch (error) {
    console.error("Exchange Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// C. Get Transactions (Includes a timestamp for mobile caching)
app.get('/api/transactions', async (req, res) => {
  if (!global.ACCESS_TOKEN) return res.status(400).json({ error: "No active bank link found" });
  
  const now = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(now.getDate() - 30);
  
  try {
    const response = await plaidClient.transactionsGet({
      access_token: global.ACCESS_TOKEN,
      start_date: thirtyDaysAgo.toISOString().split('T')[0],
      end_date: now.toISOString().split('T')[0],
    });
    
    const accountsMap = {};
    response.data.accounts.forEach(acc => {
      accountsMap[acc.account_id] = acc;
    });
    
    const transactions = response.data.transactions.map(t => {
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
    
    // Returning the timestamp so mobile knows when this specific pull happened
    res.json({ 
      transactions, 
      lastSynced: new Date().toISOString() 
    });
  } catch (error) {
    console.error("Transaction Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// D. Get Accounts
app.get('/api/accounts', async (req, res) => {
  if (!global.ACCESS_TOKEN) return res.json({ accounts: [] });
  try {
    const response = await plaidClient.accountsGet({ access_token: global.ACCESS_TOKEN });
    const accounts = response.data.accounts.map(a => ({
      id: a.account_id,
      name: a.name,
      mask: a.mask,
      balance: a.balances.current,
      type: a.type
    }));
    res.json({ accounts });
  } catch (error) {
    console.error("Accounts Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// E. Health Check
app.get('/api/status', (req, res) => {
  res.json({ 
    status: "online", 
    environment: process.env.PLAID_ENV || 'sandbox' 
  });
});

const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`Syncra Backend: Running on port ${PORT}`);
  console.log(`Syncra Backend: Plaid initialized in ${process.env.PLAID_ENV || 'sandbox'} mode.`);
});
