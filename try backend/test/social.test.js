const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { PGlite } = require("@electric-sql/pglite");
const { initializeDatabase, makeApp } = require("../ahder.njs");

let db;
let server;
let baseUrl;
let temporaryDirectory;

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "ahder-test-"));
  const databaseDirectory = path.join(temporaryDirectory, "database");
  const uploadsDirectory = path.join(temporaryDirectory, "uploads");
  await fs.mkdir(uploadsDirectory);
  db = new PGlite(databaseDirectory);
  await db.waitReady;
  await initializeDatabase(db);
  server = makeApp({
    db,
    uploadsDirectory,
    webRoot: path.resolve(__dirname, "..", "..", "try"),
    production: false
  }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (db) await db.close();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
});

async function request(url, { cookie, ...options } = {}) {
  const headers = new Headers(options.headers);
  if (cookie) headers.set("Cookie", cookie);
  const response = await fetch(`${baseUrl}${url}`, { ...options, headers });
  const body = response.status === 204 ? null : await response.json();
  const setCookie = response.headers.get("set-cookie");
  return {
    response,
    body,
    cookie: setCookie ? setCookie.split(";")[0] : cookie
  };
}

async function register(name, email) {
  const result = await request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, email, password: "password123" })
  });
  assert.equal(result.response.status, 201);
  return { user: result.body.user, cookie: result.cookie };
}

test("users can browse profiles, follow, see posts, and exchange private DMs", async () => {
  const alice = await register("Alice Campus", "alice@example.edu");
  const bob = await register("Bob Campus", "bob@example.edu");
  const carol = await register("Carol Campus", "carol@example.edu");

  const people = await request("/api/people?q=Alice", { cookie: bob.cookie });
  assert.equal(people.response.status, 200);
  assert.equal(people.body.people[0].id, alice.user.id);

  const profile = await request(`/api/people/${alice.user.id}`, { cookie: bob.cookie });
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.profile.following, false);
  assert.equal(profile.body.profile.isPro, false);

  const followed = await request(`/api/people/${alice.user.id}/follow`, {
    cookie: bob.cookie,
    method: "POST"
  });
  assert.equal(followed.body.following, true);

  const form = new FormData();
  form.set("body", "A post from Alice");
  const createdPost = await request("/api/posts", {
    cookie: alice.cookie,
    method: "POST",
    body: form
  });
  assert.equal(createdPost.response.status, 201);
  assert.equal(createdPost.body.post.user_id, alice.user.id);

  const rejectedDelete = await request(`/api/posts/${createdPost.body.post.id}`, {
    cookie: bob.cookie,
    method: "DELETE"
  });
  assert.equal(rejectedDelete.response.status, 404);

  const alicePosts = await request(`/api/posts?authorId=${alice.user.id}`, { cookie: bob.cookie });
  assert.equal(alicePosts.body.posts.length, 1);
  assert.equal(alicePosts.body.posts[0].body, "A post from Alice");

  const followingFeed = await request("/api/posts?following=true", { cookie: bob.cookie });
  assert.equal(followingFeed.body.posts.length, 1);
  assert.equal(followingFeed.body.posts[0].followed, true);

  const sent = await request(`/api/messages/${bob.user.id}`, {
    cookie: alice.cookie,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: "Hello Bob" })
  });
  assert.equal(sent.response.status, 201);

  const received = await request(`/api/messages/${alice.user.id}`, { cookie: bob.cookie });
  assert.equal(received.body.messages.length, 1);
  assert.equal(received.body.messages[0].body, "Hello Bob");

  const isolated = await request(`/api/messages/${alice.user.id}`, { cookie: carol.cookie });
  assert.equal(isolated.response.status, 200);
  assert.equal(isolated.body.messages.length, 0);

  const conversations = await request("/api/messages/conversations", { cookie: bob.cookie });
  assert.equal(conversations.body.conversations.length, 1);
  assert.equal(conversations.body.conversations[0].id, alice.user.id);

  const checkout = await request("/api/me/pro/checkout", { cookie: alice.cookie, method: "POST" });
  assert.equal(checkout.response.status, 503);
  assert.match(checkout.body.error, /payment provider/i);

  const banner = new FormData();
  banner.set("banner", new Blob([
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=", "base64")
  ], { type: "image/png" }), "banner.png");
  const uploadedBanner = await request("/api/me/banner", {
    cookie: alice.cookie,
    method: "POST",
    body: banner
  });
  assert.equal(uploadedBanner.response.status, 200);
  assert.match(uploadedBanner.body.user.banner, /^\/uploads\/[a-f0-9-]+\.png$/);
  const updatedProfile = await request(`/api/people/${alice.user.id}`, { cookie: bob.cookie });
  assert.equal(updatedProfile.body.profile.banner, uploadedBanner.body.user.banner);

  const deletedPost = await request(`/api/posts/${createdPost.body.post.id}`, {
    cookie: alice.cookie,
    method: "DELETE"
  });
  assert.equal(deletedPost.response.status, 204);
  const afterDelete = await request(`/api/posts?authorId=${alice.user.id}`, { cookie: bob.cookie });
  assert.equal(afterDelete.body.posts.length, 0);
});
