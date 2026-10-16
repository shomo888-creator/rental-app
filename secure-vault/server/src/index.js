import { loadConfig } from './config.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
const app = await buildApp(cfg);
await app.listen({ port: cfg.port, host: '0.0.0.0' });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => app.close().then(() => process.exit(0)));
}
