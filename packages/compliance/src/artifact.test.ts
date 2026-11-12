import { describe, expect, it } from 'vitest';
import { checkArtifactFiles } from './artifact.js';

describe('built artifact compliance', () => {
  it('detects trackers and ads embedded in built JavaScript', () => {
    const results = checkArtifactFiles(
      new Map([['assets/index.js', 'gtag("config", "G-123"); adsbygoogle.push({});']]),
    );
    expect(results.map((r) => r.status)).toEqual(['fail', 'fail', 'pass']);
  });

  it('detects payment APIs in shipped code', () => {
    const results = checkArtifactFiles(new Map([['assets/pay.js', 'new PaymentRequest([]);']]));
    expect(results.find((r) => r.name === 'No payments (built artifact)')?.status).toBe('fail');
  });

  it('passes a clean artifact', () => {
    expect(
      checkArtifactFiles(new Map([['index.html', '<main>hello</main>']])).every(
        (r) => r.status === 'pass',
      ),
    ).toBe(true);
  });
});
