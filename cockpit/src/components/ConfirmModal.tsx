interface ConfirmModalProps {
  open: boolean;
  title: string;
  body: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  open,
  title,
  body,
  confirmLabel = "Confirm",
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-title"
    >
      <div className="w-full max-w-md rounded-xl border border-bevel bg-panel p-5 shadow-2xl">
        <h3 id="confirm-title" className="font-display text-xl font-bold tracking-wide uppercase">
          {title}
        </h3>
        <p className="mt-2 font-mono text-sm text-muted">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-bevel px-3 py-2 font-mono text-xs uppercase"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded-lg border border-red-glow bg-crimson/80 px-3 py-2 font-mono text-xs font-bold text-white uppercase shadow-[0_0_14px_rgba(255,42,42,0.45)]"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
