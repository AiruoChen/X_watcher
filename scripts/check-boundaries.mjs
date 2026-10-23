import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve('src');
const allowed = {
  domain: new Set(['domain']),
  application: new Set(['application', 'domain']),
  adapters: new Set(['adapters', 'domain']),
  runtime: new Set(['runtime', 'domain']),
};
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  return (await Promise.all(entries.map(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat();
}
const errors = [];
for (const file of await walk(root)) {
  if (!file.endsWith('.ts')) continue;
  const layer = path.relative(root, file).split(path.sep)[0];
  if (!allowed[layer]) continue;
  const tree = ts.createSourceFile(file, await readFile(file, 'utf8'), ts.ScriptTarget.Latest, true);
  function visit(node) {
    let spec;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) spec = node.moduleSpecifier;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) spec = node.arguments[0];
    if (spec) {
      if (!ts.isStringLiteral(spec)) errors.push(`${file}: computed imports are not allowed in layers`);
      else {
        const dest = spec.text.startsWith('.')
          ? path.relative(root, path.resolve(path.dirname(file), spec.text)).split(path.sep)[0]
          : 'external';
        if (!allowed[layer].has(dest) && !(layer === 'adapters' && dest === 'external')) {
          errors.push(`${path.relative(root, file)}: forbidden dependency ${spec.text}`);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
}
if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
else console.log('Architecture boundaries OK.');
