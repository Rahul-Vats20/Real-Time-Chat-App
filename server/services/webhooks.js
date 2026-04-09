// server/services/webhooks.js
// Outbound webhook delivery with HMAC signing, retry logic, and delivery logs.
// Webhooks are triggered by events from the Redis event bus or socket handlers.

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { query } = require('../db/postgres');

const MAX_RETRIES = 3;
const RETRY_DELAYS = [5_000, 30_000, 300_000]; // 5s, 30s, 5m
const DELIVERY_TIMEOUT = 10_000; // 10s per attempt

// ── HMAC signature ────────────────────────────────────────
function signPayload(secret, payload) {
  return 'sha256=' + crypto
    .createHmac('sha256', secret)
    .update(typeof payload === 'string' ? payload : JSON.stringify(payload))
    .digest('hex');
}

// ── HTTP delivery ─────────────────────────────────────────
function deliverHttp(url, payload, signature) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);
    const mod = parsed.protocol === 'https:' ? https : http;

    const req = mod.request({
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent': 'NexChat-Webhook/1.0',
        'X-NexChat-Signature': signature,
        'X-NexChat-Timestamp': Date.now().toString(),
      },
      timeout: DELIVERY_TIMEOUT,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        body: data.slice(0, 500), // cap response body
        success: res.statusCode >= 200 && res.statusCode < 300,
      }));
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Webhook timeout after ${DELIVERY_TIMEOUT}ms`));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Core delivery function ────────────────────────────────
async function deliverWebhook(webhookId, event, payload, attempt = 1) {
  let webhook;
  try {
    const result = await query(
      'SELECT id, url, secret, name FROM webhooks WHERE id = $1 AND enabled = TRUE',
      [webhookId]
    );
    if (!result.rows.length) return; // webhook disabled or deleted
    webhook = result.rows[0];
  } catch (err) {
    console.error('[Webhook] DB fetch error:', err.message);
    return;
  }

  const fullPayload = {
    id: crypto.randomUUID(),
    event,
    timestamp: new Date().toISOString(),
    attempt,
    data: payload,
  };

  const signature = webhook.secret
    ? signPayload(webhook.secret, fullPayload)
    : 'unsigned';

  let deliveryResult;
  let errorMessage = null;
  const startTime = Date.now();

  try {
    deliveryResult = await deliverHttp(webhook.url, fullPayload, signature);
  } catch (err) {
    errorMessage = err.message;
    deliveryResult = { success: false, statusCode: 0 };
  }

  const duration = Date.now() - startTime;

  // Log delivery attempt
  await query(
    `INSERT INTO webhook_deliveries
       (webhook_id, event, payload, response_status, response_body, duration_ms, success, error, attempt)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      webhookId,
      event,
      JSON.stringify(payload),
      deliveryResult.statusCode,
      deliveryResult.body || errorMessage,
      duration,
      deliveryResult.success,
      errorMessage,
      attempt,
    ]
  ).catch(err => console.error('[Webhook] Log error:', err.message));

  // Update last_triggered_at
  await query(
    'UPDATE webhooks SET last_triggered_at = NOW() WHERE id = $1',
    [webhookId]
  ).catch(() => {});

  // Schedule retry on failure
  if (!deliveryResult.success && attempt <= MAX_RETRIES) {
    const delay = RETRY_DELAYS[attempt - 1] || 60_000;
    console.warn(`[Webhook] ${webhook.name} failed (attempt ${attempt}), retrying in ${delay}ms`);
    setTimeout(() => deliverWebhook(webhookId, event, payload, attempt + 1), delay);
  } else if (deliveryResult.success) {
    console.log(`[Webhook] ${webhook.name} delivered "${event}" in ${duration}ms`);
  } else {
    console.error(`[Webhook] ${webhook.name} failed after ${MAX_RETRIES} attempts`);
  }

  return deliveryResult;
}

// ── Trigger webhooks for an event ─────────────────────────
async function triggerWebhooks(roomId, event, payload) {
  try {
    const result = await query(
      `SELECT id FROM webhooks
       WHERE room_id = $1 AND enabled = TRUE AND $2 = ANY(events)`,
      [roomId, event]
    );

    for (const { id } of result.rows) {
      // Fire-and-forget (non-blocking)
      setImmediate(() => deliverWebhook(id, event, payload));
    }

    return result.rows.length;
  } catch (err) {
    console.error('[Webhook] triggerWebhooks error:', err.message);
    return 0;
  }
}

// ── REST routes for webhook management ────────────────────
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// POST /api/webhooks — Create webhook
router.post('/', requireAuth, async (req, res) => {
  try {
    const { roomId, name, url, secret, events = ['message.sent'] } = req.body;
    if (!roomId || !name || !url) {
      return res.status(400).json({ error: 'roomId, name, and url required' });
    }

    // Validate URL
    try { new URL(url); } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }

    // Must be room admin
    const adminCheck = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2 AND role = 'admin'`,
      [roomId, req.user.userId]
    );
    if (!adminCheck.rows.length) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const result = await query(
      `INSERT INTO webhooks (room_id, created_by, name, url, secret, events)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, url, events, enabled, created_at`,
      [roomId, req.user.userId, name, url, secret || null, events]
    );

    res.status(201).json({ webhook: result.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create webhook' });
  }
});

// GET /api/webhooks/room/:roomId — List webhooks for room
router.get('/room/:roomId', requireAuth, async (req, res) => {
  try {
    const adminCheck = await query(
      `SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2 AND role = 'admin'`,
      [req.params.roomId, req.user.userId]
    );
    if (!adminCheck.rows.length) {
      return res.status(403).json({ error: 'Admin only' });
    }

    const result = await query(
      `SELECT id, name, url, events, enabled, last_triggered_at, created_at
       FROM webhooks WHERE room_id = $1 ORDER BY created_at DESC`,
      [req.params.roomId]
    );
    res.json({ webhooks: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch webhooks' });
  }
});

// POST /api/webhooks/:id/test — Send test ping
router.post('/:id/test', requireAuth, async (req, res) => {
  try {
    const result = await deliverWebhook(req.params.id, 'ping', {
      message: 'This is a test webhook from NexChat',
      triggeredBy: req.user.userId,
    });
    res.json({ result });
  } catch (err) {
    res.status(500).json({ error: 'Test delivery failed' });
  }
});

// PATCH /api/webhooks/:id — Update webhook
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { enabled, name, url, events } = req.body;
    const updates = []; const vals = [];
    let i = 1;
    if (enabled !== undefined) { updates.push(`enabled=$${i++}`); vals.push(enabled); }
    if (name)    { updates.push(`name=$${i++}`);    vals.push(name); }
    if (url)     { updates.push(`url=$${i++}`);     vals.push(url); }
    if (events)  { updates.push(`events=$${i++}`);  vals.push(events); }
    if (!updates.length) return res.status(400).json({ error: 'Nothing to update' });

    vals.push(req.params.id, req.user.userId);
    await query(
      `UPDATE webhooks SET ${updates.join(',')}
       WHERE id = $${i} AND created_by = $${i + 1}`,
      vals
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update webhook' });
  }
});

// DELETE /api/webhooks/:id
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    await query(
      'DELETE FROM webhooks WHERE id = $1 AND created_by = $2',
      [req.params.id, req.user.userId]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete webhook' });
  }
});

module.exports = router;
module.exports.triggerWebhooks = triggerWebhooks;
module.exports.deliverWebhook = deliverWebhook;
module.exports.signPayload = signPayload;
