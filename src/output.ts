import path from 'node:path';

import type {AnswerResult, CanonicalReport} from './types.js';

function formatList(items: string[], bullet = '-'): string {
  if (items.length === 0) {
    return `${bullet} None`;
  }
  return items.map((item) => `${bullet} ${item}`).join('\n');
}

function formatPairs(items: Array<{name: string; value: string}>): string {
  if (items.length === 0) {
    return '- None';
  }
  return items.map((item) => `- ${item.name}: ${item.value}`).join('\n');
}

export function renderReport(report: CanonicalReport): string {
  const fileName = path.basename(report.file.path);
  const chapters = report.analysis.chapters
    .map((chapter) => {
      const range = chapter.end ? `${chapter.start} -> ${chapter.end}` : chapter.start;
      return `- ${range} | ${chapter.title}\n  ${chapter.description}`;
    })
    .join('\n');

  const people = report.analysis.people.map((person) => ({
    name: person.name,
    value: person.evidence
      ? `${person.role} (${person.evidence})`
      : person.role,
  }));

  const sections = [
    `# ${report.analysis.headline}`,
    `File: ${fileName}`,
    `Model: ${report.model}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    report.analysis.summary,
    '',
    '## Deep Overview',
    report.analysis.detailedOverview,
    '',
    '## Timeline',
    chapters || '- No chapter breakdown available.',
    '',
    '## People',
    formatPairs(people),
    '',
    '## Locations',
    formatList(report.analysis.locations),
    '',
    '## Objects',
    formatList(report.analysis.objects),
    '',
    '## Brands',
    formatList(report.analysis.brands),
    '',
    '## On-Screen Text',
    formatList(report.analysis.onScreenText),
    '',
    '## Audio',
    report.analysis.audioSummary,
    '',
    '## Notable Quotes',
    formatList(report.analysis.notableQuotes),
    '',
    '## Notable Moments',
    formatList(report.analysis.notableMoments),
    '',
    '## Themes',
    formatList(report.analysis.themes),
    '',
    '## Web Insights',
    formatList(report.analysis.webInsights),
    '',
    '## Uncertainties',
    formatList(report.analysis.uncertainties),
    '',
    '## Suggested Follow-Ups',
    formatList(report.analysis.suggestedFollowUps),
    '',
    '## Sources',
    report.sources.length === 0
      ? '- No grounded web sources were returned.'
      : report.sources.map((source) => `- ${source.title}: ${source.url}`).join('\n'),
  ];

  return sections.join('\n');
}

export function renderAnswer(result: AnswerResult): string {
  const lines = [result.answer.trim()];
  if (result.sources.length > 0) {
    lines.push('', 'Sources:');
    lines.push(...result.sources.map((source) => `- ${source.title}: ${source.url}`));
  }
  return lines.join('\n');
}
