import { createApp } from './app.js';
const app = createApp();
if (process.env.QQ_AGENT_READ_ONLY === '1') {
  app.orchestrator.setPaused(true, 'migration-validation');
  for (const name of ['sendTextBatch','sendSticker','sendImage','sendPoke','poke','sendImageBatch']) {
    if (typeof app.sender[name] === 'function') app.sender[name] = async () => { throw new Error('Migration validation: QQ sending disabled'); };
  }
}
process.on('unhandledRejection', error => console.error('[unhandled]',error));
process.on('uncaughtException', error => {console.error('[uncaught]',error);process.exit(1);});
let stopping = false;
async function stop() { if(stopping)return;stopping=true;await app.stop();process.exit(0); }
process.on('SIGINT',stop);process.on('SIGTERM',stop);
await app.start();
