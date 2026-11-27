// Shared by the main process and the Publish page (#800); no Node imports.
// The categories /v1/publish accepts: a copy of VALID_CATEGORIES in packages/backend/src/lib/apps.ts, kept equal
// by scripts/categories.test.ts.
export const CATEGORIES = [
  'Learning',
  'Strategy',
  'Discovery',
  'Brain Training',
  'Social',
  'Productivity',
  'Lifestyle',
  'Health & Fitness',
  'Finance',
  'Creative',
  'News & Weather',
  'Utilities',
  'Other (specify in description)',
] as const;
