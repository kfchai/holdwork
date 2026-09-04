import { Ajv2020, type ErrorObject } from 'ajv/dist/2020.js';
import addFormatsModule, { type FormatsPlugin } from 'ajv-formats';

// ajv-formats ships a CommonJS default export; under ESM it may arrive wrapped in { default }.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ?? addFormatsModule) as FormatsPlugin;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

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
    const validate = ajv.compile(schema as object);
    const valid = validate(output) as boolean;
    const errors = (validate.errors ?? []).map((e: ErrorObject) => `${e.instancePath || '/'} ${e.message ?? ''}`.trim());
    return { applicable: true, valid, errors };
  } catch (e) {
    return { applicable: true, valid: false, errors: [`schema could not be compiled: ${String(e)}`] };
  }
}
