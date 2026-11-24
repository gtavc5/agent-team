// Serializes commits independently for each project. A rejected task rejects
// only its own caller; the internal tail always resolves so later tasks run.
export class ProjectCommitLock {
  private tails = new Map<string, Promise<void>>();

  run<T>(projectId: string, fn: () => Promise<T> | T): Promise<T> {
    const previous = this.tails.get(projectId) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(projectId, tail);
    void tail.then(() => {
      if (this.tails.get(projectId) === tail) this.tails.delete(projectId);
    });
    return result;
  }

  get pending(): number {
    return this.tails.size;
  }

  isLocked(projectId: string): boolean {
    return this.tails.has(projectId);
  }

  async waitForIdle(projectId: string): Promise<void> {
    // Include work queued while an earlier tail was being awaited.
    while (true) {
      const tail = this.tails.get(projectId);
      if (!tail) return;
      await tail;
    }
  }
}
