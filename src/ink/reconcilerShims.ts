/**
 * Centralized type augmentations for `react-reconciler` runtime APIs that
 * ship in the package but are missing (or lagging) in `@types/react-reconciler`.
 *
 * Previously every call site duplicated `@ts-expect-error` comments for
 * `updateContainerSync`, `flushSyncWork`, `flushSyncFromReconciler`, and the
 * 10-vs-11-arg `createContainer` arity. This module declares them once so
 * callers import from here and the suppressions live in a single file.
 *
 * If `@types/react-reconciler` ever catches up to `react-reconciler@0.33.0`,
 * delete this file and remove the imports.
 */

import type { FiberRoot } from 'react-reconciler'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNode = any

/**
 * The runtime `reconciler` namespace exposes these sync flush helpers. They
 * exist on the real export but the type stub omits them.
 */
export type ReconcilerSyncApi = {
  /**
   * Synchronously updates the container's children. Exists in
   * react-reconciler@0.31+ but not in @types/react-reconciler@0.32.3.
   */
  updateContainerSync(
    element: AnyNode,
    container: FiberRoot,
    parentComponent: AnyNode,
    callback: (() => void) | null,
  ): void
  /**
   * Synchronously flushes pending work. Exists in react-reconciler@0.31+ but
   * not in @types/react-reconciler@0.32.3.
   */
  flushSyncWork(): void
  /**
   * Flushes sync work from within the reconciler. Exists in
   * react-reconciler@0.31 but not in @types/react-reconciler.
   */
  flushSyncFromReconciler(): void
}

/**
 * Cast the imported reconciler module to include the sync API. Callers do
 * `import reconciler from './reconcilerShims.js'` and use
 * `reconciler.updateContainerSync(...)` etc. without per-site suppression.
 */
export function asSyncReconciler<T extends Record<string, unknown>>(
  mod: T,
): T & ReconcilerSyncApi {
  return mod as T & ReconcilerSyncApi
}

/**
 * react-reconciler@0.33.0's createContainer takes 10 args (no
 * transitionCallbacks); @types/react-reconciler@0.32.3 declares 11. This
 * wrapper fixes the arity so call sites don't need @ts-expect-error.
 */
export type CreateContainer10 = (
  root: AnyNode,
  tag: number,
  options: AnyNode,
  hydrate: boolean,
  hydrationCallbacks: AnyNode,
  identifierPrefix: string,
  onUncaughtError: (error: unknown) => void,
  onCaughtError: (error: unknown) => void,
  onRecoverableError: (error: unknown) => void,
  onDefaultTransitionIndicator: (error: unknown) => void,
) => FiberRoot

export function asCreateContainer10<T extends { createContainer: (...args: unknown[]) => FiberRoot }>(
  mod: T,
): Omit<T, 'createContainer'> & { createContainer: CreateContainer10 } {
  return mod as Omit<T, 'createContainer'> & { createContainer: CreateContainer10 }
}
