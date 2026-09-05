/**
 * Debounced filesystem watch for project-rules cache invalidation.
 * @module @firefly0621/dsh-always-apply
 */

import { watch, type FSWatcher } from 'node:fs'

/** Options for {@link RulesRootWatcher}. */
export interface RulesRootWatchOptions {
  /** Watcher debounce window in milliseconds before invalidation. Default 100. */
  readonly debounceMs?: number
  /** Called after the debounce window when a watched root changes. */
  readonly onInvalidate: (rulesRoot: string) => void
  /** Optional warning sink for watch setup or runtime errors. */
  readonly onWarning?: (message: string) => void
}

/**
 * Watch one or more rules roots and debounce cache invalidation on external edits.
 */
export class RulesRootWatcher {
  readonly #debounceMs: number
  readonly #onInvalidate: (rulesRoot: string) => void
  readonly #onWarning: ((message: string) => void) | undefined
  readonly #watchers = new Map<string, FSWatcher>()
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #disposed = false

  /**
   * @param options - debounce window, invalidation callback, and optional warnings.
   */
  constructor(options: RulesRootWatchOptions) {
    this.#debounceMs = options.debounceMs ?? 100
    this.#onInvalidate = options.onInvalidate
    this.#onWarning = options.onWarning
  }

  /**
   * Start watching `rulesRoot` when it is not already watched.
   * @param rulesRoot - absolute rules directory.
   */
  ensure(rulesRoot: string): void {
    if (this.#disposed || this.#watchers.has(rulesRoot)) return
    let watcher: FSWatcher
    try {
      watcher = watch(rulesRoot, { recursive: true }, () => {
        this.scheduleInvalidate(rulesRoot)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.#onWarning?.(`rules: cannot watch ${rulesRoot} (${message})`)
      return
    }
    watcher.on('error', (error) => {
      const message = error instanceof Error ? error.message : String(error)
      this.#onWarning?.(`rules: watcher error on ${rulesRoot} (${message})`)
    })
    this.#watchers.set(rulesRoot, watcher)
  }

  /**
   * Debounce invalidation for one rules root (exposed for tests).
   * @param rulesRoot - absolute rules directory.
   */
  scheduleInvalidate(rulesRoot: string): void {
    if (this.#disposed) return
    const existing = this.#timers.get(rulesRoot)
    if (existing !== undefined) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.#timers.delete(rulesRoot)
      if (this.#disposed) return
      this.#onInvalidate(rulesRoot)
    }, this.#debounceMs)
    this.#timers.set(rulesRoot, timer)
  }

  /** Close every watcher and cancel pending debounced invalidations. */
  dispose(): void {
    this.#disposed = true
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
  }
}
