// services/pushNotifications.js
// Server-side Web Push using VAPID protocol.
// Sends push notifications to subscribed browsers even when app is closed.
//
// Setup:
//   1. Generate VAPID keys: node -e "require('web-push').generateVAPIDKeys()" 
//   2. Add to .env: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_EMAIL
//   3. npm install web-push

const { query } = require('../db/postgres');
const express = require('express');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Lazy-load web-push (optional dependency)
let webpush = null;
function getWebPush() {
  if (webpush) return webpush;
  try {
    webpush = require('web-push');
    if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
      webpush.setVapidDetails(
        `mailto:${process.env.VAPID_EMAIL || 'admin@nexchat.app'}`,
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
      );
      console.log('✅ Web Push: VAPID configured');
    } else {
      console.warn('⚠️  Web Push: VAPID keys not set — push notifications disabled');
      webpush = null;
    }
    return webpush;
  } catch {
    console.warn('⚠️  Web Push: web-push package not installed (npm install web-push)');
    return null;
  }
}

// ── GET /api/push/vapid-key — Public VAPID key for client ─
router.get('/vapid-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Push notifications not configured' });
  res.json({ publicKey: key });
});

// ── POST /api/push/subscribe — Save browser subscription ──
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { subscription, deviceName = 'Browser' } = req.body;
    if (!subscription?.endpoint) {
      return res.status(400).json({ error: 'Invalid subscription object' });
    }

    // Upsert subscription (one per endpoint per user)
    await query(
      `INSERT INTO push_subscriptions (user_id, endpoint, keys, device_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET
         user_id = $1, keys = $3, device_name = $4, updated_at = NOW()`,
      [
        req.user.userId,
        subscription.endpoint,
        JSON.stringify(subscription.keys || {}),
        deviceName,
      ]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('[Push] subscribe error:', err);
    res.status(500).json({ error: 'Failed to save subscription' });
  }
});

// ── DELETE /api/push/unsubscribe — Remove subscription ────
router.delete('/unsubscribe', requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await query(
      'DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
      [req.user.userId, endpoint]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to remove subscription' });
  }
});

// ── POST /api/push/test — Send test push to self ──────────
router.post('/test', requireAuth, async (req, res) => {
  const sent = await sendPushToUser(req.user.userId, {
    title: 'NexChat Test',
    body: 'Push notifications are working! ✅',
    tag: 'test',
    url: '/',
  });
  res.json({ sent, message: sent > 0 ? 'Test push sent' : 'No subscriptions found' });
});

// ── Core: send push to a user (all their devices) ─────────
async function sendPushToUser(userId, payload) {
  const wp = getWebPush();
  if (!wp) return 0;

  let subs;
  try {
    const result = await query(
      'SELECT endpoint, keys FROM push_subscriptions WHERE user_id = $1',
      [userId]
    );
    subs = result.rows;
  } catch (err) {
    console.error('[Push] DB error:', err.message);
    return 0;
  }

  if (!subs.length) return 0;

  let sent = 0;
  const expired = [];

  await Promise.all(subs.map(async (sub) => {
    try {
      const subscription = {
        endpoint: sub.endpoint,
        keys: typeof sub.keys === 'string' ? JSON.parse(sub.keys) : sub.keys,
      };

      await wp.sendNotification(subscription, JSON.stringify({
        title: payload.title || 'NexChat',
        body: payload.body || '',
        icon: '/icons/icon-192.png',
        badge: '/icons/badge-72.png',
        tag: payload.tag || 'nexchat',
        url: payload.url || '/',
        roomId: payload.roomId,
        data: payload.data || {},
      }));
      sent++;
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expired/unsubscribed — clean up
        expired.push(sub.endpoint);
      } else {
        console.error('[Push] delivery error:', err.message);
      }
    }
  }));

  // Clean up expired subscriptions
  if (expired.length) {
    await query(
      'DELETE FROM push_subscriptions WHERE endpoint = ANY($1)',
      [expired]
    ).catch(() => {});
  }

  return sent;
}

// ── Send push to all members of a room (except sender) ────
async function sendRoomPush(roomId, senderId, payload) {
  const wp = getWebPush();
  if (!wp) return;

  try {
    const members = await query(
      `SELECT rm.user_id FROM room_members rm
       WHERE rm.room_id = $1 AND rm.user_id != $2`,
      [roomId, senderId]
    );

    // Check user preferences before sending
    const prefs = await query(
      `SELECT user_id, notify_mentions, notify_replies
       FROM user_preferences
       WHERE user_id = ANY($1)`,
      [members.rows.map(m => m.user_id)]
    );

    const prefMap = {};
    for (const p of prefs.rows) prefMap[p.user_id] = p;

    // Only push to users who are offline (online users get socket events)
    const { getOnlineUsers } = require('../db/redis');
    const onlineIds = new Set(await getOnlineUsers());

    const pushTargets = members.rows.filter(m =>
      !onlineIds.has(m.user_id)
    );

    await Promise.all(
      pushTargets.map(m => sendPushToUser(m.user_id, payload))
    );
  } catch (err) {
    console.error('[Push] sendRoomPush error:', err.message);
  }
}

module.exports = router;
module.exports.sendPushToUser = sendPushToUser;
module.exports.sendRoomPush = sendRoomPush;
