import jsonata from 'jsonata';

export interface TransformInput {
  headers: Record<string, unknown>;
  body: unknown;
  route: { slug: string; name: string };
}

const cache = new Map<string, ReturnType<typeof jsonata>>();

function compile(spec: string) {
  let expr = cache.get(spec);
  if (!expr) {
    expr = jsonata(spec); // throws on syntax error
    cache.set(spec, expr);
  }
  return expr;
}

/** Validate a JSONata spec without evaluating it. Returns an error message or null. */
export function validateSpec(spec: string): string | null {
  try {
    compile(spec);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Pure transform: (input, spec) -> output. No I/O, no side effects.
 * The same function backs live delivery, replay, and the UI preview.
 */
export async function transform(spec: string, input: TransformInput): Promise<unknown> {
  const expr = compile(spec);
  return expr.evaluate(input);
}
