-- #675: api.stripe.com left HOST_TO_PROVIDER in #495, so no app can spend a
-- vaulted Stripe key, yet 0012 still seeded the provider and PUT /v1/keys/stripe
-- kept storing users' Stripe secret keys. Drop the stored keys and the provider.
DELETE FROM user_api_keys WHERE provider = 'stripe';
DELETE FROM key_providers WHERE id = 'stripe';
