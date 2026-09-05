import { useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeMouseHandler,
  useEdgesState,
  useNodesState,
  useReactFlow
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  ProjectGraphEntityRecord,
  ProjectGraphEventRecord,
  ProjectGraphRecord
} from "../types";
import { Button } from "./ui/button";
import { cn } from "../lib/utils";
import type { SupportedLanguage } from "../i18n";

type GraphNodeData = {
  label: string;
  kind: "entity" | "event";
  expanded: boolean;
} & Record<string, unknown>;

type GraphNode = Node<GraphNodeData>;
type GraphEdge = Edge;

const ROOT_ENTITY_LIMIT = 8;
const ENTITY_NODE_WIDTH = 170;
const EVENT_NODE_WIDTH = 180;
const NODE_HEIGHT = 44;
const ENTITY_RING_START_RADIUS = 220;
const ENTITY_RING_GAP = 190;
const ENTITY_SLOT_SPACING = 210;
const EVENT_RING_START_RADIUS = 520;
const EVENT_RING_GAP = 185;
const EVENT_SLOT_SPACING = 240;
const EVENT_ANGLE_OFFSET = -Math.PI / 2 + Math.PI / 12;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

type GraphPosition = {
  x: number;
  y: number;
  angle: number;
  radius: number;
  root?: boolean;
};

export function ProjectGraphFlow(props: {
  graph: ProjectGraphRecord;
  language: SupportedLanguage;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  return (
    <ReactFlowProvider>
      <ProjectGraphCanvas {...props} />
    </ReactFlowProvider>
  );
}

function ProjectGraphCanvas(props: {
  graph: ProjectGraphRecord;
  language: SupportedLanguage;
  onOpenEvent: (eventId: string) => void;
  onOpenEntity: (entityId: string) => void;
}) {
  const initialEntityIds = useMemo(
    () => new Set(props.graph.entities.slice(0, ROOT_ENTITY_LIMIT).map((entity) => entity.id)),
    [props.graph.entities]
  );
  const [expandedEntityIds, setExpandedEntityIds] = useState<Set<string>>(
    () => new Set(props.graph.entities[0] ? [props.graph.entities[0].id] : [])
  );
  const [expandedEventIds, setExpandedEventIds] = useState<Set<string>>(new Set());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const expandedEntityIdsRef = useRef(expandedEntityIds);
  const expandedEventIdsRef = useRef(expandedEventIds);
  const [nodes, setNodes, onNodesChange] = useNodesState<GraphNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<GraphEdge>([]);
  const { fitView } = useReactFlow<GraphNode, GraphEdge>();
  const clickTimerRef = useRef<number | null>(null);
  const shouldFitViewRef = useRef(true);

  const entityById = useMemo(
    () => new Map(props.graph.entities.map((entity) => [entity.id, entity])),
    [props.graph.entities]
  );
  const eventById = useMemo(
    () => new Map(props.graph.events.map((event) => [event.id, event])),
    [props.graph.events]
  );
  const eventIdsByEntityId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of props.graph.edges) {
      const eventIds = map.get(edge.entityId) ?? [];
      eventIds.push(edge.eventId);
      map.set(edge.entityId, eventIds);
    }
    for (const [entityId, eventIds] of map.entries()) {
      eventIds.sort((a, b) => compareEvents(eventById.get(a), eventById.get(b)));
      map.set(entityId, eventIds);
    }
    return map;
  }, [eventById, props.graph.edges]);
  const entityIdsByEventId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const edge of props.graph.edges) {
      const entityIds = map.get(edge.eventId) ?? [];
      entityIds.push(edge.entityId);
      map.set(edge.eventId, entityIds);
    }
    for (const [eventId, entityIds] of map.entries()) {
      entityIds.sort((a, b) => compareEntities(entityById.get(a), entityById.get(b)));
      map.set(eventId, entityIds);
    }
    return map;
  }, [entityById, props.graph.edges]);
  // Compute visible node IDs ONCE per expand state, so positions are only
  // generated for nodes we actually render. The full 1168-entity circular
  // layout would otherwise force fitView to zoom to ~0.22x and crush nodes
  // into illegible specks. With visible-only positions, fitView fits cleanly.
  const visibleEntityIds = useMemo(() => {
    const set = new Set<string>(initialEntityIds);
    for (const entityId of expandedEntityIds) {
      set.add(entityId);
      for (const eventId of eventIdsByEntityId.get(entityId) ?? []) {
        // events pulled in by entity expansion are also visible
        void eventId;
      }
    }
    for (const eventId of expandedEventIds) {
      for (const entityId of entityIdsByEventId.get(eventId) ?? []) {
        set.add(entityId);
      }
    }
    return set;
  }, [initialEntityIds, expandedEntityIds, expandedEventIds, eventIdsByEntityId, entityIdsByEventId]);
  const visibleEventIds = useMemo(() => {
    const set = new Set<string>();
    for (const entityId of expandedEntityIds) {
      for (const eventId of eventIdsByEntityId.get(entityId) ?? []) {
        set.add(eventId);
      }
    }
    for (const eventId of expandedEventIds) {
      set.add(eventId);
    }
    return set;
  }, [expandedEntityIds, expandedEventIds, eventIdsByEntityId]);
  const positionByNodeId = useMemo(
    () => buildCircularPositionMap(props.graph, visibleEntityIds, visibleEventIds),
    [props.graph, visibleEntityIds, visibleEventIds]
  );
  const graphIdentity = useMemo(
    () => [
      props.graph.entities.map((entity) => entity.id).join(","),
      props.graph.events.map((event) => event.id).join(","),
      props.graph.edges.map((edge) => `${edge.entityId}:${edge.eventId}`).join(",")
    ].join("|"),
    [props.graph]
  );

  const graphModel = useMemo(() => buildVisibleGraph({
    initialEntityIds,
    expandedEntityIds,
    expandedEventIds,
    entityById,
    eventById,
    eventIdsByEntityId,
    entityIdsByEventId,
    edges: props.graph.edges,
    positionByNodeId,
    selectedNodeId
  }), [
    entityById,
    entityIdsByEventId,
    eventById,
    eventIdsByEntityId,
    expandedEntityIds,
    expandedEventIds,
    initialEntityIds,
    positionByNodeId,
    props.graph.edges,
    selectedNodeId
  ]);

  useEffect(() => {
    setNodes(graphModel.nodes);
    setEdges(graphModel.edges);
    if (shouldFitViewRef.current) {
      shouldFitViewRef.current = false;
      window.requestAnimationFrame(() => {
        fitView({ padding: 0.22, duration: 220 });
      });
    }
  }, [fitView, graphModel.edges, graphModel.nodes, setEdges, setNodes]);

  useEffect(() => {
    shouldFitViewRef.current = true;
    setExpandedEntityIds(new Set(props.graph.entities[0] ? [props.graph.entities[0].id] : []));
    setExpandedEventIds(new Set());
    setSelectedNodeId(null);
  }, [graphIdentity]);

  useEffect(() => {
    expandedEntityIdsRef.current = expandedEntityIds;
  }, [expandedEntityIds]);

  useEffect(() => {
    expandedEventIdsRef.current = expandedEventIds;
  }, [expandedEventIds]);

  // When the visible set changes (e.g. Expand all), recompute positions and
  // re-fit the viewport so newly-revealed nodes are framed, not cropped.
  useEffect(() => {
    shouldFitViewRef.current = true;
  }, [visibleEntityIds, visibleEventIds]);

  useEffect(() => () => clearClickTimer(), []);

  const onNodeClick: NodeMouseHandler<GraphNode> = (event, node) => {
    event.stopPropagation();
    setSelectedNodeId(node.id);
    clearClickTimer();
    clickTimerRef.current = window.setTimeout(() => {
      toggleNode(node);
      clickTimerRef.current = null;
    }, 180);
  };

  const onNodeDoubleClick: NodeMouseHandler<GraphNode> = (event, node) => {
    event.stopPropagation();
    clearClickTimer();
    setSelectedNodeId(node.id);
    const data = node.data as GraphNodeData;
    if (data.kind === "entity") {
      props.onOpenEntity(node.id);
      return;
    }
    props.onOpenEvent(node.id);
  };

  function toggleNode(node: GraphNode) {
    const data = node.data as GraphNodeData;
    if (data.kind === "entity") {
      const isExpanded = expandedEntityIdsRef.current.has(node.id);
      setExpandedEntityIds((current) => {
        const next = new Set(current);
        if (isExpanded) {
          next.delete(node.id);
        } else {
          next.add(node.id);
        }
        return next;
      });
      if (isExpanded) {
        const relatedEventIds = new Set(eventIdsByEntityId.get(node.id) ?? []);
        setExpandedEventIds((current) => {
          const next = new Set(current);
          for (const eventId of relatedEventIds) {
            next.delete(eventId);
          }
          return next;
        });
      }
      return;
    }
    setExpandedEventIds((current) => {
      const next = new Set(current);
      if (expandedEventIdsRef.current.has(node.id)) {
        next.delete(node.id);
      } else {
        next.add(node.id);
      }
      return next;
    });
  }

  function clearClickTimer() {
    if (clickTimerRef.current == null) {
      return;
    }
    window.clearTimeout(clickTimerRef.current);
    clickTimerRef.current = null;
  }

  function resetGraph() {
    shouldFitViewRef.current = true;
    setExpandedEntityIds(new Set(props.graph.entities[0] ? [props.graph.entities[0].id] : []));
    setExpandedEventIds(new Set());
    setSelectedNodeId(null);
  }

  function expandAll() {
    shouldFitViewRef.current = true;
    setExpandedEntityIds(new Set(props.graph.entities.map((entity) => entity.id)));
    setExpandedEventIds(new Set(props.graph.events.map((event) => event.id)));
    setSelectedNodeId(null);
  }

  return (
    <div className="relative h-full min-h-0 overflow-hidden rounded-lg border border-border bg-background">
      <div className="absolute left-3 top-3 z-10 flex flex-wrap items-center gap-2 rounded-md border border-border bg-background/95 p-2 shadow-sm">
        <MetricChip label={graphText(props.language, "实体", "Entities")} value={props.graph.entities.length} />
        <MetricChip label={graphText(props.language, "事件", "Events")} value={props.graph.events.length} />
        <MetricChip label={graphText(props.language, "关系", "Relations")} value={props.graph.edges.length} />
        <Button type="button" variant="outline" size="sm" onClick={resetGraph}>{graphText(props.language, "重置", "Reset")}</Button>
        <Button type="button" variant="outline" size="sm" onClick={expandAll}>{graphText(props.language, "展开全部", "Expand all")}</Button>
      </div>
      <ReactFlow<GraphNode, GraphEdge>
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={() => setSelectedNodeId(null)}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.12}
        maxZoom={2.5}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          nodeColor={(node) => ((node.data as GraphNodeData).kind === "entity" ? "#111827" : "#6b7280")}
          maskColor="rgba(255,255,255,0.65)"
        />
      </ReactFlow>
    </div>
  );
}

function graphText(language: SupportedLanguage, zh: string, en: string) {
  return language === "en" ? en : zh;
}

function buildVisibleGraph(input: {
  initialEntityIds: Set<string>;
  expandedEntityIds: Set<string>;
  expandedEventIds: Set<string>;
  entityById: Map<string, ProjectGraphEntityRecord>;
  eventById: Map<string, ProjectGraphEventRecord>;
  eventIdsByEntityId: Map<string, string[]>;
  entityIdsByEventId: Map<string, string[]>;
  edges: ProjectGraphRecord["edges"];
  positionByNodeId: Map<string, GraphPosition>;
  selectedNodeId: string | null;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const visibleEntityIds = new Set(input.initialEntityIds);
  const visibleEventIds = new Set<string>();

  for (const entityId of input.expandedEntityIds) {
    visibleEntityIds.add(entityId);
    for (const eventId of input.eventIdsByEntityId.get(entityId) ?? []) {
      visibleEventIds.add(eventId);
    }
  }

  for (const eventId of input.expandedEventIds) {
    visibleEventIds.add(eventId);
    for (const entityId of input.entityIdsByEventId.get(eventId) ?? []) {
      visibleEntityIds.add(entityId);
    }
  }

  const nodes: GraphNode[] = [];
  const entityIds = [...visibleEntityIds]
    .filter((id) => input.entityById.has(id))
    .sort((a, b) => compareEntities(input.entityById.get(a), input.entityById.get(b)));
  const eventIds = [...visibleEventIds]
    .filter((id) => input.eventById.has(id))
    .sort((a, b) => compareEvents(input.eventById.get(a), input.eventById.get(b)));

  for (const entityId of entityIds) {
    const entity = input.entityById.get(entityId);
    if (!entity) continue;
    const position = input.positionByNodeId.get(entity.id) ?? fallbackPosition();
    nodes.push(createGraphNode({
      id: entity.id,
      label: entity.name,
      kind: "entity",
      expanded: input.expandedEntityIds.has(entity.id),
      x: position.x,
      y: position.y,
      root: position.root
    }));
  }

  for (const eventId of eventIds) {
    const event = input.eventById.get(eventId);
    if (!event) continue;
    const position = input.positionByNodeId.get(event.id) ?? fallbackPosition();
    nodes.push(createGraphNode({
      id: event.id,
      label: event.title,
      kind: "event",
      expanded: input.expandedEventIds.has(event.id),
      x: position.x,
      y: position.y
    }));
  }

  const visibleNodeIds = new Set(nodes.map((node) => node.id));
  const edges = input.edges
    .filter((edge) => visibleNodeIds.has(edge.entityId) && visibleNodeIds.has(edge.eventId))
    .map((edge) => {
      const eventExpandsEntity = input.expandedEventIds.has(edge.eventId) && !input.expandedEntityIds.has(edge.entityId);
      return {
        id: `${edge.entityId}-${edge.eventId}`,
        source: eventExpandsEntity ? edge.eventId : edge.entityId,
        target: eventExpandsEntity ? edge.entityId : edge.eventId,
        animated: input.expandedEntityIds.has(edge.entityId) || input.expandedEventIds.has(edge.eventId),
        style: { stroke: "#d4d4d8", strokeWidth: 1.4 }
      };
    });

  return applySelectionStyles({
    nodes,
    edges,
    selectedNodeId: input.selectedNodeId
  });
}

function createGraphNode(input: {
  id: string;
  label: string;
  kind: GraphNodeData["kind"];
  expanded: boolean;
  x: number;
  y: number;
  root?: boolean;
}): GraphNode {
  return {
    id: input.id,
    type: "default",
    position: { x: input.x, y: input.y },
    data: {
      label: input.label,
      kind: input.kind,
      expanded: input.expanded
    },
    style: {
      width: input.root ? ENTITY_NODE_WIDTH + 20 : input.kind === "entity" ? ENTITY_NODE_WIDTH : EVENT_NODE_WIDTH,
      borderRadius: 6,
      border: input.expanded ? "1.5px solid #111827" : "1px solid #d4d4d8",
      background: input.kind === "entity" ? "#ffffff" : "#f8fafc",
      color: "#111827",
      fontSize: 12,
      fontWeight: input.kind === "entity" ? 650 : 520,
      padding: "8px 10px",
      boxShadow: input.root ? "0 8px 24px rgba(15, 23, 42, 0.12)" : "0 2px 8px rgba(15, 23, 42, 0.06)",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap"
    },
    className: cn(input.expanded && "ring-2 ring-ring/25")
  };
}

function applySelectionStyles(input: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  selectedNodeId: string | null;
}) {
  if (!input.selectedNodeId || !input.nodes.some((node) => node.id === input.selectedNodeId)) {
    return input;
  }

  const relatedNodeIds = new Set([input.selectedNodeId]);
  for (const edge of input.edges) {
    if (edge.source === input.selectedNodeId || edge.target === input.selectedNodeId) {
      relatedNodeIds.add(edge.source);
      relatedNodeIds.add(edge.target);
    }
  }

  return {
    nodes: input.nodes.map((node) => {
      const related = relatedNodeIds.has(node.id);
      const selected = node.id === input.selectedNodeId;
      return {
        ...node,
        style: {
          ...node.style,
          opacity: related ? 1 : 0.18,
          border: selected ? "2px solid #111827" : node.style?.border,
          boxShadow: selected ? "0 10px 30px rgba(15, 23, 42, 0.22)" : node.style?.boxShadow
        }
      };
    }),
    edges: input.edges.map((edge) => {
      const related = edge.source === input.selectedNodeId || edge.target === input.selectedNodeId;
      return {
        ...edge,
        style: {
          ...edge.style,
          opacity: related ? 1 : 0.12,
          strokeWidth: related ? 2 : 1
        }
      };
    })
  };
}

function buildCircularPositionMap(
  graph: ProjectGraphRecord,
  visibleEntityIds: Set<string>,
  visibleEventIds: Set<string>
) {
  const positions = new Map<string, GraphPosition>();
  const entities = [...graph.entities].sort(compareEntities);
  const [rootEntity, ...secondaryEntities] = entities;

  if (rootEntity) {
    positions.set(rootEntity.id, {
      x: -ENTITY_NODE_WIDTH / 2,
      y: -NODE_HEIGHT / 2,
      angle: -Math.PI / 2,
      radius: 0,
      root: true
    });
  }

  const visibleSecondaryIds = secondaryEntities
    .filter((entity) => visibleEntityIds.has(entity.id))
    .map((entity) => entity.id);
  placeOnRings({
    ids: visibleSecondaryIds,
    positions,
    startRadius: ENTITY_RING_START_RADIUS,
    ringGap: ENTITY_RING_GAP,
    slotSpacing: ENTITY_SLOT_SPACING,
    nodeWidth: ENTITY_NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    angleOffset: -Math.PI / 2
  });

  const visibleEvents = graph.events.filter((event) => visibleEventIds.has(event.id));
  placeEventsOnOuterRings({
    events: visibleEvents,
    positions,
    angleOffset: EVENT_ANGLE_OFFSET
  });

  return positions;
}

function fallbackPosition(): GraphPosition {
  return {
    x: 0,
    y: 0,
    angle: 0,
    radius: 0
  };
}

function placeEventsOnOuterRings(input: {
  events: ProjectGraphEventRecord[];
  positions: Map<string, GraphPosition>;
  angleOffset: number;
}) {
  const sortedEvents = [...input.events].sort(compareEvents);
  const occupiedSlotsByRing = new Map<number, Set<number>>();

  for (let index = 0; index < sortedEvents.length; index += 1) {
    const event = sortedEvents[index];
    const desiredAngle = index * GOLDEN_ANGLE;
    const slot = findEventSlot({
      desiredAngle,
      angleOffset: input.angleOffset,
      occupiedSlotsByRing
    });
    const radius = EVENT_RING_START_RADIUS + slot.ring * EVENT_RING_GAP;
    const angle = input.angleOffset + (2 * Math.PI * slot.index) / slot.capacity;
    input.positions.set(event.id, {
      x: Math.cos(angle) * radius - EVENT_NODE_WIDTH / 2,
      y: Math.sin(angle) * radius - NODE_HEIGHT / 2,
      angle,
      radius
    });
  }
}

function findEventSlot(input: {
  desiredAngle: number;
  angleOffset: number;
  occupiedSlotsByRing: Map<number, Set<number>>;
}) {
  let ring = 0;
  while (true) {
    const radius = EVENT_RING_START_RADIUS + ring * EVENT_RING_GAP;
    const capacity = Math.max(8, Math.floor((2 * Math.PI * radius) / EVENT_SLOT_SPACING));
    const occupiedSlots = input.occupiedSlotsByRing.get(ring) ?? new Set<number>();
    const desiredSlot = modulo(
      Math.round(((input.desiredAngle - input.angleOffset) / (2 * Math.PI)) * capacity),
      capacity
    );
    const freeSlot = nearestFreeSlot(desiredSlot, capacity, occupiedSlots);
    if (freeSlot != null) {
      occupiedSlots.add(freeSlot);
      input.occupiedSlotsByRing.set(ring, occupiedSlots);
      return { ring, index: freeSlot, capacity };
    }
    ring += 1;
  }
}

function nearestFreeSlot(desiredSlot: number, capacity: number, occupiedSlots: Set<number>) {
  for (let distance = 0; distance < capacity; distance += 1) {
    const candidates = distance === 0 ? [desiredSlot] : [
      modulo(desiredSlot - distance, capacity),
      modulo(desiredSlot + distance, capacity)
    ];
    for (const candidate of candidates) {
      if (!occupiedSlots.has(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function modulo(value: number, divisor: number) {
  return ((value % divisor) + divisor) % divisor;
}

function placeOnRings(input: {
  ids: string[];
  positions: Map<string, GraphPosition>;
  startRadius: number;
  ringGap: number;
  slotSpacing: number;
  nodeWidth: number;
  nodeHeight: number;
  angleOffset: number;
}) {
  let index = 0;
  let ring = 0;

  while (index < input.ids.length) {
    const radius = input.startRadius + ring * input.ringGap;
    const capacity = Math.max(6, Math.floor((2 * Math.PI * radius) / input.slotSpacing));
    for (let slot = 0; slot < capacity && index < input.ids.length; slot += 1) {
      const id = input.ids[index];
      const angle = input.angleOffset + (2 * Math.PI * slot) / capacity;
      input.positions.set(id, {
        x: Math.cos(angle) * radius - input.nodeWidth / 2,
        y: Math.sin(angle) * radius - input.nodeHeight / 2,
        angle,
        radius
      });
      index += 1;
    }
    ring += 1;
  }

  return ring;
}

function compareEntities(a?: ProjectGraphEntityRecord, b?: ProjectGraphEntityRecord) {
  return (b?.eventCount ?? 0) - (a?.eventCount ?? 0) || (a?.name ?? "").localeCompare(b?.name ?? "");
}

function compareEvents(a?: ProjectGraphEventRecord, b?: ProjectGraphEventRecord) {
  return (a?.rank ?? 0) - (b?.rank ?? 0) || (a?.title ?? "").localeCompare(b?.title ?? "");
}

function MetricChip({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border bg-muted/40 px-2 py-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="ml-1 text-sm font-semibold">{value}</span>
    </div>
  );
}
