import { readFileSync } from 'node:fs';
import type { BuildInfo } from './domain/model.js';
export function buildInfo():BuildInfo {
  let value:BuildInfo;
  try{value=JSON.parse(readFileSync(new URL('../build-info.json',import.meta.url),'utf8')) as BuildInfo;}catch{throw new Error('Build metadata is unavailable; rebuild the application.');}
  if(value.formatVersion!==1 || !/^[a-f0-9]{64}$/.test(value.sourceHash) || !/^[a-f0-9]{64}$/.test(value.lockHash)
    || !/^\d+\.\d+\.\d+$/.test(value.version) || !Number.isSafeInteger(value.schemaVersion)) throw new Error('Invalid build metadata; rebuild the application.');
  return value;
}
