import { createApp } from './app.js';
import { PORT } from './config.js';
import { engine } from './engine/engine.js';

// Boot the World with a default run context before accepting any request (docs/PLAN.md
// Task 3: "Boot the World with a default run context"). Without this, GET /github/user
// 500s on a fresh process until a scenario is activated (verified defect, commit
// 351ecb3): free exploration and the implementation track both need a healthy World with
// no scenario chosen. Activating a scenario later replaces this default with a fresh one.
engine.boot();

const app = createApp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`postman-gym listening on 0.0.0.0:${PORT} (also reachable at 127.0.0.1:${PORT})`);
});
