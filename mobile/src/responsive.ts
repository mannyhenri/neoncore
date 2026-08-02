/**
 * One definition of how the app responds to the size of its window.
 *
 * `useWindowDimensions`, never `Dimensions.get`. Info.plist does not set UIRequiresFullScreen,
 * so on iPad this app can be resized WHILE RUNNING — Split View, Slide Over, dragging the
 * divider. `Dimensions.get('window')` is read once at module scope and never updates, so a
 * layout built on it is correct until the first resize and then quietly wrong. The hook
 * re-renders on every change, which is the only version that survives a user dragging a divider.
 *
 * The breakpoints are about LINE LENGTH, not device names. Text stops being comfortable to read
 * somewhere past ~90 characters, and an iPad Pro in landscape is 1366pt wide — a full-bleed card
 * there runs about 180. So a wide window is not an invitation to stretch; it is an invitation to
 * either cap the column or add a second one.
 */
import { useWindowDimensions } from 'react-native';

/** Below this we are a phone: one full-bleed column, no capping. */
export const TABLET_MIN_WIDTH = 768;

/**
 * Below this, a second column would be too narrow to be worth it. An iPad in PORTRAIT is 1024pt,
 * which is wide enough to need capping but not wide enough for two comfortable columns — so
 * portrait gets one centred column and landscape gets two.
 */
export const TWO_COLUMN_MIN_WIDTH = 1100;

/** The widest a single column of prose may get before it is hard to track across. */
export const MAX_COLUMN_WIDTH = 720;

/** The widest the whole content area may get in a two-column layout. */
export const MAX_GRID_WIDTH = 1400;

export interface Responsive {
  width: number;
  height: number;
  /** Wide enough that phone layout would look stretched. */
  isTablet: boolean;
  /** Wider than it is tall. Worth knowing separately from size. */
  isLandscape: boolean;
  /** How many card columns to render. 1 or 2. */
  columns: number;
  /** Cap for the content area; centre within the window using it. */
  contentMaxWidth: number;
}

export function useResponsive(): Responsive {
  const { width, height } = useWindowDimensions();
  const isTablet = width >= TABLET_MIN_WIDTH;
  const columns = width >= TWO_COLUMN_MIN_WIDTH ? 2 : 1;
  const contentMaxWidth = !isTablet
    ? width                                   // phone: full bleed, nothing to cap
    : columns === 2
      ? Math.min(width, MAX_GRID_WIDTH)
      : Math.min(width, MAX_COLUMN_WIDTH);
  return { width, height, isTablet, isLandscape: width > height, columns, contentMaxWidth };
}

/**
 * Props for a list that should become a grid on a wide window.
 *
 * `key` is the load-bearing part and the reason this is a helper rather than three inline props:
 * FlatList cannot change `numColumns` on an existing instance — React Native throws
 * "Changing numColumns on the fly is not supported". Rotating an iPad or dragging a Split View
 * divider does exactly that, so the list must be REMOUNTED, which is what keying on the column
 * count achieves. Getting this wrong produces a crash only on rotate, which is precisely the
 * path a phone-shaped test run never takes.
 */
export function gridProps(columns: number) {
  return {
    numColumns: columns,
    columnWrapperStyle: columns > 1 ? { gap: 0 } : undefined,
  } as const;
}

/**
 * The remount key for a column-count change. Pass as `key={gridKey(columns)}` — NEVER inside a
 * spread.
 *
 * React 19 refuses to read `key` out of a spread props object and warns "a props object
 * containing a key prop is being spread into JSX". It is not cosmetic: the key is dropped, the
 * FlatList is not remounted, and the numColumns change it existed to handle throws instead. So
 * the key is deliberately separate from gridProps rather than convenient — the convenient
 * version was silently broken.
 */
export function gridKey(columns: number): string {
  return `cols-${columns}`;
}
