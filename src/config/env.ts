/** Thrown when a required environment variable is missing. Maps to `500 INTERNAL` (CONTRACT.md §3.6). */
export class MissingEnvError extends Error {
  readonly variable: string;

  constructor(variable: string) {
    // The message names the variable, never a value.
    super(`missing required environment variable ${variable}`);
    this.name = 'MissingEnvError';
    this.variable = variable;
  }
}

export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (value === undefined || value.trim() === '') {
    throw new MissingEnvError(name);
  }
  return value;
}
