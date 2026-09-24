import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useIntl } from "react-intl";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import type { ZoomTransform } from "d3-zoom";
import { GitBranch, Hash, RefreshCw } from "lucide-react";
import { PreviewCard, PreviewCardContent, PreviewCardTrigger } from "raft-ui";
import { useServerStore } from "../../store/serverStore";
import api from "../../api/client";
import AvatarSlot from "../ui/AvatarSlot";
import Banner from "../ui/Banner";
import SectionHeader from "../ui/SectionHeader";
import ProfilePreviewCardContent from "../message/ProfilePreviewCardContent";

type GraphHuman = {
  type: "human";
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  gravatarHash: string;
  role: string;
  channelIds: string[];
};

type GraphAgent = {
  type: "agent";
  id: string;
  name: string;
  displayName: string | null;
  avatarUrl: string | null;
  status: string;
  runtime: string;
  channelIds: string[];
};

type GraphMember = GraphHuman | GraphAgent;

type GraphChannel = {
  id: string;
  name: string;
  type: "channel" | "private" | "joint" | "dm" | "thread";
  archivedAt: string | null;
  humanCount: number;
  agentCount: number;
  memberCount: number;
};

type GraphEdge = {
  channelId: string;
  memberType: "human" | "agent";
  memberId: string;
};

type MemberLink = {
  source: string;
  target: string;
  channelIds: string[];
  channelNames: string[];
  weight: number;
};

type GraphResponse = {
  humans: GraphHuman[];
  agents: GraphAgent[];
  channels: GraphChannel[];
  edges: GraphEdge[];
};

type Point = { x: number; y: number };
type GraphViewBox = { x: number; y: number; width: number; height: number };
type GraphDimensions = { width: number; height: number };
type LayoutComponent = { keys: string[]; center: Point; radiusX: number; radiusY: number };

const VIEWBOX_WIDTH = 920;
const VIEWBOX_HEIGHT = 560;
const CENTER: Point = { x: VIEWBOX_WIDTH / 2, y: VIEWBOX_HEIGHT / 2 };
const GRAPH_PADDING = 58;
const DEFAULT_GRAPH_VIEWBOX: GraphViewBox = { x: 0, y: 0, width: VIEWBOX_WIDTH, height: VIEWBOX_HEIGHT };
const MAX_GRAPH_ZOOM = 4;
const GRAPH_NODE_SIZE = 36;

function displayName(member: GraphMember): string {
  return member.displayName || member.name;
}

function shortLabel(label: string, max = 18): string {
  return label.length > max ? `${label.slice(0, max - 1)}…` : label;
}

function memberKey(member: GraphMember): string {
  return `${member.type}:${member.id}`;
}

function buildMemberLinkDegrees(links: MemberLink[]) {
  const degrees = new Map<string, number>();
  const neighbors = new Map<string, Set<string>>();
  links.forEach((link) => {
    const sourceNeighbors = neighbors.get(link.source) ?? new Set<string>();
    sourceNeighbors.add(link.target);
    neighbors.set(link.source, sourceNeighbors);
    const targetNeighbors = neighbors.get(link.target) ?? new Set<string>();
    targetNeighbors.add(link.source);
    neighbors.set(link.target, targetNeighbors);
  });
  neighbors.forEach((memberNeighbors, key) => degrees.set(key, memberNeighbors.size));
  return degrees;
}

function MemberAvatar({ member, compact = false }: { member: GraphMember; compact?: boolean }) {
  if (member.type === "agent") {
    return (
      <AvatarSlot
        context={compact ? "compact-list" : "surface-list"}
        type="agent"
        agentAvatarUrl={member.avatarUrl}
      />
    );
  }

  return (
    <AvatarSlot
      context={compact ? "compact-list" : "surface-list"}
      type="human"
      humanAvatarUrl={member.avatarUrl}
      gravatarHash={member.gravatarHash}
      humanPlaceholder={!member.avatarUrl && !member.gravatarHash}
    />
  );
}

function GraphMemberNode({
  member,
  point,
  degree,
  dense,
  screenPosition,
}: {
  member: GraphMember;
  point: Point;
  degree: number;
  dense: boolean;
  screenPosition: (point: Point) => { left: number; top: number };
}) {
  const { formatMessage } = useIntl();
  const label = displayName(member);
  const mentionType = member.type === "agent" ? "agent" : "user";

  return (
    <PreviewCard>
      <div
        className="pointer-events-auto absolute"
        style={{ ...screenPosition(point), transform: "translate(-50%, -50%)" }}
      >
        <PreviewCardTrigger
          delay={200}
          closeDelay={120}
          render={
            <button
              type="button"
              aria-label={label}
              className="relative block cursor-default border-0 bg-transparent p-0 text-left"
            >
              <div
                className="relative overflow-hidden rounded-full border-black"
                style={{
                  width: GRAPH_NODE_SIZE,
                  height: GRAPH_NODE_SIZE,
                  borderWidth: 1,
                  backgroundColor:
                    member.type === "agent"
                      ? "var(--color-brutal-cyan)"
                      : "var(--color-brutal-lavender)",
                  boxSizing: "border-box",
                }}
              >
                <div className="absolute inset-0 overflow-hidden rounded-full">
                  {member.type === "agent" ? (
                    <AvatarSlot
                      context="panel-header"
                      type="agent"
                      agentAvatarUrl={member.avatarUrl}
                      className="!h-full !w-full !border-0 rounded-full"
                    />
                  ) : (
                    <AvatarSlot
                      context="panel-header"
                      type="human"
                      humanAvatarUrl={member.avatarUrl}
                      gravatarHash={member.gravatarHash}
                      humanPlaceholder={!member.avatarUrl && !member.gravatarHash}
                      className="!h-full !w-full !border-0 rounded-full"
                    />
                  )}
                </div>
              </div>
              <div
                className={[
                  "pointer-events-none absolute whitespace-nowrap text-[12px] font-bold text-black",
                  dense
                    ? member.type === "agent"
                      ? "right-full top-1/2 -translate-y-1/2 pr-2 text-right"
                      : "left-full top-1/2 -translate-y-1/2 pl-2"
                    : "left-1/2 top-full mt-1 -translate-x-1/2 text-center",
                ].join(" ")}
              >
                <div>{shortLabel(label, dense ? 12 : 16)}</div>
                {!dense && <div className="font-mono text-[10px] text-black/55">{formatMessage({ id: "settings.memberGraph.nodeLinks" }, { count: degree })}</div>}
              </div>
            </button>
          }
        />
      </div>
      <PreviewCardContent sideOffset={6} collisionPadding={6} className="w-[280px]">
        <ProfilePreviewCardContent mentionType={mentionType} mentionId={member.id} />
      </PreviewCardContent>
    </PreviewCard>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function seededAngle(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
  }
  return (hash / 0xffffffff) * Math.PI * 2;
}

function initialPoint(key: string, index: number, total: number, channel: boolean): Point {
  const angle = (index / Math.max(total, 1)) * Math.PI * 2 + seededAngle(key) * 0.08 - Math.PI / 2;
  const radiusX = channel ? 118 : 326;
  const radiusY = channel ? 74 : 198;
  return {
    x: CENTER.x + Math.cos(angle) * radiusX,
    y: CENTER.y + Math.sin(angle) * radiusY,
  };
}

function componentInitialPoint(key: string, index: number, total: number, component: LayoutComponent): Point {
  if (total <= 1) return { ...component.center };
  const angle = (index / total) * Math.PI * 2 + seededAngle(key) * 0.1 - Math.PI / 2;
  const radiusScale = total <= 3 ? 0.46 : 0.78;
  return {
    x: component.center.x + Math.cos(angle) * component.radiusX * radiusScale,
    y: component.center.y + Math.sin(angle) * component.radiusY * radiusScale,
  };
}

function buildConnectedComponents(nodeKeys: string[], neighbors: Map<string, Set<string>>) {
  const visited = new Set<string>();
  const components: string[][] = [];
  for (const key of nodeKeys) {
    if (visited.has(key)) continue;
    const stack = [key];
    const component: string[] = [];
    visited.add(key);
    while (stack.length > 0) {
      const current = stack.pop()!;
      component.push(current);
      for (const next of neighbors.get(current) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        stack.push(next);
      }
    }
    components.push(component.sort());
  }
  return components.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]));
}

function assignComponentLayouts(components: string[][], dense: boolean): LayoutComponent[] {
  if (components.length <= 1) {
    return [{ keys: components[0] ?? [], center: CENTER, radiusX: 326, radiusY: 198 }];
  }

  const largest = components[0]?.length ?? 0;
  const second = components[1]?.length ?? 0;
  const shouldUseGrid = largest <= 1 || second >= Math.max(4, largest * 0.45);
  const usableWidth = VIEWBOX_WIDTH - GRAPH_PADDING * 2;
  const usableHeight = VIEWBOX_HEIGHT - GRAPH_PADDING * 2;

  if (shouldUseGrid) {
    const columns = Math.ceil(Math.sqrt(components.length * 1.45));
    const rows = Math.ceil(components.length / columns);
    const cellWidth = usableWidth / columns;
    const cellHeight = usableHeight / rows;
    return components.map((keys, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      const sizeScale = clamp(Math.sqrt(keys.length) / 3, 0.42, 1);
      return {
        keys,
        center: {
          x: GRAPH_PADDING + cellWidth * (column + 0.5),
          y: GRAPH_PADDING + cellHeight * (row + 0.5),
        },
        radiusX: Math.max(28, Math.min(cellWidth * 0.34 * sizeScale, 150)),
        radiusY: Math.max(24, Math.min(cellHeight * 0.34 * sizeScale, 104)),
      };
    });
  }

  const railComponents = components.slice(1);
  const railColumns = railComponents.length > 7 ? 2 : 1;
  const railRows = Math.ceil(railComponents.length / railColumns);
  const railWidth = dense ? 296 : 260;
  const mainWidth = VIEWBOX_WIDTH - railWidth - GRAPH_PADDING * 2;
  const railCellWidth = railWidth / railColumns;
  const railCellHeight = usableHeight / Math.max(railRows, 1);
  const layouts: LayoutComponent[] = [
    {
      keys: components[0],
      center: { x: GRAPH_PADDING + mainWidth * 0.5, y: CENTER.y },
      radiusX: Math.min(mainWidth * 0.38, dense ? 250 : 282),
      radiusY: dense ? 190 : 206,
    },
  ];

  railComponents.forEach((keys, railIndex) => {
    const column = railIndex % railColumns;
    const row = Math.floor(railIndex / railColumns);
    const sizeScale = clamp(Math.sqrt(keys.length) / 2.2, 0.44, 1);
    layouts.push({
      keys,
      center: {
        x: VIEWBOX_WIDTH - GRAPH_PADDING - railWidth + railCellWidth * (column + 0.5),
        y: GRAPH_PADDING + railCellHeight * (row + 0.5),
      },
      radiusX: Math.max(18, Math.min(railCellWidth * 0.28 * sizeScale, 56)),
      radiusY: Math.max(14, Math.min(railCellHeight * 0.24 * sizeScale, 40)),
    });
  });

  return layouts;
}

function edgePath(from: Point, to: Point, dense: boolean): string {
  if (!dense) return `M ${from.x} ${from.y} L ${to.x} ${to.y}`;
  const curve = Math.abs(to.x - from.x) * 0.48;
  const sourceControlX = from.x < to.x ? from.x + curve : from.x - curve;
  const targetControlX = from.x < to.x ? to.x - curve : to.x + curve;
  return `M ${from.x} ${from.y} C ${sourceControlX} ${from.y}, ${targetControlX} ${to.y}, ${to.x} ${to.y}`;
}

function buildMemberLinks(members: GraphMember[], channels: GraphChannel[]): MemberLink[] {
  const membersByChannel = new Map<string, string[]>();
  for (const member of members) {
    for (const channelId of member.channelIds) {
      const bucket = membersByChannel.get(channelId) ?? [];
      bucket.push(memberKey(member));
      membersByChannel.set(channelId, bucket);
    }
  }

  const addLinksForChannels = (candidateChannels: GraphChannel[]) => {
    const links = new Map<string, MemberLink>();
    for (const channel of candidateChannels) {
      const channelMemberKeys = [...new Set(membersByChannel.get(channel.id) ?? [])].sort();
      for (let i = 0; i < channelMemberKeys.length; i += 1) {
        for (let j = i + 1; j < channelMemberKeys.length; j += 1) {
          const source = channelMemberKeys[i];
          const target = channelMemberKeys[j];
          const key = `${source}--${target}`;
          const current = links.get(key) ?? {
            source,
            target,
            channelIds: [],
            channelNames: [],
            weight: 0,
          };
          current.channelIds.push(channel.id);
          current.channelNames.push(channel.name);
          current.weight = current.channelIds.length;
          links.set(key, current);
        }
      }
    }
    return [...links.values()];
  };

  // Broad default rooms connect nearly everyone and turn the graph into a
  // complete graph, so use more specific public channels for the default shape.
  const focusedChannels = channels.filter((channel) => channel.name !== "all" && channel.memberCount <= 36);
  const links = addLinksForChannels(focusedChannels);
  return links.length > 0
    ? links
    : addLinksForChannels(channels.filter((channel) => channel.name !== "all"));
}

function computeMemberNetworkLayout(members: GraphMember[], links: MemberLink[], dense: boolean) {
  const positions = new Map<string, Point>();
  const degrees = new Map<string, number>();
  const nodeKeys = members.map(memberKey);
  const neighbors = new Map<string, Set<string>>();

  members.forEach((member, index) => {
    const key = memberKey(member);
    positions.set(key, initialPoint(key, index, members.length, false));
    neighbors.set(key, new Set());
  });

  links.forEach((link) => {
    neighbors.get(link.source)?.add(link.target);
    neighbors.get(link.target)?.add(link.source);
  });
  members.forEach((member) => {
    const key = memberKey(member);
    degrees.set(key, neighbors.get(key)?.size ?? 0);
  });

  if (nodeKeys.length <= 1) return { positions, degrees };

  const componentLayouts = assignComponentLayouts(buildConnectedComponents(nodeKeys, neighbors), dense);
  const componentByKey = new Map<string, LayoutComponent>();
  componentLayouts.forEach((component) => {
    component.keys.forEach((key, index) => {
      componentByKey.set(key, component);
      positions.set(key, componentInitialPoint(key, index, component.keys.length, component));
    });
  });

  const area = VIEWBOX_WIDTH * VIEWBOX_HEIGHT;
  const repulsion = Math.min(8200, Math.max(2800, area / Math.max(nodeKeys.length, 1) / 1.9));
  const iterations = dense ? 150 : 128;

  for (let step = 0; step < iterations; step += 1) {
    const alpha = 1 - step / iterations;
    const deltas = new Map<string, Point>();
    nodeKeys.forEach((key) => deltas.set(key, { x: 0, y: 0 }));

    for (let i = 0; i < nodeKeys.length; i += 1) {
      const aKey = nodeKeys[i];
      const a = positions.get(aKey);
      if (!a) continue;
      for (let j = i + 1; j < nodeKeys.length; j += 1) {
        const bKey = nodeKeys[j];
        if (componentLayouts.length > 1 && componentByKey.get(aKey) !== componentByKey.get(bKey)) continue;
        const b = positions.get(bKey);
        if (!b) continue;
        const dx = a.x - b.x;
        const dy = a.y - b.y;
        const distanceSq = Math.max(100, dx * dx + dy * dy);
        const force = (repulsion / distanceSq) * alpha;
        const distance = Math.sqrt(distanceSq);
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        const aDelta = deltas.get(aKey)!;
        const bDelta = deltas.get(bKey)!;
        aDelta.x += fx;
        aDelta.y += fy;
        bDelta.x -= fx;
        bDelta.y -= fy;
      }
    }

    for (const link of links) {
      const source = positions.get(link.source);
      const target = positions.get(link.target);
      if (!source || !target) continue;
      const dx = target.x - source.x;
      const dy = target.y - source.y;
      const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
      const desired = dense ? 112 : 210;
      const force = (distance - desired) * (0.018 + Math.min(link.weight, 4) * 0.004) * alpha;
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      const sourceDelta = deltas.get(link.source)!;
      const targetDelta = deltas.get(link.target)!;
      sourceDelta.x += fx;
      sourceDelta.y += fy;
      targetDelta.x -= fx;
      targetDelta.y -= fy;
    }

    for (const key of nodeKeys) {
      const position = positions.get(key);
      const delta = deltas.get(key);
      if (!position || !delta) continue;
      const degree = degrees.get(key) ?? 0;
      const component = componentByKey.get(key);
      const gravityCenter = component?.center ?? CENTER;
      const gravity = degree === 0 ? 0.04 : 0.014;
      delta.x += (gravityCenter.x - position.x) * gravity * alpha;
      delta.y += (gravityCenter.y - position.y) * gravity * alpha;
      position.x = clamp(position.x + delta.x, GRAPH_PADDING, VIEWBOX_WIDTH - GRAPH_PADDING);
      position.y = clamp(position.y + delta.y, GRAPH_PADDING, VIEWBOX_HEIGHT - GRAPH_PADDING);
    }
  }

  return { positions, degrees };
}

function MemberGraphCanvas({ data }: { data: GraphResponse }) {
  const { formatMessage } = useIntl();
  const graphRef = useRef<HTMLDivElement | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const [transform, setTransform] = useState<ZoomTransform>(zoomIdentity);
  const [dimensions, setDimensions] = useState<GraphDimensions>({ width: 0, height: 0 });
  const members = useMemo<GraphMember[]>(
    () => [...data.humans, ...data.agents].sort((a, b) => displayName(a).localeCompare(displayName(b))),
    [data.agents, data.humans],
  );
  const channels = useMemo(
    () => [...data.channels].sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name)),
    [data.channels],
  );
  const memberLinks = useMemo(() => buildMemberLinks(members, channels), [channels, members]);
  const dense = members.length > 34 || memberLinks.length > 120;
  const { positions, degrees } = useMemo(
    () => computeMemberNetworkLayout(members, memberLinks, dense),
    [dense, memberLinks, members],
  );
  useEffect(() => {
    const node = graphRef.current;
    if (!node) return;

    const updateDimensions = () => {
      const bounds = node.getBoundingClientRect();
      setDimensions({ width: bounds.width, height: bounds.height });
    };

    // Layout dimensions read from DOM via ResizeObserver. Sync-with-external-
    // store FP family, not prop-derived state.
    // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
    updateDimensions();
    const observer = new ResizeObserver(updateDimensions);
    observer.observe(node);
    return () => observer.disconnect();
  }, [channels.length, members.length]);

  useEffect(() => {
    const node = graphRef.current;
    if (!node || dimensions.width <= 0 || dimensions.height <= 0) return;

    const behavior = zoom<HTMLDivElement, unknown>()
      .scaleExtent([1, MAX_GRAPH_ZOOM])
      .extent([[0, 0], [dimensions.width, dimensions.height]])
      .translateExtent([[0, 0], [dimensions.width, dimensions.height]])
      .on("zoom", (event) => {
        transformRef.current = event.transform;
        setTransform(event.transform);
      });

    const selection = select(node);
    selection.call(behavior);
    selection.call(behavior.transform, transformRef.current);
    return () => {
      selection.on(".zoom", null);
    };
  }, [dimensions.width, dimensions.height]);

  const viewBox = useMemo<GraphViewBox>(() => {
    if (dimensions.width <= 0 || dimensions.height <= 0) return DEFAULT_GRAPH_VIEWBOX;
    const width = VIEWBOX_WIDTH / transform.k;
    const height = VIEWBOX_HEIGHT / transform.k;
    return {
      x: clamp((-transform.x / transform.k / dimensions.width) * VIEWBOX_WIDTH, 0, VIEWBOX_WIDTH - width),
      y: clamp((-transform.y / transform.k / dimensions.height) * VIEWBOX_HEIGHT, 0, VIEWBOX_HEIGHT - height),
      width,
      height,
    };
  }, [dimensions.height, dimensions.width, transform]);

  const screenPosition = (point: Point) => ({
    left: transform.x + (point.x / VIEWBOX_WIDTH) * dimensions.width * transform.k,
    top: transform.y + (point.y / VIEWBOX_HEIGHT) * dimensions.height * transform.k,
  });

  if (members.length === 0 && channels.length === 0) {
    return (
      <div className="flex min-h-[320px] items-center justify-center border-2 border-dashed border-black/30 bg-white text-sm font-bold text-black/40">
        {formatMessage({ id: "settings.memberGraph.emptyState" })}
      </div>
    );
  }

  const renderGraphSvg = () => {
    return (
      <svg
        viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
        className="h-[360px] w-full md:h-[520px]"
        role="img"
        aria-label={formatMessage({ id: "settings.memberGraph.graphAriaLabel" })}
      >
        <rect x="0" y="0" width={VIEWBOX_WIDTH} height={VIEWBOX_HEIGHT} fill="#f8f8f0" />
        <g opacity={dense ? "0.16" : "0.34"}>
          {memberLinks.map((link) => {
            const from = positions.get(link.source);
            const to = positions.get(link.target);
            if (!from || !to) return null;
            return (
              <path
                key={`${link.source}:${link.target}`}
                d={edgePath(from, to, dense)}
                fill="none"
                stroke="#111"
                strokeWidth={dense ? Math.min(1.8, 0.55 + link.weight * 0.2) : Math.min(3, 1.1 + link.weight * 0.35)}
                vectorEffect="non-scaling-stroke"
              />
            );
          })}
        </g>
      </svg>
    );
  };

  return (
    <div
      ref={graphRef}
      className="relative touch-none select-none overflow-hidden border-2 border-black bg-[#f8f8f0] shadow-brutal-sm cursor-grab active:cursor-grabbing"
    >
      {renderGraphSvg()}
      <div className="pointer-events-none absolute inset-0">
        {members.map((member) => {
          const key = memberKey(member);
          const point = positions.get(key);
          if (!point) return null;
          const degree = degrees.get(key) ?? 0;
          return (
            <GraphMemberNode
              key={key}
              member={member}
              point={point}
              degree={degree}
              dense={dense}
              screenPosition={screenPosition}
            />
          );
        })}
      </div>
    </div>
  );
}

function RankedList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-2 border-black bg-white p-3 shadow-brutal-sm">
      <div className="mb-2 text-xs font-black uppercase tracking-normal text-black">{title}</div>
      {children}
    </div>
  );
}

export default function MemberGraphSection({
  showHeader = true,
  sectionLabel,
}: {
  showHeader?: boolean;
  sectionLabel?: string;
}) {
  const { formatMessage } = useIntl();
  // Resolve the default through the catalog rather than a hardcoded English
  // literal: the sole caller passes sectionLabel today, but a future one that
  // omits it would silently render English in zh. Same shape as the
  // SelectionPopover primitive defaults (#5716).
  const resolvedSectionLabel = sectionLabel ?? formatMessage({ id: "settings.memberGraph.sectionLabel" });
  const current = useServerStore((s) => s.current);
  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const loadGraph = async () => {
    if (!current) return;
    setLoading(true);
    setError("");
    try {
      const { data: next } = await api.get(`/servers/${current.id}/member-graph`);
      setData(next);
    } catch (err: any) {
      setError(err.response?.data?.error || formatMessage({ id: "settings.memberGraph.loadFailed" }));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  const members = useMemo<GraphMember[]>(
    () => data ? [...data.humans, ...data.agents] : [],
    [data],
  );
  const memberLinks = useMemo(() => data ? buildMemberLinks(members, data.channels) : [], [data, members]);
  const memberLinkDegrees = useMemo(() => buildMemberLinkDegrees(memberLinks), [memberLinks]);
  const rankedMembers = useMemo(
    () => [...members]
      .sort((a, b) => (memberLinkDegrees.get(memberKey(b)) ?? 0) - (memberLinkDegrees.get(memberKey(a)) ?? 0) || displayName(a).localeCompare(displayName(b)))
      .slice(0, 6),
    [memberLinkDegrees, members],
  );
  const rankedChannels = useMemo(
    () => data ? [...data.channels].sort((a, b) => b.memberCount - a.memberCount || a.name.localeCompare(b.name)).slice(0, 6) : [],
    [data],
  );

  return (
    <div className="space-y-4">
      <div className={`flex flex-col gap-3 sm:flex-row sm:items-center ${showHeader ? "sm:justify-between" : "sm:justify-end"}`}>
        {showHeader && (
          <SectionHeader
            icon={<GitBranch size={16} />}
            label={resolvedSectionLabel}
            count={data ? data.humans.length + data.agents.length : undefined}
          />
        )}
        <button
          type="button"
          onClick={loadGraph}
          disabled={loading}
          className="btn-brutal-sm flex w-fit items-center gap-1.5 bg-white px-2.5 py-1.5 text-xs disabled:opacity-50"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          {formatMessage({ id: "settings.memberGraph.refresh" })}
        </button>
      </div>

      {error && <Banner intent="warning" density="sm" className="font-bold">{error}</Banner>}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_280px]">
        <MemberGraphCanvas data={data ?? { humans: [], agents: [], channels: [], edges: [] }} />

        <div className="space-y-3">
          <div className="grid grid-cols-3 gap-2">
            <div className="border-2 border-black bg-white p-2 text-center shadow-brutal-sm">
              <div className="text-lg font-black">{data?.humans.length ?? 0}</div>
              <div className="text-[10px] font-bold uppercase text-black/55">{formatMessage({ id: "settings.memberGraph.humans" })}</div>
            </div>
            <div className="border-2 border-black bg-white p-2 text-center shadow-brutal-sm">
              <div className="text-lg font-black">{data?.agents.length ?? 0}</div>
              <div className="text-[10px] font-bold uppercase text-black/55">{formatMessage({ id: "settings.memberGraph.agents" })}</div>
            </div>
            <div className="border-2 border-black bg-white p-2 text-center shadow-brutal-sm">
              <div className="text-lg font-black">{memberLinks.length}</div>
              <div className="text-[10px] font-bold uppercase text-black/55">{formatMessage({ id: "settings.memberGraph.links" })}</div>
            </div>
          </div>

          <RankedList title={formatMessage({ id: "settings.memberGraph.mostConnectedTitle" })}>
            {rankedMembers.length > 0 ? (
              <div className="space-y-2">
                {rankedMembers.map((member) => (
                  <div key={memberKey(member)} className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <MemberAvatar member={member} compact />
                      <span className="truncate font-bold">{displayName(member)}</span>
                    </div>
                    <span className="shrink-0 font-mono text-black/55">{memberLinkDegrees.get(memberKey(member)) ?? 0}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs italic text-black/40">{formatMessage({ id: "settings.memberGraph.noMemberships" })}</div>
            )}
          </RankedList>

          <RankedList title={formatMessage({ id: "settings.memberGraph.largestChannelsTitle" })}>
            {rankedChannels.length > 0 ? (
              <div className="space-y-2">
                {rankedChannels.map((channel) => (
                  <div key={channel.id} className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <Hash size={13} />
                      <span className="truncate font-bold">{channel.name}</span>
                    </div>
                    <span className="shrink-0 font-mono text-black/55">
                      {channel.humanCount}H/{channel.agentCount}A
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-xs italic text-black/40">{formatMessage({ id: "settings.memberGraph.noVisibleChannels" })}</div>
            )}
          </RankedList>
        </div>
      </div>
    </div>
  );
}
