import path from 'node:path';

import type {AnswerResult, CanonicalReport, GenerationRecord} from './types.js';

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
  const assetLabel =
    report.assets.length === 1
      ? path.basename(report.assets[0]?.path ?? report.source.displayLabel)
      : `${report.assets.length} assets`;
  const assetList = report.assets
    .map((asset) => `- [${asset.index + 1}] ${asset.kind} | ${path.basename(asset.path)}`)
    .join('\n');
  const assetSummaries = report.analysis.assetSummaries
    .map((summary) => `- [${summary.assetIndex + 1}] ${summary.summary}`)
    .join('\n');
  const segments = report.analysis.segments
    .map((segment) => {
      const timeRange = segment.start
        ? segment.end
          ? `${segment.start} -> ${segment.end}`
          : segment.start
        : 'No timestamp';
      return `- [${segment.assetIndex + 1}] ${timeRange} | ${segment.title}\n  ${segment.description}`;
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
    `Source: ${report.source.displayLabel}`,
    `Assets: ${assetLabel}`,
    `Model: ${report.model}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Summary',
    report.analysis.summary,
    '',
    '## Deep Overview',
    report.analysis.detailedOverview,
    '',
    '## Assets',
    assetList || '- No assets found.',
    '',
    '## Asset Summaries',
    assetSummaries || '- No asset summaries available.',
    '',
    '## Segments',
    segments || '- No segment breakdown available.',
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
    ...(report.analysis.audioSummary
      ? ['', '## Audio', report.analysis.audioSummary]
      : []),
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

export function renderGenerationRecord(record: GenerationRecord): string {
  const outputLines = record.outputs.map(
    (output) => `- [${output.index + 1}] ${output.mimeType} | ${output.path}`,
  );
  const inputLines = record.inputs.flatMap((input) =>
    input.assets.map(
      (asset) =>
        `- ${input.source.displayLabel} -> [${asset.index + 1}] ${asset.kind} | ${path.basename(asset.path)}`,
    ),
  );

  const sections = [
    `# Generated ${record.kind}`,
    `Model: ${record.modelAlias ? `${record.modelAlias} (${record.model})` : record.model}`,
    `Mode: ${record.mode}`,
    `Created: ${record.createdAt}`,
    `ID: ${record.id}`,
    '',
    '## Prompt',
    record.prompt,
    '',
    '## Inputs',
    inputLines.length > 0 ? inputLines.join('\n') : '- None',
    '',
    '## Outputs',
    outputLines.join('\n'),
  ];

  if (record.operationName) {
    sections.push('', '## Operation', record.operationName);
  }

  return sections.join('\n');
}
