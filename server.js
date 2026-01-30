/**
 * Syncra Backend (Express + Plaid + Postgres)
 * - Multi-user auth via Sign in with Apple (Option B)
 * - Issues Syncra JWT sessions
 * - Uses JWT user_id to scope Plaid tokens per user
 * - Keeps your existing Plaid + AASA + OAuth redirect page behavior
 * - Adds: /api/institutions + /api/delete_institution for your Settings “Connected Banks”
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Configuration, PlaidApi, PlaidEnvironments } = require("plaid");
const { Pool } = require("pg");

const jwt = require("jsonwebtoken");
const jwksClient = require("jwks-rsa");

const app = express();

/** ----------------------------
 *  Basic middleware
 *  ---------------------------- */
app.use(
  cors({
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(",") : "*",
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-user-id"],
  })
);

app.use(express.json({ limit: "1mb" }));

/** ----------------------------
 *  Helpers
 *  ---------------------------- */
function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

const isProd = process.env.NODE_ENV === "production";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || ""; // iOS bundle id
const SYNCRA_JWT_SECRET = process.env.SYNCRA_JWT_SECRET || "";

try {
  // You need these in prod AND realistically in dev too for Apple auth to work.
  // (We don't hard-crash in dev to keep local work easier.)
  if (isProd) {
    requireEnv("APPLE_CLIENT_ID");
    requireEnv("SYNCRA_JWT_SECRET");
    requireEnv("DATABASE_URL");
    requireEnv("PLAID_CLIENT_ID");
    requireEnv("PLAID_SECRET");
    requireEnv("PLAID_ENV");
    requireEnv("PLAID_REDIRECT_URI");
  }
} catch (e) {
  console.error("❌ ENV CONFIG ERROR:", e.message);
}

/** ----------------------------
 *  PostgreSQL
 *  ---------------------------- */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: isProd ? { rejectUnauthorized: false } : false,
});

// Create tables if missing
async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        email TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

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

    console.log("✅ Database tables are ready.");
  } catch (err) {
    console.error("❌ Database Init Error:", err.message);
  }
}
initDb();

/** ----------------------------
 *  Plaid client
 *  ---------------------------- */
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
const AASA_JSON = {
  applinks: {
    apps: [],
    details: [
      {
        // TeamID.BundleID
        appID: "FYGW4LHN42.com.elilindenDinematch.Syncra",
        paths: ["/plaid/*"],
      },
    ],
  },
};

app.get("/.well-known/apple-app-site-association", (req, res) => {
  res.set("Content-Type", "application/json");
  res.set("Cache-Control", "no-store");
  res.status(200).send(JSON.stringify(AASA_JSON, null, 2));
});

// also serve at root path (nice for some validators)
app.get("/apple-app-site-association", (req, res) => {
  res.set("Content-Type", "application/json");
  res.set("Cache-Control", "no-store");
  res.status(200).send(JSON.stringify(AASA_JSON, null, 2));
});

/** ----------------------------
 *  Plaid OAuth redirect landing page
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
  <body style="font-family:-apple-system,system-ui,Arial;padding:24px;">
    <h3>Returning to Syncra…</h3>
    <p>If you aren’t redirected automatically, close this page and return to the app.</p>
  </body>
</html>`);
});

/** ----------------------------
 *  Sign in with Apple verification (jwks-rsa)
 *  ---------------------------- */
const appleJwks = jwksClient({
  jwksUri: "https://appleid.apple.com/auth/keys",
  cache: true,
  cacheMaxEntries: 5,
  cacheMaxAge: 10 * 60 * 1000, // 10 minutes
  rateLimit: true,
  jwksRequestsPerMinute: 10,
});

function getAppleSigningKey(header, callback) {
  appleJwks.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    const pubKey = key.getPublicKey();
    callback(null, pubKey);
  });
}

function verifyAppleIdentityToken(identityToken) {
  if (!APPLE_CLIENT_ID) {
    throw new Error("Missing APPLE_CLIENT_ID");
  }

  return new Promise((resolve, reject) => {
    jwt.verify(
      identityToken,
      getAppleSigningKey,
      {
        algorithms: ["RS256"],
        issuer: APPLE_ISSUER,
        audience: APPLE_CLIENT_ID,
      },
      (err, decoded) => {
        if (err) return reject(err);
        resolve(decoded);
      }
    );
  });
}

function signSyncraSession(userId) {
  if (!SYNCRA_JWT_SECRET) throw new Error("Missing SYNCRA_JWT_SECRET");
  // 180 days is nice for small friend beta
  return jwt.sign({ sub: userId }, SYNCRA_JWT_SECRET, { expiresIn: "180d" });
}

function getUserIdFromAuth(req) {
  const auth = req.header("Authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  try {
    const payload = jwt.verify(m[1], SYNCRA_JWT_SECRET);
    return payload?.sub || null;
  } catch {
    return null;
  }
}

/**
 * Auth gate for /api routes
 * - In prod: requires Bearer token
 * - In dev: allows x-user-id fallback (or default) to keep you moving fast locally
 */
function requireUser(req, res, next) {
  const userId = getUserIdFromAuth(req);

  if (userId) {
    req.userId = userId;
    return next();
  }

  // dev fallback
  if (!isProd) {
    const headerUser = (req.header("x-user-id") || "").trim();
    req.userId = headerUser || "syncra_user_001";
    return next();
  }

  return res.status(401).json({ error: "Unauthorized" });
}

/** ----------------------------
 *  AUTH ROUTE: Exchange Apple identity token -> Syncra session token
 *  ---------------------------- */
app.post("/api/auth/apple", async (req, res) => {
  try {
    const { identity_token } = req.body || {};
    if (!identity_token) return res.status(400).json({ error: "Missing identity_token" });

    const payload = await verifyAppleIdentityToken(identity_token);

    const userId = payload.sub; // stable per user for your developer team
    const email = payload.email || null;

    // upsert user record
    await pool.query(
      `
      INSERT INTO users (user_id, email)
      VALUES ($1, $2)
      ON CONFLICT (user_id) DO UPDATE
      SET email = COALESCE(EXCLUDED.email, users.email)
      `,
      [userId, email]
    );

    const token = signSyncraSession(userId);

    res.json({
      success: true,
      userId,
      token,
      email,
    });
  } catch (error) {
    console.error("Apple Auth Error:", error.message);
    res.status(401).json({ error: "Apple auth failed", details: error.message });
  }
});

/** ----------------------------
 *  Plaid helpers
 *  ---------------------------- */
async function fetchAllTransactionsForToken(accessToken, startDate, endDate) {
  const pageSize = 100;
  let offset = 0;
  let allTransactions = [];
  const accountsMap = {};

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

  return allTransactions.map((t) => {
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
}

/** ----------------------------
 *  Routes
 *  ---------------------------- */

// Quick root ping
app.get("/", (req, res) => {
  res.json({ ok: true, service: "syncra-backend" });
});

// Protect all /api/* EXCEPT /api/auth/apple
app.use("/api", (req, res, next) => {
  if (req.path === "/auth/apple") return next();
  return requireUser(req, res, next);
});

// A. Create Link Token
app.get("/api/create_link_token", async (req, res) => {
  try {
    const userId = req.userId;

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
    const userId = req.userId;
    const { public_token } = req.body || {};

    if (!public_token) return res.status(400).json({ error: "Missing public_token" });

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
    const userId = req.userId;

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
    const userId = req.userId;

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

// E. Health Check (scoped to the current user)
app.get("/api/status", async (req, res) => {
  try {
    const userId = req.userId;
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
    const userId = req.userId;
    await pool.query("DELETE FROM bank_tokens WHERE user_id = $1", [userId]);
    console.log(`✅ All banks unlinked for user=${userId}.`);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to unlink banks", details: err.message });
  }
});

/** ----------------------------
 *  NEW: Connected Banks list + delete
 *  These power your iOS:
 *   - GET /api/institutions
 *   - POST /api/delete_institution { index: Int }
 *  ---------------------------- */

// G. List connected banks for the current user
app.get("/api/institutions", async (req, res) => {
  try {
    const userId = req.userId;

    const result = await pool.query(
      "SELECT id, access_token FROM bank_tokens WHERE user_id = $1 ORDER BY created_at DESC",
      [userId]
    );

    if (result.rows.length === 0) return res.json({ institutions: [] });

    const institutions = await Promise.all(
      result.rows.map(async (row) => {
        try {
          const itemResp = await plaidClient.itemGet({ access_token: row.access_token });
          const instId = itemResp.data.item.institution_id;

          let name = "Connected Bank";
          if (instId) {
            const instResp = await plaidClient.institutionsGetById({
              institution_id: instId,
              country_codes: ["US"],
            });
            name = instResp.data.institution?.name || name;
          }

          return { id: row.id, name };
        } catch {
          return { id: row.id, name: "Connected Bank" };
        }
      })
    );

    res.json({ institutions });
  } catch (error) {
    const details = error?.response?.data || error.message;
    console.error("Institutions Error:", details);
    res.status(500).json({ error: "Failed to load institutions", details });
  }
});

// H. Delete one connected bank by DB row id
app.post("/api/delete_institution", async (req, res) => {
  try {
    const userId = req.userId;
    const { index } = req.body || {};
    if (typeof index !== "number") return res.status(400).json({ error: "Missing index" });

    const del = await pool.query(
      "DELETE FROM bank_tokens WHERE user_id = $1 AND id = $2 RETURNING id",
      [userId, index]
    );

    if (del.rowCount === 0) return res.status(404).json({ error: "Not found" });

    res.json({ success: true });
  } catch (error) {
    const details = error?.response?.data || error.message;
    console.error("Delete Institution Error:", details);
    res.status(500).json({ error: "Failed to delete institution", details });
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
