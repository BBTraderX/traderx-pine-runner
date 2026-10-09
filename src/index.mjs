import { createServer, PORT, TOKEN, SOURCE_URL } from './server.mjs';

if (!TOKEN) console.warn('RUNNER_TOKEN is not set: the API is open. Set it outside local development.');
createServer().listen(PORT, () => console.log(`traderx-pine-runner on :${PORT} (source: ${SOURCE_URL})`));
