import { describeConfig, loadConfig } from './config.js';
import { loadLocalConfig } from './config/load.js';
import { runDemo } from './demo.js';

const command = process.argv[2] ?? 'demo';
try {
  if (command === 'demo') await runDemo();
  else if (command === 'config') console.log(JSON.stringify(describeConfig(loadConfig(process.env)), null, 2));
  else if (command === 'run') await runDemo(loadConfig(process.env));
  else if (['digest:status', 'digest:preview', 'digest:generate'].includes(command)) {
    const { digestOperations } = await import('./digest-operations.js');
    digestOperations(loadLocalConfig(process.env), command, process.argv.slice(3));
  }
  else if (command === 'mail:status' || command === 'mail:resolve') {
    const { mailOperations } = await import('./mail-operations.js');
    mailOperations(loadLocalConfig(process.env), command, process.argv.slice(3));
  }
  else if (command === 'watch') {
    if (process.argv.slice(3).some(arg => arg !== '--create')) throw new Error('Usage: watch [--create]');
    const { watch } = await import('./watch.js'); process.exitCode = await watch(loadConfig(process.env), process.argv.includes('--create'));
  }
  else if (['source:probe', 'source:preview', 'rsshub:probe', 'rsshub:preview', 'x:probe', 'x:preview'].includes(command)) {
    const args = process.argv.slice(3), probe = command.endsWith(':probe');
    if (args.some(arg => probe || !['--create','--once'].includes(arg))) throw new Error('Usage: source:probe | source:preview [--create] [--once]');
    const config = loadConfig(process.env);
    if (command.startsWith('rsshub:') && config.services.source.provider !== 'rsshub') throw new Error('rsshub:* commands require SOURCE_PROVIDER=rsshub.');
    if (command.startsWith('x:') && config.services.source.provider !== 'x-api-v2') throw new Error('x:* commands require SOURCE_PROVIDER=x-api-v2.');
    const { probeSource, previewSource } = await import('./source-preview.js');
    process.exitCode = probe ? await probeSource(config, process.env)
      : await previewSource(config, process.env, args.includes('--create'), args.includes('--once'));
  }
  else throw new Error('Usage: npm run demo | npm start | npm run config:check | npm run watch -- [--create] | npm run source:probe | npm run source:preview -- [--create] [--once] | npm run digest:status -- <day> | npm run digest:preview -- <day> [--partial] | npm run digest:generate -- <day>');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Application failed.');
  process.exitCode = 1;
}
