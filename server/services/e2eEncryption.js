// services/e2eEncryption.js
// Client-side E2E encryption key exchange infrastructure.
//
// Design:
//   - Each user generates an X25519 keypair in the browser (SubtleCrypto)
//   - Public keys are stored on the server (this file)
//   - Sender fetches recipient's public key, derives shared secret (ECDH),
//     encrypts message with AES-GCM, sends ciphertext + ephemeral pubkey
//   - Server stores ciphertext; server NEVER sees plaintext for E2E rooms
//
// This module handles the server-side key registry only.
// Actual encryption/decryption happens entirely in the browser.

const express = require('express');
const { query } = require('../db/postgres');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── GET /api/e2e/public-key/:userId ───────────────────────
// Fetch a user's current public key for encryption
router.get('/public-key/:userId', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `SELECT public_key, key_id, algorithm, created_at
       FROM user_public_keys
       WHERE user_id = $1 AND active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [req.params.userId]
    );

    if (!result.rows.length) {
      return res.status(404).json({ error: 'No public key registered for this user' });
    }

    res.json({ key: result.rows[0] });
  } catch (err) {
    console.error('[E2E] get key error:', err);
    res.status(500).json({ error: 'Failed to fetch public key' });
  }
});

// ── GET /api/e2e/public-keys — Batch fetch keys for a room ─
router.get('/public-keys', requireAuth, async (req, res) => {
  try {
    const { userIds } = req.query;
    if (!userIds) return res.status(400).json({ error: 'userIds query param required' });

    const ids = userIds.split(',').slice(0, 50); // cap at 50

    const result = await query(
      `SELECT DISTINCT ON (user_id) user_id, public_key, key_id, algorithm, created_at
       FROM user_public_keys
       WHERE user_id = ANY($1) AND active = TRUE
       ORDER BY user_id, created_at DESC`,
      [ids]
    );

    // Build map: userId -> keyInfo
    const keys = {};
    for (const row of result.rows) {
      keys[row.user_id] = {
        publicKey: row.public_key,
        keyId: row.key_id,
        algorithm: row.algorithm,
      };
    }

    res.json({ keys });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch public keys' });
  }
});

// ── POST /api/e2e/register-key — Upload own public key ────
router.post('/register-key', requireAuth, async (req, res) => {
  try {
    const { publicKey, algorithm = 'X25519', keyId } = req.body;

    if (!publicKey) return res.status(400).json({ error: 'publicKey required' });

    // Validate it's base64url (basic check)
    if (!/^[A-Za-z0-9+/=_-]+$/.test(publicKey)) {
      return res.status(400).json({ error: 'publicKey must be base64 encoded' });
    }

    // Deactivate all old keys for this user
    await query(
      'UPDATE user_public_keys SET active = FALSE WHERE user_id = $1',
      [req.user.userId]
    );

    // Insert new key
    const result = await query(
      `INSERT INTO user_public_keys (user_id, public_key, key_id, algorithm)
       VALUES ($1, $2, $3, $4)
       RETURNING key_id, algorithm, created_at`,
      [req.user.userId, publicKey, keyId || require('crypto').randomUUID(), algorithm]
    );

    res.json({ registered: true, key: result.rows[0] });
  } catch (err) {
    console.error('[E2E] register key error:', err);
    res.status(500).json({ error: 'Failed to register key' });
  }
});

// ── DELETE /api/e2e/revoke-key — Revoke own keys ─────────
router.delete('/revoke-key', requireAuth, async (req, res) => {
  try {
    await query(
      'UPDATE user_public_keys SET active = FALSE WHERE user_id = $1',
      [req.user.userId]
    );
    res.json({ revoked: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to revoke keys' });
  }
});

// ── GET /api/e2e/room/:roomId/status — E2E status per room ─
router.get('/room/:roomId/status', requireAuth, async (req, res) => {
  try {
    const memberCheck = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [req.params.roomId, req.user.userId]
    );
    if (!memberCheck.rows.length) return res.status(403).json({ error: 'Not a member' });

    // Check how many members have registered E2E keys
    const result = await query(
      `SELECT
         COUNT(DISTINCT rm.user_id)::int as total_members,
         COUNT(DISTINCT upk.user_id)::int as members_with_keys
       FROM room_members rm
       LEFT JOIN user_public_keys upk ON upk.user_id = rm.user_id AND upk.active = TRUE
       WHERE rm.room_id = $1`,
      [req.params.roomId]
    );

    const { total_members, members_with_keys } = result.rows[0];
    res.json({
      roomId: req.params.roomId,
      totalMembers: total_members,
      membersWithKeys: members_with_keys,
      e2eReady: members_with_keys === total_members && total_members > 0,
      coveragePercent: total_members > 0
        ? Math.round((members_with_keys / total_members) * 100)
        : 0,
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to check E2E status' });
  }
});

module.exports = router;

// ============================================================
// CLIENT-SIDE IMPLEMENTATION GUIDE (browser JS)
// ============================================================
//
// 1. Generate keypair on first login:
//
//   const keypair = await crypto.subtle.generateKey(
//     { name: 'X25519' },
//     true,
//     ['deriveKey', 'deriveBits']
//   );
//
//   // Export and store private key in IndexedDB (never send to server)
//   const privateKeyJwk = await crypto.subtle.exportKey('jwk', keypair.privateKey);
//   await idb.put('e2e_private_key', privateKeyJwk);
//
//   // Export public key and register with server
//   const publicKeyRaw = await crypto.subtle.exportKey('raw', keypair.publicKey);
//   const publicKeyB64 = btoa(String.fromCharCode(...new Uint8Array(publicKeyRaw)));
//   await fetch('/api/e2e/register-key', {
//     method: 'POST',
//     body: JSON.stringify({ publicKey: publicKeyB64, algorithm: 'X25519' }),
//   });
//
// 2. Encrypt a message for a recipient:
//
//   async function encryptForUser(plaintext, recipientPublicKeyB64) {
//     // Fetch sender's private key from IndexedDB
//     const privateKeyJwk = await idb.get('e2e_private_key');
//     const privateKey = await crypto.subtle.importKey('jwk', privateKeyJwk,
//       { name: 'X25519' }, false, ['deriveKey']);
//
//     // Import recipient public key
//     const pubKeyBytes = Uint8Array.from(atob(recipientPublicKeyB64), c => c.charCodeAt(0));
//     const recipientPubKey = await crypto.subtle.importKey('raw', pubKeyBytes,
//       { name: 'X25519' }, false, []);
//
//     // Derive shared AES key via ECDH
//     const sharedKey = await crypto.subtle.deriveKey(
//       { name: 'X25519', public: recipientPubKey },
//       privateKey,
//       { name: 'AES-GCM', length: 256 },
//       false,
//       ['encrypt', 'decrypt']
//     );
//
//     // Encrypt
//     const iv = crypto.getRandomValues(new Uint8Array(12));
//     const encoded = new TextEncoder().encode(plaintext);
//     const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, sharedKey, encoded);
//
//     return {
//       ciphertext: btoa(String.fromCharCode(...new Uint8Array(ciphertext))),
//       iv: btoa(String.fromCharCode(...iv)),
//     };
//   }
//
// 3. Send encrypted message via socket:
//   socket.emit('send_message', {
//     roomId,
//     content: JSON.stringify({ encrypted: true, ciphertext, iv }),
//     messageType: 'encrypted',
//   });
//
// 4. Decrypt on receive: reverse the process using stored private key.
