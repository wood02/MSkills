import { useEffect, useRef, useState } from "react";
import { Portal as TooltipPortal } from "@radix-ui/react-tooltip";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface SkillDescriptionProps {
  name: string;
  description: string;
  source?: string;
  className?: string;
  side?: "top" | "bottom";
}

export function SkillDescription({
  name,
  description,
  source,
  className,
  side = "bottom",
}: SkillDescriptionProps) {
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const [overflow, setOverflow] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const element = descriptionRef.current;
    if (!element) return;
    const measure = () =>
      setOverflow(
        element.scrollWidth > element.clientWidth ||
          element.scrollHeight > element.clientHeight,
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [description]);

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={0}>
      <Tooltip
        open={overflow && open}
        onOpenChange={setOpen}
        disableHoverableContent={false}
      >
        <TooltipTrigger asChild>
          <p
            ref={descriptionRef}
            tabIndex={overflow ? 0 : undefined}
            className={cn(
              "text-xs text-muted-foreground",
              className,
              overflow &&
                "cursor-help rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            )}
          >
            {description}
          </p>
        </TooltipTrigger>
        <TooltipPortal>
          <TooltipContent
            side={side}
            align="start"
            sideOffset={8}
            collisionPadding={16}
            className="flex w-[480px] max-w-[calc(100vw-2rem)] max-h-[min(320px,var(--radix-tooltip-content-available-height))] flex-col overflow-hidden rounded-lg border border-border bg-popover p-0 text-popover-foreground shadow-lg !animate-none"
          >
            <div className="flex shrink-0 items-baseline gap-2 px-4 pb-2 pt-3.5 text-[13px]">
              <span className="min-w-0 truncate font-medium">{name}</span>
              {source && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {source}
                </span>
              )}
            </div>
            <div className="min-h-0 overflow-y-auto whitespace-pre-wrap break-words select-text px-4 pb-4 text-[13px] leading-[1.75] [scrollbar-width:thin] [scrollbar-color:hsl(var(--border))_transparent]">
              {description}
            </div>
          </TooltipContent>
        </TooltipPortal>
      </Tooltip>
    </TooltipProvider>
  );
}
