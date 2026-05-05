import { Box, Text, useInput } from 'ink';

interface Props {
  onContinue: () => void;
}

export function Welcome({ onContinue }: Props): React.ReactElement {
  useInput((_, key) => {
    if (key.return) onContinue();
  });

  return (
    <Box flexDirection="column">
      <Text>Welcome to FreeAppStore.</Text>
      <Text color="gray">
        You're not signed in yet. To publish a free app, run{' '}
        <Text bold color="cyan">
          fas login
        </Text>{' '}
        in another terminal first.
      </Text>
      <Box marginTop={1}>
        <Text color="gray" dimColor>
          Press Enter to continue to the menu.
        </Text>
      </Box>
    </Box>
  );
}
