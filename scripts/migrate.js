#!/usr/bin/env node
// scripts/migrate.js — Idempotent database migration runner
//
// Applies schema files in order, tracking which have been applied
// in a migrations table. Safe to run multiple times.
//
// Usage:
//   node scripts/migrate.js              # apply all pending
//   node scripts/migrate.js --dry-run    # show what would run
//   node scripts/migrate.js --status     # show migration state
//   node scripts/migrate.js --reset      # DANGER: drop all tables

require('dotenv').config({ path: require('path').join(__dirname, '../server/.env') });
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const SCHEMA_DIR = path.join(__dirname, '../server');
const MIGRATIONS = [
  { file: 'schema.sql',            version: 1, description: 'Core schema + seed data' },
  { file: 'schema_additions.sql',  version: 2, description: 'Reactions, notifications, FTS indexes' },
  { file: 'schema_v3.sql',         version: 3, description: 'Invites, composite indexes, views' },
  { file: 'schema_v4.sql',         version: 4, description: 'Drafts, scheduled messages, webhooks' },
  { file: 'schema_v5.sql',         version: 5, description: 'Webhook deliveries, slow-mode, heatmap' },
  { file: 'schema_v6.sql',         version: 6, description: 'Push subscriptions, room settings, export' },
  { file: 'schema_v7.sql',         version: 7, description: 'E2E encryption keys, performance indexes, maintenance' },
];

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const STATUS = args.includes('--status');
const RESET = args.includes('--reset');

async function getClient() {
  const config = process.env.DATABASE_URL 
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: process.env.POSTGRES_HOST || 'localhost',
        port: parseInt(process.env.POSTGRES_PORT || '5432'),
        database: process.env.POSTGRES_DB || 'chatdb',
        user: process.env.POSTGRES_USER || 'chatuser',
        password: process.env.POSTGRES_PASSWORD || 'chatpassword',
      };

  // Add SSL for connection if it is not localhost (likely cloud DB)
  if (config.connectionString || (config.host && config.host !== 'localhost' && config.host !== '127.0.0.1')) {
    config.ssl = { rejectUnauthorized: false };
  }

  const client = new Client(config);
  await client.connect();
  return client;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INT PRIMARY KEY,
      file VARCHAR(100) NOT NULL,
      description TEXT,
      applied_at TIMESTAMPTZ DEFAULT NOW(),
      checksum VARCHAR(64)
    )
  `);
}

function checksum(content) {
  return require('crypto').createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function main() {
  let client;
  try {
    client = await getClient();
    console.log(`\n📋 NexChat Migration Runner`);
    console.log(`   Host: ${process.env.POSTGRES_HOST || 'localhost'}:${process.env.POSTGRES_PORT || '5432'}`);
    console.log(`   DB:   ${process.env.POSTGRES_DB || 'chatdb'}\n`);

    if (RESET) {
      const readline = require('readline').createInterface({ input: process.stdin, output: process.stdout });
      await new Promise(resolve => {
        readline.question('⚠️  DANGER: Drop all tables and reset? [type "yes" to confirm]: ', (answer) => {
          readline.close();
          if (answer !== 'yes') { console.log('Aborted.'); process.exit(0); }
          resolve();
        });
      });

      console.log('💥 Dropping all tables...');
      await client.query(`
        DROP SCHEMA public CASCADE;
        CREATE SCHEMA public;
        GRANT ALL ON SCHEMA public TO ${process.env.POSTGRES_USER || 'chatuser'};
      `);
      console.log('✅ All tables dropped. Run migrate again to recreate.\n');
      return;
    }

    await ensureMigrationsTable(client);

    const applied = await client.query('SELECT version, file, applied_at FROM _migrations ORDER BY version');
    const appliedVersions = new Set(applied.rows.map(r => r.version));

    if (STATUS) {
      console.log('Migration Status:');
      console.log('─'.repeat(70));
      for (const m of MIGRATIONS) {
        const isApplied = appliedVersions.has(m.version);
        const row = applied.rows.find(r => r.version === m.version);
        const status = isApplied ? `✅ Applied ${row.applied_at.toISOString().slice(0, 10)}` : '⏳ Pending';
        console.log(`  v${m.version}  ${m.file.padEnd(30)} ${status}`);
        console.log(`       ${m.description}`);
      }
      console.log('─'.repeat(70));
      console.log(`  ${appliedVersions.size}/${MIGRATIONS.length} migrations applied\n`);
      return;
    }

    const pending = MIGRATIONS.filter(m => !appliedVersions.has(m.version));

    if (!pending.length) {
      console.log('✅ All migrations already applied. Nothing to do.\n');
      return;
    }

    console.log(`Found ${pending.length} pending migration(s):\n`);

    for (const migration of pending) {
      const filePath = path.join(SCHEMA_DIR, migration.file);
      if (!fs.existsSync(filePath)) {
        console.warn(`  ⚠️  File not found: ${migration.file} — skipping`);
        continue;
      }

      const sql = fs.readFileSync(filePath, 'utf8');
      const cs = checksum(sql);

      console.log(`  📄 v${migration.version}: ${migration.file}`);
      console.log(`     ${migration.description}`);

      if (DRY_RUN) {
        console.log(`     [DRY RUN — would apply ${sql.length} bytes]\n`);
        continue;
      }

      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          `INSERT INTO _migrations (version, file, description, checksum)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (version) DO NOTHING`,
          [migration.version, migration.file, migration.description, cs]
        );
        await client.query('COMMIT');
        console.log(`     ✅ Applied successfully\n`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`     ❌ Error: ${err.message}\n`);
        throw err;
      }
    }

    if (!DRY_RUN) {
      console.log(`✅ ${pending.length} migration(s) applied successfully.\n`);
    }
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    if (client) await client.end();
  }
}

main();
