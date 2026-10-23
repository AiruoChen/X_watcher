/** Backwards-compatible public configuration entry point. */
export { loadConfig, describeConfig } from './config/load.js';
export { parseConfig } from './config/validate.js';
export { CONFIG_SCHEMA, ConfigError } from './config/schema.js';
