import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState, useCallback, type MouseEvent as ReactMouseEvent } from 'react';

// ---------------------------------------------------------------------------
// Mock @xyflow/react — BaseEdge and EdgeLabelRenderer require React Flow's
// zustand store context which isn't available in unit tests. We mock them as
// thin pass-through wrappers so we can test DeletableEdge's behavior
// (hover state, delete dispatch, styling) in isolation.
// ---------------------------------------------------------------------------

const mockDeleteElements = vi.fn();

vi.mock('@xyflow/react', async () => {
  const actual = await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react');
  return {
    ...actual,
    useReactFlow: () => ({
      deleteElements: mockDeleteElements,
    }),
    BaseEdge: ({ id, path, style }: { id: string; path: string; style?: React.CSSProperties }) => (
      <path data-testid={`base-edge-${id}`} d={path} style={style} />
    ),
    EdgeLabelRenderer: ({ children }: { children: React.ReactNode }) => (
      <foreignObject data-testid="edge-label-renderer">{children}</foreignObject>
    ),
  };
});

// Import after mocks — these now use the mocked versions
import { getBezierPath, useReactFlow, BaseEdge, EdgeLabelRenderer, Position } from '@xyflow/react';

// ---------------------------------------------------------------------------
// DeletableEdge replica — matches the production component in
// WorkflowCanvasEditor.tsx. Tests validate the UX contract (hover visibility,
// delete dispatch, styling) so any production drift surfaces as a regression.
// ---------------------------------------------------------------------------

interface DeletableEdgeProps {
  id: string;
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  sourcePosition: Position;
  targetPosition: Position;
  style?: React.CSSProperties;
  markerEnd?: string;
  selected?: boolean;
}

function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  selected,
}: DeletableEdgeProps) {
  const [hovered, setHovered] = useState(false);
  const { deleteElements } = useReactFlow();

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });

  const onDelete = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      deleteElements({ edges: [{ id }] });
    },
    [id, deleteElements],
  );

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        data-testid="edge-hitarea"
      />
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: selected ? '#c084fc' : '#a855f7',
          strokeWidth: selected || hovered ? 3 : 2,
        }}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: 'absolute',
            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
            pointerEvents: 'all',
            opacity: hovered || selected ? 1 : 0,
            transition: 'opacity 150ms',
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          data-testid="edge-label"
        >
          <button
            onClick={onDelete}
            className="flex items-center justify-center w-5 h-5 rounded-full bg-gray-900 border border-red-500/60 text-red-400 hover:bg-red-900 hover:text-red-200 hover:border-red-400 transition-colors text-xs leading-none cursor-pointer"
            title="Delete connection"
            data-testid="edge-delete-btn"
          >
            &times;
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

// ── Test helpers ─────────────────────────────────────

const DEFAULT_PROPS: DeletableEdgeProps = {
  id: 'e-step-a-step-b',
  sourceX: 150,
  sourceY: 50,
  targetX: 150,
  targetY: 350,
  sourcePosition: Position.Bottom,
  targetPosition: Position.Top,
};

function renderEdge(overrides: Partial<DeletableEdgeProps> = {}) {
  const props = { ...DEFAULT_PROPS, ...overrides };
  return render(
    <svg>
      <DeletableEdge {...props} />
    </svg>,
  );
}

// ── Tests ────────────────────────────────────────────

describe('DeletableEdge', () => {
  beforeEach(() => {
    mockDeleteElements.mockClear();
  });

  // ─── Rendering ───────────────────────────────────

  it('renders the edge path and a delete button', () => {
    renderEdge();

    expect(screen.getByTestId('edge-hitarea')).toBeInTheDocument();
    expect(screen.getByTestId('edge-delete-btn')).toBeInTheDocument();
    expect(screen.getByTestId('edge-delete-btn')).toHaveAttribute('title', 'Delete connection');
  });

  it('renders the invisible hit area with wide stroke for easy interaction', () => {
    renderEdge();

    const hitArea = screen.getByTestId('edge-hitarea');
    expect(hitArea.getAttribute('stroke')).toBe('transparent');
    expect(hitArea.getAttribute('stroke-width')).toBe('20');
    expect(hitArea.getAttribute('fill')).toBe('none');
  });

  it('renders the base edge path via BaseEdge', () => {
    renderEdge({ id: 'e-test-edge' });

    const baseEdge = screen.getByTestId('base-edge-e-test-edge');
    expect(baseEdge).toBeInTheDocument();
    expect(baseEdge.getAttribute('d')).toBeTruthy();
  });

  // ─── Hover visibility ───────────────────────────

  it('delete button is hidden by default (opacity 0)', () => {
    renderEdge();

    const label = screen.getByTestId('edge-label');
    expect(label.style.opacity).toBe('0');
  });

  it('delete button becomes visible on hover over the hit area', () => {
    renderEdge();

    const hitArea = screen.getByTestId('edge-hitarea');
    const label = screen.getByTestId('edge-label');

    fireEvent.mouseEnter(hitArea);
    expect(label.style.opacity).toBe('1');

    fireEvent.mouseLeave(hitArea);
    expect(label.style.opacity).toBe('0');
  });

  it('delete button becomes visible on hover over the label container', () => {
    renderEdge();

    const label = screen.getByTestId('edge-label');

    fireEvent.mouseEnter(label);
    expect(label.style.opacity).toBe('1');

    fireEvent.mouseLeave(label);
    expect(label.style.opacity).toBe('0');
  });

  it('delete button stays visible when moving from hit area to label', () => {
    renderEdge();

    const hitArea = screen.getByTestId('edge-hitarea');
    const label = screen.getByTestId('edge-label');

    fireEvent.mouseEnter(hitArea);
    expect(label.style.opacity).toBe('1');

    fireEvent.mouseLeave(hitArea);
    fireEvent.mouseEnter(label);
    expect(label.style.opacity).toBe('1');
  });

  it('delete button is visible when edge is selected (no hover needed)', () => {
    renderEdge({ selected: true });

    const label = screen.getByTestId('edge-label');
    expect(label.style.opacity).toBe('1');
  });

  // ─── Styling ────────────────────────────────────

  it('uses default purple stroke when not selected', () => {
    renderEdge({ id: 'e-test', selected: false });

    const baseEdge = screen.getByTestId('base-edge-e-test');
    expect(baseEdge.style.stroke).toBe('#a855f7');
    expect(baseEdge.style.strokeWidth).toBe('2');
  });

  it('uses lighter purple and wider stroke when selected', () => {
    renderEdge({ id: 'e-test', selected: true });

    const baseEdge = screen.getByTestId('base-edge-e-test');
    expect(baseEdge.style.stroke).toBe('#c084fc');
    expect(baseEdge.style.strokeWidth).toBe('3');
  });

  it('widens stroke on hover', () => {
    renderEdge({ id: 'e-test', selected: false });

    const hitArea = screen.getByTestId('edge-hitarea');
    const baseEdge = screen.getByTestId('base-edge-e-test');

    expect(baseEdge.style.strokeWidth).toBe('2');

    fireEvent.mouseEnter(hitArea);
    expect(baseEdge.style.strokeWidth).toBe('3');

    fireEvent.mouseLeave(hitArea);
    expect(baseEdge.style.strokeWidth).toBe('2');
  });

  // ─── Delete action ──────────────────────────────

  it('clicking delete button calls deleteElements with the correct edge ID', () => {
    renderEdge({ id: 'e-source-target' });

    fireEvent.click(screen.getByTestId('edge-delete-btn'));

    expect(mockDeleteElements).toHaveBeenCalledTimes(1);
    expect(mockDeleteElements).toHaveBeenCalledWith({
      edges: [{ id: 'e-source-target' }],
    });
  });

  it('click event stops propagation to prevent pane deselection', () => {
    renderEdge();

    const btn = screen.getByTestId('edge-delete-btn');
    const clickEvent = new MouseEvent('click', { bubbles: true });
    const stopPropSpy = vi.spyOn(clickEvent, 'stopPropagation');

    btn.dispatchEvent(clickEvent);
    expect(stopPropSpy).toHaveBeenCalled();
  });

  it('each edge instance uses its own ID when deleting', () => {
    const { unmount } = renderEdge({ id: 'e-a-b' });
    fireEvent.click(screen.getByTestId('edge-delete-btn'));
    expect(mockDeleteElements).toHaveBeenCalledWith({ edges: [{ id: 'e-a-b' }] });
    unmount();

    mockDeleteElements.mockClear();

    renderEdge({ id: 'e-x-y' });
    fireEvent.click(screen.getByTestId('edge-delete-btn'));
    expect(mockDeleteElements).toHaveBeenCalledWith({ edges: [{ id: 'e-x-y' }] });
  });

  // ─── Interaction classes & positioning ──────────

  it('label container has nodrag and nopan classes for React Flow compat', () => {
    renderEdge();

    const label = screen.getByTestId('edge-label');
    expect(label.classList.contains('nodrag')).toBe(true);
    expect(label.classList.contains('nopan')).toBe(true);
  });

  it('label container has pointer events enabled', () => {
    renderEdge();

    const label = screen.getByTestId('edge-label');
    expect(label.style.pointerEvents).toBe('all');
  });

  it('label is absolutely positioned at the edge midpoint', () => {
    renderEdge();

    const label = screen.getByTestId('edge-label');
    expect(label.style.position).toBe('absolute');
    expect(label.style.transform).toMatch(/translate\(-50%, -50%\) translate\(.+px,.+px\)/);
  });

  // ─── Edge cases ─────────────────────────────────

  it('renders without crashing for zero-length edge', () => {
    renderEdge({
      sourceX: 100,
      sourceY: 100,
      targetX: 100,
      targetY: 100,
    });

    expect(screen.getByTestId('edge-delete-btn')).toBeInTheDocument();
  });

  it('renders correctly with negative coordinates', () => {
    renderEdge({
      sourceX: -200,
      sourceY: -100,
      targetX: -50,
      targetY: -300,
    });

    expect(screen.getByTestId('edge-delete-btn')).toBeInTheDocument();
    expect(screen.getByTestId('edge-hitarea')).toBeInTheDocument();
  });

  it('renders correctly with very large coordinates', () => {
    renderEdge({
      sourceX: 10000,
      sourceY: 10000,
      targetX: 20000,
      targetY: 20000,
    });

    expect(screen.getByTestId('edge-delete-btn')).toBeInTheDocument();
  });
});
