import { loadConfig } from './config.js';
import { runDemo } from './demo.js';

const command = process.argv[2] ?? 'demo';
try {
  if (command === 'demo') await runDemo();
  else if (command === 'run') await runDemo(loadConfig(process.env));
  else throw new Error('Usage: npm run demo | npm start');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Application failed.');
  process.exitCode = 1;
}
