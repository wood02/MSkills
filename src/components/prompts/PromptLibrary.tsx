import { useMemo, type CSSProperties } from "react";
import { CSS } from "@dnd-kit/utilities";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { FileText, Search } from "lucide-react";
import { useTranslation } from "react-i18next";
import { ManagementListSearch } from "@/components/common/ManagementListSearch";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { Prompt } from "@/lib/api";
import PromptListItem from "./PromptListItem";

interface SortablePromptItemProps {
  id: string;
  prompt: Prompt;
  showDragHandle: boolean;
  dragDisabled: boolean;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  orderIndex?: number;
  disabled?: boolean;
  deleteDisabled?: boolean;
  deleteTitle?: string;
}

function SortablePromptItem({
  id,
  prompt,
  showDragHandle,
  dragDisabled,
  onToggle,
  onEdit,
  onDelete,
  orderIndex,
  disabled,
  deleteDisabled,
  deleteTitle,
}: SortablePromptItemProps) {
  const {
    setNodeRef,
    attributes,
    listeners,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: !showDragHandle || dragDisabled });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div ref={setNodeRef} style={style}>
      <PromptListItem
        id={id}
        prompt={prompt}
        onToggle={onToggle}
        onEdit={onEdit}
        onDelete={onDelete}
        orderIndex={orderIndex}
        dragHandleProps={
          showDragHandle
            ? {
                attributes,
                listeners,
                isDragging,
                disabled: dragDisabled,
              }
            : undefined
        }
        disabled={disabled}
        deleteDisabled={deleteDisabled}
        deleteTitle={deleteTitle}
      />
    </div>
  );
}

interface PromptLibraryProps {
  prompts: Record<string, Prompt>;
  loading: boolean;
  searchQuery: string;
  statusText: string;
  headerAction?: React.ReactNode;
  disabled?: boolean;
  onSearchQueryChange: (value: string) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder?: (ids: string[]) => void;
  showOrderBadges?: boolean;
  isDeleteDisabled?: (id: string, prompt: Prompt) => boolean;
  getDeleteTitle?: (id: string, prompt: Prompt) => string;
}

export function PromptLibrary({
  prompts,
  loading,
  searchQuery,
  statusText,
  headerAction,
  disabled = false,
  onSearchQueryChange,
  onToggle,
  onEdit,
  onDelete,
  onReorder,
  showOrderBadges = false,
  isDeleteDisabled,
  getDeleteTitle,
}: PromptLibraryProps) {
  const { t } = useTranslation();
  const promptEntries = useMemo(() => Object.entries(prompts), [prompts]);
  const orderedIds = useMemo(
    () => promptEntries.map(([id]) => id),
    [promptEntries],
  );
  const enabledOrderMap = useMemo(() => {
    const map = new Map<string, number>();
    if (!showOrderBadges) return map;
    let index = 1;
    for (const [id, prompt] of promptEntries) {
      if (prompt.enabled) {
        map.set(id, index++);
      }
    }
    return map;
  }, [promptEntries, showOrderBadges]);

  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const isFiltering = normalizedSearchQuery.length > 0;
  const filteredPromptEntries = useMemo(() => {
    if (!normalizedSearchQuery) return promptEntries;

    return promptEntries.filter(([recordId, prompt]) =>
      [
        recordId,
        prompt.id,
        prompt.name,
        prompt.description,
        prompt.content,
      ].some((value) =>
        value?.toLocaleLowerCase().includes(normalizedSearchQuery),
      ),
    );
  }, [normalizedSearchQuery, promptEntries]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  );

  const dragDisabled = disabled || isFiltering || orderedIds.length < 2;
  const showDragHandle = Boolean(onReorder);

  const handleDragEnd = (event: DragEndEvent) => {
    if (!onReorder || dragDisabled) return;
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = orderedIds.indexOf(String(active.id));
    const newIndex = orderedIds.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;

    onReorder(arrayMove(orderedIds, oldIndex, newIndex));
  };

  return (
    <>
      <div className="mb-4 flex-shrink-0 rounded-xl border border-white/10 px-6 py-4 glass">
        <div className="flex items-center justify-between gap-4">
          <div className="text-sm text-muted-foreground min-w-0">
            {t("prompts.count", { count: promptEntries.length })} · {statusText}
          </div>
          {headerAction && <div className="shrink-0">{headerAction}</div>}
        </div>
      </div>

      <ManagementListSearch
        value={searchQuery}
        onValueChange={onSearchQueryChange}
        placeholder={t("prompts.searchPlaceholder")}
        ariaLabel={t("prompts.searchAriaLabel")}
        clearLabel={t("common.clear")}
      />

      <ScrollArea className="-mr-3 min-h-0 flex-1" type="auto">
        <div className="pb-16 pr-3">
          {loading ? (
            <div className="py-12 text-center text-muted-foreground">
              {t("prompts.loading")}
            </div>
          ) : promptEntries.length === 0 ? (
            <div className="py-12 text-center">
              <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-muted">
                <FileText size={24} className="text-muted-foreground" />
              </div>
              <h3 className="mb-2 text-lg font-medium text-foreground">
                {t("prompts.empty")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("prompts.emptyDescription")}
              </p>
            </div>
          ) : filteredPromptEntries.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
              <Search className="mb-4 h-10 w-10 opacity-40" />
              <p className="text-sm">{t("prompts.noSearchResults")}</p>
            </div>
          ) : (
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={filteredPromptEntries.map(([id]) => id)}
                strategy={verticalListSortingStrategy}
              >
                <div className="space-y-3">
                  {filteredPromptEntries.map(([id, prompt]) => (
                    <SortablePromptItem
                      key={id}
                      id={id}
                      prompt={prompt}
                      showDragHandle={showDragHandle}
                      dragDisabled={dragDisabled}
                      onToggle={onToggle}
                      onEdit={onEdit}
                      onDelete={onDelete}
                      orderIndex={enabledOrderMap.get(id)}
                      disabled={disabled}
                      deleteDisabled={isDeleteDisabled?.(id, prompt)}
                      deleteTitle={getDeleteTitle?.(id, prompt)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>
          )}
        </div>
      </ScrollArea>
    </>
  );
}
