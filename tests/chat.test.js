// tests/chat.test.js
// Run with: node tests/chat.test.js
// (No test framework needed — pure Node.js assertions)

const assert = require('assert');
const http = require('http');

const BASE = process.env.TEST_URL || 'http://localhost:3001';
let passed = 0;
let failed = 0;

// ─── Helpers ──────────────────────────────────────────────
async function req(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    };

    const request = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });

    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
    failed++;
  }
}

function assertStatus(res, expected) {
  assert.strictEqual(res.status, expected,
    `Expected HTTP ${expected}, got ${res.status}: ${JSON.stringify(res.body)}`);
}

function assertField(obj, field) {
  assert.ok(obj[field] !== undefined, `Expected field "${field}" in: ${JSON.stringify(obj)}`);
}

// ─── Test State ───────────────────────────────────────────
const state = {};

// ─── Test Suites ──────────────────────────────────────────

async function testHealth() {
  console.log('\n📡 Health Check');
  await test('GET /health returns ok', async () => {
    const res = await req('GET', '/health');
    assertStatus(res, 200);
    assert.strictEqual(res.body.status, 'ok');
    assertField(res.body, 'uptime');
    assertField(res.body, 'version');
  });
}

async function testAuth() {
  console.log('\n🔐 Auth');

  const ts = Date.now();
  const testUser = {
    username: `testuser_${ts}`,
    displayName: `Test User ${ts}`,
    email: `test_${ts}@test.com`,
    password: 'testpass123',
  };

  await test('Register new user', async () => {
    const res = await req('POST', '/api/auth/register', testUser);
    assertStatus(res, 201);
    assertField(res.body, 'token');
    assertField(res.body, 'user');
    assert.strictEqual(res.body.user.username, testUser.username);
    state.token = res.body.token;
    state.userId = res.body.user.id;
  });

  await test('Register duplicate username fails', async () => {
    const res = await req('POST', '/api/auth/register', testUser);
    assertStatus(res, 409);
  });

  await test('Register with missing fields fails', async () => {
    const res = await req('POST', '/api/auth/register', { username: 'x' });
    assertStatus(res, 400);
  });

  await test('Login with correct credentials', async () => {
    const res = await req('POST', '/api/auth/login', {
      username: testUser.username,
      password: testUser.password,
    });
    assertStatus(res, 200);
    assertField(res.body, 'token');
    assert.strictEqual(res.body.user.username, testUser.username);
  });

  await test('Login with wrong password fails', async () => {
    const res = await req('POST', '/api/auth/login', {
      username: testUser.username,
      password: 'wrongpassword',
    });
    assertStatus(res, 401);
  });

  await test('Login with unknown user fails', async () => {
    const res = await req('POST', '/api/auth/login', {
      username: 'nobody_xyz_' + ts,
      password: 'anything',
    });
    assertStatus(res, 401);
  });

  await test('GET /me returns current user', async () => {
    const res = await req('GET', '/api/auth/me', null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'user');
    assert.strictEqual(res.body.user.id, state.userId);
  });

  await test('GET /me without token fails', async () => {
    const res = await req('GET', '/api/auth/me');
    assertStatus(res, 401);
  });

  await test('GET /me with invalid token fails', async () => {
    const res = await req('GET', '/api/auth/me', null, 'invalid.token.here');
    assertStatus(res, 401);
  });
}

async function testRooms() {
  console.log('\n🏠 Rooms');

  await test('GET /rooms returns user rooms array', async () => {
    const res = await req('GET', '/api/rooms', null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'rooms');
    assert.ok(Array.isArray(res.body.rooms));
    // New user should be in General after registration
    state.rooms = res.body.rooms;
  });

  await test('GET /rooms requires auth', async () => {
    const res = await req('GET', '/api/rooms');
    assertStatus(res, 401);
  });

  await test('POST /rooms creates a new room', async () => {
    const res = await req('POST', '/api/rooms', {
      name: `test-room-${Date.now()}`,
      description: 'A test channel',
    }, state.token);
    assertStatus(res, 201);
    assertField(res.body, 'room');
    assertField(res.body.room, 'id');
    assert.strictEqual(res.body.room.room_type, 'group');
    state.testRoomId = res.body.room.id;
  });

  await test('POST /rooms requires a name', async () => {
    const res = await req('POST', '/api/rooms', { description: 'no name' }, state.token);
    assertStatus(res, 400);
  });

  await test('GET /rooms/:id returns room + members', async () => {
    const res = await req('GET', `/api/rooms/${state.testRoomId}`, null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'room');
    assertField(res.body, 'members');
    assert.ok(Array.isArray(res.body.members));
    // Creator should be first member as admin
    const creator = res.body.members.find(m => m.id === state.userId);
    assert.ok(creator, 'Creator should be a member');
    assert.strictEqual(creator.role, 'admin');
  });

  await test('GET /rooms/:id with non-member fails', async () => {
    // Register a second user who is not in the room
    const ts = Date.now();
    const reg = await req('POST', '/api/auth/register', {
      username: `outsider_${ts}`,
      displayName: `Outsider ${ts}`,
      email: `outsider_${ts}@test.com`,
      password: 'pass123',
    });
    state.outsiderToken = reg.body.token;

    const res = await req('GET', `/api/rooms/${state.testRoomId}`, null, state.outsiderToken);
    assertStatus(res, 403);
  });

  await test('GET /rooms/:id/messages returns messages array', async () => {
    const res = await req('GET', `/api/rooms/${state.testRoomId}/messages`, null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'messages');
    assert.ok(Array.isArray(res.body.messages));
    assertField(res.body, 'hasMore');
  });

  await test('PATCH /rooms/:id/read marks room as read', async () => {
    const res = await req('PATCH', `/api/rooms/${state.testRoomId}/read`, null, state.token);
    assertStatus(res, 200);
    assert.strictEqual(res.body.success, true);
  });
}

async function testSearch() {
  console.log('\n🔍 Search');

  await test('GET /search/users?q= finds users', async () => {
    const res = await req('GET', '/api/search/users?q=alice', null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'results');
    assert.ok(Array.isArray(res.body.results));
  });

  await test('GET /search/users requires at least 1 char', async () => {
    const res = await req('GET', '/api/search/users?q=', null, state.token);
    assertStatus(res, 400);
  });

  await test('GET /search/messages?q= returns results', async () => {
    const res = await req('GET', '/api/search/messages?q=hello', null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'results');
    assertField(res.body, 'query');
  });

  await test('GET /search/messages short query fails', async () => {
    const res = await req('GET', '/api/search/messages?q=a', null, state.token);
    assertStatus(res, 400);
  });

  await test('GET /search/rooms finds public rooms', async () => {
    const res = await req('GET', '/api/search/rooms?q=general', null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'results');
  });

  await test('Search routes require auth', async () => {
    const res = await req('GET', '/api/search/users?q=alice');
    assertStatus(res, 401);
  });
}

async function testNotifications() {
  console.log('\n🔔 Notifications');

  await test('GET /notifications returns array + unreadCount', async () => {
    const res = await req('GET', '/api/notifications', null, state.token);
    assertStatus(res, 200);
    assertField(res.body, 'notifications');
    assertField(res.body, 'unreadCount');
    assert.ok(typeof res.body.unreadCount === 'number');
  });

  await test('PATCH /notifications/read-all succeeds', async () => {
    const res = await req('PATCH', '/api/notifications/read-all', null, state.token);
    assertStatus(res, 200);
    assert.strictEqual(res.body.success, true);
  });

  await test('Notifications require auth', async () => {
    const res = await req('GET', '/api/notifications');
    assertStatus(res, 401);
  });
}

async function testRateLimiting() {
  console.log('\n🛡️  Rate Limiting');

  await test('Auth endpoint rate-limits after 10 attempts', async () => {
    // Fire 12 rapid login attempts
    let tooManyCount = 0;
    for (let i = 0; i < 12; i++) {
      const res = await req('POST', '/api/auth/login', {
        username: 'nobody_rate_test',
        password: 'bad',
      });
      if (res.status === 429) tooManyCount++;
    }
    assert.ok(tooManyCount >= 1, `Expected at least one 429, got ${tooManyCount}`);
  });
}

async function testDMRooms() {
  console.log('\n💬 Direct Messages');

  // Register two users
  const ts = Date.now();
  const u1 = await req('POST', '/api/auth/register', {
    username: `dm_u1_${ts}`, displayName: `DM User1 ${ts}`,
    email: `dm1_${ts}@test.com`, password: 'pass123',
  });
  const u2 = await req('POST', '/api/auth/register', {
    username: `dm_u2_${ts}`, displayName: `DM User2 ${ts}`,
    email: `dm2_${ts}@test.com`, password: 'pass123',
  });

  state.dmToken1 = u1.body.token;
  state.dmToken2 = u2.body.token;
  state.dmUser2Id = u2.body.user.id;

  await test('POST /rooms/direct creates DM room', async () => {
    const res = await req('POST', '/api/rooms/direct',
      { targetUserId: state.dmUser2Id }, state.dmToken1);
    assertStatus(res, 201);
    assertField(res.body, 'room');
    assert.strictEqual(res.body.room.room_type, 'direct');
    assert.strictEqual(res.body.existing, false);
    state.dmRoomId = res.body.room.id;
  });

  await test('POST /rooms/direct returns existing room on repeat', async () => {
    const res = await req('POST', '/api/rooms/direct',
      { targetUserId: state.dmUser2Id }, state.dmToken1);
    assertStatus(res, 200);
    assert.strictEqual(res.body.existing, true);
    assert.strictEqual(res.body.room.id, state.dmRoomId);
  });

  await test('POST /rooms/direct with missing targetUserId fails', async () => {
    const res = await req('POST', '/api/rooms/direct', {}, state.dmToken1);
    assertStatus(res, 400);
  });

  await test('POST /rooms/direct with unknown user fails', async () => {
    const res = await req('POST', '/api/rooms/direct',
      { targetUserId: '00000000-0000-0000-0000-000000000000' }, state.dmToken1);
    assertStatus(res, 404);
  });
}

async function testEdgeCases() {
  console.log('\n⚠️  Edge Cases');

  await test('Unknown API route returns something sensible', async () => {
    const res = await req('GET', '/api/nonexistent_endpoint_xyz', null, state.token);
    // Should be 404 (served as HTML catch-all or JSON error)
    assert.ok([404, 200].includes(res.status)); // 200 = SPA fallback
  });

  await test('Large room name is rejected', async () => {
    const res = await req('POST', '/api/rooms', {
      name: 'x'.repeat(200),
    }, state.token);
    // Should fail — either 400 (validation) or 500 (DB constraint)
    assert.ok([400, 500].includes(res.status));
  });

  await test('GET /rooms/:id with invalid UUID returns error', async () => {
    const res = await req('GET', '/api/rooms/not-a-uuid', null, state.token);
    assert.ok([400, 403, 404, 500].includes(res.status));
  });
}

// ─── Runner ───────────────────────────────────────────────
async function run() {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║     NexChat Test Suite               ║');
  console.log(`║     Target: ${BASE}`.padEnd(43) + '║');
  console.log('╚══════════════════════════════════════╝');

  try {
    await testHealth();
    await testAuth();
    await testRooms();
    await testSearch();
    await testNotifications();
    await testDMRooms();
    await testEdgeCases();
    await testRateLimiting(); // Last — exhausts rate limit
  } catch (err) {
    console.error('\n💥 Unexpected test runner error:', err.message);
  }

  console.log('');
  console.log('─'.repeat(44));
  console.log(`Results: ${passed + failed} tests | ✅ ${passed} passed | ❌ ${failed} failed`);
  console.log('─'.repeat(44));
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

run();
