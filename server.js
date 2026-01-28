require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');

const app = express();
app.use(cors());
app.use(bodyParser.json());

// 1. Setup Plaid Configuration
const configuration = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID,
      'PLAID-SECRET': process.env.PLAID_SECRET,
    },
  },
});
const plaidClient = new PlaidApi(configuration);

// --- API ENDPOINTS ---

// A. Create Link Token
app.get('/api/create_link_token', async (req, res) => {
  try {
    const response = await plaidClient.linkTokenCreate({
      user: { client_user_id: 'user_good' },
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
    console.log("Access Token Stored:", global.ACCESS_TOKEN);
    res.json({ success: true });
  } catch (error) {
    console.error("Exchange Error:", error.response ? error.response.data : error.message);
    res.status(500).json({ error: error.message });
  }
});

// C. Get Transactions (Updated to include Account Info)
app.get('/api/transactions', async (req, res) => {
  if (!global.ACCESS_TOKEN) return res.status(400).json({ error: "Not logged in" });
  
  const now = new Date();
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(now.getDate() - 30);
  
  try {
    const response = await plaidClient.transactionsGet({
      access_token: global.ACCESS_TOKEN,
      start_date: thirtyDaysAgo.toISOString().split('T')[0],
      end_date: now.toISOString().split('T')[0],
    });
    
    // 1. Create a lookup map of Accounts (ID -> Account Details)
    const accountsMap = {};
    response.data.accounts.forEach(acc => {
      accountsMap[acc.account_id] = acc;
    });
    
    // 2. Format transactions and attach account info
    const transactions = response.data.transactions.map(t => {
      const account = accountsMap[t.account_id];
      return {
        id: t.transaction_id,
        merchantName: t.merchant_name || t.name,
        amount: t.amount,
        date: t.date,
        category: t.category ? t.category[0] : "General",
        // NEW: Attach account name and mask
        accountName: account ? account.name : "Unknown",
        accountMask: account ? account.mask : "0000"
      };
    });
    
    res.json({ transactions });
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
    res.status(500).json({ error: error.message });
  }
});

app.listen(8000, () => {
  console.log('Syncra Backend running on port 8000');
});
