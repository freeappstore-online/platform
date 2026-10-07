/**
 * UI-only pending-turn queue.  These messages have not reached the agent yet,
 * so they deliberately live outside the persisted chat transcript.
 */
export interface QueuedMessage<TConfig> {
  id: string;
  content: string;
  config: TConfig;
}

export function addQueuedMessage<TConfig>(
  queue: readonly QueuedMessage<TConfig>[],
  message: QueuedMessage<TConfig>,
): QueuedMessage<TConfig>[] {
  return [...queue, message];
}

export function editQueuedMessage<TConfig>(
  queue: readonly QueuedMessage<TConfig>[],
  id: string,
  content: string,
): QueuedMessage<TConfig>[] {
  return queue.map((message) => message.id === id ? { ...message, content } : message);
}

export function removeQueuedMessage<TConfig>(
  queue: readonly QueuedMessage<TConfig>[],
  id: string,
): QueuedMessage<TConfig>[] {
  return queue.filter((message) => message.id !== id);
}

/** Remove and return the next waiting turn when the current run finishes. */
export function takeNextQueuedMessage<TConfig>(
  queue: readonly QueuedMessage<TConfig>[],
): { next: QueuedMessage<TConfig> | null; remaining: QueuedMessage<TConfig>[] } {
  const [next, ...remaining] = queue;
  return { next: next ?? null, remaining };
}
