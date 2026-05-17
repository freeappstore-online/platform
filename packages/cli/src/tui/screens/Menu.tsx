import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';

export type MenuChoice = 'doctor' | 'quit';

interface Item {
  label: string;
  value: MenuChoice;
}

interface Props {
  login: string | null;
  onSelect: (choice: MenuChoice) => void;
}

export function Menu({ login, onSelect }: Props): React.ReactElement {
  const items: Item[] = [
    { label: 'Doctor — run health checks', value: 'doctor' },
    { label: 'Quit', value: 'quit' },
  ];

  // Menu-scoped keyboard shortcut. Lives here (not at App level) so it
  // doesn't fire when a child screen has a text input.
  useInput((input) => {
    if (input === 'q') onSelect('quit');
  });

  return (
    <Box flexDirection="column">
      <Text>{login ? `Signed in as @${login}.` : 'Not signed in.'} What would you like to do?</Text>
      <Box marginTop={1}>
        <SelectInput<MenuChoice> items={items} onSelect={(item) => onSelect(item.value)} />
      </Box>
    </Box>
  );
}
