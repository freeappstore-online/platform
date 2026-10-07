import { describe, expect, it } from "vitest";
import {
  addQueuedMessage,
  editQueuedMessage,
  removeQueuedMessage,
  takeNextQueuedMessage,
  type QueuedMessage,
} from "./messageQueue";

type Config = { model: string };

const queued = (id: string, content: string): QueuedMessage<Config> => ({
  id,
  content,
  config: { model: "test-model" },
});

describe("message queue", () => {
  it("adds waiting messages in send order", () => {
    const first = queued("one", "Build the landing page");
    const second = queued("two", "Then add a pricing page");

    const queue = addQueuedMessage(addQueuedMessage([], first), second);

    expect(queue).toEqual([first, second]);
  });

  it("edits a waiting message without changing its position or saved config", () => {
    const queue = [queued("one", "Original"), queued("two", "Keep me")];

    const edited = editQueuedMessage(queue, "one", "Updated instruction");

    expect(edited).toEqual([
      { id: "one", content: "Updated instruction", config: { model: "test-model" } },
      queued("two", "Keep me"),
    ]);
    expect(queue[0]?.content).toBe("Original");
  });

  it("removes only the selected waiting message", () => {
    const queue = [queued("one", "First"), queued("two", "Remove"), queued("three", "Last")];

    expect(removeQueuedMessage(queue, "two")).toEqual([queued("one", "First"), queued("three", "Last")]);
  });

  it("auto-advances by taking one message at a time in FIFO order", () => {
    const queue = [queued("one", "First"), queued("two", "Second")];

    const firstAdvance = takeNextQueuedMessage(queue);
    expect(firstAdvance.next).toEqual(queued("one", "First"));
    expect(firstAdvance.remaining).toEqual([queued("two", "Second")]);

    const secondAdvance = takeNextQueuedMessage(firstAdvance.remaining);
    expect(secondAdvance.next).toEqual(queued("two", "Second"));
    expect(secondAdvance.remaining).toEqual([]);
    expect(takeNextQueuedMessage(secondAdvance.remaining).next).toBeNull();
  });
});
