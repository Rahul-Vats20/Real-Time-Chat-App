#!/usr/bin/env node
// tests/load-test.js — WebSocket load tester
// Usage: node tests/load-test.js [--users 50] [--duration 30] [--url http://localhost:3001]
//
// Simulates N concurrent users connecting, joining rooms, and sending messages.
// Reports: messages/sec, latency percentiles, connection success rate, error rate.

const { io } = require('socket.io-client');
const http = require('http');

// ─── CLI args ─────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const CONFIG = {
  url: getArg('--url', 'http://localhost:3001'),
  users: parseInt(getArg('--users', '20')),
  duration: parseInt(getArg('--duration', '15')),  // seconds
  msgInterval: parseInt(getArg('--msg-interval', '2000')), // ms between messages per user
  rampUp: parseInt(getArg('--ramp', '3')),  // seconds to ramp up all users
};

// ─── Metrics ──────────────────────────────────────────────
const metrics = {
  connects: 0,
  connectFails: 0,
  messagesSent: 0,
  messagesReceived: 0,
  errors: 0,
  latencies: [],   // ms per roundtrip
  startTime: null,
  endTime: null,
};

// ─── REST helper (no deps) ────────────────────────────────
function httpPost(path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const url = new URL(CONFIG.url + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || 3001,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ─── Register & login test users ─────────────────────────
async function setupUsers() {
  const users = [];
  const ts = Date.now();

  process.stdout.write(`Registering ${CONFIG.users} test users...`);

  const batchSize = 5;
  for (let i = 0; i < CONFIG.users; i += batchSize) {
    const batch = [];
    for (let j = i; j < Math.min(i + batchSize, CONFIG.users); j++) {
      batch.push(httpPost('/api/auth/register', {
        username: `loaduser_${ts}_${j}`,
        displayName: `Load User ${j}`,
        email: `load_${ts}_${j}@test.com`,
        password: 'testpass123',
      }).catch(() => httpPost('/api/auth/login', {
        username: `loaduser_${ts}_${j}`,
        password: 'testpass123',
      })));
    }
    const results = await Promise.all(batch);
    for (const r of results) {
      if (r.token) users.push({ token: r.token, rooms: [] });
    }
    process.stdout.write('.');
  }

  console.log(` done (${users.length} users)`);
  return users;
}

// ─── Simulate one user ────────────────────────────────────
function simulateUser(user, roomId, userIndex, onDone) {
  let connected = false;
  let sendInterval = null;
  const pendingPings = new Map(); // pingId -> sentAt

  const delay = (userIndex / CONFIG.users) * CONFIG.rampUp * 1000;

  setTimeout(() => {
    const socket = io(CONFIG.url, {
      auth: { token: user.token },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    });

    socket.on('connect', () => {
      connected = true;
      metrics.connects++;

      // Join the test room
      socket.emit('join_room', { roomId });

      // Start sending messages at interval
      sendInterval = setInterval(() => {
        if (!connected) return;

        const pingId = Math.random().toString(36).slice(2);
        const sentAt = Date.now();
        pendingPings.set(pingId, sentAt);

        socket.emit('send_message', {
          roomId,
          content: `[load-test] ping:${pingId} from user:${userIndex} at:${sentAt}`,
        });
        metrics.messagesSent++;
      }, CONFIG.msgInterval);
    });

    socket.on('new_message', ({ message }) => {
      metrics.messagesReceived++;

      // Parse latency from ping messages
      const match = message.content?.match(/ping:(\w+).*at:(\d+)/);
      if (match) {
        const pingId = match[1];
        const sentAt = parseInt(match[2]);
        if (pendingPings.has(pingId)) {
          metrics.latencies.push(Date.now() - sentAt);
          pendingPings.delete(pingId);
        }
      }
    });

    socket.on('connect_error', (err) => {
      metrics.connectFails++;
      onDone();
    });

    socket.on('error', () => {
      metrics.errors++;
    });

    // Disconnect after duration
    setTimeout(() => {
      clearInterval(sendInterval);
      connected = false;
      socket.disconnect();
      onDone();
    }, (CONFIG.rampUp + CONFIG.duration) * 1000);

  }, delay);
}

// ─── Stats calculator ─────────────────────────────────────
function percentile(arr, p) {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

function mean(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function printResults() {
  const duration = (metrics.endTime - metrics.startTime) / 1000;
  const msgPerSec = (metrics.messagesSent / duration).toFixed(1);
  const recvPerSec = (metrics.messagesReceived / duration).toFixed(1);
  const successRate = metrics.connects > 0
    ? ((metrics.connects / (metrics.connects + metrics.connectFails)) * 100).toFixed(1)
    : 0;

  const lats = metrics.latencies;

  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║           LOAD TEST RESULTS                   ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Config                                        ║`);
  console.log(`║    Users:           ${String(CONFIG.users).padEnd(26)}║`);
  console.log(`║    Duration:        ${String(CONFIG.duration + 's').padEnd(26)}║`);
  console.log(`║    Msg interval:    ${String(CONFIG.msgInterval + 'ms').padEnd(26)}║`);
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Connections                                   ║`);
  console.log(`║    Success:         ${String(metrics.connects).padEnd(26)}║`);
  console.log(`║    Failed:          ${String(metrics.connectFails).padEnd(26)}║`);
  console.log(`║    Success rate:    ${String(successRate + '%').padEnd(26)}║`);
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Throughput                                    ║`);
  console.log(`║    Messages sent:   ${String(metrics.messagesSent).padEnd(26)}║`);
  console.log(`║    Messages recv:   ${String(metrics.messagesReceived).padEnd(26)}║`);
  console.log(`║    Send rate:       ${String(msgPerSec + '/sec').padEnd(26)}║`);
  console.log(`║    Recv rate:       ${String(recvPerSec + '/sec').padEnd(26)}║`);
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Roundtrip Latency (${lats.length} samples)${' '.repeat(Math.max(0, 23 - String(lats.length).length - 9))}║`);
  console.log(`║    Mean:            ${String(mean(lats).toFixed(1) + 'ms').padEnd(26)}║`);
  console.log(`║    p50:             ${String(percentile(lats, 50) + 'ms').padEnd(26)}║`);
  console.log(`║    p90:             ${String(percentile(lats, 90) + 'ms').padEnd(26)}║`);
  console.log(`║    p99:             ${String(percentile(lats, 99) + 'ms').padEnd(26)}║`);
  console.log(`║    Max:             ${String(percentile(lats, 100) + 'ms').padEnd(26)}║`);
  console.log('╠═══════════════════════════════════════════════╣');
  console.log(`║  Errors:            ${String(metrics.errors).padEnd(26)}║`);
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');

  // Health assessment
  const p99 = percentile(lats, 99);
  const srNum = parseFloat(successRate);
  if (srNum >= 99 && p99 < 200) {
    console.log('🟢 Excellent — p99 < 200ms, connection rate ≥ 99%');
  } else if (srNum >= 95 && p99 < 500) {
    console.log('🟡 Good — p99 < 500ms, connection rate ≥ 95%');
  } else if (srNum >= 90) {
    console.log('🟠 Degraded — some connections failed or high latency');
  } else {
    console.log('🔴 Poor — significant failures detected');
  }
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────
async function main() {
  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║         NexChat WebSocket Load Tester         ║');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
  console.log(`Target:    ${CONFIG.url}`);
  console.log(`Users:     ${CONFIG.users}`);
  console.log(`Duration:  ${CONFIG.duration}s`);
  console.log(`Ramp-up:   ${CONFIG.rampUp}s`);
  console.log('');

  // Check server is up
  try {
    await new Promise((res, rej) => {
      const req = http.get(CONFIG.url + '/health', r => {
        if (r.statusCode === 200) res();
        else rej(new Error(`Health check failed: ${r.statusCode}`));
      });
      req.on('error', rej);
    });
    console.log('✅ Server is reachable\n');
  } catch (err) {
    console.error(`❌ Server not reachable at ${CONFIG.url}: ${err.message}`);
    console.error('   Start the server first with: npm start');
    process.exit(1);
  }

  // Set up users
  const users = await setupUsers();
  if (!users.length) {
    console.error('❌ Failed to create any test users');
    process.exit(1);
  }

  // Get or create a test room (join General)
  const rooms = await new Promise((resolve) => {
    const req = http.request({
      hostname: new URL(CONFIG.url).hostname,
      port: new URL(CONFIG.url).port || 3001,
      path: '/api/rooms',
      method: 'GET',
      headers: { Authorization: `Bearer ${users[0].token}` },
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).rooms || []); }
        catch { resolve([]); }
      });
    });
    req.end();
  });

  const roomId = rooms[0]?.id;
  if (!roomId) {
    console.error('❌ No rooms available for testing');
    process.exit(1);
  }
  console.log(`\n🏠 Testing with room: ${rooms[0]?.name || roomId}`);
  console.log(`👥 Simulating ${users.length} concurrent users...`);
  console.log(`⏱  Running for ${CONFIG.duration}s (+ ${CONFIG.rampUp}s ramp-up)\n`);

  // Progress ticker
  metrics.startTime = Date.now();
  const progressInterval = setInterval(() => {
    const elapsed = ((Date.now() - metrics.startTime) / 1000).toFixed(0);
    process.stdout.write(
      `\r  ⚡ ${elapsed}s | connected: ${metrics.connects} | sent: ${metrics.messagesSent} | recv: ${metrics.messagesReceived} | errors: ${metrics.errors}   `
    );
  }, 500);

  // Start all users
  let doneCount = 0;
  await new Promise(resolve => {
    for (let i = 0; i < users.length; i++) {
      simulateUser(users[i], roomId, i, () => {
        doneCount++;
        if (doneCount >= users.length) resolve();
      });
    }
  });

  clearInterval(progressInterval);
  metrics.endTime = Date.now();
  console.log('');

  printResults();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
