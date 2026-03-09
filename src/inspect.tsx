import React, {useMemo, useState} from 'react';
import {Box, Text, useApp, useInput} from 'ink';

import type {CanonicalReport} from './types.js';

const tabs = ['Summary', 'Timeline', 'Entities', 'Sources', 'Meta'] as const;

function joinOrNone(items: string[]): string {
  return items.length > 0 ? items.join(', ') : 'None';
}

function Section(props: {title: string; body: string[]}) {
  return (
    <Box flexDirection="column" gap={1}>
      <Text color="cyan">{props.title}</Text>
      {props.body.map((line, index) => (
        <Text key={`${props.title}-${index}`}>{line}</Text>
      ))}
    </Box>
  );
}

export function InspectApp(props: {report: CanonicalReport}) {
  const {exit} = useApp();
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (input === 'q' || key.escape || key.ctrl && input === 'c') {
      exit();
      return;
    }

    if (key.leftArrow) {
      setSelectedIndex((current) => (current - 1 + tabs.length) % tabs.length);
      return;
    }

    if (key.rightArrow || key.tab) {
      setSelectedIndex((current) => (current + 1) % tabs.length);
      return;
    }

    const numericIndex = Number.parseInt(input, 10);
    if (!Number.isNaN(numericIndex) && numericIndex >= 1 && numericIndex <= tabs.length) {
      setSelectedIndex(numericIndex - 1);
    }
  });

  const currentTab = tabs[selectedIndex];
  const content = useMemo(() => {
    if (currentTab === 'Summary') {
      return (
        <Section
          title="Summary"
          body={[
            props.report.analysis.summary,
            '',
            props.report.analysis.detailedOverview,
          ]}
        />
      );
    }

    if (currentTab === 'Timeline') {
      return (
        <Section
          title="Timeline"
          body={props.report.analysis.chapters.map((chapter) => {
            const range = chapter.end ? `${chapter.start} -> ${chapter.end}` : chapter.start;
            return `${range} | ${chapter.title} | ${chapter.description}`;
          })}
        />
      );
    }

    if (currentTab === 'Entities') {
      return (
        <Section
          title="Entities"
          body={[
            `People: ${props.report.analysis.people.map((person) => `${person.name} (${person.role})`).join(', ') || 'None'}`,
            `Locations: ${joinOrNone(props.report.analysis.locations)}`,
            `Objects: ${joinOrNone(props.report.analysis.objects)}`,
            `Brands: ${joinOrNone(props.report.analysis.brands)}`,
            `On-Screen Text: ${joinOrNone(props.report.analysis.onScreenText)}`,
            `Themes: ${joinOrNone(props.report.analysis.themes)}`,
          ]}
        />
      );
    }

    if (currentTab === 'Sources') {
      return (
        <Section
          title="Sources"
          body={
            props.report.sources.length > 0
              ? props.report.sources.map((source) => `${source.title} | ${source.url}`)
              : ['No grounded sources were returned for this report.']
          }
        />
      );
    }

    return (
      <Section
        title="Meta"
        body={[
          `File: ${props.report.file.path}`,
          `Hash: ${props.report.file.hash}`,
          `Model: ${props.report.model}`,
          `Generated: ${props.report.generatedAt}`,
          `Web mode: ${props.report.webMode}`,
          `Prompt version: ${props.report.promptVersion}`,
          `Search queries: ${props.report.searchQueries.join(', ') || 'None'}`,
          `Suggested follow-ups: ${props.report.analysis.suggestedFollowUps.join(', ') || 'None'}`,
        ]}
      />
    );
  }, [currentTab, props.report]);

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="magentaBright">peek inspector</Text>
      <Text color="gray">
        {props.report.analysis.headline}
      </Text>
      <Box marginTop={1} marginBottom={1}>
        {tabs.map((tab, index) => (
          <Box key={tab} marginRight={2}>
            <Text color={index === selectedIndex ? 'greenBright' : 'gray'}>
              {index + 1}. {tab}
            </Text>
          </Box>
        ))}
      </Box>
      <Box borderStyle="round" borderColor="blue" padding={1}>
        {content}
      </Box>
      <Box marginTop={1}>
        <Text color="gray">Use left/right arrows or 1-5 to switch tabs. Press q to exit.</Text>
      </Box>
    </Box>
  );
}
