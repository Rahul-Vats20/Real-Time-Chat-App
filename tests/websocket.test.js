// tests/websocket.test.js — WebSocket integration tests
// Requires socket.io-client: npm install socket.io-client --save-dev
// Run with: node tests/websocket.test.js

const { io } = require('socket.io-client');
const http = require('http');

const BASE = process.env.TEST_URL || 'http://localhost:3001';
let passed = 0;
let failed = 0;
const cleanup = [];

// ─── Helpers ──────────────────────────────────────────────
function httpReq(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname + url.search,
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function connectSocket(token) {
  const socket = io(BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000,
  });
  cleanup.push(() => socket.disconnect());
  return socket;
}

function waitFor(socket, event, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for "${event}" after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

function waitForCondition(socket, event, condition, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event} matching condition`)), timeoutMs);
    const handler = (data) => {
      if (condition(data)) {
        clearTimeout(timer);
        socket.off(event, handler);
        resolve(data);
      }
    };
    socket.on(event, handler);
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

// ─── Setup: register two test users ────────────────────────
let userA, userB, testRoomId;

async function setup() {
  const ts = Date.now();

  const regA = await httpReq('POST', '/api/auth/register', {
    username: `ws_a_${ts}`,
    displayName: `WS User A`,
    email: `ws_a_${ts}@test.com`,
    password: 'testpass123',
  });
  const regB = await httpReq('POST', '/api/auth/register', {
    username: `ws_b_${ts}`,
    displayName: `WS User B`,
    email: `ws_b_${ts}@test.com`,
    password: 'testpass123',
  });

  if (!regA.body.token || !regB.body.token) {
    throw new Error('Failed to register test users');
  }

  userA = regA.body;
  userB = regB.body;

  // Create a shared room with both users
  const room = await httpReq('POST', '/api/rooms', {
    name: `ws-test-${ts}`,
    memberIds: [userA.user.id, userB.user.id],
  }, userA.token);

  testRoomId = room.body.room.id;
  console.log(`  🏗  Test room: ${room.body.room.name} (${testRoomId})`);
  console.log(`  👤 User A: ${userA.user.username} | User B: ${userB.user.username}`);
}

// ─── Test suites ───────────────────────────────────────────

async function testConnection() {
  console.log('\n🔌 Connection');

  await test('Connect with valid token', async () => {
    const socket = connectSocket(userA.token);
    await waitFor(socket, 'connect');
    if (!socket.connected) throw new Error('Socket not connected');
  });

  await test('Connect with invalid token is rejected', async () => {
    const socket = io(BASE, {
      auth: { token: 'invalid.token.here' },
      transports: ['websocket'],
      reconnection: false,
      timeout: 3000,
    });
    cleanup.push(() => socket.disconnect());
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Expected connect_error')), 3000);
      socket.on('connect_error', (err) => {
        clearTimeout(timer);
        resolve(err);
      });
      socket.on('connect', () => {
        clearTimeout(timer);
        reject(new Error('Should not have connected with invalid token'));
      });
    });
  });

  await test('Receive online_users on connect', async () => {
    const socket = connectSocket(userA.token);
    const data = await waitFor(socket, 'online_users');
    if (!Array.isArray(data.userIds)) throw new Error('online_users.userIds should be array');
  });
}

async function testRooms() {
  console.log('\n🏠 Room Events');

  await test('join_room receives room_history', async () => {
    const socket = connectSocket(userA.token);
    await waitFor(socket, 'connect');
    socket.emit('join_room', { roomId: testRoomId });
    const data = await waitFor(socket, 'room_history');
    if (data.roomId !== testRoomId) throw new Error('Wrong room in history');
    if (!Array.isArray(data.messages)) throw new Error('Expected messages array');
  });

  await test('join_room with invalid roomId emits error', async () => {
    const socket = connectSocket(userA.token);
    await waitFor(socket, 'connect');
    socket.emit('join_room', { roomId: '00000000-0000-0000-0000-000000000000' });
    const err = await waitFor(socket, 'error');
    if (!err.message) throw new Error('Expected error message');
  });
}

async function testMessaging() {
  console.log('\n💬 Messaging');

  await test('send_message broadcasts to all room members', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([
      waitFor(socketA, 'connect'),
      waitFor(socketB, 'connect'),
    ]);

    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });

    await Promise.all([
      waitFor(socketA, 'room_history'),
      waitFor(socketB, 'room_history'),
    ]);

    const content = `Test message ${Date.now()}`;
    socketA.emit('send_message', { roomId: testRoomId, content });

    // Both A and B should receive it
    const [dataA, dataB] = await Promise.all([
      waitFor(socketA, 'new_message'),
      waitFor(socketB, 'new_message'),
    ]);

    if (dataA.message.content !== content) throw new Error('A did not get correct message');
    if (dataB.message.content !== content) throw new Error('B did not get correct message');
    if (dataA.message.sender.id !== userA.user.id) throw new Error('Wrong sender ID');
  });

  await test('Empty message is rejected', async () => {
    const socket = connectSocket(userA.token);
    await waitFor(socket, 'connect');
    socket.emit('join_room', { roomId: testRoomId });
    await waitFor(socket, 'room_history');
    socket.emit('send_message', { roomId: testRoomId, content: '   ' });
    const err = await waitFor(socket, 'error');
    if (!err.message.includes('empty')) throw new Error(`Expected "empty" error, got: ${err.message}`);
  });

  await test('Message sent to non-member room is rejected', async () => {
    // Register a user who is NOT in the test room
    const ts = Date.now();
    const reg = await httpReq('POST', '/api/auth/register', {
      username: `outsider_ws_${ts}`, displayName: 'Outsider',
      email: `outsider_ws_${ts}@test.com`, password: 'pass123',
    });
    const socket = connectSocket(reg.body.token);
    await waitFor(socket, 'connect');
    socket.emit('send_message', { roomId: testRoomId, content: 'Sneak attack' });
    const err = await waitFor(socket, 'error');
    if (!err.message) throw new Error('Expected error');
  });
}

async function testReadReceipts() {
  console.log('\n✓ Read Receipts');

  await test('mark_read emits message_read to room', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);
    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });
    await Promise.all([waitFor(socketA, 'room_history'), waitFor(socketB, 'room_history')]);

    // A sends a message
    const content = `Read receipt test ${Date.now()}`;
    socketA.emit('send_message', { roomId: testRoomId, content });
    const msgData = await waitFor(socketB, 'new_message');
    const messageId = msgData.message.id;

    // B marks it as read
    socketB.emit('mark_read', { roomId: testRoomId, messageId });

    // A should receive the read receipt
    const readData = await waitForCondition(
      socketA, 'message_read',
      (d) => d.messageId === messageId,
    );

    if (readData.userId !== userB.user.id) throw new Error('Wrong user in read receipt');
    if (!readData.readAt) throw new Error('Missing readAt timestamp');
  });
}

async function testTypingIndicators() {
  console.log('\n⌨️  Typing Indicators');

  await test('typing_start broadcasts user_typing', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);
    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });
    await Promise.all([waitFor(socketA, 'room_history'), waitFor(socketB, 'room_history')]);

    socketA.emit('typing_start', { roomId: testRoomId });

    const typingData = await waitForCondition(
      socketB, 'user_typing',
      (d) => d.userId === userA.user.id,
    );

    if (typingData.roomId !== testRoomId) throw new Error('Wrong roomId in typing event');
    if (!typingData.display_name) throw new Error('Missing display_name in typing event');
  });

  await test('typing_stop broadcasts user_stopped_typing', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);
    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });
    await Promise.all([waitFor(socketA, 'room_history'), waitFor(socketB, 'room_history')]);

    socketA.emit('typing_start', { roomId: testRoomId });
    await waitFor(socketB, 'user_typing');

    socketA.emit('typing_stop', { roomId: testRoomId });

    const stoppedData = await waitForCondition(
      socketB, 'user_stopped_typing',
      (d) => d.userId === userA.user.id,
    );

    if (stoppedData.roomId !== testRoomId) throw new Error('Wrong roomId in stopped typing event');
  });
}

async function testMessageEditing() {
  console.log('\n✏️  Message Editing & Deletion');

  let testMessageId;

  await test('edit_message broadcasts message_edited', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);
    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });
    await Promise.all([waitFor(socketA, 'room_history'), waitFor(socketB, 'room_history')]);

    // Send original
    socketA.emit('send_message', { roomId: testRoomId, content: 'Original content' });
    const msgData = await waitFor(socketA, 'new_message');
    testMessageId = msgData.message.id;

    // Edit it
    socketA.emit('edit_message', { messageId: testMessageId, newContent: 'Edited content' });

    const editData = await waitFor(socketB, 'message_edited');
    if (editData.message.id !== testMessageId) throw new Error('Wrong message ID in edit event');
    if (editData.message.content !== 'Edited content') throw new Error('Content not updated');
    if (!editData.message.edited) throw new Error('edited flag not set');
  });

  await test('Cannot edit another user\'s message', async () => {
    const socketB = connectSocket(userB.token);
    await waitFor(socketB, 'connect');
    socketB.emit('join_room', { roomId: testRoomId });
    await waitFor(socketB, 'room_history');

    socketB.emit('edit_message', { messageId: testMessageId, newContent: 'Hacked!' });
    const err = await waitFor(socketB, 'error');
    if (!err.message) throw new Error('Expected error when editing others message');
  });

  await test('delete_message broadcasts message_deleted', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);
    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });
    await Promise.all([waitFor(socketA, 'room_history'), waitFor(socketB, 'room_history')]);

    socketA.emit('send_message', { roomId: testRoomId, content: 'To be deleted' });
    const msgData = await waitFor(socketA, 'new_message');
    const delMsgId = msgData.message.id;

    socketA.emit('delete_message', { messageId: delMsgId });

    const delData = await waitForCondition(
      socketB, 'message_deleted',
      (d) => d.messageId === delMsgId,
    );

    if (delData.roomId !== testRoomId) throw new Error('Wrong roomId in delete event');
  });
}

async function testPresence() {
  console.log('\n👥 Presence');

  await test('Connecting broadcasts user_status_change (online)', async () => {
    const socketA = connectSocket(userA.token);
    await waitFor(socketA, 'connect');

    const socketB = connectSocket(userB.token);

    // A should see B come online
    const statusData = await waitForCondition(
      socketA, 'user_status_change',
      (d) => d.userId === userB.user.id && d.status === 'online',
      4000,
    );

    if (statusData.status !== 'online') throw new Error('Expected online status');
  });

  await test('update_status emits user_status_change', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);

    socketB.emit('update_status', { status: 'away' });

    const statusData = await waitForCondition(
      socketA, 'user_status_change',
      (d) => d.userId === userB.user.id && d.status === 'away',
    );

    if (statusData.status !== 'away') throw new Error(`Expected 'away', got '${statusData.status}'`);
  });
}

async function testReactions() {
  console.log('\n😊 Reactions');

  await test('toggle_reaction broadcasts reaction_updated', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);
    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });
    await Promise.all([waitFor(socketA, 'room_history'), waitFor(socketB, 'room_history')]);

    socketA.emit('send_message', { roomId: testRoomId, content: 'React to this' });
    const msgData = await waitFor(socketA, 'new_message');
    const msgId = msgData.message.id;

    socketB.emit('toggle_reaction', { messageId: msgId, emoji: '👍' });

    const reactionData = await waitForCondition(
      socketA, 'reaction_updated',
      (d) => d.messageId === msgId,
    );

    const thumbsUp = reactionData.reactions.find(r => r.emoji === '👍');
    if (!thumbsUp) throw new Error('Expected 👍 reaction in update');
    if (thumbsUp.count !== 1) throw new Error(`Expected count 1, got ${thumbsUp.count}`);
  });

  await test('toggle_reaction again removes it', async () => {
    const socketA = connectSocket(userA.token);
    const socketB = connectSocket(userB.token);

    await Promise.all([waitFor(socketA, 'connect'), waitFor(socketB, 'connect')]);
    socketA.emit('join_room', { roomId: testRoomId });
    socketB.emit('join_room', { roomId: testRoomId });
    await Promise.all([waitFor(socketA, 'room_history'), waitFor(socketB, 'room_history')]);

    socketA.emit('send_message', { roomId: testRoomId, content: 'Toggle test' });
    const msgData = await waitFor(socketA, 'new_message');
    const msgId = msgData.message.id;

    // Add reaction
    socketB.emit('toggle_reaction', { messageId: msgId, emoji: '❤️' });
    await waitForCondition(socketA, 'reaction_updated', (d) => d.messageId === msgId);

    // Remove reaction
    socketB.emit('toggle_reaction', { messageId: msgId, emoji: '❤️' });
    const removeData = await waitForCondition(
      socketA, 'reaction_updated',
      (d) => d.messageId === msgId && !d.reactions.find(r => r.emoji === '❤️'),
    );

    if (removeData.reactions.find(r => r.emoji === '❤️')) {
      throw new Error('Reaction should have been removed');
    }
  });
}

// ─── Runner ───────────────────────────────────────────────
async function run() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║   NexChat WebSocket Integration Tests   ║');
  console.log(`║   Target: ${BASE.padEnd(30)}║`);
  console.log('╚══════════════════════════════════════════╝');

  try {
    console.log('\n⚙️  Setup');
    await setup();
    console.log('  ✅ Test users and room created');
  } catch (err) {
    console.error(`  ❌ Setup failed: ${err.message}`);
    process.exit(1);
  }

  try {
    await testConnection();
    await testRooms();
    await testMessaging();
    await testReadReceipts();
    await testTypingIndicators();
    await testMessageEditing();
    await testPresence();
    await testReactions();
  } catch (err) {
    console.error('\n💥 Unexpected runner error:', err.message);
  } finally {
    // Disconnect all sockets
    cleanup.forEach(fn => { try { fn(); } catch {} });
  }

  console.log('');
  console.log('─'.repeat(44));
  console.log(`Results: ${passed + failed} tests | ✅ ${passed} passed | ❌ ${failed} failed`);
  console.log('─'.repeat(44));
  console.log('');

  process.exit(failed > 0 ? 1 : 0);
}

run();
