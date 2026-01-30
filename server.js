/**
 * Syncra Backend (Express + Plaid + Postgres)
 * - Safer Postgres SSL handling (prod vs local)
 * - Uses express.json instead of body-parser
 * - Supports multiple end-users via x-user-id header (defaults to syncra_user_001)
 * - Paginates Plaid transactions so you don’t silently miss results
 * - Uses newer Plaid personal_finance_category when available
 * - Sorts merged transactions by date desc
 * - Adds Plaid OAuth redirect page + AASA config for Universal Links
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { Pool } = require("pg");

const app = express();

/** ----------------------------
 *  Basic middleware
 *  ---------------------------- */
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-user-id"],
  })
);

app.use(express.json({ limit: "1mb" }));

/** ----------------------------
 *  Helpers
 *  ---------------------------- */
function getUserId(req) {
  return (req.header("x-user-id") || "syncra_user_001").trim();
}

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

/** ----------------------------
 *  PostgreSQL
 *  ---------------------------- */
const isProd = process.env.NODE_ENV === "production";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
});

// Create table if missing
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS bank_tokens (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        access_token TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (access_token)
      );
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_bank_tokens_user_id ON bank_tokens(user_id);`
    );
    console.log("✅ Database table 'bank_tokens' is ready.");
  } catch (err) {
    console.error("❌ Database Init Error:", err.message);
  }
}
initDb();

/** ----------------------------
 *  Plaid client
 *  ---------------------------- */
try {
  requireEnv("PLAID_CLIENT_ID");
  requireEnv("PLAID_SECRET");
  requireEnv("PLAID_ENV");
  requireEnv("PLAID_REDIRECT_URI");
} catch (e) {
  console.error("❌ ENV CONFIG ERROR:", e.message);
}

const plaidEnv = (process.env.PLAID_ENV || "sandbox").toLowerCase();
const basePath = PlaidEnvironments[plaidEnv] || PlaidEnvironments.sandbox;

const configuration = new Configuration({
  basePath,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
      ...(process.env.PLAID_VERSION ? { "Plaid-Version": process.env.PLAID_VERSION } : {}),
    },
  },
});

const plaidClient = new PlaidApi(configuration);

/** ----------------------------
 *  Apple Universal Links (AASA)
 *  IMPORTANT: Your iOS app must include:
 *  Associated Domains: applinks:syncra-backend-2ox9.onrender.com
 *  ---------------------------- */
app.get("/.well-known/apple-app-site-association", (req, res) => {
  res.set("Content-Type", "application/json");
  res.status(200).send(
    JSON.stringify(
      {
        applinks: {
          apps: [],
          details: [
            {
              appID: "FYGW4LHN42.com.elilindenDinematch.Syncra",
              paths: ["/plaid/*"],
            },
          ],
        },
      },
      null,
      2
    )
  );
});

/** ----------------------------
 *  Plaid OAuth redirect landing page
 *  Your PLAID_REDIRECT_URI should be:
 *  https://syncra-backend-2ox9.onrender.com/plaid/oauth.html
 *  ---------------------------- */
app.get("/plaid/oauth.html", (req, res) => {
  res.set("Content-Type", "text/html; charset=utf-8");
  res.status(200).send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>Syncra</title>
  </head>
  <body style="font-family: -apple-system, system-ui, Arial; padding: 24px;">
    <h3>Returning to Syncra…</h3>
    <p>If you aren’t redirected automatically, close this page and return to the app.</p>
  </body>
</html>`);
});

/** ----------------------------
 *  Plaid helpers
 *  ---------------------------- */
async function fetchAllTransactionsForToken(accessToken, startDate, endDate) {
  const pageSize = 100;
  let offset = 0;
  let allTransactions = [];
  let accountsMap = {};

  while (true) {
    const resp = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: pageSize, offset },
    });

    for (const acc of resp.data.accounts || []) {
      accountsMap[acc.account_id] = acc;
    }

    allTransactions = allTransactions.concat(resp.data.transactions || []);

    const total = resp.data.total_transactions || allTransactions.length;
    if (allTransactions.length >= total) break;

    offset += pageSize;
  }

  const enriched = allTransactions.map((t) => {
    const account = accountsMap[t.account_id];

    const category =
      t.personal_finance_category?.primary ||
      (Array.isArray(t.category) && t.category.length ? t.category[0] : null) ||
      "General";

    return {
      id: t.transaction_id,
      merchantName: t.merchant_name || t.name,
      amount: t.amount,
      date: t.date,
      pending: !!t.pending,
      category,
      accountName: account ? account.official_name || account.name : "Unknown",
      accountMask: account ? account.mask || "0000" : "0000",
      accountType: account ? account.type : undefined,
    };
  });

  return enriched;
}

/** ----------------------------
 *  Routes
 *  ---------------------------- */

// Quick root ping
app.get("/", (req, res) => {
  res.json({ ok: true, service: "syncra-backend" });
});

// A. Create Link Token
app.get("/api/create_link_token", async (req, res) => {
  try {
    const userId = getUserId(req);

    const createArgs = {
      user: { client_user_id: userId },
      client_name: "Syncra",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
      redirect_uri: process.env.PLAID_REDIRECT_URI,
    };

    const response = await plaidClient.linkTokenCreate(createArgs);
    res.json({ link_token: response.data.link_token });
  } catch (error) {
    const details = error?.response?.data || error.message;
    console.error("Link Token Error:", details);
    res.status(500).json({ error: "Failed to create link token", details });
  }
});

// B. Exchange public_token -> access_token (SAVES to Database)
app.post("/api/exchange_public_token", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { public_token } = req.body || {};

    if (!public_token) {
      return res.status(400).json({ error: "Missing public_token" });
    }

    const response = await plaidClient.itemPublicTokenExchange({ public_token });
    const newToken = response.data.access_token;

    await pool.query(
      `INSERT INTO bank_tokens (user_id, access_token)
       VALUES ($1, $2)
       ON CONFLICT (access_token) DO NOTHING`,
      [userId, newToken]
    );

    console.log(`✅ New bank linked for user=${userId} and saved to DB.`);
    res.json({ success: true });
  } catch (error) {
    const details = error?.response?.data || error.message;
    console.error("Exchange Error:", details);
    res.status(500).json({ error: "Failed to exchange public token", details });
  }
});

// C. Get Transactions
app.get("/api/transactions", async (req, res) => {
  try {
    const userId = getUserId(req);

    const result = await pool.query(
      "SELECT access_token FROM bank_tokens WHERE user_id = $1",
      [userId]
    );
    const tokens = result.rows.map((row) => row.access_token);

    if (tokens.length === 0) {
      return res.json({ transactions: [], message: "No active bank links found" });
    }

    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const startDate = thirtyDaysAgo.toISOString().split("T")[0];
    const endDate = now.toISOString().split("T")[0];

    const perTokenResults = await Promise.all(
      tokens.map(async (token) => {
        try {
          return await fetchAllTransactionsForToken(token, startDate, endDate);
        } catch (err) {
          const details = err?.response?.data || err.message;
          console.error("Error fetching transactions for a token:", details);
          return [];
        }
      })
    );

    let merged = perTokenResults.flat();

    merged.sort((a, b) => {
      if (a.date === b.date) return (b.amount || 0) - (a.amount || 0);
      return a.date < b.date ? 1 : -1;
    });

    res.json({
      transactions: merged,
      lastSynced: new Date().toISOString(),
    });
  } catch (error) {
    const details = error?.response?.data || error.message;
    console.error("Transaction Error:", details);
    res.status(500).json({ error: "Failed to fetch transactions", details });
  }
});

// D. Get Accounts
app.get("/api/accounts", async (req, res) => {
  try {
    const userId = getUserId(req);

    const result = await pool.query(
      "SELECT access_token FROM bank_tokens WHERE user_id = $1",
      [userId]
    );
    const tokens = result.rows.map((row) => row.access_token);

    if (tokens.length === 0) return res.json({ accounts: [] });

    const perTokenAccounts = await Promise.all(
      tokens.map(async (token) => {
        try {
          const response = await plaidClient.accountsGet({ access_token: token });
          return (response.data.accounts || []).map((a) => ({
            id: a.account_id,
            name: a.official_name || a.name,
            mask: a.mask,
            balance: a.balances?.current,
            available: a.balances?.available,
            type: a.type,
            subtype: a.subtype,
          }));
        } catch (err) {
          const details = err?.response?.data || err.message;
          console.error("Accounts fetch error for a token:", details);
          return [];
        }
      })
    );

    res.json({ accounts: perTokenAccounts.flat() });
  } catch (error) {
    const details = error?.response?.data || error.message;
    console.error("Accounts Error:", details);
    res.status(500).json({ error: "Failed to fetch accounts", details });
  }
});

// E. Health Check
app.get("/api/status", async (req, res) => {
  try {
    const userId = getUserId(req);
    const result = await pool.query(
      "SELECT COUNT(*) FROM bank_tokens WHERE user_id = $1",
      [userId]
    );

    res.json({
      status: "online",
      database: "connected",
      user_id: userId,
      banks_connected: parseInt(result.rows[0].count, 10),
    });
  } catch (err) {
    res.status(500).json({ status: "degraded", error: err.message });
  }
});

// F. Unlink All
app.post("/api/unlink", async (req, res) => {
  try {
    const userId = getUserId(req);
    await pool.query("DELETE FROM bank_tokens WHERE user_id = $1", [userId]);
    console.log(`✅ All banks unlinked for user=${userId}.`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to unlink banks", details: err.message });
  }
});

/** ----------------------------
 *  Shutdown safety
 *  ---------------------------- */
process.on("SIGTERM", async () => {
  try {
    await pool.end();
  } finally {
    process.exit(0);
  }
});

/** ----------------------------
 *  Start server
 *  ---------------------------- */
const PORT = process.env.PORT || 8000;
app.listen(PORT, () => {
  console.log(`🚀 Syncra Backend running on port ${PORT} (env=${plaidEnv}, prod=${isProd})`);
});
