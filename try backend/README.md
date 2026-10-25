# Ahder backend

This folder contains the Ahder web server and API. The server serves the frontend from the neighboring `try` folder, so open the app at `http://localhost:3000` rather than opening `ahder.html` as a `file://` URL.

## Local setup

1. Install Node.js 20 or newer.
2. Open a terminal in `try backend` and run `npm install`.
3. Copy `.env.example` to `.env` and set a random `SESSION_SECRET` (at least 32 characters). `.env` is ignored by Git.
4. Run `npm start`, then visit `http://localhost:3000`.

Use the npm script to start the server because the requested `ahder.njs` extension is not a direct Node.js entry-point extension.

User accounts, posts, and other records are stored in a persistent PostgreSQL-compatible PGlite database under the `DATABASE_PATH` configured in `.env` (currently `try backend/data-live/`); uploaded media is stored under `try backend/uploads/`. The directories are created automatically and are local to this server. Back them up regularly. If an existing database cannot be opened, preserve it and configure a new `DATABASE_PATH` rather than deleting or overwriting the old data.

To use a hosted PostgreSQL service, set `DATABASE_URL` to its connection string (with TLS enabled as required by the provider). The server uses the same schema for PGlite and PostgreSQL.

Local accounts are shared with other people only if they connect to this same running server. To let friends use Ahder from other devices or networks, deploy the backend and database on a publicly reachable HTTPS host, then share that public URL; `localhost` only points to the current device.

## Deploy with Render and Neon

The repository root contains `render.yaml`, configured for a Render Node web service whose root directory is `try backend`. It uses the checked-in npm lockfile with `npm ci`, starts with `npm start`, and checks `/api/health`. The Blueprint generates `SESSION_SECRET`; enter the Neon PostgreSQL connection string as the prompted `DATABASE_URL` secret during setup. Do not commit `.env` or paste database credentials into source files.

1. Create a Neon PostgreSQL project and copy its connection string from the Neon dashboard. Use the connection string with TLS enabled (`sslmode=require`).
2. Create a private GitHub repository. From the workspace root, initialize Git and commit the project. The root `.gitignore` excludes `.env` files (except `.env.example`), `node_modules`, local databases, and uploads. Check the GitHub file list before deployment to ensure secrets and local data were not uploaded.
3. In Render, create a new Blueprint and select the GitHub repository. Render reads `render.yaml`; provide `DATABASE_URL` when prompted. Deploy, then open the HTTPS URL Render assigns to the service.
4. Check `https://<your-render-host>/api/health`. Set provider OAuth callback URLs to the deployed host if enabling Google or Apple sign-in.

The Neon database is separate from the local PGlite folders; deploying does not migrate or upload existing local accounts. Render's free web service has an ephemeral filesystem, so uploaded avatars, banners, and post media saved to the local `uploads` directory can disappear after a restart or deploy. Persist media with an external object-storage service or a host-supported persistent disk before relying on it in production. Free-tier quotas, availability, and cold starts are controlled by the providers and may change.

## Accounts and OAuth

Email/password registration and sign-in use server-side password hashes and opaque, HTTP-only session cookies. Google and Apple routes use OpenID Connect, state/nonce checks, and verified provider identity. Provider secrets are only read from environment variables.

For Google, create a Web OAuth client and register `http://localhost:3000/auth/google/callback` as an authorized redirect URI. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`.

For Apple, configure Sign in with Apple for a Services ID, Team ID, Key ID, and private key. Apple requires a verified domain and an HTTPS return URL; configure that HTTPS URL as `APPLE_CALLBACK_URL`. Set `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, and `APPLE_PRIVATE_KEY` in `.env`; represent newlines in the private key as `\n`. OAuth buttons report when provider configuration is still missing.

Never commit `.env`, OAuth keys, uploaded media, or database files. Deploy behind HTTPS, set `NODE_ENV=production`, and use a managed PostgreSQL service for a production multi-instance deployment.

## Profiles, follows, messages, and Pro

Signed-in users choose a unique username during registration and can search the student directory by username (including `@username`), open public profiles, follow or unfollow accounts, browse a Following feed, and view posts on each profile. On phones, the three-dot navigation button opens the hidden sidebar. Users can permanently delete their own posts, but cannot delete posts belonging to other accounts. Profile owners can upload an image banner (up to 8 MB) as well as an avatar. Direct messages and member-only group chats are text-only and stored in the application database.

The schema stores Pro account status, but billing is intentionally unavailable until a payment provider, subscription price, and billing period are selected and configured. The upgrade endpoint returns an unavailable response; it does not grant Pro access or collect payment.

## API overview

- `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/session`
- `GET/PATCH /api/me`, `POST /api/me/avatar`
- `POST /api/me/banner`
- `GET /api/people`, `GET /api/people/:id`, `POST /api/people/:id/follow`
- `GET /api/messages/conversations`, `GET/POST /api/messages/:userId`
- `GET/POST /api/groups`, `GET /api/groups/:id`, `POST /api/groups/:id/messages`
- `POST /api/me/pro/checkout` (unavailable until billing is configured)
- `GET/POST /api/posts`, `POST /api/posts/:id/comments`, `POST /api/posts/:id/like`, `POST /api/posts/:id/save`, `POST /api/posts/:id/vote`
- `DELETE /api/posts/:id` (only the post owner can delete a post)
- `GET/POST /api/events`, `POST /api/events/:id/rsvp`
- `GET /api/auth/providers`, `GET /auth/google`, `GET /auth/google/callback`, `GET /auth/apple`, `POST /auth/apple/callback`
- `GET /api/health`

Run backend checks with `npm test`.
