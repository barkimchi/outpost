import { createApp } from './app.js';
import { PORT } from './config.js';

const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`postman-gym listening on 0.0.0.0:${PORT} (also reachable at 127.0.0.1:${PORT})`);
});
