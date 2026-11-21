import { Game } from './game.js';

const bar = document.getElementById('load-bar');
const text = document.getElementById('load-text');
const game = new Game(document.getElementById('view'));
game.init((pct, msg) => {
  bar.style.width = Math.round(pct * 100) + '%';
  text.textContent = msg;
}).then(async () => {
  if (import.meta.env.DEV) (await import('./dev.js')).installDevTools(game);
}).catch((err) => {
  console.error(err);
  text.textContent = 'Failed to start: ' + err.message;
  text.style.color = '#ff8a7a';
});
