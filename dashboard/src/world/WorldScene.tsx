/**
 * THE AGENTS SCREEN — a scene instead of a grid (V3).
 *
 * Every cartridge is a crew member at a work site on the plate, with a small panel over its
 * head saying what it is working on. The figure is a drawn sprite sheet (sheets.ts); until an
 * engine has one, its crew show the panel only — there are no figures drawn from code. The scene is a VIEW of the same records the
 * cartridge list shows: nothing here is invented, and everything you could do from a card
 * you can still do — click a crew member and its card opens beside the scene.
 *
 * Art rule (docs/DESIGN.md "The World view"): the plate and the avatars are pixel art; every
 * panel drawn over them is Night Glass.
 */
import { FinalAnswerModal } from '../components/FinalAnswerModal';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { SendOutcome } from '../lib/deliveryNotice';
import type { Agent, AgentMode, Activity, PermissionRequest, StuckAlert, CommandAttachmentInput } from '../types';
import { CartridgeGrid } from '../components/CartridgeGrid';
import type { StatusFilter } from '../components/CartridgeGrid';
import { cartridgeProgress } from '../lib/cartridgeProgress';
import { useLiveWork } from '../hooks/useLiveWork';
import { buildCrew, crewCounts, ENGINE_COLOURS } from './crew';
import type { CrewMember, CrewAttention } from './crew';
import { assignSlots, spotsFor } from './sites';
import { PLATE, THEME, MAPS, MAP_KEY, resolveMap, word } from './theme';
import type { WorldMap } from './theme';
import { MapSwitch, isOpen } from './MapSwitch';
import type { MapProgress } from '../types';
import { planZones, planCamps, planAnnexes, planSectors, sectorByRepo, buildingFor, POD_PREFIX, zoneFor, placeByZone, normRepo, OPEN_POOL } from './zones';
import { pipelineSignal, benchSeats, featuresToDo, freightFor, freightTitle, nextWorkSwitch, settledDeliveries, workCycleAt } from './props';
import type { PoolSlots } from './zones';
import { padsFor, padOf } from './fleet';
import { meetingKeys } from './meeting';
import { deadlineFor, pennantFrame, badgesFor, FEATURE_BADGES } from './milestones';
import { FeaturePlates, worktreeRepos } from './FeaturePlates';
import type { Deadline } from './milestones';
import type { Placement, WorldPlate, WorldSite, WorldStructure } from './sites';
import type { KitName } from './kit';
import { SIGNPOST } from './signpost.generated';
import { projectHash } from '../lib/projectSelection';
import { playUi } from '../lib/sound/engine';
import { useRewards, useNewMaps } from './useRewards';
import { NewMapPanel } from './NewMapPanel';
import { RewardMedal } from '../components/rewards/RewardMedal';
import { topTier } from '../components/rewards/ProjectRewards';
import { Avatar } from './Avatar';
import { animationFor } from './anim';
import { CHARACTERS, assignCharacters } from './sheets';
import { clampSpot, loadCustomSpots, saveCustomSpots, spotHolds, spotStranded } from './customSpots';
import type { Spot, HeldSpot } from './customSpots';
import { queueFor, burnShares, formatRate } from './extras';
import type { CrewQueue, CrewBurn } from './extras';
import { useCrewExtras } from './useCrewExtras';
import { KIT, crateSpriteFor, cellSpriteFor } from './kit';
import { AMBIENT_GROUND, AMBIENT_PROPS } from './ambient.generated';
import type { AmbientStrip as AmbientArt } from './ambient.generated';

// The ambient frames are cut from the BASE theme's own map and props (scripts/world/build_ambient.py):
// laid over another theme's art they would be the wrong pond and the wrong table, so a pack
// without its own is simply still.
const AMBIENT: typeof AMBIENT_GROUND = THEME === 'scifi' ? AMBIENT_GROUND : {};
const MOVING_PROPS: typeof AMBIENT_PROPS = THEME === 'scifi' ? AMBIENT_PROPS : {};
import { MIN_ZOOM, MAX_ZOOM, ZOOM_STEP, scaleFor, clampCamera, homeCamera, zoomAt, panBy } from './camera';
import type { Camera } from './camera';
import { summarize, isReport, messageId, loadRead, markRead, isUnread } from './summary';

interface WorldSceneProps {
  agents: Agent[];
  activitiesByAgent: Record<string, Activity[]>;
  pendingPermissions: PermissionRequest[];
  stuckAlerts: StuckAlert[];
  onDecidePermission: (id: string, decision: 'allowed' | 'denied', response?: Record<string, unknown>) => void;
  onSetMode: (agentId: string, mode: AgentMode) => void;
  // Returns what the server said about delivery, so the card can say when a prompt reached no session.
  onSendCommand: (agentId: string, text: string, includeMemory?: boolean, attachments?: CommandAttachmentInput[]) => void | Promise<SendOutcome | null | void>;
  onDelete: (agentId: string) => void;
  onDismiss: (agentId: string) => void;
  onRestore: (agentId: string) => void;
  onDismissStuck: (agentId: string) => void;
  onActivityClick?: (activity: Activity) => void;
  statusFilter?: StatusFilter;
  onStatusCounts?: (counts: Record<StatusFilter, number>) => void;
  /** Controls drawn over the scene's top edge (filters, the scene/list switch). */
  hud?: ReactNode;
  /** Cartridges that exist but are not drawn in the scene (hidden ones, virtual ones). */
  offSceneCount?: number;
  onOpenList?: () => void;
  plate?: WorldPlate;
}

const ATTENTION_LABEL: Record<CrewAttention, string> = {
  approval: 'Needs you · approval',
  question: 'Needs you · question',
  stuck: 'Stuck',
  review: 'Needs review',
};

const STATUS_WORD: Record<CrewMember['status'], string> = { working: 'Working', waiting: 'Waiting', idle: 'Idle' };

/**
 * Height of one sprite CELL as a fraction of the plate's height. The character fills about
 * 60% of its cell, which puts it at the size of the figures in the concept art.
 */
const AVATAR_SCALE = 0.2;
/** Walking speed: seconds to cross the full width of the plate. */
const WALK_SECONDS_PER_PLATE = 9;
/** How long a figure wipes its brow after a finished task before it stands idle or waves, in milliseconds. */
const FINISH_MS = 2000;
/** A signpost's height, in figure heights. */
const SIGN_HEIGHT = 1.15;
const SIGN_ART = SIGNPOST[THEME] ?? SIGNPOST.scifi;
/**
 * Where things stand relative to the signpost's spot, as fractions of the plate's width.
 * hang: the mast stands left of the spot and the board hangs over it. center: the post IS the spot.
 */
const SIGN_ROW = {
  hang: { mast: -0.03, marker: -0.006, gauge: 0.016, pennant: 0.032 },
  center: { mast: 0, marker: -0.026, gauge: 0.024, pennant: 0.04 },
} as const;
const PLAQUE_CLASS = 'absolute top-full mt-0.5 px-1.5 py-px rounded-md border border-white/[0.14] bg-[rgba(10,16,32,0.82)] font-mono text-[10px] leading-4 text-gray-300 whitespace-nowrap';
/** Above this many figures the panels shrink to a name; the rest shows on hover, selection or alert. */
const COMPACT_ABOVE = 8;
/**
 * LAYERS, bottom to top. Scenery (buildings, props, name plates on them) sorts by where it
 * stands, 0–1000. Characters are ALWAYS above all of it, sorted among themselves the same way.
 * A project's banner is above every character — at rest, hovered (index.css, 5000) or dragged.
 */
const FIGURE_Z = 2000;
export const FIGURE_DRAG_Z = 6000;
const BANNER_Z = 8000;
/** How far the pointer must travel before a press on a figure counts as a drag, in pixels. */
const DRAG_THRESHOLD = 5;

/** What the map switch needs: the maps of this theme, which is on screen, and how to go to another. */
interface SceneTravel {
  newMaps: MapProgress[];
  /** Present only when there is somewhere to go: more than one map is open. */
  travel?: { maps: readonly WorldMap[]; current: string; unlocked: ReadonlySet<string>; go: (id: string) => void };
}

/** The map the world is on is remembered: it opens where you left it (theme.ts resolveMap). */
function readMap(): string | null { try { return window.localStorage.getItem(MAP_KEY); } catch { return null; } }
function writeMap(id: string): void { try { window.localStorage.setItem(MAP_KEY, id); } catch { /* not remembered */ } }

/**
 * THE WORLD, ON ONE OF ITS MAPS. Which map is decided here (the remembered one while it is unlocked,
 * else home — a map still to earn is never shown); the scene itself is built for that map's plate and rebuilt when it changes,
 * so every placement, dragged spot and camera belongs to the map it was made on.
 */
export function WorldScene(props: WorldSceneProps) {
  // NEW MAPS: what every project together has done towards the next maps (lib/project-rewards.ts).
  const newMaps = useNewMaps();
  const [pick, setPick] = useState(readMap);
  const unlockedSig = newMaps.filter((m) => m.unlocked).map((m) => m.id).join('|');
  const unlocked = useMemo(() => new Set(unlockedSig ? unlockedSig.split('|') : []), [unlockedSig]);
  // A plate handed in (a test, an embed) is shown as it is: there is nowhere to travel.
  if (props.plate) return <WorldSceneOn {...props} newMaps={newMaps} />;
  const map = resolveMap(MAPS, pick, unlocked);
  const openCount = MAPS.filter((m) => isOpen(m, unlocked)).length;
  const go = (id: string) => {
    const to = MAPS.find((m) => m.id === id);
    // Only an open map can be gone to: the switch shows no other.
    if (!to || !isOpen(to, unlocked)) return;
    playUi('ui-tap');
    setPick(id); writeMap(id);
  };
  return <WorldSceneOn key={map.plate.id} {...props} plate={map.plate} newMaps={newMaps} travel={openCount > 1 ? { maps: MAPS, current: map.id, unlocked, go } : undefined} />;
}

function WorldSceneOn({
  agents, activitiesByAgent, pendingPermissions, stuckAlerts,
  onDecidePermission, onSetMode, onSendCommand, onDelete, onDismiss, onRestore, onDismissStuck, onActivityClick,
  statusFilter = 'all', onStatusCounts, hud, offSceneCount = 0, onOpenList, plate = PLATE, newMaps, travel,
}: WorldSceneProps & SceneTravel) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [tick, setTick] = useState(() => Date.now());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  // An agent's card opening and closing each have their sound (lib/sound).
  const hadCardRef = useRef(false);
  useEffect(() => {
    const has = selectedKey !== null;
    if (has !== hadCardRef.current) playUi(has ? 'ui-open' : 'ui-close');
    hadCardRef.current = has;
  }, [selectedKey]);
  // The full final answer being read (FinalAnswerModal); onClose marks that answer read.
  const [answerFor, setAnswerFor] = useState<{ agentId: string; name: string; onClose: () => void } | null>(null);
  const { confers, runs } = useLiveWork();

  // Statuses age with the clock (an agent goes quiet), not only with events.
  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);

  // THE SCENE TAKES THE WHOLE SPACE: from wherever the top bar ends to the bottom of the
  // window (above the tab bar on phones). Measured rather than assumed, because the top bar
  // wraps and the demo banner comes and goes.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const fit = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const tabBar = window.innerWidth < 768 ? 80 : 0;
      setSize({ w: el.clientWidth, h: Math.max(420, window.innerHeight - top - tabBar) });
    };
    fit();
    window.addEventListener('resize', fit);
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => { window.removeEventListener('resize', fit); ro?.disconnect(); };
  }, []);

  const crew = useMemo(
    () => buildCrew({ agents, activitiesByAgent, pendingPermissions, stuckAlerts, now: tick }),
    [agents, activitiesByAgent, pendingPermissions, stuckAlerts, tick],
  );
  const counts = useMemo(() => crewCounts(crew), [crew]);
  // Queue lanes and token burn, per crew member — from the records, polled.
  const extras = useCrewExtras(crew, agents);
  const burn = useMemo(() => burnShares(extras.burn), [extras.burn]);
  // REWARDS: what each project has earned (lib/project-rewards.ts), shown as medals under its signpost.
  const rewards = useRewards();
  // Draw nobody until the records have answered once (useCrewExtras `ready`).
  const ready = extras.ready !== false;

  // MACHINE → LANDING PAD (fleet.ts): each online machine holds a pad, named after it. The
  // shuttle is NOT parked there: it flies in for a launch and out again (see `service` below).
  const padIds = useMemo(() => plate.structures.filter((st) => st.sprite === 'pad').map((st) => st.id), [plate]);
  const padSlotsRef = useRef<Map<string, number>>(new Map());
  const hostsSig = [...new Set(crew.map((m) => m.agent.machine))].sort().join('|');
  const machinesSig = extras.machines.map((m) => `${m.hostname}=${m.status}`).join('|');
  const pads = useMemo(() => {
    const r = padsFor(padSlotsRef.current, extras.machines, hostsSig ? hostsSig.split('|') : [], padIds);
    padSlotsRef.current = r.slots;
    return r.pads;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machinesSig, hostsSig, padIds]);
  /** Where a machine's agents come in and go out: beside its pad, or the plate's entry point. */
  const padFor = (host: string): string => padOf(pads, host) ?? padIds[0] ?? '';
  const doorFor = (host: string): Spot => plate.structures.find((st) => st.id === padFor(host))?.door ?? plate.entry;

  // LAUNCH → SHUTTLE. A pad's shuttle is down while something needs it: a cartridge that was
  // just launched (it lands, the agent steps out, it leaves) or an agent whose session ended
  // (it lands, the agent reaches it, it leaves). `service` counts those needs per pad.
  const [service, setService] = useState<Map<string, number>>(new Map());
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  useEffect(() => () => { for (const t of timersRef.current) clearTimeout(t); }, []);
  const later = (fn: () => void, ms: number) => {
    const t = setTimeout(() => { timersRef.current.delete(t); fn(); }, ms);
    timersRef.current.add(t);
  };
  const holdPad = (pad: string, ms: number) => {
    if (!pad) return;
    const bump = (by: number) => setService((prev) => {
      const next = new Map(prev);
      const n = (next.get(pad) ?? 0) + by;
      if (n > 0) next.set(pad, n); else next.delete(pad);
      return next;
    });
    bump(1);
    later(() => bump(-1), ms);
  };

  // PROJECT → ZONE, REPO → BUILDING (zones.ts).
  const projectsSig = JSON.stringify((extras.projects ?? []).map((p) => [p.id, p.name, p.color, p.primaryRepo, p.cartridges, p.createdAt, p.featureCount, p.featuresDone, p.featuresActive]));
  // SECTORS (zones.ts): the world holds one district per project; past that the projects are
  // spread over sectors — the same world again — and ONE sector is on the map at a time.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const sectors = useMemo(() => planSectors(extras.projects ?? [], plate), [projectsSig, plate]);
  const [sectorPick, setSectorPick] = useState(readSector);
  const sector = Math.min(sectorPick, sectors.length - 1);
  const pickSector = (i: number) => { setSectorPick(i); writeSector(i); playUi('ui-tap'); };
  const sectorProjects = sectors[sector]?.projects ?? [];
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const repoSector = useMemo(() => sectorByRepo(sectors), [sectors]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const zones = useMemo(() => planZones(sectorProjects, plate), [projectsSig, plate, sector]);
  // FEATURES (FeaturePlates.tsx): an agent in a feature's worktree works at its REAL repo's
  // building — the worktree folder belongs to no project, and would otherwise land on open ground.
  const features = extras.features ?? [];
  const worktreeSig = JSON.stringify(features.map((f) => f.worktrees));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const worktreeOf = useMemo(() => worktreeRepos(features, normRepo), [worktreeSig]);
  const realRepo = (p: string) => worktreeOf.get(normRepo(p)) ?? p;
  useEffect(() => {
    onStatusCounts?.({ all: counts.all, working: counts.working, waiting: counts.waiting, idle: counts.idle });
  }, [counts.all, counts.working, counts.waiting, counts.idle, onStatusCounts]);

  // Sites are assigned over the WHOLE crew, then filtered — so
  // filtering never makes the remaining agents jump, and (sticky slots) neither does anyone
  // else arriving or leaving.
  const crewKeys = crew.map((m) => m.key).join('|');
  // DELIVERY → a flare over the pod each time a project has one more feature delivered than it
  // had. What was already delivered when the scene opened is not news.
  const doneSig = (extras.projects ?? []).map((p) => `${p.id}=${p.featuresDone ?? 0}`).join('|');
  const doneSeenRef = useRef<Map<string, number> | null>(null);
  const [bursts, setBursts] = useState<{ key: string; district: string }[]>([]);
  useEffect(() => {
    if (!ready) return;
    const now = new Map((extras.projects ?? []).map((p) => [p.id, p.featuresDone ?? 0]));
    const before = doneSeenRef.current;
    doneSeenRef.current = now;
    if (!before) return;
    const fresh = zones.filter((z) => before.has(z.projectId) && (now.get(z.projectId) ?? 0) > before.get(z.projectId)!);
    if (fresh.length > 0) setBursts((b) => [...b, ...fresh.map((z) => ({ key: `${z.projectId}-${now.get(z.projectId)}-${Date.now()}`, district: z.districts[0] }))]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doneSig, ready]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const camps = useMemo(() => planCamps(sectorProjects, zones), [projectsSig, zones]);
  /** The sector a crew member works in: its project's. undefined for one whose repo no project owns — it is on the open land of every sector. */
  const sectorOf = (m: CrewMember): number | undefined => m.agentIds
    .map((id) => repoSector.get(normRepo(realRepo(agents.find((a) => a.id === id)?.repoPath ?? ''))))
    .find((i) => i !== undefined);
  /** Crew of ANOTHER sector: not on this map (they are on theirs). Still counted, still in the list. */
  const elsewhere = new Set(crew.filter((m) => { const i = sectorOf(m); return i !== undefined && i !== sector; }).map((m) => m.key));
  // An agent works at its repo's building; one whose repo no project owns uses unclaimed land.
  const homes = crew.map((m) => {
    const paths = m.agentIds.map((id) => agents.find((a) => a.id === id)?.repoPath ?? '');
    const home = paths.map((path) => zoneFor(zones, realRepo(path))).find((z) => z !== null) ?? null;
    // A project past the map's districts has no pod: its agents gather at its camp (zones.ts).
    const camp = paths.map((path) => camps.get(normRepo(realRepo(path)))).find((c) => c !== undefined);
    // The feature it is on, so a feature's team takes its places together.
    const feature = features.find((f) => f.agentIds.some((id) => m.agentIds.includes(id)))?.goalId ?? '~';
    return { key: m.key, home, camp, feature };
  });
  // A POD HOLDS FOUR (zones.ts): each agent has a sticky place in its project; places 0–3 are the
  // home pod, 4–7 the project's second pod, and so on.
  const placesRef = useRef<Map<string, Map<string, number>>>(new Map());
  const places = new Map<string, Map<string, number>>();
  for (const z of zones) {
    const mine = homes.filter((h) => h.home?.zone.projectId === z.projectId).sort((a, b) => a.feature.localeCompare(b.feature) || a.key.localeCompare(b.key));
    places.set(z.projectId, assignSlots(placesRef.current.get(z.projectId) ?? new Map(), mine.map((h) => h.key)));
  }
  placesRef.current = places;
  const annexes = planAnnexes(zones, plate, new Map([...places].map(([id, m]) => [id, m.size])));
  const wants = homes.filter((h) => !elsewhere.has(h.key)).map((h) => {
    if (!h.home) return { key: h.key, pool: h.camp ?? OPEN_POOL };
    const id = h.home.zone.projectId;
    const at = buildingFor(plate, h.home.zone, h.home.building, places.get(id)!.get(h.key) ?? 0, annexes.get(id) ?? []);
    // At home: its own repo's building. In the second pod: anywhere in it, so four agents take four spots.
    return { key: h.key, pool: at.district === h.home.zone.districts[0] ? at.building : `${POD_PREFIX}${at.district}` };
  });
  /** Repos (normalised paths) that have a character on the map right now. */
  const manned = new Set(crew.flatMap((m) => m.agentIds.map((id) => normRepo(realRepo(agents.find((a) => a.id === id)?.repoPath ?? '')))));
  const wantsSig = wants.map((w) => `${w.key}>${w.pool}`).join('|');
  const claimedSig = [...zones.flatMap((z) => z.districts), ...[...annexes.values()].flat()].join('|');
  const poolSlotsRef = useRef<PoolSlots>(new Map());
  const placement = useMemo(() => {
    const r = placeByZone(poolSlotsRef.current, wants, plate, new Set(claimedSig ? claimedSig.split('|') : []));
    poolSlotsRef.current = r.slots;
    return r.spots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantsSig, claimedSig, plate]);

  // CONFER → THE COMMONS TABLE (meeting.ts): participants of a running confer stand together.
  const meetSig = meetingKeys(confers, crew.map((m) => {
    const paths = m.agentIds.map((id) => agents.find((x) => x.id === id)?.repoPath ?? '');
    return { key: m.key, agentIds: m.agentIds, pod: paths.map((path) => zoneFor(zones, realRepo(path))).find((z) => z !== null)?.zone.districts[0] };
  })).join('|');
  const meetSlotsRef = useRef<Map<string, number>>(new Map());
  const meetSpots = useMemo(() => {
    meetSlotsRef.current = assignSlots(meetSlotsRef.current, meetSig ? meetSig.split('|') : []);
    return plate.meet.length > 0 ? spotsFor(meetSlotsRef.current, { sites: plate.meet, figureScale: plate.figureScale }) : new Map<string, Spot & { siteId: string }>();
  }, [meetSig, plate]);

  // WHO LOOKS LIKE WHOM: a character per agent (not per engine), sticky like the slots.
  const castRef = useRef<Map<string, string>>(new Map());
  const cast = useMemo(() => {
    castRef.current = assignCharacters(castRef.current, crewKeys ? crewKeys.split('|') : [], CHARACTERS);
    return castRef.current;
  }, [crewKeys]);

  // WHERE YOU PUT THEM: agents dragged off their site stay where they were dropped.
  const [customSpots, setCustomSpots] = useState<Map<string, HeldSpot>>(() => loadCustomSpots(plate.id));
  /** The district an agent is planned for right now (its site's), or undefined on open land. */
  const plannedPod = (key: string) => {
    const siteId = placement.get(key)?.siteId;
    return siteId ? plate.sites.find((s) => s.id === siteId)?.district : undefined;
  };
  const moveMember = (key: string, spot: Spot | null) => {
    const idle = crew.find((m) => m.key === key)?.status === 'idle';
    const pod = plannedPod(key);
    setCustomSpots((prev) => {
      const next = new Map(prev);
      if (spot) next.set(key, { ...clampSpot(spot), ...(idle ? { idle: true } : {}), ...(pod ? { pod } : {}) }); else next.delete(key);
      saveCustomSpots(plate.id, next);
      return next;
    });
  };
  // A spot dropped while the agent was idle keeps it off its bench only for THAT idle spell:
  // once the agent is doing anything else, the spot is an ordinary work spot.
  const statusSig = crew.map((m) => `${m.key}=${m.status}`).join('|');
  useEffect(() => {
    setCustomSpots((prev) => {
      const over = [...prev].filter(([key, held]) => { const m = crew.find((x) => x.key === key); return held.idle === true && m !== undefined && m.status !== 'idle'; });
      if (over.length === 0) return prev;
      const next = new Map(prev);
      for (const [key, held] of over) next.set(key, { x: held.x, y: held.y, ...(held.pod ? { pod: held.pod } : {}) });
      saveCustomSpots(plate.id, next);
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusSig]);
  const resetSpots = () => { setCustomSpots(new Map()); saveCustomSpots(plate.id, new Map()); };
  // Only the spots whose plan still holds (customSpots.ts spotHolds): a spot dragged before the
  // project took a second district does not pin its agent in the first. Stale ones are kept, unused.
  // Nor does a spot dropped on open ground while the agent's project had no district keep it away
  // from the district the project has now (spotStranded).
  const hasHome = new Set(homes.filter((h) => h.home !== null).map((h) => h.key));
  const heldSpots = new Map([...customSpots].filter(([key, held]) => spotHolds(held, plannedPod(key), plate) && !spotStranded(held, hasHome.has(key), plate)));

  // THE BENCH BY THE POND (props.ts): an agent idle for 30 minutes goes and sits; new work sends
  // it back. "Idle since" is its last activity when the scene first sees it idle, and the moment
  // it turned idle after that. One you dropped somewhere during this idle spell stays there.
  const idleSinceRef = useRef<Map<string, number>>(new Map());
  const benchRef = useRef<Map<string, number>>(new Map());
  /** Agents this scene has seen busy: when one of them turns idle, it turned idle NOW. */
  const busySeenRef = useRef<Set<string>>(new Set());
  const idleNow: { key: string; since: number }[] = [];
  for (const m of crew) {
    if (m.status !== 'idle' || m.attention !== null) { idleSinceRef.current.delete(m.key); busySeenRef.current.add(m.key); continue; }
    if (!idleSinceRef.current.has(m.key)) {
      const last = Math.max(0, ...m.agentIds.flatMap((id) => (activitiesByAgent[id] ?? []).map((a) => new Date(a.timestamp).getTime() || 0)));
      // Idle when the scene first saw it: since its last activity. Turned idle while open: now.
      idleSinceRef.current.set(m.key, !busySeenRef.current.has(m.key) && last > 0 ? Math.min(last, tick) : tick);
    }
    if (heldSpots.get(m.key)?.idle !== true) idleNow.push({ key: m.key, since: idleSinceRef.current.get(m.key)! });
  }
  for (const key of [...idleSinceRef.current.keys()]) if (!crew.some((m) => m.key === key)) idleSinceRef.current.delete(key);
  benchRef.current = benchSeats(benchRef.current, idleNow, tick, plate.rest.length);
  const restSpots = new Map<string, Placement>([...benchRef.current].map(([key, seat]) => [key, { x: plate.rest[seat].x, y: plate.rest[seat].y, siteId: plate.rest[seat].id }]));

  // WHAT THEY SAID WHEN THEY FINISHED: shown over an idle agent until it is clicked.
  const [read, setRead] = useState<Map<string, string>>(loadRead);

  // WHO WAS ALREADY HERE, AND WHO JUST LAUNCHED. The crew present when the scene opens is
  // simply on site (`known`). A cartridge that turns up afterwards was just launched: its
  // shuttle lands first, and only then does the agent appear, at the pad's door (`landed`).
  const knownRef = useRef<Set<string> | null>(null);
  const known = knownRef.current;
  const pendingRef = useRef<Set<string>>(new Set());
  const [landed, setLanded] = useState<Set<string>>(new Set());
  const crewRef = useRef(crew);
  crewRef.current = crew;
  // A scene that opens EMPTY still has to know its first agent is new: after a moment,
  // "already here" is settled as whoever is here — possibly nobody.
  useEffect(() => {
    if (!ready) return;
    later(() => { if (knownRef.current === null) knownRef.current = new Set(crewRef.current.map((m) => m.key)); }, OPENING_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    const now = crewKeys ? crewKeys.split('|') : [];
    if (knownRef.current === null) {
      if (now.length > 0) knownRef.current = new Set(now);
      return;
    }
    const here = knownRef.current;
    for (const k of [...here]) if (!now.includes(k)) here.delete(k);
    const still = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const k of now) {
      if (here.has(k)) continue;
      if (landed.has(k)) { here.add(k); continue; }   // it has stepped out: from now on it is simply here
      if (pendingRef.current.has(k)) continue;
      pendingRef.current.add(k);
      const landMs = still ? 0 : LAND_MS;
      holdPad(padFor(crewRef.current.find((m) => m.key === k)?.agent.machine ?? ''), landMs + STEP_OUT_MS);
      later(() => { pendingRef.current.delete(k); setLanded((prev) => new Set(prev).add(k)); }, landMs);
    }
    if ([...landed].some((k) => !now.includes(k))) setLanded((prev) => new Set([...prev].filter((k) => now.includes(k))));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [crewKeys, landed, ready]);

  // SESSION ENDED → the agent walks back to its machine's pad and is gone. `lastSeen` is where
  // each figure stood on the last paint; a key that leaves the crew becomes a ghost from there.
  const lastSeenRef = useRef<Map<string, Ghost>>(new Map());
  const prevKeysRef = useRef<string[] | null>(null);
  const [ghosts, setGhosts] = useState<Ghost[]>([]);
  useEffect(() => {
    const now = crewKeys ? crewKeys.split('|') : [];
    const before = prevKeysRef.current;
    prevKeysRef.current = now;
    if (!before) return;
    const gone = before.filter((k) => !now.includes(k)).flatMap((k) => {
      const last = lastSeenRef.current.get(k);
      lastSeenRef.current.delete(k);
      if (!last) return [];
      // The shuttle comes down for it, and leaves once it has had time to get there.
      holdPad(last.pad, Math.max(walkSeconds(last.from, last.to) * 1000, LAND_MS) + STEP_OUT_MS);
      return [last];
    });
    setGhosts((g) => {
      const kept = g.filter((x) => !now.includes(x.key));
      return gone.length === 0 && kept.length === g.length ? g : [...kept, ...gone];
    });
  }, [crewKeys]);
  // Still in the air: a newly launched agent is not on the map until its shuttle is down.
  const inFlight = (key: string) => known !== null && !known.has(key) && !landed.has(key);
  const shown = !ready ? [] : (statusFilter === 'all' ? crew : crew.filter((m) => m.status === statusFilter)).filter((m) => !inFlight(m.key) && !elsewhere.has(m.key));
  const selected = crew.find((m) => m.key === selectedKey) ?? null;

  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedKey(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected]);

  // THE CAMERA: zoom 1 fills the space with the plate; the wheel, the buttons and dragging the
  // ground zoom and pan from there (camera.ts keeps the map covering the view).
  const plateSize = useMemo(() => ({ w: plate.width, h: plate.height }), [plate.width, plate.height]);
  const [camera, setCamera] = useState<Camera | null>(null);
  const cam = size.w > 0 ? clampCamera(camera ?? homeCamera(size, plateSize), size, plateSize) : null;
  const camRef = useRef(cam);
  camRef.current = cam;
  const sizeRef = useRef(size);
  sizeRef.current = size;
  const scale = cam ? scaleFor(cam.zoom, size, plateSize) : 0;
  const stage = cam ? { width: plate.width * scale, height: plate.height * scale, left: cam.x, top: cam.y } : null;
  const zoomBy = (factor: number, at?: { x: number; y: number }) => {
    const c = camRef.current;
    const v = sizeRef.current;
    if (!c || v.w === 0) return;
    const next = zoomAt(c, factor, at ?? { x: v.w / 2, y: v.h / 2 }, v, plateSize);
    camRef.current = next;   // a burst of wheel ticks builds on itself, like the pan below
    setCamera(next);
  };

  // The wheel zooms around the cursor. Registered natively because React's wheel listener is
  // passive and could not stop the page from scrolling under the map.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!(e.target as Element | null)?.closest('[data-world-stage]')) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, { x: e.clientX - r.left, y: e.clientY - r.top });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dragging the ground pans.
  const pan = useRef<{ x: number; y: number } | null>(null);
  const onGroundDown = (e: React.PointerEvent<HTMLImageElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pan.current = { x: e.clientX, y: e.clientY };
  };
  const onGroundMove = (e: React.PointerEvent<HTMLImageElement>) => {
    const p = pan.current;
    const c = camRef.current;
    if (!p || !c) return;
    // Several moves can arrive before the next paint: each must start from where the last
    // one left the camera, not from the camera of the last paint — or the map lags the hand.
    const next = panBy(c, e.clientX - p.x, e.clientY - p.y, sizeRef.current, plateSize);
    camRef.current = next;
    setCamera(next);
    pan.current = { x: e.clientX, y: e.clientY };
  };
  const onGroundUp = (e: React.PointerEvent<HTMLImageElement>) => {
    pan.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  /** Where each figure stands on this paint — what the selected one's card is anchored to. */
  const standsAt = new Map<string, Spot>();
  const avatarHeight = Math.max(36, (stage?.height ?? 560) * AVATAR_SCALE * plate.figureScale);

  return (
    <div
      ref={rootRef}
      data-testid="world-scene"
      data-zoom={(cam?.zoom ?? 1).toFixed(2)}
      className="relative overflow-hidden bg-ink"
      style={{ height: size.h || undefined, minHeight: 420 }}
    >
      <div className="absolute inset-0 isolate">
        <div className="absolute" data-world-stage style={stage ?? { inset: 0 }}>
          <img
            src={plate.src}
            alt=""
            draggable={false}
            onPointerDown={onGroundDown}
            onPointerMove={onGroundMove}
            onPointerUp={onGroundUp}
            onPointerCancel={() => { pan.current = null; }}
            className={`absolute inset-0 w-full h-full select-none ${cam && cam.zoom > MIN_ZOOM ? 'cursor-grab active:cursor-grabbing' : ''}`}
            style={{ objectFit: 'cover', touchAction: 'none' }}
          />
          {/* AMBIENT MOTION: the water, drawn over the terrain and under everything else. It
              plays all the time, whatever the agents are doing (ambient.generated.ts). */}
          {Object.entries(plate.id === 'base' ? AMBIENT : {}).map(([id, art]) => (
            <AmbientStrip key={id} id={id} art={art} style={{ left: `${art.x * 100}%`, top: `${art.y * 100}%`, width: `${art.w * 100}%`, height: `${art.h * 100}%`, zIndex: 0 }} />
          ))}
          {plate.structures.map((st) => {
            if (st.when === 'in-service') {
              return ready ? <ShuttleCraft key={st.id} st={st} online={(service.get(st.on ?? '') ?? 0) > 0} /> : null;
            }
            if (st.gate) {
              // FEATURE → GATE: open while the district's project has a feature under way.
              const open = zones.some((z) => z.districts.includes(st.district ?? '') && z.features.active > 0);
              return ready ? <FeatureGate key={st.id} st={st} open={open} /> : null;
            }
            const moving = MOVING_PROPS[st.sprite];
            if (moving) {
              // A structure that moves all the time (the hologram, the station's tank).
              return (
                <AmbientStrip
                  key={st.id}
                  id={st.id}
                  structure
                  art={moving}
                  // A frame can be wider than the still sprite (room to move in): keep the art at the same scale.
                  style={{ left: `${st.x * 100}%`, top: `${st.y * 100}%`, width: `${st.w * (moving.w / KIT[st.sprite].w) * 100}%`, aspectRatio: `${moving.w} / ${moving.h}`, transform: 'translate(-50%, -100%)', zIndex: Math.round(st.y * 1000) }}
                />
              );
            }
            return (
              <img
                key={st.id}
                data-structure={st.id}
                src={KIT[st.sprite].src}
                alt=""
                draggable={false}
                className="absolute select-none pointer-events-none max-w-none"
                style={{
                  left: `${st.x * 100}%`,
                  top: `${st.y * 100}%`,
                  width: `${st.w * 100}%`,
                  transform: 'translate(-50%, -100%)',
                  // Sorted with the figures by where they stand; flat things lie under everything.
                  zIndex: st.flat ? 0 : Math.round(st.y * 1000),
                }}
              />
            );
          })}
          {/* What each place IS, in the records' words: project on its SIGNPOST, repo on its
              building, machine on its pad. The project's name is on the drawn board, which is as
              wide as the name (signpost.generated.ts); a plaque under the post keeps the counts
              and the badges. Above the figures, like every banner — and it takes no clicks. */}
          {zones.map((z) => {
            const d = z.districts[0];
            const at = plate.props[d]?.sign;
            if (!at) return null;
            const running = features.some((f) => f.projectId === z.projectId);
            const feats = (extras.goals ?? []).filter((g) => g.projectId === z.projectId && g.origin !== 'imported' && g.pilot);
            const earned = feats.length > 0 ? badgesFor(extras.goals ?? [], z.projectId) : null;
            return (
              <Signpost key={`${z.projectId}-${d}`} district={d} name={z.name} colour={z.color || ENGINE_COLOURS.claude.suit} at={at} height={avatarHeight * SIGN_HEIGHT} caption={running}>
                {/* A project with features running keeps the name only: its features' plates say the rest. */}
                {!running && (z.features.total > 0 || earned !== null) && (
                  <div data-zone-plaque={d} className={`${PLAQUE_CLASS} ${SIGN_ART.mode === 'hang' ? 'left-0' : 'left-1/2 -translate-x-1/2'}`}>
                    {z.features.total > 0 && <span>{z.features.done}/{z.features.total} features</span>}
                    {z.features.active > 0 && <span className="text-emerald-300"> · {z.features.active} under way</span>}
                    {/* BADGES: one per step of the feature under way; lit once earned (milestones.ts). */}
                    {earned !== null && (
                      <span className="inline-flex items-center gap-0.5 ml-2 align-[-4px]" aria-label={`${earned} of ${FEATURE_BADGES.length} steps earned`}>
                        {FEATURE_BADGES.map((b, i) => (
                          <img key={b.step} data-badge={b.step} data-earned={i < earned} src={KIT[b.sprite as KitName].src} alt={i < earned ? b.label : ''}
                            className="h-[16px] w-[16px] object-contain" style={{ opacity: i < earned ? 1 : 0.18, filter: i < earned ? undefined : 'grayscale(1)' }} />
                        ))}
                      </span>
                    )}
                  </div>
                )}
              </Signpost>
            );
          })}
          {/* REWARDS: the highest medal the project has earned in each family, under its signpost.
              Each medal says the project's name and what it is for (hover). */}
          {zones.map((z) => {
            const at = plate.props[z.districts[0]]?.sign;
            const tops = (rewards.get(z.projectId)?.families ?? []).map((f) => ({ f, i: topTier(f) })).filter((x) => x.i >= 0);
            if (!at || tops.length === 0) return null;
            return (
              <div key={`rewards-${z.projectId}`} data-zone-rewards={z.projectId} className="absolute -translate-x-1/2 flex items-center gap-[3px]"
                style={{ left: `${at.x * 100}%`, top: `${(at.y + 0.046) * 100}%`, zIndex: BANNER_Z }}>
                {tops.map(({ f, i }) => <RewardMedal key={f.id} family={f.id} tier={i} threshold={f.tiers[i].threshold} earned label={f.tiers[i].label} size={20} />)}
              </div>
            );
          })}
          {/* A project's SECOND pod (zones.ts POD_CAPACITY) carries its name too. */}
          {zones.flatMap((z) => (annexes.get(z.projectId) ?? []).map((d) => {
            const at = plate.props[d]?.sign;
            return at ? <Signpost key={`${z.projectId}-annex-${d}`} annex district={d} name={z.name} colour={z.color || ENGINE_COLOURS.claude.suit} at={at} height={avatarHeight * SIGN_HEIGHT} caption /> : null;
          }))}
          <FeaturePlates features={features.filter((f) => sectorProjects.some((sp) => sp.id === f.projectId))} crew={crew} placement={placement} zones={zones} districts={Object.entries(plate.props).map(([id, p]) => ({ id, ...p.sign }))} goals={extras.goals ?? []} z={BANNER_Z} />
          {zones.flatMap((z) => [...z.buildings].map(([repo, id]) => {
            const st = plate.structures.find((x) => x.id === id);
            // Two repos can share a building when a project has more repos than buildings.
            const sharing = [...z.buildings].filter(([, b]) => b === id).map(([r]) => r);
            if (!st || sharing[0] !== repo) return null;
            // A repo whose character is on the map needs no plate: the character is its name.
            const unmanned = sharing.filter((r) => !manned.has(r));
            if (unmanned.length === 0) return null;
            return (
              <div key={`${z.projectId}-${id}`} data-building-label={id} className={PLATE_CLASS} style={{ left: `${st.x * 100}%`, top: `${st.y * 100}%`, zIndex: 1 }}>
                {unmanned.map((r) => r.split('/').pop()).join(' · ')}
              </div>
            );
          }))}
          {/* UNDER THE BOARD: the marker (props.ts pipelineSignal), then the pod's deadline gauge
              and its delivery pennant (milestones.ts) — standing in a row beside the post's foot. */}
          {ready && zones.map((z) => {
            const d = z.districts[0];
            const at = plate.props[d]?.sign;
            if (!at) return null;
            const deadline = deadlineFor(extras.goals ?? [], z.projectId, tick);
            const pennant = pennantFrame(z.features.done, z.features.total);
            const signal = pipelineSignal(extras.goals ?? [], z.projectId);
            const side = SIGN_ART.mode === 'hang' ? SIGN_ROW.hang : SIGN_ROW.center;
            const prop = (dx: number, w = '1.7%') => ({ left: `${(at.x + dx) * 100}%`, top: `${at.y * 100}%`, width: w, transform: 'translate(-50%, -100%)', zIndex: Math.round(at.y * 1000) });
            return (
              <Fragment key={`m-${z.projectId}`}>
                {signal && (
                  <button type="button" data-pipeline-marker={d} data-tone={signal.tone}
                    onClick={() => { window.location.hash = projectHash(z.projectId, signal.features[0].id); }}
                    aria-label={`${z.name}: ${signal.tone === 'yellow' ? 'a feature is waiting on you' : 'features are moving'} — ${signal.features.map((f) => `${f.name}: ${f.label}`).join('; ')}. Open ${signal.features[0].name}.`}
                    title={signal.features.map((f) => `${f.needsYou ? '● ' : ''}${f.name} — ${f.label}`).join('\n')}
                    className={`absolute p-0 bg-transparent border-0 cursor-pointer ${signal.tone === 'yellow' ? 'world-alert' : ''}`} style={prop(side.marker, '2.1%')}>
                    <img src={KIT[signal.tone === 'yellow' ? 'marker-yellow' : 'marker-green'].src} alt="" draggable={false} className="block w-full max-w-none select-none" />
                  </button>
                )}
                {deadline && <DeadlineGauge district={d} deadline={deadline} style={prop(side.gauge)} />}
                {pennant !== null && <Pennant district={d} frame={pennant} style={prop(side.pennant)} />}
              </Fragment>
            );
          })}
          {/* WHAT THE RECORDS EARN (props.ts): the statue once a feature has been delivered for a
              day, and the freight — what is left to build. Two fixed spots per pod; figures are
              always drawn above them, so a prop never takes a click meant for an agent. */}
          {ready && zones.map((z) => {
            const spots = plate.props[z.districts[0]];
            if (!spots) return null;
            const settled = settledDeliveries(extras.goals ?? [], z.projectId, tick);
            const toDo = featuresToDo(z.features);
            const freight = freightFor(toDo);
            const place = (at: { x: number; y: number }, w: number) => ({ left: `${at.x * 100}%`, top: `${at.y * 100}%`, width: `${w * 100}%`, transform: 'translate(-50%, -100%)', zIndex: Math.round(at.y * 1000) });
            return (
              <Fragment key={`p-${z.projectId}`}>
                {settled > 0 && (
                  <img data-statue={z.districts[0]} src={KIT.statue.src} alt={`${z.name}: ${settled} feature${settled === 1 ? '' : 's'} delivered`} title={`${z.name}: ${settled} feature${settled === 1 ? '' : 's'} delivered`}
                    draggable={false} className="absolute select-none max-w-none" style={place(spots.statue, 0.03)} />
                )}
                <img data-freight={z.districts[0]} data-freight-kind={freight} src={KIT[freight].src} alt={`${z.name}: ${freightTitle(toDo, z.features.total)}`} title={`${z.name}: ${freightTitle(toDo, z.features.total)}`}
                  draggable={false} className="absolute select-none max-w-none" style={place(spots.freight, freight.startsWith('cart') ? 0.034 : 0.024)} />
              </Fragment>
            );
          })}
          {bursts.map((b) => {
            const at = plate.districts.find((x) => x.id === b.district);
            if (at?.x === undefined || at.y === undefined) return null;
            return <Burst key={b.key} style={{ left: `${at.x * 100}%`, top: `${(at.y - 0.1) * 100}%`, width: '9%', transform: 'translate(-50%, -100%)', zIndex: 6500 }} onDone={() => setBursts((all) => all.filter((x) => x.key !== b.key))} />;
          })}
          {pads.map((pd) => {
            const st = plate.structures.find((x) => x.id === pd.pad);
            if (!st || pd.host === null) return null;
            return (
              <div key={pd.pad} data-pad-label={pd.pad} className={`${PLATE_CLASS} ${pd.online ? '' : 'opacity-60'}`} style={{ left: `${st.x * 100}%`, top: `${st.y * 100}%`, zIndex: 1 }}>
                {pd.host}{pd.online ? '' : ' · offline'}
              </div>
            );
          })}
          {ghosts.map((g) => (
            <DepartingFigure key={g.key} ghost={g} avatarHeight={avatarHeight} onGone={() => setGhosts((all) => all.filter((x) => x.key !== g.key))} />
          ))}
          {shown.map((m) => {
            const home = placement.get(m.key)!;
            const custom = heldSpots.get(m.key) ?? null;
            // Dropped during this idle spell: it stays there instead of going to its bench.
            const keptOffBench = custom?.idle === true && m.status === 'idle';
            const said = messageId(m.sessionId, m.lastMessage);
            // "Finished" = idle. A working agent is not done, and one waiting on you already
            // has its question on the panel.
            const finished = m.status === 'idle' && isUnread(read, m.key, said) ? summarize(m.lastMessage) : [];
            // In a running confer it stands at the table, whatever its own status.
            const meet = custom ? null : meetSpots.get(m.key) ?? null;
            const rest = meet || keptOffBench ? null : restSpots.get(m.key) ?? null;
            // Idle with nothing to ask → its bench, wherever you may have put it for work.
            const stands = m.status === 'idle' && m.attention === null && rest ? rest : custom ?? meet ?? home;
            standsAt.set(m.key, { x: stands.x, y: stands.y });
            lastSeenRef.current.set(m.key, { key: m.key, name: m.name, character: cast.get(m.key) ?? '', from: { x: stands.x, y: stands.y }, to: doorFor(m.agent.machine), pad: padFor(m.agent.machine) });
            return (
              <CrewFigure
                key={m.key}
                member={m}
                spot={custom ?? meet ?? home}
                restSpot={rest}
                // Off its site, an agent just stands: the thing it was working at is not there.
                site={custom ? null : (meet ? plate.meet : plate.sites).find((s) => s.id === (meet ?? home).siteId) ?? null}
                siteId={(meet ?? home).siteId}
                meeting={meet !== null}
                moved={custom !== null}
                character={cast.get(m.key) ?? ''}
                compact={shown.length > COMPACT_ABOVE}
                startAt={known !== null && !known.has(m.key) ? doorFor(m.agent.machine) : null}
                avatarHeight={avatarHeight}
                selected={m.key === selectedKey}
                progress={cartridgeProgress(m.agent, m.agentIds.slice(1), confers, runs)}
                finished={finished}
                finishedAsReport={finished.length > 0 && isReport(m.lastMessage)}
                // Reading the full answer is reading it: closing the answer dismisses the bubble.
                onOpenAnswer={() => setAnswerFor({ agentId: m.agent.id, name: m.name, onClose: () => setRead(markRead(m.key, said)) })}
                queue={queueFor(m, agents, extras.queue)}
                burn={burn.get(m.key) ?? null}
                onDecide={onDecidePermission}
                onSelect={() => setSelectedKey((k) => (k === m.key ? null : m.key))}
                onMove={(spot) => moveMember(m.key, spot)}
              />
            );
          })}
        </div>
      </div>

      {answerFor && (
        <FinalAnswerModal agentId={answerFor.agentId} name={answerFor.name} onClose={() => { answerFor.onClose(); setAnswerFor(null); }} />
      )}

      {hud && <div className="absolute top-3 left-3 right-3 flex items-start gap-2.5 flex-wrap pointer-events-none [&>*]:pointer-events-auto">{hud}</div>}

      {offSceneCount > 0 && (
        <button
          onClick={onOpenList}
          className="absolute bottom-3 left-3 h-9 px-3 rounded-[10px] border border-white/[0.14] bg-[rgba(10,16,32,0.9)] text-[12px] font-semibold text-gray-300 hover:text-gray-100"
          title="Hidden and virtual cartridges are not drawn in the scene"
        >
          {offSceneCount} more in the list
        </button>
      )}

      <div role="group" aria-label="Zoom" className="absolute bottom-3 right-3 flex items-center gap-1 p-1 rounded-xl border border-white/[0.1] bg-[rgba(10,16,32,0.92)]">
        <button
          onClick={() => zoomBy(1 / ZOOM_STEP)}
          disabled={!cam || cam.zoom <= MIN_ZOOM}
          aria-label="Zoom out"
          className="w-8 h-8 rounded-lg text-[16px] font-semibold text-gray-200 hover:bg-white/[0.06] disabled:opacity-35"
        >
          −
        </button>
        <button
          onClick={() => setCamera(null)}
          aria-label="Reset zoom"
          title="Show the whole map"
          className="h-8 px-2 rounded-lg font-mono text-[11px] text-gray-300 hover:bg-white/[0.06]"
        >
          {Math.round((cam?.zoom ?? 1) * 100)}%
        </button>
        <button
          onClick={() => zoomBy(ZOOM_STEP)}
          disabled={!cam || cam.zoom >= MAX_ZOOM}
          aria-label="Zoom in"
          className="w-8 h-8 rounded-lg text-[16px] font-semibold text-gray-200 hover:bg-white/[0.06] disabled:opacity-35"
        >
          +
        </button>
      </div>

      {customSpots.size > 0 && (
        <button
          onClick={resetSpots}
          className="absolute bottom-3 right-[132px] h-9 px-3 rounded-[10px] border border-white/[0.14] bg-[rgba(10,16,32,0.9)] text-[12px] font-semibold text-gray-300 hover:text-gray-100"
          title="Send every agent you moved back to its work site"
        >
          Reset positions
        </button>
      )}

      {/* SECTORS: with more projects than the world has districts, the rest are on the next
          sector. Each says which projects it holds, how many agents are there, and whether one
          of them needs you — so nothing waits unseen on a map you are not looking at. */}
      {(sectors.length > 1 || newMaps.length > 0 || travel) && (
        <nav data-world-nav data-sectors={(sectors.length > 1 || newMaps.length > 0) || undefined} aria-label={`Maps and ${word('sector').toLowerCase()}s`} className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-stretch gap-1.5 p-1.5 rounded-[14px] border border-white/[0.14] bg-[rgba(10,16,32,0.92)] max-w-[calc(100%-420px)] flex-wrap justify-center">
          {/* MAPS: the home map and the ones the outfit has unlocked — the rest are not shown until earned. */}
          {travel && <MapSwitch maps={travel.maps} current={travel.current} unlocked={travel.unlocked} onGo={travel.go} />}
          {sectors.length > 1 && sectors.map((sec) => {
            const there = crew.filter((m) => sectorOf(m) === sec.index);
            const need = there.filter((m) => m.attention !== null || m.status === 'waiting').length;
            const on = sec.index === sector;
            return (
              <button key={sec.index} data-sector={sec.index} data-current={on || undefined} data-needs={need || undefined} aria-pressed={on} onClick={() => pickSector(sec.index)}
                title={`${word('sector')} ${sec.index + 1}: ${sec.projects.map((sp) => sp.name).join(', ')} — ${there.length} agent${there.length === 1 ? '' : 's'}${need ? `, ${need} need${need === 1 ? 's' : ''} you` : ''}`}
                className={`relative px-3 py-1.5 rounded-[10px] text-left whitespace-nowrap transition-colors ${on ? 'bg-neon-500/20 shadow-[inset_0_0_0_1px_rgba(90,174,255,0.7)]' : 'hover:bg-white/[0.06]'}`}>
                <span className="flex items-center gap-2">
                  <span className={`font-display text-[13px] font-bold tracking-[0.1em] uppercase ${on ? 'text-neon-100' : 'text-gray-300'}`}>{word('sector')} {sec.index + 1}</span>
                  <span className="text-[12px] text-gray-400 tabular-nums">{there.length} agent{there.length === 1 ? '' : 's'}</span>
                  {need > 0 && <span data-sector-needs className="rounded-full bg-ember-500 text-ink text-[11px] font-bold px-1.5 leading-[18px]">{need} need{need === 1 ? 's' : ''} you</span>}
                </span>
                <span className="flex items-center gap-2.5 mt-0.5">
                  {sec.projects.map((sp) => (
                    <span key={sp.id} className="inline-flex items-center gap-1 text-[12px] text-gray-200">
                      <span aria-hidden="true" className="w-2 h-2 rounded-full" style={{ backgroundColor: sp.color || '#60a0ff' }} />{sp.name}
                    </span>
                  ))}
                </span>
              </button>
            );
          })}
          {/* The next map to discover: what all the projects together have done towards it. */}
          {newMaps.map((m) => <NewMapPanel key={m.id} map={m} ready />)}
        </nav>
      )}

      {crew.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center p-6 pointer-events-none">
          <div className="pointer-events-auto max-w-md text-center px-6 py-5 rounded-[18px] border border-neon-500/40 bg-[rgba(10,16,32,0.92)]">
            <div className="font-display font-bold tracking-[0.12em] text-lg text-neon-200 mb-2">NO AGENTS ON SITE</div>
            <p className="text-[13px] text-gray-400 leading-relaxed">
              Launch a cartridge from the top bar, or install the NeonCore hooks on a machine
              (<code className="text-neon-200 bg-white/[0.06] px-1.5 py-0.5 rounded text-xs font-mono">./agent/install.sh</code>)
              and its agents will walk in here.
            </p>
          </div>
        </div>
      )}
      {crew.length > 0 && shown.length === 0 && (
        <div className="absolute inset-x-0 bottom-14 flex justify-center pointer-events-none">
          <div data-scene-empty className="px-4 py-2 rounded-[10px] border border-white/[0.14] bg-[rgba(10,16,32,0.9)] text-[13px] text-gray-300">
            {statusFilter === 'all' ? `No agents in this ${word('sector').toLowerCase()} right now` : `No ${statusFilter} agents${sectors.length > 1 ? ` in this ${word('sector').toLowerCase()}` : ''}`}
          </div>
        </div>
      )}

      {/* The cartridge card for the selected crew member, floating over that figure so you stay
          on the map (it follows the figure when the map is zoomed or moved). No z-index and no
          backdrop filter on purpose: either would trap the card's own dialogs under the top bar. */}
      {selected && (
        <aside
          aria-label={`Cartridge ${selected.name}`}
          data-crew-card={selected.key}
          className="absolute overflow-y-auto rounded-[16px] border border-white/[0.14] p-3 shadow-[0_18px_40px_rgba(0,0,0,0.55)]"
          // 90% so the map shows through. A background alpha, NOT `opacity`: opacity would make
          // a stacking context and trap the card's own dialogs under the top bar.
          style={{ ...cardPlace(standsAt.get(selected.key), stage, size, avatarHeight), background: 'rgba(10, 16, 32, 0.9)' }}
        >
          <div className="flex items-center justify-between gap-3 mb-3">
            <h2 className="font-display text-lg font-semibold text-gray-100 truncate">{selected.name}</h2>
            <button
              onClick={() => setSelectedKey(null)}
              aria-label="Close cartridge"
              className="btn-ghost h-9 px-3 rounded-[10px] text-sm font-semibold"
            >
              Close
            </button>
          </div>
          <CartridgeGrid
            agents={agents.filter((a) => selected.agentIds.includes(a.id))}
            activitiesByAgent={activitiesByAgent}
            pendingPermissions={pendingPermissions}
            stuckAlerts={stuckAlerts}
            onDecidePermission={onDecidePermission}
            onSetMode={onSetMode}
            onSendCommand={onSendCommand}
            onDelete={onDelete}
            onDismiss={onDismiss}
            onRestore={onRestore}
            onDismissStuck={onDismissStuck}
            onActivityClick={onActivityClick}
          />
        </aside>
      )}
    </div>
  );
}

// ── Deadlines and delivery ─────────────────────────────────────────────────────────────

/** DEADLINE → the oxygen gauge. One frame per level; the two red frames alternate (a blinking light). */
function DeadlineGauge({ district, deadline, style }: { district: string; deadline: Deadline; style: React.CSSProperties }) {
  const [blink, setBlink] = useState(0);
  const pair = deadline.frames.length > 1;
  useEffect(() => {
    if (!pair) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const t = setInterval(() => setBlink((n) => n + 1), 600);
    return () => clearInterval(t);
  }, [pair]);
  const frame = deadline.frames[pair ? blink % deadline.frames.length : 0];
  const when = deadline.daysLeft < 0 ? `${-deadline.daysLeft} day(s) past its date` : `${deadline.daysLeft} day(s) to its date`;
  return (
    <img
      data-deadline={district}
      data-deadline-state={deadline.state}
      data-frame={frame}
      src={KIT[`gauge-${frame}` as KitName].src}
      alt={`Nearest feature: ${when}`}
      title={`Nearest feature: ${when} (${new Date(deadline.targetDate).toLocaleDateString()})`}
      draggable={false}
      className="absolute select-none max-w-none"
      style={style}
    />
  );
}

/**
 * A POD'S SIGNPOST: the drawn post, and the drawn board cut in three so its middle is as wide as
 * the project's name (scripts/world/build_signpost.py). Nothing here is drawn in code.
 */
/** The sector on the map is remembered: the map opens where you left it. */
const SECTOR_KEY = 'neoncore.world.sector';
function readSector(): number {
  try { const n = Number(window.localStorage.getItem(SECTOR_KEY)); return Number.isInteger(n) && n > 0 ? n : 0; } catch { return 0; }
}
function writeSector(i: number): void { try { window.localStorage.setItem(SECTOR_KEY, String(i)); } catch { /* not remembered */ } }

function Signpost({ district, name, colour, at, height, caption, annex, children }: {
  district: string; name: string; colour: string; at: { x: number; y: number }; height: number; caption: boolean;
  /** The project's second pod: the same name, none of the home pod's counts. */
  annex?: boolean; children?: ReactNode;
}) {
  const art = SIGN_ART;
  const k = height / art.post.h;
  const boardH = art.boardH * k;
  const hang = art.mode === 'hang';
  return (
    <div data-zone-label={annex ? undefined : district} data-zone-annex={annex ? district : undefined} data-caption={caption || undefined} data-sign-mode={art.mode} title={name}
      className={`absolute pointer-events-none select-none ${hang ? 'flex items-start' : 'grid justify-items-center'}`}
      style={{
        left: `${(at.x + (hang ? SIGN_ROW.hang.mast : 0)) * 100}%`, top: `${at.y * 100}%`, zIndex: BANNER_Z,
        // hang: the mast's foot is the anchor, the board grows to the right. center: the post is.
        transform: hang ? `translate(${-(art.post.w / 2) * k}px, -100%)` : 'translate(-50%, -100%)',
      }}>
      <img data-sign-post src={art.post.src} alt="" draggable={false} className="max-w-none select-none shrink-0" style={{ height, width: 'auto', gridArea: '1 / 1', imageRendering: 'pixelated' }} />
      <div data-sign-board className="flex items-stretch shrink-0" style={{ height: boardH, marginTop: art.boardY * k, marginLeft: hang ? -(art.post.w - art.attach) * k : undefined, gridArea: '1 / 1', alignSelf: 'start', imageRendering: 'pixelated' }}>
        <img src={art.left.src} alt="" draggable={false} className="h-full w-auto max-w-none select-none" />
        <span data-sign-name className="flex items-center whitespace-nowrap font-display font-bold uppercase tracking-[0.06em]"
          style={{ backgroundImage: `url(${art.mid.src})`, backgroundSize: '100% 100%', color: art.ink, fontSize: Math.max(8, boardH * 0.44), padding: `0 ${boardH * 0.12}px`, borderBottom: `2px solid ${colour}`, boxSizing: 'border-box' }}>
          {name}
        </span>
        <img src={art.right.src} alt="" draggable={false} className="h-full w-auto max-w-none select-none" />
      </div>
      {children}
    </div>
  );
}

/** DELIVERY → the pennant. It climbs (or comes down) one drawn frame at a time when the count changes. */
function Pennant({ district, frame, style }: { district: string; frame: number; style: React.CSSProperties }) {
  const [shown, setShown] = useState(frame);
  useEffect(() => {
    if (shown === frame) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(frame); return; }
    const t = setTimeout(() => setShown((f) => f + (frame > f ? 1 : -1)), 260);
    return () => clearTimeout(t);
  }, [frame, shown]);
  return (
    <img data-pennant={district} data-frame={shown} src={KIT[`pennant-${shown}` as KitName].src} alt="" draggable={false}
      className="absolute select-none pointer-events-none max-w-none" style={style} />
  );
}

/** A FEATURE WAS JUST DELIVERED → one flare: rise, burst, fade, gone. */
function Burst({ style, onDone }: { style: React.CSSProperties; onDone: () => void }) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { onDone(); return; }
    if (frame > 3) { onDone(); return; }
    const t = setTimeout(() => setFrame((f) => f + 1), 320);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frame]);
  if (frame > 3) return null;
  return (
    <img data-burst data-frame={frame} src={KIT[`burst-${frame}` as KitName].src} alt="" draggable={false}
      className="absolute select-none pointer-events-none max-w-none" style={style} />
  );
}

// ── Ambient motion ─────────────────────────────────────────────────────────────────────

/**
 * Something on the map that moves ALL THE TIME — water, a hologram — tied to no event. Its
 * frames sit side by side in one image (scripts/world/build_ambient.py makes them from the
 * drawn art) and the same CSS player as the crew steps through them. Reduced-motion users see
 * the first frame, which is the still art.
 */
function AmbientStrip({ id, art, style, structure }: { id: string; art: AmbientArt; style: React.CSSProperties; structure?: boolean }) {
  return (
    <div
      data-ambient={id}
      data-structure={structure ? id : undefined}
      aria-hidden="true"
      className="absolute overflow-hidden select-none pointer-events-none"
      style={style}
    >
      <div
        className="world-strip h-full"
        style={{
          width: `${art.frames * 100}%`,
          backgroundImage: `url(${art.src})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: '100% 100%',
          animationDuration: `${art.frames / art.fps}s`,
          animationTimingFunction: `steps(${art.frames})`,
        }}
      />
    </div>
  );
}

// ── The cartridge card ─────────────────────────────────────────────────────────────────

/** The card's width, and the least room above a figure for the card to sit over its head. */
const CARD_WIDTH = 440;
const CARD_ROOM_ABOVE = 260;

/**
 * Where the selected crew member's card goes, in scene pixels: over the figure's head when
 * there is room, otherwise beside it — always wholly inside the scene.
 */
function cardPlace(
  at: Spot | undefined,
  stage: { left: number; top: number; width: number; height: number } | null,
  size: { w: number; h: number },
  avatarHeight: number,
): { left: number; top?: number; bottom?: number; width: number; maxHeight: number } {
  const width = Math.min(CARD_WIDTH, Math.max(260, size.w - 16));
  const tallest = Math.max(240, Math.min(560, size.h - 16));
  if (!at || !stage || size.w === 0) return { left: 8, top: 8, width, maxHeight: tallest };
  const x = stage.left + at.x * stage.width;
  const head = stage.top + at.y * stage.height - avatarHeight * 0.8 - 8;
  const within = (left: number) => Math.min(Math.max(8, left), Math.max(8, size.w - width - 8));
  if (head >= CARD_ROOM_ABOVE) return { left: within(x - width / 2), bottom: size.h - head, width, maxHeight: Math.min(tallest, head - 8) };
  const gap = avatarHeight * 0.5 + 12;
  const beside = x + gap + width <= size.w - 8 ? x + gap : x - gap - width;
  return { left: within(beside), top: 8, width, maxHeight: tallest };
}

// ── The shuttle ────────────────────────────────────────────────────────────────────────

/** How far the shuttle hovers above its pad, and where it flies off to, as fractions of the plate. */
const HOVER = 0.045;
const AWAY = { x: 0.16, y: -0.42 };

interface FlightStep { frame: 0 | 1 | 2 | 3; at: 'pad' | 'hover' | 'away'; ms: number; dust?: 0 | 1 | 2 | 3 }

/** Engines light, it lifts with the legs folding, then climbs away. */
const TAKE_OFF: readonly FlightStep[] = [
  { frame: 1, at: 'pad', ms: 650, dust: 0 },
  { frame: 2, at: 'hover', ms: 750, dust: 1 },
  { frame: 3, at: 'hover', ms: 350, dust: 2 },
  { frame: 3, at: 'away', ms: 2600, dust: 3 },
];
/** The reverse: it comes in, hovers, lowers its legs, settles and cuts the engines. */
const LANDING: readonly FlightStep[] = [
  { frame: 3, at: 'away', ms: 60 },
  { frame: 3, at: 'hover', ms: 2600 },
  { frame: 2, at: 'hover', ms: 350, dust: 0 },
  { frame: 2, at: 'pad', ms: 750, dust: 1 },
  { frame: 1, at: 'pad', ms: 550, dust: 2 },
];

/** From first sight of the shuttle to engines off — when the new agent may step out. */
const LAND_MS = LANDING.reduce((sum, st) => sum + st.ms, 0) + 90;
/** How long the shuttle stays down after its agent has stepped out (or reached it), in milliseconds. */
const STEP_OUT_MS = 2600;
/** After this long, whoever is on the map counts as "already here" — even if that is nobody. */
const OPENING_MS = 4000;

/**
 * LAUNCH → the shuttle.
 *
 * One per pad, and it is never parked. `online` means "needed on the pad": it flies in and
 * lands when a cartridge is launched (the new agent then steps out of the landing zone) or
 * when an agent's session ends (it walks back to the pad), and takes off again afterwards. A shuttle that is
 * already there (or already gone) when the scene opens is simply there (or gone) — only a
 * CHANGE flies. Reduced-motion users get the end state straight away.
 */
function ShuttleCraft({ st, online }: { st: WorldStructure; online: boolean }) {
  const [phase, setPhase] = useState<'landed' | 'absent' | 'landing' | 'leaving'>(online ? 'landed' : 'absent');
  const [step, setStep] = useState(0);
  const [seen, setSeen] = useState(online);
  if (seen !== online) {
    setSeen(online);
    setPhase(online ? 'landing' : 'leaving');
    setStep(0);
  }
  const plan = phase === 'landing' ? LANDING : phase === 'leaving' ? TAKE_OFF : null;

  useEffect(() => {
    if (!plan) return;
    const done = () => setPhase(phase === 'landing' ? 'landed' : 'absent');
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { done(); return; }
    if (step >= plan.length) { done(); return; }
    const t = setTimeout(() => setStep((n) => n + 1), plan[step].ms);
    return () => clearTimeout(t);
  }, [plan, phase, step]);

  if (phase === 'absent') return null;
  const now: FlightStep = plan ? plan[Math.min(step, plan.length - 1)] : { frame: 0, at: 'pad', ms: 0 };
  const x = st.x + (now.at === 'away' ? AWAY.x : 0);
  const y = st.y + (now.at === 'away' ? AWAY.y : now.at === 'hover' ? -HOVER : 0);
  const sprite = `shuttle-${now.frame}` as KitName;

  return (
    <>
      {now.dust !== undefined && (
        <img
          data-shuttle-dust={now.dust}
          src={KIT[`dust-${now.dust}` as KitName].src}
          alt=""
          draggable={false}
          className="absolute select-none pointer-events-none max-w-none"
          style={{ left: `${st.x * 100}%`, top: `${(st.y + 0.012) * 100}%`, width: `${st.w * 105}%`, transform: 'translate(-50%, -100%)', zIndex: Math.round(st.y * 1000) + 1 }}
        />
      )}
      <img
        data-structure={st.id}
        data-shuttle={st.on}
        data-shuttle-phase={phase}
        data-frame={now.frame}
        src={KIT[sprite].src}
        alt=""
        draggable={false}
        className="absolute select-none pointer-events-none max-w-none"
        style={{
          left: `${x * 100}%`,
          top: `${y * 100}%`,
          width: `${st.w * 100}%`,
          opacity: now.at === 'away' ? 0 : 1,
          transform: 'translate(-50%, -100%)',
          zIndex: now.at === 'pad' ? Math.round(st.y * 1000) : 7000,
          transition: plan ? `left ${now.ms}ms ease-in-out, top ${now.ms}ms ease-in-out, opacity ${now.ms}ms ease-in` : undefined,
        }}
      />
    </>
  );
}

// ── The gate ───────────────────────────────────────────────────────────────────────────

/** Milliseconds per frame of the gate opening or closing. */
const GATE_FRAME_MS = 220;

/**
 * FEATURE → GATE. The gate into a district is shut (red) while its project has no feature
 * under way and open (green) while it has one. It moves one drawn frame at a time when that
 * changes; a gate that is already open when the scene opens is simply open.
 */
function FeatureGate({ st, open }: { st: WorldStructure; open: boolean }) {
  const [frame, setFrame] = useState(open ? 3 : 0);
  useEffect(() => {
    const goal = open ? 3 : 0;
    if (frame === goal) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setFrame(goal); return; }
    const t = setTimeout(() => setFrame((f) => f + (goal > f ? 1 : -1)), GATE_FRAME_MS);
    return () => clearTimeout(t);
  }, [open, frame]);
  return (
    <img
      data-structure={st.id}
      data-gate={open ? 'open' : 'closed'}
      data-district={st.district}
      data-frame={frame}
      src={KIT[`gate-${frame}` as KitName].src}
      alt=""
      draggable={false}
      className="absolute select-none pointer-events-none max-w-none"
      style={{ left: `${st.x * 100}%`, top: `${st.y * 100}%`, width: `${st.w * 100}%`, transform: 'translate(-50%, -100%)', zIndex: Math.round(st.y * 1000) }}
    />
  );
}

// ── Leaving ────────────────────────────────────────────────────────────────────────────

/** An agent whose session has ended, on its way out. */
interface Ghost { key: string; name: string; character: string; from: Spot; to: Spot; pad: string }

/** How long a walk between two spots takes, in seconds. */
const walkSeconds = (from: Spot, to: Spot) => Math.min(7, Math.max(0.7, Math.hypot(to.x - from.x, to.y - from.y) * WALK_SECONDS_PER_PLATE));

/** Name plates on the map: Night Glass, small, never in the way of a click. */
const PLATE_CLASS = 'absolute -translate-x-1/2 mt-0.5 px-1.5 py-px rounded-md border border-white/[0.14] bg-[rgba(10,16,32,0.82)] font-mono text-[10px] leading-4 text-gray-300 whitespace-nowrap pointer-events-none select-none';
/** A project's name on its district — a step up from the repo and machine plates, so the map reads by project. */

/**
 * SESSION ENDED → the figure walks from where it stood to its machine's landing pad, then it
 * is gone. Not a crew member any more: no panel, no clicks. Reduced-motion users see it go
 * at once.
 */
function DepartingFigure({ ghost, avatarHeight, onGone }: { ghost: Ghost; avatarHeight: number; onGone: () => void }) {
  const [pos, setPos] = useState<Spot>(ghost.from);
  const seconds = walkSeconds(ghost.from, ghost.to);
  useEffect(() => {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { onGone(); return; }
    const frame = requestAnimationFrame(() => setPos(ghost.to));
    const done = setTimeout(onGone, seconds * 1000 + 150);
    return () => { cancelAnimationFrame(frame); clearTimeout(done); };
    // Runs once: a ghost has one journey.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div
      data-departing={ghost.key}
      className="absolute flex flex-col items-center gap-1 pointer-events-none opacity-80"
      style={{
        left: `${pos.x * 100}%`,
        top: `${pos.y * 100}%`,
        transform: 'translate(-50%, -100%)',
        zIndex: FIGURE_Z + Math.round(pos.y * 1000),
        transition: `left ${seconds}s linear, top ${seconds}s linear`,
      }}
    >
      <span className="px-1.5 py-px rounded-md border border-white/[0.14] bg-[rgba(10,16,32,0.82)] font-mono text-[10px] leading-4 text-gray-400 whitespace-nowrap">{ghost.name} · leaving</span>
      <Avatar character={ghost.character} height={avatarHeight} anim="walk" facing={ghost.to.x < ghost.from.x ? -1 : 1} />
    </div>
  );
}

/**
 * One crew member on the plate: the overhead panel, the figure, and how it gets where it is.
 *
 * WALKING. A figure walks (CSS transition on its position, timed by distance, playing the
 * walk cycle) whenever where it belongs changes: it arrives after the scene opened (in from
 * the plate's entry point), it starts working (rest spot → work site), its turn finishes (a
 * short jump, then work site → rest spot), or it is sent back from where you dragged it. Reduced-motion users get it at its spot straight away.
 *
 * DRAGGING. Press on the figure and move: it follows the pointer and stays where it is
 * dropped (remembered per browser). A press without movement is a click and opens the card;
 * a double-click sends it back to its site.
 */
function CrewFigure({ member, spot, restSpot, site, siteId, meeting, moved, character, compact, startAt, avatarHeight, selected, progress, finished, finishedAsReport, onOpenAnswer, queue, burn, onDecide, onSelect, onMove }: {
  member: CrewMember;
  /** Where the figure belongs right now: its site, or wherever it was dropped. */
  spot: Spot;
  /** Where it sits when idle; null when the plate has no rest spots. */
  restSpot: Spot | null;
  /** The work site it is standing at (posture, facing); null when it has been moved off it. */
  site: WorldSite | null;
  siteId: string;
  /** Standing at the commons table with the other participants of a confer. */
  meeting: boolean;
  moved: boolean;
  character: string;
  compact: boolean;
  /** Where to walk in from; null when the agent is already here. */
  startAt: Spot | null;
  avatarHeight: number;
  selected: boolean;
  progress: ReturnType<typeof cartridgeProgress>;
  /** The summary of what it said when it finished; empty when there is nothing unread. */
  finished: string[];
  finishedAsReport: boolean;
  /** Open the full final answer (the bubble, and the crew card's button). */
  onOpenAnswer: () => void;
  queue: CrewQueue;
  burn: CrewBurn | null;
  onDecide: (id: string, decision: 'allowed' | 'denied') => void;
  onSelect: () => void;
  onMove: (spot: Spot | null) => void;
}) {
  // A TASK JUST FINISHED (working → idle or waiting): it wipes its brow for a moment, then
  // stands idle or waves for you. Decided while rendering, not in an effect: the figure must
  // not play even one frame of the next state first.
  const [seenStatus, setSeenStatus] = useState(member.status);
  const [finishing, setFinishing] = useState(false);
  if (seenStatus !== member.status) {
    setSeenStatus(member.status);
    setFinishing(seenStatus === 'working' && member.status !== 'working');
  }
  useEffect(() => {
    if (!finishing) return;
    const t = setTimeout(() => setFinishing(false), FINISH_MS);
    return () => clearTimeout(t);
  }, [finishing]);

  // WHERE IT BELONGS: an idle agent with nothing to ask sits on its bench; anyone else is at its
  // work site — or at the spot you dragged it to, which is its work spot from then on.
  const resting = member.status === 'idle' && member.attention === null && restSpot !== null && !finishing;
  const target: Spot = resting ? restSpot : spot;

  const [pos, setPos] = useState<Spot>(startAt ?? target);
  const [walk, setWalk] = useState<{ seconds: number; facing: 1 | -1 } | null>(
    startAt ? { seconds: 0, facing: target.x < startAt.x ? -1 : 1 } : null,
  );
  const [dragging, setDragging] = useState(false);
  const posRef = useRef(pos);
  const press = useRef<{ x: number; y: number; offX: number; offY: number; drag: boolean } | null>(null);

  useEffect(() => {
    const from = posRef.current;
    const dx = target.x - from.x;
    const dy = target.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance < 0.001) return;
    const arrive = () => { posRef.current = target; setPos({ x: target.x, y: target.y }); };
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      arrive();
      setWalk(null);
      return;
    }
    const seconds = Math.min(7, Math.max(0.7, distance * WALK_SECONDS_PER_PLATE));
    setWalk({ seconds, facing: dx < 0 ? -1 : 1 });
    // One frame later, so the browser has painted the starting position to transition FROM.
    const frame = requestAnimationFrame(arrive);
    const done = setTimeout(() => { arrive(); setWalk(null); }, seconds * 1000 + 120);
    return () => { cancelAnimationFrame(frame); clearTimeout(done); };
  }, [target.x, target.y]);

  const stageRect = (el: Element) => el.closest('[data-world-stage]')?.getBoundingClientRect() ?? null;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const rect = stageRect(e.currentTarget);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    // Keep the grip: the feet stay as far from the pointer as they were when it was pressed.
    press.current = {
      x: e.clientX,
      y: e.clientY,
      offX: rect ? e.clientX - (rect.left + posRef.current.x * rect.width) : 0,
      offY: rect ? e.clientY - (rect.top + posRef.current.y * rect.height) : 0,
      drag: false,
    };
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.drag && Math.hypot(e.clientX - p.x, e.clientY - p.y) < DRAG_THRESHOLD) return;
    const rect = stageRect(e.currentTarget);
    if (!rect || rect.width === 0 || rect.height === 0) return;
    p.drag = true;
    setDragging(true);
    setWalk(null);
    const next = clampSpot({ x: (e.clientX - p.offX - rect.left) / rect.width, y: (e.clientY - p.offY - rect.top) / rect.height });
    posRef.current = next;
    setPos(next);
  };
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    if (!p) return;
    if (p.drag) { setDragging(false); onMove(posRef.current); }
    else onSelect();
  };

  const posture = resting ? 'stand' : site?.work ?? 'stand';
  // Seated once it has ARRIVED at its bench: on the way there it walks.
  const seated = resting && walk === null && Math.hypot(pos.x - target.x, pos.y - target.y) < 0.002;
  // WORKING: one of the four work cycles, changing at this agent's own pace (props.ts).
  const [workCycle, setWorkCycle] = useState(() => workCycleAt(member.key, Date.now()));
  useEffect(() => {
    if (member.status !== 'working') return;
    let t: ReturnType<typeof setTimeout>;
    const turn = () => { setWorkCycle(workCycleAt(member.key, Date.now())); t = setTimeout(turn, nextWorkSwitch(member.key, Date.now())); };
    turn();
    return () => clearTimeout(t);
  }, [member.status, member.key]);
  const anim = animationFor(member, walk !== null, posture, { finishing, seated, workCycle });
  const crates = crateSpriteFor(queue.waiting);
  const facing = walk?.facing ?? (resting ? 1 : site?.faces ?? 1);

  return (
    <div
      className="world-member group absolute flex flex-col items-center gap-1"
      data-site={siteId}
      data-work={posture}
      data-anim={anim}
      data-facing={facing}
      data-moved={moved || undefined}
      data-meeting={meeting || undefined}
      data-resting={resting || undefined}
      data-seat={resting && restSpot && 'siteId' in restSpot ? (restSpot as Placement).siteId : undefined}
      style={{
        left: `${pos.x * 100}%`,
        top: `${pos.y * 100}%`,
        transform: 'translate(-50%, -100%)',
        zIndex: dragging ? FIGURE_DRAG_Z : FIGURE_Z + Math.round(pos.y * 1000) + (finished.length > 0 ? 1000 : 0),
        transition: walk && !dragging ? `left ${walk.seconds}s linear, top ${walk.seconds}s linear` : undefined,
      }}
    >
      {finished.length > 0 && resting && (
        // On the bench the wide bubble would cover its neighbour: a chip, with the summary on hover.
        <button type="button" data-finished-chip onClick={onOpenAnswer} title={`${finished.join(' ')} — click to read the full answer`}
          aria-label={`${member.name} finished: ${finished.join(' ')} — click to read the full answer`}
          className="px-1.5 py-px rounded-full border border-emerald-400/70 bg-[rgba(8,20,22,0.95)] text-[9px] font-bold uppercase tracking-wide text-emerald-300 hover:border-emerald-300">
          Finished
        </button>
      )}
      {finished.length > 0 && !resting && (
        <button
          type="button"
          data-finished-bubble
          onClick={onOpenAnswer}
          aria-label={`${member.name} finished: ${finished.join(' ')} — click to read the full answer`}
          title="Click to read the full answer"
          className="relative w-[236px] text-left px-3 py-2 rounded-[12px] border border-emerald-400/70 bg-[rgba(8,20,22,0.95)] shadow-[0_0_16px_rgba(74,222,128,0.35)] hover:border-emerald-300"
        >
          <span className="block text-[10px] font-bold uppercase tracking-wide text-emerald-300 mb-0.5">Finished</span>
          {finishedAsReport ? (
            finished.map((l, i) => <span key={i} className="block text-[11px] leading-snug text-gray-100 truncate">{l}</span>)
          ) : (
            <span className="text-[11px] leading-snug text-gray-100 line-clamp-3" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{finished.join(' ')}</span>
          )}
          <span aria-hidden="true" className="absolute left-1/2 -bottom-[5px] -ml-[5px] w-[10px] h-[10px] rotate-45 border-r border-b border-emerald-400/70 bg-[rgba(8,20,22,0.95)]" />
        </button>
      )}
      <CrewPanel member={member} selected={selected} compact={compact || resting} progress={progress} queue={queue} burn={burn} onDecide={onDecide} onSelect={onSelect} onOpenAnswer={onOpenAnswer} />
      <div
        data-drag-handle
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => { press.current = null; setDragging(false); }}
        onDoubleClick={() => { if (moved) onMove(null); }}
        title={moved ? 'Drag to move · double-click to send back to its site' : 'Drag to move'}
        className={dragging ? 'cursor-grabbing' : 'cursor-grab'}
        style={{ touchAction: 'none' }}
      >
        <Avatar character={character} height={avatarHeight} anim={anim} facing={facing} />
      </div>
      {crates && (
        // QUEUE LANE → the work waiting behind this agent, stacked at its feet on the side it
        // is not facing.
        <img
          data-queue-crates={crates}
          src={KIT[crates].src}
          alt=""
          title={`${queue.waiting} queued`}
          draggable={false}
          className="absolute bottom-0 select-none pointer-events-none max-w-none"
          style={{
            height: avatarHeight * 0.34 * (KIT[crates].h / KIT['crate-1'].h),
            [facing > 0 ? 'right' : 'left']: '50%',
            marginRight: facing > 0 ? avatarHeight * 0.2 : undefined,
            marginLeft: facing > 0 ? undefined : avatarHeight * 0.2,
          }}
        />
      )}
    </div>
  );
}

/**
 * The panel over a crew member's head — Night Glass, never pixel art.
 *
 *   who, what, how far        name · task · step meter (when a run or confer gives a real fraction)
 *   token burn                the energy bar: this agent's tokens in the last hour against the
 *                             hungriest agent on site
 *   queue lane                how many items are waiting behind it, and why the lane stopped
 *   approval request          Approve / Deny right here; a question opens the card to answer
 *   stuck agent               a red pulsing marker over the panel
 */
function CrewPanel({ member, selected, compact, progress, queue, burn, onDecide, onSelect, onOpenAnswer }: {
  member: CrewMember;
  selected: boolean;
  /** A crowded scene: show the name only, and the rest on hover, selection or alert. */
  compact: boolean;
  progress: ReturnType<typeof cartridgeProgress>;
  queue: CrewQueue;
  burn: CrewBurn | null;
  onDecide: (id: string, decision: 'allowed' | 'denied') => void;
  onSelect: () => void;
  /** Open the agent's full final answer. */
  onOpenAnswer: () => void;
}) {
  const stuck = member.attention === 'stuck';
  const needsYou = member.attention !== null || member.status === 'waiting';
  const live = member.status === 'working';
  const border = stuck
    ? 'border-red-400/90 shadow-[0_0_16px_rgba(255,107,107,0.55)]'
    : needsYou
      ? 'border-ember-500/80 shadow-[0_0_14px_rgba(255,138,61,0.45)]'
      : live
        ? 'border-neon-500/70 shadow-[0_0_14px_rgba(90,174,255,0.4)]'
        : 'border-white/[0.16]';
  const line = member.task || (progress ? progress.label : '');
  const cells = progress ? Math.min(progress.total, 12) : 0;
  const lit = progress && progress.total > 0 ? Math.round((cells * progress.done) / progress.total) : 0;
  // In a crowd the detail lines fold away unless this one is selected, calling for you, or hovered.
  const folded = compact && !selected && !member.attention;
  const detail = folded ? 'hidden group-hover:block group-focus-within:block' : 'block';
  const row = folded ? 'hidden group-hover:flex group-focus-within:flex' : 'flex';
  const label = `Crew member ${member.name} — ${member.attention ? ATTENTION_LABEL[member.attention] : STATUS_WORD[member.status]}${line ? ` — ${line}` : ''}`;
  // The approval this panel can decide: a real tool approval, never a question.
  const approval = member.attention === 'approval' ? member.approvals.find((p) => p.toolName !== 'AskUserQuestion') ?? null : null;
  const burning = burn !== null && burn.tokensPerHour > 0;
  const burnLit = burning ? Math.max(1, Math.round(burn.share * 8)) : 0;

  return (
    <div className={`relative ${folded ? 'w-[124px] group-hover:w-[168px] group-focus-within:w-[168px]' : 'w-[168px]'}`}>
      {stuck && (
        <img
          data-stuck-marker
          src={KIT['marker-red'].src}
          alt=""
          title={member.attentionText}
          draggable={false}
          className="world-alert absolute left-1/2 bottom-full -ml-[13px] mb-0.5 w-[26px] select-none pointer-events-none max-w-none"
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        aria-label={label}
        aria-pressed={selected}
        data-attention={member.attention ?? undefined}
        data-status={member.status}
        title={member.attentionText || line || STATUS_WORD[member.status]}
        className={`block w-full text-left px-2.5 py-1.5 rounded-[10px] border bg-[rgba(10,16,32,0.92)] transition-colors hover:bg-[rgba(16,24,46,0.96)] ${border} ${selected ? 'ring-2 ring-neon-400/80' : ''}`}
      >
        <span className="flex items-center gap-1.5">
          <span
            className="w-2 h-2 rounded-full shrink-0"
            style={{ background: ENGINE_COLOURS[member.engine]?.suit }}
            title={ENGINE_COLOURS[member.engine]?.label}
          />
          <span className="font-mono text-[12px] font-semibold text-gray-100 truncate">{member.name}</span>
        </span>
        <span className={`${detail} text-[11px] leading-snug truncate ${line ? 'text-gray-300' : 'text-gray-500'}`}>
          {line || STATUS_WORD[member.status]}
        </span>
        {progress && cells > 0 && (
          <span className={`mt-1 items-center gap-1.5 ${row}`} title={`${progress.label}: ${progress.done} of ${progress.total}`}>
            <span className="flex gap-[2px] flex-1">
              {Array.from({ length: cells }, (_, i) => (
                <span key={i} className={`flex-1 h-[5px] rounded-[1px] ${i < lit ? 'seg-on' : 'seg-off'}`} />
              ))}
            </span>
            <span className="font-mono text-[10px] text-gray-400">{progress.done}/{progress.total}</span>
          </span>
        )}
        {burning && (
          <span
            data-burn={burn.share.toFixed(2)}
            className={`mt-1 items-center gap-1.5 ${row}`}
            title={`${formatRate(burn.tokensPerHour)} tokens in the last hour — bar is relative to the busiest agent on site`}
          >
            <img src={KIT[cellSpriteFor(burn.share)].src} alt="" aria-hidden="true" className="h-[18px] w-auto -my-1 max-w-none" />
            <span className="flex gap-[2px] flex-1">
              {Array.from({ length: 8 }, (_, i) => (
                <span key={i} className={`flex-1 h-[5px] rounded-[1px] ${i < burnLit ? 'bg-ember-400' : 'border border-ember-500/30'}`} />
              ))}
            </span>
            <span className="font-mono text-[10px] text-gray-400">{formatRate(burn.tokensPerHour)}/h</span>
          </span>
        )}
        {(queue.waiting > 0 || queue.halted) && (
          <span className={`${detail} mt-1 text-[10px] font-semibold truncate ${queue.halted ? 'text-ember-300' : 'text-gray-400'}`} title={queue.halted || undefined}>
            {queue.waiting > 0 ? `${queue.waiting} queued` : 'Queue'}{queue.halted ? ` · halted: ${queue.halted}` : ''}
          </span>
        )}
        {member.attention && (
          <span className={`world-alert mt-1 block text-[10px] font-bold uppercase tracking-wide ${stuck ? 'text-red-300' : 'text-ember-300'}`}>
            {ATTENTION_LABEL[member.attention]}
          </span>
        )}
      </button>
      {approval && (
        <div className="mt-1 flex gap-1">
          <button
            type="button"
            onClick={() => onDecide(approval.id, 'allowed')}
            aria-label={`Approve: ${approval.description || approval.toolName}`}
            title={approval.description || approval.toolName}
            className="flex-1 h-7 rounded-[8px] text-[11px] font-semibold bg-neon-500/25 border border-neon-500/60 text-neon-50 hover:bg-neon-500/40"
          >
            Approve
          </button>
          <button
            type="button"
            onClick={() => onDecide(approval.id, 'denied')}
            aria-label={`Deny: ${approval.description || approval.toolName}`}
            className="flex-1 h-7 rounded-[8px] text-[11px] font-semibold bg-[rgba(10,16,32,0.92)] border border-red-400/45 text-red-200 hover:bg-red-400/15"
          >
            Deny
          </button>
        </div>
      )}
      {member.attention === 'question' && (
        <button
          type="button"
          onClick={() => { if (!selected) onSelect(); }}
          aria-label={`Answer ${member.name}`}
          className="mt-1 w-full h-7 rounded-[8px] text-[11px] font-semibold bg-ember-500/20 border border-ember-500/60 text-ember-300 hover:bg-ember-500/30"
        >
          Answer
        </button>
      )}
      {selected && member.lastMessage && (
        <button
          type="button"
          onClick={onOpenAnswer}
          aria-label={`Read ${member.name}'s final answer`}
          className="mt-1 w-full h-7 rounded-[8px] text-[11px] font-semibold bg-[rgba(10,16,32,0.92)] border border-white/[0.18] text-gray-200 hover:border-white/30"
        >
          Final answer
        </button>
      )}
    </div>
  );
}
