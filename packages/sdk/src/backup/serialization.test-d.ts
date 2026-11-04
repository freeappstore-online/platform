import { type BackupEnvelope, exportBackup, type JsonSerialized } from '@freeappstore/sdk/backup';
import { expectTypeOf } from 'vitest';
import { detachJson } from './envelope.js';

class RecordWithJson {
  method() {
    return 'domain';
  }
  toJSON() {
    return { label: 'wire', dates: [new Date()] };
  }
}

async function contract() {
  const result = await exportBackup({
    appId: 'notes',
    data: {
      when: new Date(),
      record: new RecordWithJson(),
      nested: [{ when: new Date() }],
      nil: null,
    },
  });
  if (result.ok) {
    expectTypeOf(result.value.data.when).toEqualTypeOf<string>();
    expectTypeOf(result.value.data.record.label).toEqualTypeOf<string>();
    expectTypeOf(result.value.data.record.dates).toEqualTypeOf<string[]>();
    expectTypeOf(result.value.data.nested[0]!.when).toEqualTypeOf<string>();
    expectTypeOf(result.value.data.nil).toEqualTypeOf<null>();
    // @ts-expect-error JSON dates have no Date methods.
    result.value.data.when.getTime();
    // @ts-expect-error JSON snapshots have no class methods.
    result.value.data.record.method();
  }
  const detached = detachJson(new RecordWithJson());
  if (detached.ok) expectTypeOf(detached.value.dates).toEqualTypeOf<string[]>();
  expectTypeOf<BackupEnvelope<{ when: Date }>['data']['when']>().toEqualTypeOf<string>();
  expectTypeOf<JsonSerialized<[undefined, string | undefined, null, boolean]>>().toEqualTypeOf<
    [null, string | null, null, boolean]
  >();
  expectTypeOf<JsonSerialized<{ value: string | undefined }>['value']>().toEqualTypeOf<
    string | undefined
  >();
  // @ts-expect-error Omitted object methods are absent.
  type Omitted = JsonSerialized<{ method(): void }>['method'];
  expectTypeOf<Omitted>();
  expectTypeOf<JsonSerialized<[{ toJSON(): undefined }]>>().toEqualTypeOf<[null]>();
  expectTypeOf<JsonSerialized<{ absent: { toJSON(): undefined } }>>().toEqualTypeOf<{} & {}>();
}
void contract;
