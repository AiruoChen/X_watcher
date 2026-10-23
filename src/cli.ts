import { describeConfig, loadConfig } from './config.js';
import { runDemo } from './demo.js';

const command = process.argv[2] ?? 'demo';
try {
  if (command === 'demo') await runDemo();
  else if (command === 'config') console.log(JSON.stringify(describeConfig(loadConfig(process.env)), null, 2));
  else if (command === 'run') await runDemo(loadConfig(process.env));
  else if (command === 'watch') {
    if (process.argv.slice(3).some(arg => arg !== '--create')) throw new Error('Usage: watch [--create]');
    const { watch } = await import('./watch.js'); process.exitCode = await watch(loadConfig(process.env), process.argv.includes('--create'));
  }
  else if (command === 'x:probe' || command === 'x:preview') {
    const args = process.argv.slice(3);
    if (args.some(arg => command === 'x:probe' || !['--create','--once'].includes(arg))) throw new Error('Usage: x:probe | x:preview [--create] [--once]');
    const { probeX, previewX } = await import('./x-preview.js');
    process.exitCode = command === 'x:probe' ? await probeX(loadConfig(process.env), process.env)
      : await previewX(loadConfig(process.env), process.env, args.includes('--create'), args.includes('--once'));
  }
  else throw new Error('Usage: npm run demo | npm start | npm run config:check | npm run watch -- [--create]');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Application failed.');
  process.exitCode = 1;
}
