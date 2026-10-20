import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fsFileSource } from '../lib/file-source.js';
import { checkNoPayments } from './no-payments.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fas-compliance-'));
  await mkdir(join(dir, 'web', 'src'), { recursive: true });
  await mkdir(join(dir, 'web', 'public'), { recursive: true });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const run = () => checkNoPayments(fsFileSource(dir));
const write = (path: string, content: string) => writeFile(join(dir, path), content);

// FreeAppStore apps take no payments (#289).
describe('checkNoPayments', () => {
  it('passes an ordinary app, including words like "payment" in a calculator', async () => {
    await write(
      'web/src/App.tsx',
      "export const monthlyPayment = (p: number) => p / 12; // loan payment\nconst label = 'Payment schedule';",
    );
    await write(
      'web/public/manifest.json',
      JSON.stringify({ name: 'Loan', short_name: 'Loan', start_url: '/', display: 'standalone' }),
    );
    expect((await run()).status).toBe('pass');
  });

  it.each([
    ['Payment Request API', 'const r = new PaymentRequest(methods, details);'],
    ['Payment Request API', 'if (window.PaymentRequest) {}'],
    ['Payment Request API', "await registration.paymentManager.instruments.set('a', {});"],
    ['Apple Pay', 'if (window.ApplePaySession) new ApplePaySession(3, req);'],
    ['Google Pay', "s.src = 'https://pay.google.com/gp/p/js/pay.js';"],
    ['Stripe', "import { loadStripe } from '@stripe/stripe-js';"],
    ['Stripe', '<script src="https://js.stripe.com/v3/"></script>'],
    ['Stripe', "location.href = 'https://buy.stripe.com/test_abc123';"],
    ['Stripe', "fetch('https://api.stripe.com/v1/checkout/sessions', opts);"],
    ['PayPal', "s.src = 'https://www.paypal.com/sdk/js?client-id=x';"],
    ['Paddle', "s.src = 'https://cdn.paddle.com/paddle/v2/paddle.js';"],
    ['Lemon Squeezy', "window.open('https://store.lemonsqueezy.com/checkout/buy/123');"],
    ['Gumroad', "s.src = 'https://gumroad.com/js/gumroad.js';"],
  ])('fails on %s: %s', async (name, code) => {
    await write('web/src/pay.ts', code);
    const r = await run();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain(name);
    expect(r.suggestions?.join(' ')).toContain('ProAppStore');
  });

  it('fails on a payment SDK dependency in package.json', async () => {
    await write(
      'web/package.json',
      JSON.stringify({ dependencies: { stripe: '^17.0.0', react: '^19.0.0' } }),
    );
    expect((await run()).status).toBe('fail');
  });

  it.each(['payment', 'serviceworker'])('fails on a "%s" member in manifest.json', async (key) => {
    await write(
      'web/public/manifest.json',
      JSON.stringify({
        name: 'X',
        short_name: 'X',
        start_url: '/',
        display: 'standalone',
        [key]: {},
      }),
    );
    const r = await run();
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('manifest payment member');
  });

  it('fails on a payment member in an inline VitePWA manifest', async () => {
    await write(
      'web/vite.config.ts',
      "import { VitePWA } from 'vite-plugin-pwa';\nexport default { plugins: [VitePWA({ manifest: { name: 'X', serviceworker: { src: '/sw.js' } } })] };",
    );
    expect((await run()).status).toBe('fail');
  });

  it('ignores payment APIs that are only mentioned in comments or tests', async () => {
    await write(
      'web/src/App.tsx',
      '// Free tier: no new PaymentRequest(), no @stripe/stripe-js\nexport const x = 1;',
    );
    await mkdir(join(dir, 'web', 'e2e'), { recursive: true });
    await write('web/e2e/no-pay.spec.ts', 'expect(window.PaymentRequest).toBeUndefined();');
    await write('web/src/pay.test.ts', "import '@stripe/stripe-js';");
    expect((await run()).status).toBe('pass');
  });
});
