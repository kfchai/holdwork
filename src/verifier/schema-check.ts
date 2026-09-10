import { Validator, type Schema } from '@cfworker/json-schema';

// @cfworker/json-schema interprets the schema directly instead of compiling it to JavaScript.
// Ajv compiles with `new Function`, which Cloudflare Workers forbid ("code generation from strings
// disallowed"), so under Ajv every schema check on the Worker failed to compile and every output was
// capped at the schema-failure ceiling. Found 2026-09-10 by the fixture study.

export interface SchemaCheck {
  applicable: boolean;
  valid: boolean;
  errors: string[];
}

/** Deterministic first gate: does the output satisfy the buyer's JSON Schema, if one was given. */
export function checkSchema(schema: unknown, output: unknown): SchemaCheck {
  if (!schema || typeof schema !== 'object' || Object.keys(schema as object).length === 0) {
    return { applicable: false, valid: true, errors: [] };
  }
  try {
    const validator = new Validator(schema as Schema, '2020-12', false);
    const result = validator.validate(output);
    const errors = result.errors
      // The library reports a generic "does not match schema" at the root alongside each specific error.
      .filter((e) => !(e.instanceLocation === '#' && e.keyword === 'schema' && result.errors.length > 1))
      .map((e) => `${e.instanceLocation.replace(/^#/, '') || '/'} ${e.error}`.trim());
    return { applicable: true, valid: result.valid, errors };
  } catch (e) {
    return { applicable: true, valid: false, errors: [`schema could not be compiled: ${String(e)}`] };
  }
}
