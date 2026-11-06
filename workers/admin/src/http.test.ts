import { describe, expect, it } from "vitest";
import { corsHeaders } from "./http";

const allowed = (origin: string) =>
  corsHeaders(new Request("https://admin.freeappstore.online/api/ping", { headers: { Origin: origin } }))["Access-Control-Allow-Origin"];

describe("admin corsHeaders (#476)", () => {
  it.each(["https://freeappstore.online", "https://console.freeappstore.online", "http://localhost:5173"])("allows %s", (o) => {
    expect(allowed(o)).toBe(o);
  });

  it.each(["https://evil-app.freeappstore.online", "http://localhost.evil.com", "http://localhost@evil.com"])(
    "falls back to the apex for %s",
    (o) => {
      expect(allowed(o)).toBe("https://freeappstore.online");
    },
  );
});
