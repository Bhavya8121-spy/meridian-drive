import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Dev-only endpoint: POST a data URL to /__capture?name=foo and it is written to ./captures/foo.jpg.
// Used for automated visual checks when the browser window is not visible.
const capture = {
  name: 'dev-capture',
  configureServer(server) {
    server.middlewares.use('/__capture', (req, res) => {
      if (req.method !== 'POST') { res.statusCode = 405; return res.end(); }
      const name = (new URL(req.url, 'http://x').searchParams.get('name') || 'shot').replace(/[^a-z0-9_-]/gi, '');
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const b64 = body.replace(/^data:image\/\w+;base64,/, '');
        fs.mkdirSync('captures', { recursive: true });
        fs.writeFileSync(path.join('captures', name + '.jpg'), Buffer.from(b64, 'base64'));
        res.end('ok');
      });
    });
  },
};

export default defineConfig({
  plugins: [capture],
  server: { port: 5173 },
});
