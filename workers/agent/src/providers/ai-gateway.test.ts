import { describe, expect, it } from "vitest";
import { gatewayEnabled, gatewayHeaders, providerBaseUrl, resolveGateway } from "./ai-gateway";

const GW = { AI_GATEWAY_ACCOUNT_ID: "acct123", AI_GATEWAY_ID: "fas-agent" };

describe("gatewayEnabled", () => {
  it("false when unset (direct provider calls)", () => {
    expect(gatewayEnabled({})).toBe(false);
    expect(gatewayEnabled({ AI_GATEWAY_ACCOUNT_ID: "acct123" })).toBe(false);
    expect(gatewayEnabled({ AI_GATEWAY_ID: "fas-agent" })).toBe(false);
  });
  it("true only when both account + id are set", () => {
    expect(gatewayEnabled(GW)).toBe(true);
  });
});

describe("providerBaseUrl", () => {
  it("returns direct provider URLs when the gateway is disabled", () => {
    expect(providerBaseUrl({}, "anthropic")).toBe("https://api.anthropic.com");
    expect(providerBaseUrl({}, "openai")).toBe("https://api.openai.com/v1");
    expect(providerBaseUrl({}, "google")).toBe("https://generativelanguage.googleapis.com");
  });

  it("returns gateway URLs with the correct provider slug when enabled", () => {
    expect(providerBaseUrl(GW, "anthropic")).toBe("https://gateway.ai.cloudflare.com/v1/acct123/fas-agent/anthropic");
    expect(providerBaseUrl(GW, "openai")).toBe("https://gateway.ai.cloudflare.com/v1/acct123/fas-agent/openai");
    // Google maps to the google-ai-studio slug, not "google".
    expect(providerBaseUrl(GW, "google")).toBe("https://gateway.ai.cloudflare.com/v1/acct123/fas-agent/google-ai-studio");
  });

  it("produces correct full endpoints when callers append their suffix", () => {
    expect(`${providerBaseUrl(GW, "anthropic")}/v1/messages`).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/fas-agent/anthropic/v1/messages",
    );
    expect(`${providerBaseUrl({}, "openai")}/chat/completions`).toBe("https://api.openai.com/v1/chat/completions");
    expect(`${providerBaseUrl(GW, "google")}/v1beta/models/gemini-2.0:streamGenerateContent`).toBe(
      "https://gateway.ai.cloudflare.com/v1/acct123/fas-agent/google-ai-studio/v1beta/models/gemini-2.0:streamGenerateContent",
    );
  });
});

describe("gatewayHeaders", () => {
  it("empty without a token", () => {
    expect(gatewayHeaders(GW)).toEqual({});
  });
  it("adds cf-aig-authorization with a token (authenticated gateway)", () => {
    expect(gatewayHeaders({ ...GW, AI_GATEWAY_TOKEN: "tok" })).toEqual({
      "cf-aig-authorization": "Bearer tok",
    });
  });
});

describe("resolveGateway", () => {
  it("bundles base URL + headers for a provider", () => {
    expect(resolveGateway({ ...GW, AI_GATEWAY_TOKEN: "tok" }, "anthropic")).toEqual({
      baseUrl: "https://gateway.ai.cloudflare.com/v1/acct123/fas-agent/anthropic",
      headers: { "cf-aig-authorization": "Bearer tok" },
    });
  });
  it("falls back to direct base with no headers when disabled", () => {
    expect(resolveGateway({}, "openai")).toEqual({
      baseUrl: "https://api.openai.com/v1",
      headers: {},
    });
  });
});
