import { useEffect } from 'react';
import { X } from 'lucide-react';

/** A small, shared modal chrome (backdrop + card + header + Escape-to-close) used by
 *  `EnvEditor`, `OAuthModal`, `CodeExportModal`, and `SaveRequestModal`, so the four
 *  Postman-clone modals this task adds all look and behave like one system rather than
 *  four independently reinvented dialogs. */
export function Modal({
  title,
  onClose,
  children,
  widthClassName = 'max-w-lg',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  widthClassName?: string;
}): React.JSX.Element {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className={`flex max-h-[85vh] w-full ${widthClassName} flex-col overflow-hidden rounded-lg border border-gym-border bg-gym-panel shadow-popover`}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-gym-border px-4 py-3">
          <h2 className="text-sm font-semibold text-gym-text">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-gym-text-faint hover:text-gym-text">
            <X size={15} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
      </div>
    </div>
  );
}
