import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import { config } from '../../../../packages/core/src/config.js';
import { notFound, notSupported } from './errors.js';
import { specRoutes, type SpecRoute } from './spec.js';

/** The eleven domains of the spec's capability manifest. */
export const manifestDomains = [
  'agents',
  'skills',
  'mcp',
  'execution',
  'sessions',
  'memory',
  'subagents',
  'files',
  'hooks',
  'planning',
  'models',
] as const;
export type Domain = (typeof manifestDomains)[number];
export type DomainCapability = { supported: boolean; operations: string[]; limitations: string[] };
export type CapabilityManifest = Record<Domain, DomainCapability>;

export type Handler = (req: Request, res: Response) => unknown;
export type Operation = {
  /** The spec operation id, such as `execution.run`. It must exist in the pinned spec. */
  id: string;
  handler: Handler;
  /** The spec marks a few operations, such as health, as optional-auth. */
  auth?: 'required' | 'optional';
  /** Manifest operations this route provides, for example `{ domain: 'execution', operations: ['sync'] }`. */
  provides?: { domain: Domain; operations: string[] };
};
type Declaration = { operations?: string[]; limitations?: string[] };

const specIndex = new Map(specRoutes.map((r) => [r.id, r]));
const domainOf = (id: string) => id.split('.')[0];

/**
 * The single source for both the mounted routes and the capability manifest. A domain is reported as supported
 * only when a mounted operation provides it (or, for domains without routes such as `models`, when it is declared),
 * so the manifest can never claim something the router does not serve.
 */
export class OperationRegistry {
  private readonly operations = new Map<string, Operation>();
  private readonly declarations = new Map<Domain, Declaration>();

  register(...operations: Operation[]) {
    for (const operation of operations) {
      if (!specIndex.has(operation.id)) throw new Error(`Unknown Open Harness operation ${operation.id}`);
      if (this.operations.has(operation.id)) throw new Error(`Operation ${operation.id} is registered twice`);
      this.operations.set(operation.id, operation);
    }
    return this;
  }
  /** Adds manifest operations that need no route of their own, and human-readable limitations. */
  declare(domain: Domain, declaration: Declaration) {
    const current = this.declarations.get(domain) ?? {};
    this.declarations.set(domain, {
      operations: [...(current.operations ?? []), ...(declaration.operations ?? [])],
      limitations: [...(current.limitations ?? []), ...(declaration.limitations ?? [])],
    });
    return this;
  }
  has(id: string) {
    return this.operations.has(id);
  }
  manifest(): CapabilityManifest {
    const manifest = {} as CapabilityManifest;
    for (const domain of manifestDomains) {
      const provided = [...this.operations.values()]
        .filter((o) => o.provides?.domain === domain)
        .flatMap((o) => o.provides!.operations);
      const declared = this.declarations.get(domain);
      const operations = [...new Set([...provided, ...(declared?.operations ?? [])])];
      const limitations = declared?.limitations ?? [];
      manifest[domain] = {
        supported: operations.length > 0,
        operations,
        limitations: operations.length || limitations.length ? limitations : ['Not implemented yet'],
      };
    }
    return manifest;
  }
  /** Mounts every HTTP route of the spec: registered ones run their handler, the rest answer 501. */
  router(auth: { required: RequestHandler; optional: RequestHandler }) {
    const router = Router({ mergeParams: true });
    for (const route of orderedRoutes()) {
      if (route.method === 'ws') continue;
      const operation = this.operations.get(route.id);
      const handler: Handler =
        operation?.handler ??
        (() => {
          throw notSupported(domainOf(route.id), route.id);
        });
      router[route.method](
        expressPath(route.path),
        (_req: Request, res: Response, next: NextFunction) => {
          res.locals.operation = { id: route.id, domain: domainOf(route.id) };
          next();
        },
        operation?.auth === 'optional' ? auth.optional : auth.required,
        (req: Request, _res: Response, next: NextFunction) => {
          const harnessId = req.params.harnessId;
          if (harnessId !== undefined && harnessId !== config.OPENHARNESS_HARNESS_ID)
            return next(notFound('Harness', { details: { harness_id: harnessId } }));
          next();
        },
        async (req: Request, res: Response, next: NextFunction) => {
          try {
            const result = await handler(req, res);
            if (result !== undefined && !res.headersSent) res.json(result);
          } catch (error) {
            next(error);
          }
        },
      );
    }
    return router;
  }
}
/** `{param}` becomes `:param`; the multi-segment file path becomes a named wildcard. */
export function expressPath(path: string) {
  return path.replace('{path}', '*path').replace(/\{(\w+)\}/g, ':$1');
}
/**
 * Spec order, except that wildcard file routes go last and the longer one (`{path}/download`) comes before the
 * plain `{path}` route, so a wildcard never swallows a more specific route.
 */
function orderedRoutes(): SpecRoute[] {
  const plain = specRoutes.filter((r) => !r.path.includes('{path}'));
  const wildcard = specRoutes
    .filter((r) => r.path.includes('{path}'))
    .sort((a, b) => b.path.length - a.path.length);
  return [...plain, ...wildcard];
}

// Pagination is limit/offset, as in the spec's PaginationParams.
export const pageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type PageQuery = z.infer<typeof pageQuery>;
export function page<T>(items: T[], query: PageQuery, total = items.length) {
  return {
    data: items,
    total,
    limit: query.limit,
    offset: query.offset,
    has_more: query.offset + items.length < total,
  };
}
/** Slices an in-memory list. Use a database skip/limit plus a count for large collections. */
export function pageOf<T>(all: T[], query: PageQuery) {
  return page(all.slice(query.offset, query.offset + query.limit), query, all.length);
}
