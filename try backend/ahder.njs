const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const { rateLimit } = require("express-rate-limit");
const { PGlite } = require("@electric-sql/pglite");
const { fileTypeFromFile } = require("file-type");
const { importPKCS8, createRemoteJWKSet, jwtVerify, SignJWT } = require("jose");

const uploadsDir = path.resolve(__dirname, process.env.UPLOADS_PATH || "./uploads");
const webDir = path.resolve(__dirname, "..", "try");
const sessionCookieName = "ahder_session";
const sessionLifetimeMs = 14 * 24 * 60 * 60 * 1000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const allowedMedia = new Map([
  ["image/jpeg", "image"],
  ["image/png", "image"],
  ["image/webp", "image"],
  ["image/gif", "image"],
  ["video/mp4", "video"],
  ["video/webm", "video"],
  ["video/quicktime", "video"]
]);

function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function publicUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    university: row.university,
    major: row.major,
    bio: row.bio,
    avatar: row.avatar_url || "",
    banner: row.banner_url || "",
    isPro: row.pro_status === "pro" && (!row.pro_expires_at || new Date(row.pro_expires_at).getTime() > Date.now())
  };
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function configForOAuth(provider) {
  if (provider === "google") {
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return null;
    return {
      clientId: GOOGLE_CLIENT_ID,
      clientSecret: GOOGLE_CLIENT_SECRET,
      callbackUrl: process.env.GOOGLE_CALLBACK_URL || "http://localhost:3000/auth/google/callback",
      authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenEndpoint: "https://oauth2.googleapis.com/token",
      issuer: "https://accounts.google.com",
      jwksUrl: "https://www.googleapis.com/oauth2/v3/certs",
      scopes: ["openid", "email", "profile"],
      callbackMethod: "GET"
    };
  }
  if (provider === "apple") {
    const { APPLE_CLIENT_ID, APPLE_TEAM_ID, APPLE_KEY_ID, APPLE_PRIVATE_KEY } = process.env;
    if (!APPLE_CLIENT_ID || !APPLE_TEAM_ID || !APPLE_KEY_ID || !APPLE_PRIVATE_KEY || !process.env.APPLE_CALLBACK_URL) return null;
    let callbackUrl;
    try {
      callbackUrl = new URL(process.env.APPLE_CALLBACK_URL);
    } catch {
      return null;
    }
    if (callbackUrl.protocol !== "https:") return null;
    return {
      clientId: APPLE_CLIENT_ID,
      teamId: APPLE_TEAM_ID,
      keyId: APPLE_KEY_ID,
      privateKey: APPLE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      callbackUrl: process.env.APPLE_CALLBACK_URL,
      authorizationEndpoint: "https://appleid.apple.com/auth/authorize",
      tokenEndpoint: "https://appleid.apple.com/auth/token",
      issuer: "https://appleid.apple.com",
      jwksUrl: "https://appleid.apple.com/auth/keys",
      scopes: ["name", "email"],
      callbackMethod: "POST"
    };
  }
  return null;
}

function providersStatus() {
  return { google: Boolean(configForOAuth("google")), apple: Boolean(configForOAuth("apple")) };
}

async function createDatabase() {
  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    const { Pool } = require("pg");
    return new Pool({
      connectionString: databaseUrl,
      ssl: process.env.PGSSLMODE === "require" || databaseUrl.includes("sslmode=require")
        ? { rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false" }
        : undefined,
      max: Number(process.env.PG_POOL_SIZE || 10)
    });
  }
  const databasePath = path.resolve(__dirname, process.env.DATABASE_PATH || "./data");
  await fs.mkdir(databasePath, { recursive: true });
  return new PGlite(databasePath);
}

async function initializeDatabase(db) {
  const schema = await fs.readFile(path.join(__dirname, "schema.sql"), "utf8");
  if (typeof db.exec === "function") {
    await db.exec(schema);
    return;
  }
  if (typeof db.query === "function") {
    await db.query(schema);
    return;
  }
  throw new Error("Database client does not support schema initialization.");
}

function makeApp({ db, uploadsDirectory = uploadsDir, webRoot = webDir, production = process.env.NODE_ENV === "production" }) {
  const app = express();
  const jsonParser = express.json({ limit: "1mb" });
  const urlEncodedParser = express.urlencoded({ extended: false, limit: "32kb" });
  const mediaUpload = multer({
    dest: uploadsDirectory,
    limits: { fileSize: 50 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => {
      if (!file.mimetype.startsWith("image/") && !file.mimetype.startsWith("video/")) {
        callback(new Error("Choose an image or video file."));
        return;
      }
      callback(null, true);
    }
  });
  const avatarUpload = multer({
    dest: uploadsDirectory,
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, callback) => {
      if (!file.mimetype.startsWith("image/")) {
        callback(new Error("Choose an image file."));
        return;
      }
      callback(null, true);
    }
  });

  app.disable("x-powered-by");
  if (production) app.set("trust proxy", 1);
  app.use(helmet({
    crossOriginResourcePolicy: { policy: "same-site" },
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
        imgSrc: ["'self'", "data:", "blob:", "https://images.unsplash.com"],
        mediaSrc: ["'self'", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'", "https://appleid.apple.com"],
        frameAncestors: ["'none'"]
      }
    }
  }));
  app.use((req, res, next) => {
    if (["POST", "PATCH", "DELETE"].includes(req.method) && req.path !== "/auth/apple/callback") {
      const origin = req.get("origin");
      if (origin && origin !== `${req.protocol}://${req.get("host")}`) {
        res.status(403).json({ error: "Cross-origin request rejected." });
        return;
      }
    }
    next();
  });
  app.use("/api", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }));
  app.use("/api/auth", rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 30,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }));
  app.use(express.static(webRoot, {
    index: "ahder.html",
    dotfiles: "deny",
    setHeaders(res, filePath) {
      if (filePath.endsWith(".html")) res.setHeader("Cache-Control", "no-store");
    }
  }));
  app.use("/uploads", express.static(uploadsDirectory, {
    dotfiles: "deny",
    maxAge: production ? "1d" : 0,
    immutable: production
  }));

  const requireUser = asyncRoute(async (req, res, next) => {
    const cookies = Object.fromEntries(
      (req.headers.cookie || "").split(";").filter(Boolean).map((item) => {
        const index = item.indexOf("=");
        return [item.slice(0, index).trim(), decodeURIComponent(item.slice(index + 1).trim())];
      })
    );
    const token = cookies[sessionCookieName];
    if (!token) {
      res.status(401).json({ error: "Sign in to continue." });
      return;
    }
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.university, u.major, u.bio, u.avatar_url, u.banner_url, u.pro_status, u.pro_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashToken(token)]
    );
    if (!result.rows.length) {
      res.clearCookie(sessionCookieName, { httpOnly: true, sameSite: "lax", secure: production, path: "/" });
      res.status(401).json({ error: "Your session has expired. Please sign in again." });
      return;
    }
    req.user = publicUser(result.rows[0]);
    next();
  });

  async function setSession(res, userId) {
    const token = randomToken();
    const expiresAt = new Date(Date.now() + sessionLifetimeMs);
    await db.query(
      "INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)",
      [hashToken(token), userId, expiresAt]
    );
    res.cookie(sessionCookieName, token, {
      httpOnly: true,
      secure: production,
      sameSite: "lax",
      path: "/",
      expires: expiresAt
    });
  }

  async function userById(id) {
    const result = await db.query(
      "SELECT id, name, email, university, major, bio, avatar_url, banner_url, pro_status, pro_expires_at FROM users WHERE id = $1",
      [id]
    );
    return result.rows[0] ? publicUser(result.rows[0]) : null;
  }

  async function createOAuthState(provider, nonce, codeVerifier) {
    const state = randomToken();
    await db.query(
      "INSERT INTO oauth_states (state_hash, provider, nonce, code_verifier, expires_at) VALUES ($1, $2, $3, $4, $5)",
      [hashToken(state), provider, nonce, codeVerifier, new Date(Date.now() + 10 * 60 * 1000)]
    );
    return state;
  }

  async function consumeOAuthState(state, provider) {
    if (!state) return null;
    const result = await db.query(
      `DELETE FROM oauth_states
       WHERE state_hash = $1 AND provider = $2 AND expires_at > NOW()
       RETURNING nonce, code_verifier`,
      [hashToken(state), provider]
    );
    return result.rows[0] || null;
  }

  async function appleClientSecret(config) {
    const privateKey = await importPKCS8(config.privateKey, "ES256");
    return new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid: config.keyId })
      .setIssuer(config.teamId)
      .setSubject(config.clientId)
      .setAudience("https://appleid.apple.com")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
  }

  const jwks = {
    google: createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs")),
    apple: createRemoteJWKSet(new URL("https://appleid.apple.com/auth/keys"))
  };

  async function fetchOAuthIdentity(provider, config, stateData, code, appleResponse) {
    const clientSecret = provider === "apple" ? await appleClientSecret(config) : config.clientSecret;
    const tokenResponse = await fetch(config.tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: config.clientId,
        client_secret: clientSecret,
        redirect_uri: config.callbackUrl,
        code_verifier: stateData.code_verifier
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!tokenResponse.ok) throw new Error("The identity provider could not validate this sign-in.");
    const tokens = await tokenResponse.json();
    if (!tokens.id_token) throw new Error("The identity provider did not return a verified account.");
    const verified = await jwtVerify(tokens.id_token, jwks[provider], {
      issuer: config.issuer,
      audience: config.clientId,
      maxTokenAge: "10m"
    });
    const identity = verified.payload;
    const expectedNonce = provider === "apple"
      ? crypto.createHash("sha256").update(stateData.nonce).digest("base64url")
      : stateData.nonce;
    if (identity.nonce !== expectedNonce || !identity.sub || !identity.email || identity.email_verified !== true && identity.email_verified !== "true") {
      throw new Error("The provider account could not be verified.");
    }

    let name = String(identity.name || "").trim();
    if (provider === "apple" && appleResponse.user) {
      try {
        const details = JSON.parse(appleResponse.user);
        name = [details.name?.firstName, details.name?.lastName].filter(Boolean).join(" ") || name;
      } catch {
        throw new Error("The identity provider returned an invalid profile.");
      }
    }
    return { subject: identity.sub, email: normalizeEmail(identity.email), name };
  }

  async function findOrCreateOAuthUser(provider, identity) {
    const column = provider === "google" ? "google_sub" : "apple_sub";
    const existing = await db.query(
      `SELECT id, name, email, university, major, bio, avatar_url, banner_url, pro_status, pro_expires_at
       FROM users WHERE ${column} = $1 OR email = $2`,
      [identity.subject, identity.email]
    );
    if (existing.rows.length) {
      const user = existing.rows[0];
      await db.query(`UPDATE users SET ${column} = $1 WHERE id = $2 AND ${column} IS NULL`, [identity.subject, user.id]);
      if (!user.name && identity.name) await db.query("UPDATE users SET name = $1 WHERE id = $2", [identity.name, user.id]);
      return user.id;
    }
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, name, email, ${column}) VALUES ($1, $2, $3, $4)`,
      [id, identity.name || identity.email.split("@")[0], identity.email, identity.subject]
    );
    return id;
  }

  app.get("/api/health", asyncRoute(async (req, res) => {
    await db.query("SELECT 1");
    res.json({ ok: true });
  }));

  app.get("/api/auth/providers", (req, res) => res.json(providersStatus()));

  app.get("/api/auth/session", asyncRoute(async (req, res, next) => {
    const cookies = (req.headers.cookie || "").split(";").map((item) => item.trim().split("="));
    const token = cookies.find(([key]) => key === sessionCookieName)?.slice(1).join("=");
    if (!token) {
      res.json({ user: null });
      return;
    }
    const result = await db.query(
      `SELECT u.id, u.name, u.email, u.university, u.major, u.bio, u.avatar_url, u.banner_url, u.pro_status, u.pro_expires_at
       FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
      [hashToken(decodeURIComponent(token))]
    );
    res.json({ user: result.rows[0] ? publicUser(result.rows[0]) : null });
  }));

  app.post("/api/auth/register", jsonParser, asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    if (name.length < 2 || name.length > 40 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 8 || password.length > 200) {
      res.status(400).json({ error: "Enter your name, a valid email, and a password of at least 8 characters." });
      return;
    }
    const id = crypto.randomUUID();
    const passwordHash = await bcrypt.hash(password, 12);
    try {
      await db.query(
        "INSERT INTO users (id, name, email, password_hash) VALUES ($1, $2, $3, $4)",
        [id, name, email, passwordHash]
      );
    } catch (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "An account with that email already exists. Please sign in." });
        return;
      }
      throw error;
    }
    await setSession(res, id);
    res.status(201).json({ user: await userById(id) });
  }));

  app.post("/api/auth/login", jsonParser, asyncRoute(async (req, res) => {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const result = await db.query("SELECT id, password_hash FROM users WHERE email = $1", [email]);
    const user = result.rows[0];
    if (!user?.password_hash || !(await bcrypt.compare(password, user.password_hash))) {
      res.status(401).json({ error: "Email or password is incorrect." });
      return;
    }
    await setSession(res, user.id);
    res.json({ user: await userById(user.id) });
  }));

  app.post("/api/auth/demo", asyncRoute(async (req, res) => {
    if (production) {
      res.status(404).json({ error: "Demo sign-in is disabled." });
      return;
    }
    const email = "alex@northwood.edu";
    const lookup = await db.query("SELECT id FROM users WHERE email = $1", [email]);
    const id = lookup.rows[0]?.id || crypto.randomUUID();
    if (!lookup.rows.length) {
      await db.query(
        "INSERT INTO users (id, name, email, university, major, bio) VALUES ($1, $2, $3, $4, $5, $6)",
        [id, "Alex Morgan", email, "Northwood University", "Design & Media", "Making things, meeting people, and finding the best coffee on campus."]
      );
    }
    await setSession(res, id);
    res.json({ user: await userById(id) });
  }));

  app.post("/api/auth/logout", asyncRoute(async (req, res) => {
    const token = (req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${sessionCookieName}=`))?.slice(sessionCookieName.length + 1);
    if (token) await db.query("DELETE FROM sessions WHERE token_hash = $1", [hashToken(decodeURIComponent(token))]);
    res.clearCookie(sessionCookieName, { httpOnly: true, sameSite: "lax", secure: production, path: "/" });
    res.status(204).end();
  }));

  app.get("/auth/:provider", asyncRoute(async (req, res) => {
    const provider = req.params.provider;
    const config = configForOAuth(provider);
    if (!config) {
      res.status(503).type("text").send(`${provider === "apple" ? "Apple" : "Google"} sign-in is not configured. Follow the OAuth setup steps in backend/README.md.`);
      return;
    }
    const nonce = randomToken();
    const codeVerifier = randomToken(48);
    const state = await createOAuthState(provider, nonce, codeVerifier);
    const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    const authorization = new URL(config.authorizationEndpoint);
    authorization.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: config.callbackUrl,
      response_type: "code",
      response_mode: provider === "apple" ? "form_post" : "query",
      scope: config.scopes.join(" "),
      state,
      nonce: provider === "apple" ? crypto.createHash("sha256").update(nonce).digest("base64url") : nonce,
      code_challenge: codeChallenge,
      code_challenge_method: "S256"
    }).toString();
    res.redirect(authorization.toString());
  }));

  async function finishOAuth(provider, req, res) {
    if (req.body.error || req.query.error) {
      res.redirect("/?authError=cancelled");
      return;
    }
    const config = configForOAuth(provider);
    if (!config) {
      res.status(503).type("text").send(`${provider} sign-in is not configured.`);
      return;
    }
    const state = String(req.body.state || req.query.state || "");
    const stateData = await consumeOAuthState(state, provider);
    if (!stateData || !req.body.code && !req.query.code) {
      res.status(400).type("text").send("Sign-in expired or could not be verified. Please try again.");
      return;
    }
    const identity = await fetchOAuthIdentity(provider, config, stateData, String(req.body.code || req.query.code), req.body);
    const userId = await findOrCreateOAuthUser(provider, identity);
    await setSession(res, userId);
    res.redirect("/");
  }

  app.get("/auth/google/callback", asyncRoute((req, res) => finishOAuth("google", req, res)));
  app.get("/auth/apple/callback", (req, res) => res.status(405).type("text").send("Apple must use the registered HTTPS form-post callback."));
  app.post("/auth/apple/callback", urlEncodedParser, asyncRoute((req, res) => finishOAuth("apple", req, res)));

  app.get("/api/me", requireUser, (req, res) => res.json({ user: req.user }));
  app.patch("/api/me", requireUser, jsonParser, asyncRoute(async (req, res) => {
    const values = {
      name: String(req.body.name || "").trim(),
      university: String(req.body.university || "").trim(),
      major: String(req.body.major || "").trim(),
      bio: String(req.body.bio || "").trim()
    };
    if (values.name.length < 2 || values.name.length > 40 || values.university.length > 70 || values.major.length > 70 || values.bio.length > 220) {
      res.status(400).json({ error: "Check your profile details and try again." });
      return;
    }
    await db.query(
      "UPDATE users SET name = $1, university = $2, major = $3, bio = $4 WHERE id = $5",
      [values.name, values.university, values.major, values.bio, req.user.id]
    );
    res.json({ user: await userById(req.user.id) });
  }));

  async function verifyMediaFile(file) {
    if (!file) return null;
    const detected = await fileTypeFromFile(file.path);
    const mediaType = detected && allowedMedia.get(detected.mime);
    if (!mediaType) {
      await fs.unlink(file.path).catch(() => {});
      const error = new Error("This image or video format is not supported.");
      error.status = 400;
      throw error;
    }
    const extension = detected.ext.replace(/[^a-z0-9]/gi, "");
    const filename = `${crypto.randomUUID()}.${extension}`;
    const target = path.join(uploadsDirectory, filename);
    await fs.rename(file.path, target);
    return { mediaType, url: `/uploads/${filename}`, path: target };
  }

  app.post("/api/me/avatar", requireUser, avatarUpload.single("avatar"), asyncRoute(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Choose a profile photo first." });
      return;
    }
    const media = await verifyMediaFile(req.file);
    if (media.mediaType !== "image") {
      await fs.unlink(media.path).catch(() => {});
      res.status(400).json({ error: "Profile photos must be images." });
      return;
    }
    await db.query("UPDATE users SET avatar_url = $1 WHERE id = $2", [media.url, req.user.id]);
    res.json({ user: await userById(req.user.id) });
  }));

  app.post("/api/me/banner", requireUser, avatarUpload.single("banner"), asyncRoute(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Choose a banner image first." });
      return;
    }
    const media = await verifyMediaFile(req.file);
    if (media.mediaType !== "image") {
      await fs.unlink(media.path).catch(() => {});
      res.status(400).json({ error: "Profile banners must be images." });
      return;
    }
    await db.query("UPDATE users SET banner_url = $1 WHERE id = $2", [media.url, req.user.id]);
    res.json({ user: await userById(req.user.id) });
  }));

  app.get("/api/posts", requireUser, asyncRoute(async (req, res) => {
    const savedOnly = req.query.saved === "true";
    const authorId = req.query.authorId ? String(req.query.authorId) : null;
    const followingOnly = req.query.following === "true";
    if (authorId && !uuidPattern.test(authorId)) {
      res.status(400).json({ error: "That profile ID is invalid." });
      return;
    }
    const result = await db.query(
      `SELECT p.id, p.user_id, p.body, p.media_url, p.media_type, p.poll_options, p.created_at,
              u.name AS author_name, u.avatar_url AS author_avatar, u.university,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = p.user_id) AS followed,
              (SELECT COUNT(*)::int FROM likes l WHERE l.post_id = p.id) AS like_count,
              EXISTS (SELECT 1 FROM likes l WHERE l.post_id = p.id AND l.user_id = $1) AS liked,
              EXISTS (SELECT 1 FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = $1) AS saved,
              (SELECT COUNT(*)::int FROM comments c WHERE c.post_id = p.id) AS comment_count,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('id', c.id, 'name', cu.name, 'avatar', cu.avatar_url, 'text', c.body, 'createdAt', c.created_at) ORDER BY c.created_at), '[]'::jsonb)
               FROM comments c JOIN users cu ON cu.id = c.user_id WHERE c.post_id = p.id) AS comments,
              (SELECT COALESCE(jsonb_agg(jsonb_build_object('optionIndex', v.option_index, 'count', v.vote_count)), '[]'::jsonb)
               FROM (SELECT option_index, COUNT(*)::int AS vote_count FROM poll_votes WHERE post_id = p.id GROUP BY option_index) v) AS poll_votes,
              EXISTS (SELECT 1 FROM poll_votes v WHERE v.post_id = p.id AND v.user_id = $1) AS voted
       FROM posts p JOIN users u ON u.id = p.user_id
       WHERE (NOT $2 OR EXISTS (SELECT 1 FROM saved_posts s WHERE s.post_id = p.id AND s.user_id = $1))
         AND ($3::uuid IS NULL OR p.user_id = $3)
         AND (NOT $4 OR p.user_id = $1 OR EXISTS (
           SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = p.user_id
         ))
       ORDER BY p.created_at DESC LIMIT 100`,
      [req.user.id, savedOnly, authorId, followingOnly]
    );
    res.json({ posts: result.rows });
  }));

  app.post("/api/posts", requireUser, mediaUpload.single("media"), asyncRoute(async (req, res) => {
    const body = String(req.body.body || "").trim();
    let pollOptions = null;
    if (req.body.pollOptions) {
      try {
        pollOptions = JSON.parse(req.body.pollOptions);
      } catch {
        if (req.file) await fs.unlink(req.file.path).catch(() => {});
        res.status(400).json({ error: "The poll choices are invalid." });
        return;
      }
      if (!Array.isArray(pollOptions) || pollOptions.length < 2 || pollOptions.length > 3
        || pollOptions.some((option) => typeof option !== "string" || !option.trim() || option.length > 60)) {
        if (req.file) await fs.unlink(req.file.path).catch(() => {});
        res.status(400).json({ error: "A poll needs two or three choices, each under 60 characters." });
        return;
      }
      pollOptions = pollOptions.map((option) => option.trim());
    }
    if (body.length > 500 || (!body && !req.file && !pollOptions)) {
      if (req.file) await fs.unlink(req.file.path).catch(() => {});
      res.status(400).json({ error: "Write a post, add media, or create a poll." });
      return;
    }
    const media = await verifyMediaFile(req.file);
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO posts (id, user_id, body, media_url, media_type, poll_options) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, req.user.id, body, media?.url || null, media?.mediaType || null, pollOptions]
    );
    const result = await db.query("SELECT id, body, media_url, media_type, poll_options, created_at FROM posts WHERE id = $1", [id]);
    res.status(201).json({
      post: {
        ...result.rows[0],
        user_id: req.user.id,
        author_name: req.user.name,
        author_avatar: req.user.avatar || null,
        like_count: 0,
        liked: false,
        saved: false,
        comment_count: 0,
        comments: [],
        poll_votes: [],
        voted: false
      }
    });
  }));

  app.delete("/api/posts/:id", requireUser, asyncRoute(async (req, res) => {
    if (!uuidPattern.test(req.params.id)) {
      res.status(400).json({ error: "That post ID is invalid." });
      return;
    }
    const deleted = await db.query(
      "DELETE FROM posts WHERE id = $1 AND user_id = $2 RETURNING media_url",
      [req.params.id, req.user.id]
    );
    if (!deleted.rows.length) {
      res.status(404).json({ error: "Post not found or you do not own it." });
      return;
    }
    const mediaUrl = deleted.rows[0].media_url;
    if (mediaUrl && mediaUrl.startsWith("/uploads/")) {
      const filename = path.basename(mediaUrl);
      if (filename === mediaUrl.slice("/uploads/".length)) {
        await fs.unlink(path.join(uploadsDirectory, filename)).catch((error) => {
          if (error.code !== "ENOENT") console.error("Could not remove deleted post media:", error.message);
        });
      }
    }
    res.status(204).end();
  }));

  async function postExists(postId) {
    const result = await db.query("SELECT id FROM posts WHERE id = $1", [postId]);
    return result.rows.length > 0;
  }

  app.get("/api/posts/:id/comments", requireUser, asyncRoute(async (req, res) => {
    if (!await postExists(req.params.id)) {
      res.status(404).json({ error: "Post not found." });
      return;
    }
    const result = await db.query(
      `SELECT c.id, u.name, u.avatar_url AS avatar, c.body AS text, c.created_at AS "createdAt"
       FROM comments c JOIN users u ON u.id = c.user_id
       WHERE c.post_id = $1 ORDER BY c.created_at`,
      [req.params.id]
    );
    res.json({ comments: result.rows });
  }));

  app.post("/api/posts/:id/comments", requireUser, jsonParser, asyncRoute(async (req, res) => {
    const body = String(req.body.body || "").trim();
    if (!body || body.length > 240 || !await postExists(req.params.id)) {
      res.status(body.length > 240 ? 400 : 404).json({ error: body.length > 240 ? "Comments must be under 240 characters." : "Post not found." });
      return;
    }
    const id = crypto.randomUUID();
    await db.query("INSERT INTO comments (id, post_id, user_id, body) VALUES ($1, $2, $3, $4)", [id, req.params.id, req.user.id, body]);
    res.status(201).json({ comment: { id, name: req.user.name, avatar: req.user.avatar || null, text: body } });
  }));

  app.post("/api/posts/:id/like", requireUser, asyncRoute(async (req, res) => {
    if (!await postExists(req.params.id)) {
      res.status(404).json({ error: "Post not found." });
      return;
    }
    const existing = await db.query("DELETE FROM likes WHERE post_id = $1 AND user_id = $2 RETURNING post_id", [req.params.id, req.user.id]);
    const liked = !existing.rows.length;
    if (liked) await db.query("INSERT INTO likes (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.params.id, req.user.id]);
    const count = await db.query("SELECT COUNT(*)::int AS count FROM likes WHERE post_id = $1", [req.params.id]);
    res.json({ liked, count: count.rows[0].count });
  }));

  app.post("/api/posts/:id/save", requireUser, asyncRoute(async (req, res) => {
    if (!await postExists(req.params.id)) {
      res.status(404).json({ error: "Post not found." });
      return;
    }
    const existing = await db.query("DELETE FROM saved_posts WHERE post_id = $1 AND user_id = $2 RETURNING post_id", [req.params.id, req.user.id]);
    const saved = !existing.rows.length;
    if (saved) await db.query("INSERT INTO saved_posts (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.params.id, req.user.id]);
    res.json({ saved });
  }));

  app.post("/api/posts/:id/vote", requireUser, jsonParser, asyncRoute(async (req, res) => {
    const optionIndex = Number(req.body.optionIndex);
    const postResult = await db.query("SELECT poll_options FROM posts WHERE id = $1", [req.params.id]);
    if (!postResult.rows.length) {
      res.status(404).json({ error: "Post not found." });
      return;
    }
    const options = postResult.rows[0].poll_options;
    if (!Array.isArray(options) || !Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) {
      res.status(400).json({ error: "That poll option is invalid." });
      return;
    }
    try {
      await db.query("INSERT INTO poll_votes (post_id, user_id, option_index) VALUES ($1, $2, $3)", [req.params.id, req.user.id, optionIndex]);
    } catch (error) {
      if (error.code === "23505") {
        res.status(409).json({ error: "You have already voted in this poll." });
        return;
      }
      throw error;
    }
    const votes = await db.query("SELECT option_index, COUNT(*)::int AS count FROM poll_votes WHERE post_id = $1 GROUP BY option_index", [req.params.id]);
    res.json({ votes: votes.rows });
  }));

  app.get("/api/people", requireUser, asyncRoute(async (req, res) => {
    const query = `%${String(req.query.q || "").slice(0, 60)}%`;
    const people = await db.query(
      `SELECT u.id, u.name, u.university, u.major, u.avatar_url,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = u.id) AS following
       FROM users u WHERE u.id <> $1 AND ($2 = '%%' OR u.name ILIKE $2 OR u.university ILIKE $2 OR u.major ILIKE $2)
       ORDER BY u.name LIMIT 50`,
      [req.user.id, query]
    );
    res.json({ people: people.rows });
  }));

  app.post("/api/people/:id/follow", requireUser, asyncRoute(async (req, res) => {
    if (!uuidPattern.test(req.params.id)) {
      res.status(400).json({ error: "That profile ID is invalid." });
      return;
    }
    if (req.params.id === req.user.id) {
      res.status(400).json({ error: "You cannot follow your own account." });
      return;
    }
    const target = await db.query("SELECT id FROM users WHERE id = $1", [req.params.id]);
    if (!target.rows.length) {
      res.status(404).json({ error: "That user was not found." });
      return;
    }
    const result = await db.query("DELETE FROM follows WHERE follower_id = $1 AND followed_id = $2 RETURNING followed_id", [req.user.id, req.params.id]);
    const following = !result.rows.length;
    if (following) await db.query("INSERT INTO follows (follower_id, followed_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [req.user.id, req.params.id]);
    res.json({ following });
  }));

  app.get("/api/people/:id", requireUser, asyncRoute(async (req, res) => {
    if (!uuidPattern.test(req.params.id)) {
      res.status(400).json({ error: "That profile ID is invalid." });
      return;
    }
    const result = await db.query(
      `SELECT u.id, u.name, u.university, u.major, u.bio, u.avatar_url, u.banner_url, u.pro_status, u.pro_expires_at,
              (SELECT COUNT(*)::int FROM follows f WHERE f.followed_id = u.id) AS follower_count,
              (SELECT COUNT(*)::int FROM follows f WHERE f.follower_id = u.id) AS following_count,
              EXISTS(SELECT 1 FROM follows f WHERE f.follower_id = $1 AND f.followed_id = u.id) AS following
       FROM users u WHERE u.id = $2`,
      [req.user.id, req.params.id]
    );
    if (!result.rows.length) {
      res.status(404).json({ error: "That profile was not found." });
      return;
    }
    const profile = result.rows[0];
    res.json({
      profile: {
        id: profile.id,
        name: profile.name,
        university: profile.university,
        major: profile.major,
        bio: profile.bio,
        avatar: profile.avatar_url || "",
        banner: profile.banner_url || "",
        isPro: profile.pro_status === "pro" && (!profile.pro_expires_at || new Date(profile.pro_expires_at).getTime() > Date.now()),
        followerCount: profile.follower_count,
        followingCount: profile.following_count,
        following: profile.following
      }
    });
  }));

  app.get("/api/messages/conversations", requireUser, asyncRoute(async (req, res) => {
    const conversations = await db.query(
      `SELECT u.id, u.name, u.avatar_url, u.pro_status,
              (SELECT m.body FROM direct_messages m
               WHERE (m.sender_id = $1 AND m.recipient_id = u.id) OR (m.sender_id = u.id AND m.recipient_id = $1)
               ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message,
              (SELECT m.created_at FROM direct_messages m
               WHERE (m.sender_id = $1 AND m.recipient_id = u.id) OR (m.sender_id = u.id AND m.recipient_id = $1)
               ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_at
       FROM users u
       WHERE u.id IN (
         SELECT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END
         FROM direct_messages WHERE sender_id = $1 OR recipient_id = $1
       )
       ORDER BY last_at DESC`,
      [req.user.id]
    );
    res.json({
      conversations: conversations.rows.map((person) => ({
        id: person.id,
        name: person.name,
        avatar: person.avatar_url || "",
        lastMessage: person.last_message,
        lastAt: person.last_at
      }))
    });
  }));

  app.get("/api/messages/:userId", requireUser, asyncRoute(async (req, res) => {
    const userId = req.params.userId;
    if (!uuidPattern.test(userId) || userId === req.user.id) {
      res.status(400).json({ error: "Choose a valid user to message." });
      return;
    }
    const partnerResult = await db.query(
      "SELECT id, name, avatar_url FROM users WHERE id = $1",
      [userId]
    );
    if (!partnerResult.rows.length) {
      res.status(404).json({ error: "That user was not found." });
      return;
    }
    const messages = await db.query(
      `SELECT id, sender_id, recipient_id, body, created_at
       FROM direct_messages
       WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
       ORDER BY created_at, id`,
      [req.user.id, userId]
    );
    const partner = partnerResult.rows[0];
    res.json({
      partner: { id: partner.id, name: partner.name, avatar: partner.avatar_url || "" },
      messages: messages.rows
    });
  }));

  app.post("/api/messages/:userId", requireUser, jsonParser, asyncRoute(async (req, res) => {
    const userId = req.params.userId;
    const body = String(req.body.body || "").trim();
    if (!uuidPattern.test(userId) || userId === req.user.id) {
      res.status(400).json({ error: "Choose a valid user to message." });
      return;
    }
    if (!body || body.length > 1000) {
      res.status(400).json({ error: "Messages must be between 1 and 1000 characters." });
      return;
    }
    const target = await db.query("SELECT id FROM users WHERE id = $1", [userId]);
    if (!target.rows.length) {
      res.status(404).json({ error: "That user was not found." });
      return;
    }
    const id = crypto.randomUUID();
    const result = await db.query(
      "INSERT INTO direct_messages (id, sender_id, recipient_id, body) VALUES ($1, $2, $3, $4) RETURNING id, sender_id, recipient_id, body, created_at",
      [id, req.user.id, userId, body]
    );
    res.status(201).json({ message: result.rows[0] });
  }));

  app.post("/api/me/pro/checkout", requireUser, (req, res) => {
    res.status(503).json({ error: "Pro billing is not configured yet. Choose a payment provider before upgrading." });
  });

  app.get("/api/events", requireUser, asyncRoute(async (req, res) => {
    const events = await db.query(
      `SELECT e.id, e.name, e.event_date, e.event_time, e.place, u.name AS author_name,
              (SELECT COUNT(*)::int FROM event_rsvps r WHERE r.event_id = e.id) AS attendee_count,
              EXISTS(SELECT 1 FROM event_rsvps r WHERE r.event_id = e.id AND r.user_id = $1) AS attending
       FROM campus_events e JOIN users u ON u.id = e.user_id
       WHERE e.event_date >= CURRENT_DATE ORDER BY e.event_date, e.event_time LIMIT 100`,
      [req.user.id]
    );
    res.json({ events: events.rows });
  }));

  app.post("/api/events", requireUser, jsonParser, asyncRoute(async (req, res) => {
    const name = String(req.body.name || "").trim();
    const place = String(req.body.place || "").trim();
    const date = String(req.body.date || "");
    const time = String(req.body.time || "");
    if (!name || name.length > 70 || !place || place.length > 70
      || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)
      || date < new Date().toISOString().slice(0, 10)) {
      res.status(400).json({ error: "Enter a valid future event date, time, name, and location." });
      return;
    }
    const id = crypto.randomUUID();
    await db.query(
      "INSERT INTO campus_events (id, user_id, name, event_date, event_time, place) VALUES ($1, $2, $3, $4, $5, $6)",
      [id, req.user.id, name, date, time, place]
    );
    res.status(201).json({ event: { id, name, event_date: date, event_time: time, place, author_name: req.user.name, attendee_count: 0, attending: false } });
  }));

  app.post("/api/events/:id/rsvp", requireUser, asyncRoute(async (req, res) => {
    const result = await db.query("DELETE FROM event_rsvps WHERE event_id = $1 AND user_id = $2 RETURNING event_id", [req.params.id, req.user.id]);
    const attending = !result.rows.length;
    if (attending) {
      try {
        await db.query("INSERT INTO event_rsvps (event_id, user_id) VALUES ($1, $2)", [req.params.id, req.user.id]);
      } catch (error) {
        if (error.code === "23503") {
          res.status(404).json({ error: "Event not found." });
          return;
        }
        throw error;
      }
    }
    const count = await db.query("SELECT COUNT(*)::int AS count FROM event_rsvps WHERE event_id = $1", [req.params.id]);
    res.json({ attending, count: count.rows[0].count });
  }));

  app.use("/api", (req, res) => res.status(404).json({ error: "API endpoint not found." }));
  app.get("*path", (req, res, next) => {
    if (req.path.startsWith("/auth/") || req.path.startsWith("/uploads/")) {
      res.status(404).type("text").send("Not found.");
      return;
    }
    res.sendFile(path.join(webRoot, "ahder.html"), (error) => {
      if (error) next(error);
    });
  });

  app.use((error, req, res, next) => {
    if (req.file?.path) fs.unlink(req.file.path).catch(() => {});
    if (res.headersSent) {
      next(error);
      return;
    }
    if (error instanceof multer.MulterError) {
      const message = error.code === "LIMIT_FILE_SIZE"
        ? "The selected file is too large."
        : "The selected upload could not be processed.";
      res.status(400).json({ error: message });
      return;
    }
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error("Request failed:", error.message);
    res.status(status).json({ error: status >= 500 ? "The server could not complete that request." : error.message });
  });

  return app;
}

async function start() {
  if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
    throw new Error("Set SESSION_SECRET to a random value with at least 32 characters in backend/.env.");
  }
  await fs.mkdir(uploadsDir, { recursive: true });
  const db = await createDatabase();
  const ready = db.waitReady instanceof Promise ? db.waitReady : (typeof db.waitReady === "function" ? db.waitReady() : null);
  if (ready) await ready;
  await initializeDatabase(db);
  const port = Number(process.env.PORT || 3000);
  const app = makeApp({ db });
  const server = app.listen(port, () => {
    console.log(`Ahder is running at http://localhost:${port}`);
    console.log(`OAuth configured — Google: ${providersStatus().google}, Apple: ${providersStatus().apple}`);
  });
  const shutdown = async () => {
    server.close(async () => {
      await db.close?.();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module || process.env.AHDER_AUTOSTART === "true") {
  start().catch((error) => {
    console.error("Could not start Ahder:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { createDatabase, initializeDatabase, makeApp, configForOAuth };
