/**
 * Toast — lightweight right-bottom stack used by the watched-folders
 * detail page (and any future caller). Each toast auto-dismisses after
 * a short interval; the parent owns the queue.
 *
 * Why we rolled our own instead of pulling a library:
 *   - the only call sites are the retry buttons; we don't need a
 *     general-purpose toast system
 *   - keeping the styling inline with the existing `border-* bg-*-50`
 *     Tailwind palette keeps the design coherent
 */
import { CheckCircle2, AlertTriangle, Info, X } from "lucide-react";
import { useEffect } from "react";
import { cn } from "../../lib/utils";
import type { Toast, ToastKind } from "../../hooks/useRetryStatus";

interface ToastStackProps {
  toasts: Toast[];
  onDismiss: (id: string) => void;
}

const KIND_STYLES: Record<ToastKind, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-800",
  error: "border-red-200 bg-red-50 text-red-800",
  info: "border-blue-200 bg-blue-50 text-blue-800"
};

const KIND_ICONS: Record<ToastKind, React.ReactNode> = {
  success: <CheckCircle2 className="h-4 w-4 shrink-0" />,
  error: <AlertTriangle className="h-4 w-4 shrink-0" />,
  info: <Info className="h-4 w-4 shrink-0" />
};

export function ToastStack(props: ToastStackProps) {
  return (
    <div
      // Fixed bottom-right. z-50 keeps us above modals/popovers; the
      // pointer-events-none wrapper lets clicks pass through the
      // gaps between toasts but the individual toast restores them.
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2"
    >
      {props.toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={props.onDismiss} />
      ))}
    </div>
  );
}

function ToastItem(props: { toast: Toast; onDismiss: (id: string) => void }) {
  const { toast } = props;
  // Gentle slide-in animation on mount. The keyframe is defined in
  // `web/src/styles.css` alongside the rest of the page's keyframes.
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        "pointer-events-auto flex items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-md toast-slide-in",
        KIND_STYLES[toast.kind]
      )}
    >
      {KIND_ICONS[toast.kind]}
      <span className="min-w-0 flex-1 break-words">{toast.message}</span>
      <button
        type="button"
        aria-label="dismiss"
        onClick={() => props.onDismiss(toast.id)}
        className="shrink-0 rounded p-0.5 opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

/**
 * Side-effect-free countdown hook that auto-calls onExpire once the
 * toast hits its `expiresAt`. Used as an opt-in belt-and-suspenders
 * alongside the timer in `useRetryStatus`.
 */
export function useToastAutoExpire(
  toast: Toast,
  onExpire: (id: string) => void
): void {
  useEffect(() => {
    const remaining = toast.expiresAt - Date.now();
    if (remaining <= 0) {
      onExpire(toast.id);
      return;
    }
    const timer = window.setTimeout(() => onExpire(toast.id), remaining);
    return () => window.clearTimeout(timer);
  }, [toast.id, toast.expiresAt, onExpire]);
}
