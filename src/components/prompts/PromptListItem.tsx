import React from "react";
import type {
  DraggableAttributes,
  DraggableSyntheticListeners,
} from "@dnd-kit/core";
import { useTranslation } from "react-i18next";
import { Edit3, GripVertical, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Prompt } from "@/lib/api";
import PromptToggle from "./PromptToggle";

export interface PromptDragHandleProps {
  attributes: DraggableAttributes;
  listeners?: DraggableSyntheticListeners;
  isDragging?: boolean;
  disabled?: boolean;
}

interface PromptListItemProps {
  id: string;
  prompt: Prompt;
  onToggle: (id: string, enabled: boolean) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  orderIndex?: number;
  dragHandleProps?: PromptDragHandleProps;
  disabled?: boolean;
  deleteDisabled?: boolean;
  deleteTitle?: string;
}

const PromptListItem: React.FC<PromptListItemProps> = ({
  id,
  prompt,
  onToggle,
  onEdit,
  onDelete,
  orderIndex,
  dragHandleProps,
  disabled = false,
  deleteDisabled = false,
  deleteTitle,
}) => {
  const { t } = useTranslation();

  const enabled = prompt.enabled === true;
  const deleteLabel = deleteTitle ?? t("common.delete");

  return (
    <div
      className={cn(
        "group relative h-16 rounded-xl border border-border-default bg-muted/50 p-4 transition-all duration-300 hover:bg-muted hover:border-border-default/80 hover:shadow-sm",
        dragHandleProps?.isDragging &&
          "relative z-10 border-primary/40 bg-muted shadow-md",
      )}
    >
      <div className="flex items-center gap-3 h-full">
        {dragHandleProps && (
          <button
            type="button"
            disabled={dragHandleProps.disabled}
            aria-label={t("prompts.dragHandle")}
            title={
              dragHandleProps.disabled
                ? t("prompts.dragHandleDisabled")
                : t("prompts.dragHandle")
            }
            className={cn(
              "-ml-1.5 flex-shrink-0 rounded p-1 text-muted-foreground/50 transition-colors",
              dragHandleProps.disabled
                ? "cursor-not-allowed opacity-35"
                : "cursor-grab hover:text-muted-foreground active:cursor-grabbing",
              dragHandleProps.isDragging && "cursor-grabbing text-foreground",
            )}
            {...(dragHandleProps.disabled ? {} : dragHandleProps.attributes)}
            {...(dragHandleProps.disabled ? {} : dragHandleProps.listeners)}
          >
            <GripVertical className="h-4 w-4" />
          </button>
        )}

        {/* Toggle 开关 */}
        <div className="flex-shrink-0">
          <PromptToggle
            enabled={enabled}
            onChange={(newEnabled) => onToggle(id, newEnabled)}
            disabled={disabled}
          />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 min-w-0">
            <h3 className="font-medium text-foreground truncate">
              {prompt.name}
            </h3>
            {orderIndex !== undefined && (
              <span
                className="inline-flex shrink-0 items-center rounded bg-emerald-500/15 px-1.5 py-0.5 text-[11px] font-mono font-medium text-emerald-600 dark:text-emerald-400"
                title={t("prompts.concatOrderTitle", { order: orderIndex })}
              >
                #{orderIndex}
              </span>
            )}
          </div>
          {prompt.description && (
            <p className="text-sm text-muted-foreground truncate">
              {prompt.description}
            </p>
          )}
        </div>

        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => onEdit(id)}
            disabled={disabled}
            className="disabled:opacity-100"
            title={t("common.edit")}
          >
            <Edit3 size={16} />
          </Button>
          {deleteDisabled ? (
            <span
              title={deleteLabel}
              onClick={disabled ? undefined : () => toast.info(deleteLabel)}
              className="inline-flex cursor-not-allowed"
            >
              <Button
                type="button"
                variant="ghost"
                size="icon"
                disabled
                aria-label={deleteLabel}
                className="disabled:opacity-35"
              >
                <Trash2 size={16} />
              </Button>
            </span>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => onDelete(id)}
              disabled={disabled}
              className="hover:text-red-500 hover:bg-red-100 disabled:opacity-100 dark:hover:text-red-400 dark:hover:bg-red-500/10"
              title={deleteLabel}
            >
              <Trash2 size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default PromptListItem;
