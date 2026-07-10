"use client";

import { useMemo } from "react";
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from "@xyflow/react";
import type { MemoryRecord, MemoryType } from "@/lib/memory/types";

const memoryTypeLabels: Record<MemoryType, string> = {
  semantic: "事实",
  episodic: "经历",
  procedural: "习惯",
  affect: "情绪",
  safety: "安全",
  preference: "偏好",
  boundary: "边界",
};

const memoryTypeOrder = Object.keys(memoryTypeLabels) as MemoryType[];

export function MemoryGraph({
  memories,
  selectedMemoryId,
  onSelectMemory,
}: {
  memories: MemoryRecord[];
  selectedMemoryId: string | null;
  onSelectMemory: (memoryId: string | null) => void;
}) {
  const { nodes, edges, graphSize } = useMemo(() => {
    const usedTypes = memoryTypeOrder.filter((type) => memories.some((memory) => memory.type === type));
    const center = { x: 420, y: 300 };
    const typeRadius = Math.max(150, Math.min(250, 130 + usedTypes.length * 18));
    const grouped = new Map<MemoryType, MemoryRecord[]>();
    const typePositions = new Map<MemoryType, { x: number; y: number; angle: number }>();

    for (const type of usedTypes) {
      grouped.set(
        type,
        memories
          .filter((memory) => memory.type === type)
          .sort((left, right) => right.importance - left.importance || right.lastSeenAt.localeCompare(left.lastSeenAt)),
      );
    }

    const typeNodes: Node[] = usedTypes.map((type, index) => {
      const angle = -Math.PI / 2 + (index / Math.max(usedTypes.length, 1)) * Math.PI * 2;
      const x = center.x + Math.cos(angle) * typeRadius;
      const y = center.y + Math.sin(angle) * typeRadius;
      typePositions.set(type, { x, y, angle });
      return {
        id: `type-${type}`,
        position: { x, y },
        data: { label: memoryTypeLabels[type], kind: "type" },
        style: typeNodeStyle,
      };
    });

    const memoryNodes: Node[] = usedTypes.flatMap((type) =>
      (grouped.get(type) ?? []).map((memory, index) => {
        const typePosition = typePositions.get(type) ?? { ...center, angle: 0 };
        const ring = 130 + Math.floor(index / 4) * 150;
        const inRing = index % 4;
        const count = Math.min(4, (grouped.get(type)?.length ?? 1) - Math.floor(index / 4) * 4);
        const offset = count === 1 ? 0 : -0.55 + (inRing / Math.max(count - 1, 1)) * 1.1;
        const angle = typePosition.angle + offset;
        const selected = memory.id === selectedMemoryId;
        return {
          id: memory.id,
          position: { x: typePosition.x + Math.cos(angle) * ring, y: typePosition.y + Math.sin(angle) * ring },
          data: { label: truncateMemory(memory.content), kind: "memory", memoryId: memory.id },
          style: memoryNodeStyle(selected),
        };
      }),
    );

    const centerNode: Node = {
      id: "memory-center",
      position: center,
      data: { label: "长期记忆", kind: "center" },
      selectable: false,
      draggable: false,
      style: centerNodeStyle,
    };
    const edges: Edge[] = [
      ...usedTypes.map((type) => ({
        id: `edge-center-${type}`,
        source: "memory-center",
        target: `type-${type}`,
        style: { stroke: "var(--color-line)" },
      })),
      ...memories.map((memory) => ({
        id: `edge-${memory.id}`,
        source: `type-${memory.type}`,
        target: memory.id,
        animated: memory.id === selectedMemoryId,
        style: { stroke: "var(--color-line-strong)" },
      })),
    ];
    const allNodes = [centerNode, ...typeNodes, ...memoryNodes];
    const maxX = Math.max(...allNodes.map((node) => node.position.x), 0) + 320;
    const maxY = Math.max(...allNodes.map((node) => node.position.y), 0) + 220;
    return { nodes: allNodes, edges, graphSize: { width: Math.max(1120, maxX), height: Math.max(860, maxY) } };
  }, [memories, selectedMemoryId]);

  const handleNodeClick: NodeMouseHandler = (_, node) => {
    const memoryId = node.data?.memoryId;
    onSelectMemory(typeof memoryId === "string" ? memoryId : null);
  };

  return (
    <div className="h-[420px] overflow-auto rounded-2xl border border-line bg-card">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={handleNodeClick}
        defaultViewport={{ x: -220, y: -120, zoom: 0.82 }}
        minZoom={0.45}
        maxZoom={1.3}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
        panOnScroll
        translateExtent={[[-80, -80], [graphSize.width, graphSize.height]]}
        nodeExtent={[[-20, -20], [graphSize.width - 40, graphSize.height - 40]]}
        style={{ width: graphSize.width, height: graphSize.height }}
      >
        <Background color="var(--color-line)" gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

const typeNodeStyle = {
  width: 124,
  border: "1px solid var(--color-line)",
  borderRadius: 999,
  background: "var(--color-moss)",
  color: "var(--color-pine-deep)",
  fontSize: 12,
  fontWeight: 600,
  padding: "9px 12px",
  textAlign: "center" as const,
  boxShadow: "0 8px 20px rgb(63 58 38 / 0.08)",
};

const centerNodeStyle = {
  width: 116,
  border: "1px solid var(--color-pine)",
  borderRadius: 999,
  background: "var(--color-pine)",
  color: "var(--color-on-pine)",
  fontSize: 12,
  fontWeight: 600,
  padding: "10px 12px",
  textAlign: "center" as const,
  boxShadow: "0 12px 28px rgb(34 57 42 / 0.22)",
};

function memoryNodeStyle(selected: boolean) {
  return {
    width: 152,
    minHeight: 72,
    border: `1px solid ${selected ? "var(--color-pine)" : "var(--color-line)"}`,
    borderRadius: 12,
    background: selected ? "var(--color-pine)" : "var(--color-card)",
    color: selected ? "var(--color-on-pine)" : "var(--color-ink)",
    fontSize: 11,
    lineHeight: 1.5,
    padding: "9px 10px",
    boxShadow: selected ? "0 10px 24px rgb(34 57 42 / 0.2)" : "0 2px 10px rgb(63 58 38 / 0.06)",
  };
}

function truncateMemory(content: string) {
  return content.length > 34 ? `${content.slice(0, 34)}...` : content;
}
