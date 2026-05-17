import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Db } from "./db.js";

interface AuthLike {
  token: string | null;
  handleUnauthorized: ReturnType<typeof vi.fn>;
}

function fakeAuth(token: string | null): AuthLike {
  return { token, handleUnauthorized: vi.fn() };
}

beforeEach(() => {
  globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [], total: 0 }), { status: 200 }));
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).fetch;
});

describe("Db.collection", () => {
  it("returns a Collection instance", () => {
    const db = new Db("test-app", "https://api.example", fakeAuth("tok") as any);
    const col = db.collection("posts");
    expect(col).toBeDefined();
  });
});

describe("Collection.create", () => {
  it("sends POST to the collection endpoint", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "abc123", title: "Hello" }), { status: 201 }));
    const db = new Db("myapp", "https://api.example", fakeAuth("tok") as any);
    const result = await db.collection("posts").create({ title: "Hello" });
    expect(result).toEqual({ id: "abc123", title: "Hello" });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[0].toString()).toContain("/v1/apps/myapp/db/posts");
    expect(call[1].method).toBe("POST");
  });

  it("throws when not signed in", async () => {
    const db = new Db("myapp", "https://api.example", fakeAuth(null) as any);
    await expect(db.collection("posts").create({ title: "x" })).rejects.toThrow(/not signed in/i);
  });
});

describe("Collection.query", () => {
  it("sends GET with query params", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ documents: [{ id: "1", title: "A" }], total: 1 }), { status: 200 }));
    const db = new Db("myapp", "https://api.example", fakeAuth(null) as any);
    const result = await db.collection("posts").query({ limit: 10, order: "desc" });
    expect(result.documents).toHaveLength(1);
    expect(result.total).toBe(1);
    const url = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0].toString();
    expect(url).toContain("limit=10");
    expect(url).toContain("order=desc");
  });
});

describe("Collection.get", () => {
  it("returns document on 200", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "abc", title: "Test" }), { status: 200 }));
    const db = new Db("myapp", "https://api.example", fakeAuth(null) as any);
    const doc = await db.collection("posts").get("abc");
    expect(doc).toEqual({ id: "abc", title: "Test" });
  });

  it("returns null on 404", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("not found", { status: 404 }));
    const db = new Db("myapp", "https://api.example", fakeAuth(null) as any);
    const doc = await db.collection("posts").get("missing");
    expect(doc).toBeNull();
  });
});

describe("Collection.update", () => {
  it("sends PUT with patch data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "abc", title: "Updated" }), { status: 200 }));
    const db = new Db("myapp", "https://api.example", fakeAuth("tok") as any);
    const result = await db.collection("posts").update("abc", { title: "Updated" });
    expect(result).toEqual({ id: "abc", title: "Updated" });
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1].method).toBe("PUT");
  });

  it("throws when not signed in", async () => {
    const db = new Db("myapp", "https://api.example", fakeAuth(null) as any);
    await expect(db.collection("posts").update("abc", {})).rejects.toThrow(/not signed in/i);
  });
});

describe("Collection.delete", () => {
  it("sends DELETE", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const db = new Db("myapp", "https://api.example", fakeAuth("tok") as any);
    await db.collection("posts").delete("abc");
    const call = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(call[1].method).toBe("DELETE");
  });

  it("throws when not signed in", async () => {
    const db = new Db("myapp", "https://api.example", fakeAuth(null) as any);
    await expect(db.collection("posts").delete("abc")).rejects.toThrow(/not signed in/i);
  });

  it("calls handleUnauthorized on 401", async () => {
    const auth = fakeAuth("expired");
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("", { status: 401 }));
    const db = new Db("myapp", "https://api.example", auth as any);
    await expect(db.collection("posts").delete("abc")).rejects.toThrow();
    expect(auth.handleUnauthorized).toHaveBeenCalled();
  });
});
