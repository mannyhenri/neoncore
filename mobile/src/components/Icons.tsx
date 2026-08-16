import React from 'react';
import Svg, { Path } from 'react-native-svg';
import { theme } from '../theme';

/**
 * Icon set for the mobile app.
 *
 * Deliberately mirrors the dashboard's icon language so the two surfaces read as one
 * product: Heroicons-outline geometry on a 24x24 grid, no fill, stroke in the current
 * colour, 1.5 stroke width, round caps and joins. The app previously used emoji
 * (🔔 ⚡ ▣ ⚙ ❓), which render as full-colour glyphs and clashed with the dashboard's
 * monochrome line work — and drag in whatever the OS decides they look like.
 */
type IconProps = {
  size?: number;
  color?: string;
  /** Match the dashboard: 1.5 for UI chrome, 2 for emphasis. */
  strokeWidth?: number;
};

function Icon({
  size = 24,
  color = theme.textDim,
  strokeWidth = 1.5,
  d,
}: IconProps & { d: string | string[] }) {
  const paths = Array.isArray(d) ? d : [d];
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {paths.map((p, i) => (
        <Path
          key={i}
          d={p}
          stroke={color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </Svg>
  );
}

/** Cartridges — the agent grid. (Heroicons: squares-2x2) */
export const CartridgesIcon = (p: IconProps) => (
  <Icon
    {...p}
    d="M3.75 6A2.25 2.25 0 0 1 6 3.75h2.25A2.25 2.25 0 0 1 10.5 6v2.25a2.25 2.25 0 0 1-2.25 2.25H6a2.25 2.25 0 0 1-2.25-2.25V6ZM3.75 15.75A2.25 2.25 0 0 1 6 13.5h2.25a2.25 2.25 0 0 1 2.25 2.25V18a2.25 2.25 0 0 1-2.25 2.25H6A2.25 2.25 0 0 1 3.75 18v-2.25ZM13.5 6a2.25 2.25 0 0 1 2.25-2.25H18A2.25 2.25 0 0 1 20.25 6v2.25A2.25 2.25 0 0 1 18 10.5h-2.25a2.25 2.25 0 0 1-2.25-2.25V6ZM13.5 15.75a2.25 2.25 0 0 1 2.25-2.25H18a2.25 2.25 0 0 1 2.25 2.25V18A2.25 2.25 0 0 1 18 20.25h-2.25A2.25 2.25 0 0 1 13.5 18v-2.25Z"
  />
);

/** Workflows — a run you can launch. (Heroicons: bolt) */
export const WorkflowsIcon = (p: IconProps) => (
  <Icon {...p} d="m3.75 13.5 10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75Z" />
);

/** Approvals — things queued for your decision. (Heroicons: inbox)
 *  Replaces the bell: this is a queue you work through, not an alert that chimes. */
export const ApprovalsIcon = (p: IconProps) => (
  <Icon
    {...p}
    d="M2.25 13.5h3.86a2.25 2.25 0 0 1 2.012 1.244l.256.512a2.25 2.25 0 0 0 2.013 1.244h3.218a2.25 2.25 0 0 0 2.013-1.244l.256-.512a2.25 2.25 0 0 1 2.013-1.244h3.859m-19.5.338V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H6.911a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661Z"
  />
);

/** An agent is asking you something. (Heroicons: question-mark-circle) */
export const QuestionIcon = (p: IconProps) => (
  <Icon
    {...p}
    d={[
      'M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75',
      'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z',
    ]}
  />
);

/** A tool call. (Heroicons: command-line) */
export const ToolIcon = (p: IconProps) => (
  <Icon
    {...p}
    d="M6.75 7.5l3 2.25-3 2.25m4.5 0h3m-9 8.25h13.5A2.25 2.25 0 0 0 21 18V6a2.25 2.25 0 0 0-2.25-2.25H5.25A2.25 2.25 0 0 0 3 6v12a2.25 2.25 0 0 0 2.25 2.25Z"
  />
);

/** A tool result coming back. (Heroicons: arrow-turn-down-right) */
export const ResultIcon = (p: IconProps) => (
  <Icon {...p} d="M4.5 4.5v9a3 3 0 0 0 3 3h11.25m0 0-4.5-4.5m4.5 4.5-4.5 4.5" />
);

/** Launch a workflow. (Heroicons: play) */
export const PlayIcon = (p: IconProps) => (
  <Icon
    {...p}
    d="M5.25 5.653c0-.856.917-1.398 1.667-.986l11.54 6.347a1.125 1.125 0 0 1 0 1.972l-11.54 6.347a1.125 1.125 0 0 1-1.667-.986V5.653Z"
  />
);

/** Nothing waiting. (Heroicons: check-circle) */
export const CheckCircleIcon = (p: IconProps) => (
  <Icon {...p} d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" />
);

/** Goals — the outcome the work is aimed at. (Heroicons: flag) */
export const GoalsIcon = (p: IconProps) => (
  <Icon {...p} d="M3 3v1.5M3 21v-6m0 0 2.77-.693a9 9 0 0 1 6.208.682l.108.054a9 9 0 0 0 6.086.71l3.114-.732a48.524 48.524 0 0 1-.005-10.499l-3.11.732a9 9 0 0 1-6.085-.711l-.108-.054a9 9 0 0 0-6.208-.682L3 4.5M3 15V4.5" />
);

/** Tasks — discrete work items waiting for a cartridge. (Heroicons: clipboard-document-list) */
export const TasksIcon = (p: IconProps) => (
  <Icon
    {...p}
    d={[
      'M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25Z',
    ]}
  />
);
