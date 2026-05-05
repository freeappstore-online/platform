import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { useEffect, useState } from 'react';
import { runDoctor, type CheckResult } from '../../one-shot/doctor.js';

interface Props {
  onBack: () => void;
}

export function Doctor({ onBack }: Props): React.ReactElement {
  const [results, setResults] = useState<CheckResult[] | null>(null);

  useEffect(() => {
    // Track mount so we don't call setResults on an unmounted component
    // if the user navigates away while checks are still running.
    let active = true;
    void (async () => {
      const r = await runDoctor();
      if (active) setResults(r);
    })();
    return () => {
      active = false;
    };
  }, []);

  useInput((input, key) => {
    if (key.escape || input === 'b') onBack();
  });

  if (!results) {
    return (
      <Box>
        <Text color="cyan">
          <Spinner type="dots" />
        </Text>
        <Text> Running checks…</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {results.map((r) => (
        <ResultRow key={r.name} result={r} />
      ))}
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Press Esc or b to go back.
        </Text>
      </Box>
    </Box>
  );
}

function ResultRow({ result }: { result: CheckResult }): React.ReactElement {
  const color = result.status === 'pass' ? 'green' : result.status === 'warn' ? 'yellow' : 'red';
  const icon = result.status === 'pass' ? '✓' : result.status === 'warn' ? '!' : '✗';
  return (
    <Box>
      <Text color={color}>
        {icon}
        {'  '}
      </Text>
      <Text>{result.name.padEnd(20)}</Text>
      <Text color="gray" dimColor>
        {result.detail}
      </Text>
    </Box>
  );
}
