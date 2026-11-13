/**
 * Storefront icon and tile colour for a newly published app (#600). Publish
 * used to send a rocket on grey for every app, so most of the store grid was
 * the same tile. The icon comes from the app's own words: the name is matched
 * first, then the one-liner, then the category decides.
 */

const KEYWORDS: [RegExp, string][] = [
  [/\b(to-?dos?|tasks?|checklist|chores?)\b/, '✅'],
  [/\b(timer|pomodoro|stopwatch|countdown|metronome)\b/, '⏱️'],
  [/\b(calendar|schedul\w*|planner|booking)\b/, '📅'],
  [/\b(notes?|journal|diary|letters?)\b/, '📔'],
  [/\b(recipes?|cook\w*|meals?|food|pizza)\b/, '🍳'],
  [/\b(budget|expenses?|money|invoices?|bills?|loan|mortgage)\b/, '💰'],
  [/\b(workout|fitness|exercise|gym|hiit)\b/, '🏋️'],
  [/\b(sleep)\b/, '😴'],
  [/\b(meditat\w*|breath\w*|calm|relax\w*|asmr)\b/, '🧘'],
  [/\b(mood|habits?)\b/, '🙂'],
  [/\b(music|songs?|piano|guitar|chords?|tuner?|karaoke|midi)\b/, '🎵'],
  [/\b(audio|sound\w*|voice|record\w*)\b/, '🎙️'],
  [/\b(photos?|camera|images?)\b/, '📷'],
  [/\b(draw\w*|sketch\w*|paint\w*|pixel)\b/, '🎨'],
  [/\b(colou?rs?|palette)\b/, '🌈'],
  [/\b(chat|messag\w*|rooms?)\b/, '💬'],
  [/\b(polls?|vot\w*)\b/, '🗳️'],
  [/\b(maps?|geograph\w*|travel|countries)\b/, '🌍'],
  [/\b(weather|forecast)\b/, '⛅'],
  [/\b(math\w*|calculat\w*|formulas?|statistics?|graph\w*)\b/, '🧮'],
  [/\b(chemistry|physics|science|biology|lab)\b/, '🔬'],
  [/\b(stars?|planets?|solar|moon|astronomy)\b/, '🌌'],
  [/\b(dictionary|words?|read\w*|books?|language|translat\w*)\b/, '📖'],
  [/\b(quiz\w*|study|learn\w*|flashcards?|coach)\b/, '🎓'],
  [/\b(code|coding|json|regex|developer|markdown|cron\w*)\b/, '💻'],
  [/\b(shop\w*|grocer\w*|cart)\b/, '🛒'],
  [/\b(pets?|dogs?|cats?)\b/, '🐶'],
  [/\b(health|symptoms?|pills?|medic\w*)\b/, '🩺'],
  [/\b(plants?|garden\w*)\b/, '🌱'],
  [/\b(stock|inventory)\b/, '📦'],
  [/\b(time ?zones?|clock)\b/, '🕒'],
  [/\b(passwords?|encrypt\w*|encod\w*|hash)\b/, '🔐'],
  [/\b(ai|agents?|bot)\b/, '🤖'],
  [/\b(shar\w*|files?|transfer)\b/, '📤'],
  [/\b(games?|play)\b/, '🎲'],
];

const BY_CATEGORY: Record<string, { icon: string; bg: string }> = {
  Learning: { icon: '🎓', bg: '#dbeafe' },
  Strategy: { icon: '♟️', bg: '#fee2e2' },
  Discovery: { icon: '🧭', bg: '#cffafe' },
  'Brain Training': { icon: '🧠', bg: '#fef3c7' },
  Social: { icon: '💬', bg: '#fce7f3' },
  Productivity: { icon: '📋', bg: '#e0e7ff' },
  Lifestyle: { icon: '🌿', bg: '#ffedd5' },
  'Health & Fitness': { icon: '💪', bg: '#dcfce7' },
  Finance: { icon: '💰', bg: '#fef9c3' },
  Creative: { icon: '🎨', bg: '#f3e8ff' },
  'News & Weather': { icon: '📰', bg: '#e0f2fe' },
  Utilities: { icon: '🧰', bg: '#e2e8f0' },
};
const OTHER = { icon: '📱', bg: '#ccfbf1' };

export function pickAppIcon(
  name: string,
  oneliner: string,
  category: string,
): { icon: string; iconBg: string } {
  const byCategory = BY_CATEGORY[category] ?? OTHER;
  for (const text of [name, oneliner]) {
    const words = text.toLowerCase().replace(/[-_]+/g, ' ');
    const hit = KEYWORDS.find(([pattern]) => pattern.test(words));
    if (hit) return { icon: hit[1], iconBg: byCategory.bg };
  }
  return { icon: byCategory.icon, iconBg: byCategory.bg };
}
