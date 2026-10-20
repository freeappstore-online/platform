// Rigged for the "No payments (free tier)" check (#289): FreeAppStore apps take no payments.
export function buy() {
  return new PaymentRequest([{ supportedMethods: 'https://google.com/pay' }], {
    total: { label: 'Pro', amount: { currency: 'USD', value: '4.99' } },
  });
}
