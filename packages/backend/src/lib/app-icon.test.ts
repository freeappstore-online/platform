import { describe, expect, it } from 'vitest';
import { pickAppIcon } from './app-icon.js';

describe('pickAppIcon (#600)', () => {
  it('matches the app name before its one-liner', () => {
    expect(pickAppIcon('pill-count', 'A timer for your medicine', 'Health & Fitness')).toEqual({
      icon: '🩺',
      iconBg: '#dcfce7',
    });
  });

  it('falls back to the one-liner, then to the category', () => {
    expect(pickAppIcon('zenith', 'Track your daily expenses', 'Finance').icon).toBe('💰');
    expect(pickAppIcon('zenith', 'Something new', 'Discovery')).toEqual({
      icon: '🧭',
      iconBg: '#cffafe',
    });
  });

  it('matches whole words only and never returns the old rocket', () => {
    expect(pickAppIcon('aircraft', 'Hangar logbook', 'Other (specify in description)')).toEqual({
      icon: '📱',
      iconBg: '#ccfbf1',
    });
    expect(pickAppIcon('my-todo-app', '', 'Productivity').icon).toBe('✅');
  });
});
