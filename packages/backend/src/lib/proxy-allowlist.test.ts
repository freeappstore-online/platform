import { describe, expect, it } from 'vitest';
import {
  AllowlistError,
  type AllowlistRule,
  injectSecret,
  isAiProviderHost,
  pickRule,
  validateRule,
} from './proxy-allowlist.js';

describe('validateRule', () => {
  const base = {
    pattern: 'https://api.openweathermap.org/data/2.5/',
    injectKind: 'query',
    injectName: 'appid',
    secretName: 'OPENWEATHER_KEY',
    methods: ['get', 'POST'],
  };

  it('accepts a typical rule and upper-cases methods', () => {
    const rule = validateRule(base);
    expect(rule.methods).toEqual(['GET', 'POST']);
  });

  it('rejects http:// patterns', () => {
    expect(() => validateRule({ ...base, pattern: 'http://api.example.com/' })).toThrow(
      /https:\/\//,
    );
  });

  it('rejects malformed URLs', () => {
    expect(() => validateRule({ ...base, pattern: 'https://' })).toThrow(/valid URL/);
  });

  it.each([
    'api.openai.com',
    'openai.com',
    'api.anthropic.com',
    'openrouter.ai',
    'generativelanguage.googleapis.com',
    'foo.openai.com',
  ])('blocks AI provider host: %s', (host) => {
    expect(() => validateRule({ ...base, pattern: `https://${host}/v1/x` })).toThrow(
      /PAS AI key vault/,
    );
  });

  it('does NOT block hosts that merely contain the substring', () => {
    // openai.computer is not openai.com — endsWith('.openai.com') guards us.
    expect(() => validateRule({ ...base, pattern: 'https://openai.computer/x' })).not.toThrow();
  });

  it('rejects unknown injectKind', () => {
    expect(() => validateRule({ ...base, injectKind: 'cookie' })).toThrow(/injectKind/);
  });

  it('requires injectName for query/header but not bearer', () => {
    expect(() => validateRule({ ...base, injectKind: 'header', injectName: '' })).toThrow(
      /injectName is required/,
    );
    expect(() => validateRule({ ...base, injectKind: 'bearer', injectName: '' })).not.toThrow();
  });

  it('requires non-empty methods', () => {
    expect(() => validateRule({ ...base, methods: [] })).toThrow(/methods/);
  });

  it('rejects junk methods', () => {
    expect(() => validateRule({ ...base, methods: ['GET ', 'POST'] })).toThrow(/HTTP method/);
  });
});

describe('pickRule', () => {
  const rules: AllowlistRule[] = [
    {
      pattern: 'https://api.openweathermap.org/data/2.5/',
      injectKind: 'query',
      injectName: 'appid',
      secretName: 'OPENWEATHER_KEY',
      methods: ['GET'],
    },
    {
      pattern: 'https://api.openweathermap.org/data/2.5/onecall',
      injectKind: 'query',
      injectName: 'appid',
      secretName: 'OPENWEATHER_PRO_KEY',
      methods: ['GET'],
    },
    {
      pattern: 'https://api.example.com/',
      injectKind: 'header',
      injectName: 'X-API-Key',
      secretName: 'EXAMPLE_KEY',
      methods: ['POST'],
    },
  ];

  it('returns null when no rule matches the URL', () => {
    expect(pickRule(rules, 'https://other.example.org/x', 'GET')).toBeNull();
  });

  it('returns null when URL matches but method does not', () => {
    expect(pickRule(rules, 'https://api.example.com/v1/widgets', 'GET')).toBeNull();
  });

  it('matches by prefix and method', () => {
    const rule = pickRule(rules, 'https://api.example.com/v1/widgets', 'POST');
    expect(rule?.secretName).toBe('EXAMPLE_KEY');
  });

  it('picks the longest matching prefix (most specific wins)', () => {
    const rule = pickRule(
      rules,
      'https://api.openweathermap.org/data/2.5/onecall?lat=1&lon=2',
      'GET',
    );
    expect(rule?.secretName).toBe('OPENWEATHER_PRO_KEY');
  });

  it('falls back to less specific prefix when the long one does not apply', () => {
    const rule = pickRule(rules, 'https://api.openweathermap.org/data/2.5/weather?q=London', 'GET');
    expect(rule?.secretName).toBe('OPENWEATHER_KEY');
  });

  it('is case-insensitive on method', () => {
    expect(pickRule(rules, 'https://api.example.com/v1/widgets', 'post')?.secretName).toBe(
      'EXAMPLE_KEY',
    );
  });
});

describe('injectSecret', () => {
  const baseRule: AllowlistRule = {
    pattern: 'https://api.example.com/',
    injectKind: 'query',
    injectName: 'apikey',
    secretName: 'X',
    methods: ['GET'],
  };

  it('injects a query parameter, preserving existing query', () => {
    const { url, headers } = injectSecret(
      baseRule,
      'https://api.example.com/v1/x?foo=bar',
      new Headers({ 'X-User': 'u1' }),
      'sekret',
    );
    const u = new URL(url);
    expect(u.searchParams.get('apikey')).toBe('sekret');
    expect(u.searchParams.get('foo')).toBe('bar');
    // Headers untouched.
    expect(headers.get('X-User')).toBe('u1');
    expect(headers.get('Authorization')).toBeNull();
  });

  it('replaces an existing query value of the same name', () => {
    const { url } = injectSecret(
      baseRule,
      'https://api.example.com/v1/x?apikey=PLACEHOLDER',
      new Headers(),
      'real',
    );
    expect(new URL(url).searchParams.get('apikey')).toBe('real');
  });

  it('injects a header', () => {
    const rule: AllowlistRule = { ...baseRule, injectKind: 'header', injectName: 'X-API-Key' };
    const { url, headers } = injectSecret(
      rule,
      'https://api.example.com/v1/x',
      new Headers(),
      'sekret',
    );
    expect(url).toBe('https://api.example.com/v1/x');
    expect(headers.get('X-API-Key')).toBe('sekret');
  });

  it('injects a Bearer token', () => {
    const rule: AllowlistRule = { ...baseRule, injectKind: 'bearer', injectName: '' };
    const { headers } = injectSecret(rule, 'https://api.example.com/v1/x', new Headers(), 'sekret');
    expect(headers.get('Authorization')).toBe('Bearer sekret');
  });
});

describe('isAiProviderHost', () => {
  it.each([
    ['api.openai.com', true],
    ['openai.com', true],
    ['api.anthropic.com', true],
    ['openrouter.ai', true],
    ['generativelanguage.googleapis.com', true],
    ['us-central1-aiplatform.googleapis.com', false], // different host
    ['notopenai.com', false],
    ['api.openweathermap.org', false],
  ])('isAiProviderHost(%s) = %s', (host, expected) => {
    expect(isAiProviderHost(host)).toBe(expected);
  });
});

describe('AllowlistError', () => {
  it('has a stable name for catch handlers', () => {
    const e = new AllowlistError('x');
    expect(e.name).toBe('AllowlistError');
    expect(e).toBeInstanceOf(Error);
  });
});
