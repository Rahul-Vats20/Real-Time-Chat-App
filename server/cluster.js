// cluster.js — Multi-core cluster manager
// Usage: node cluster.js
// Spawns one worker per CPU core, auto-restarts crashed workers,
// and coordinates Socket.io across workers via Redis pub/sub adapter.

const cluster = require('cluster');
const os = require('os');
const path = require('path');

const NUM_WORKERS = parseInt(process.env.WORKERS || os.cpus().length);
const WORKER_RESTART_DELAY = 1000; // ms before restarting a crashed worker

if (cluster.isPrimary) {
  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║        NexChat Cluster Manager            ║');
  console.log(`║        Primary PID: ${String(process.pid).padEnd(20)}║`);
  console.log(`║        Workers: ${String(NUM_WORKERS).padEnd(24)}║`);
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');

  const workers = new Map(); // workerId -> { worker, startedAt, restarts }
  let isShuttingDown = false;

  function spawnWorker() {
    const worker = cluster.fork({ WORKER_ID: Object.keys(workers).length + 1 });
    workers.set(worker.id, { worker, startedAt: Date.now(), restarts: 0 });

    worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        console.log(`✅ Worker ${worker.id} (PID ${worker.process.pid}) ready`);
      }
    });

    return worker;
  }

  // Spawn all workers
  for (let i = 0; i < NUM_WORKERS; i++) {
    spawnWorker();
  }

  // Handle worker exits
  cluster.on('exit', (worker, code, signal) => {
    const info = workers.get(worker.id);
    workers.delete(worker.id);

    if (isShuttingDown) return;

    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.warn(`⚠️  Worker ${worker.id} died (${reason})`);

    if (code === 0) {
      console.log(`   Worker exited cleanly, not restarting.`);
      return;
    }

    const restarts = (info?.restarts || 0) + 1;
    if (restarts > 10) {
      console.error(`❌ Worker restarted ${restarts} times — giving up.`);
      return;
    }

    setTimeout(() => {
      console.log(`🔄 Restarting worker (attempt ${restarts})...`);
      const newWorker = spawnWorker();
      const newInfo = workers.get(newWorker.id);
      if (newInfo) newInfo.restarts = restarts;
    }, WORKER_RESTART_DELAY * Math.min(restarts, 5)); // exponential-ish backoff
  });

  // Stats reporting
  setInterval(() => {
    const alive = Array.from(workers.values()).filter(w => !w.worker.isDead());
    console.log(`📊 Cluster: ${alive.length}/${NUM_WORKERS} workers alive`);
  }, 30_000);

  // Graceful shutdown
  const shutdown = async (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n⚠️  Primary received ${signal} — shutting down all workers...`);

    for (const { worker } of workers.values()) {
      worker.send({ type: 'shutdown' });
    }

    // Force kill after 10s
    setTimeout(() => {
      console.log('⚡ Force-killing remaining workers');
      for (const { worker } of workers.values()) {
        if (!worker.isDead()) worker.kill('SIGKILL');
      }
      process.exit(0);
    }, 10_000);

    // Wait for all workers to exit
    cluster.on('exit', () => {
      if (Object.keys(cluster.workers).length === 0) {
        console.log('✅ All workers stopped');
        process.exit(0);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

} else {
  // ── Worker process ────────────────────────────────────────
  const workerId = process.env.WORKER_ID || cluster.worker.id;
  console.log(`🔧 Worker ${workerId} starting (PID ${process.pid})...`);

  // Start the actual server
  require('./index.js');

  // Notify primary when ready
  process.on('listening', () => {
    process.send?.({ type: 'ready', workerId, pid: process.pid });
  });

  // Handle graceful shutdown from primary
  process.on('message', (msg) => {
    if (msg.type === 'shutdown') {
      console.log(`Worker ${workerId}: shutting down gracefully...`);
      // index.js has its own SIGTERM handler that closes the HTTP server
      process.emit('SIGTERM');
    }
  });
}
