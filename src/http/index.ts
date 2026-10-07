import { depsFromEnv } from './deps';
import { createHandlers } from './handlers';

/** Production handlers, wired from env. The `api/` files bind these to exported methods. */
export const handlers = createHandlers(() => depsFromEnv());
