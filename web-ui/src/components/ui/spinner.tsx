import { Loader2 } from "lucide-react";

import { cn } from "@/components/ui/cn";

export function Spinner({ size = 16, className }: { size?: number; className?: string }): React.ReactElement {
	const diffColor = Boolean(className?.match(/\btext-/gi));
	return <Loader2 size={size} className={cn("animate-spin", !diffColor && "text-text-secondary", className)} />;
}
