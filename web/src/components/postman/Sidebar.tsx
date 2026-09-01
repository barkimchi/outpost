import { useState } from 'react';
import type { KeyboardEvent } from 'react';
import { ChevronRight, File, Folder, FolderOpen, Pencil, Plus, Settings2, Trash2 } from 'lucide-react';
import type { Collection, CollectionItem } from '@gym/shared';
import { useStore } from '../../state/store.js';
import { methodColor } from '../../lib/methodColors.js';
import { EnvEditor } from './EnvEditor.js';
import { ResetProgressControl } from '../ResetProgressControl.js';

/**
 * The collections sidebar (docs/SPEC.md section 13/4): create/rename/delete folders and
 * requests, click a saved request to load it into the builder, save the current request
 * into a collection. Also hosts the environment selector, since it is the one piece of
 * workspace chrome that is always on screen regardless of which request tab is active.
 */

function IconButton({ title, onClick, children, danger }: { title: string; onClick: () => void; children: React.ReactNode; danger?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`shrink-0 rounded p-0.5 text-gym-text-faint opacity-0 transition-opacity hover:text-gym-text group-hover:opacity-100 ${danger ? 'hover:text-gym-red' : ''}`}
    >
      {children}
    </button>
  );
}

function InlineNameField({ value, onSubmit, onCancel }: { value: string; onSubmit: (v: string) => void; onCancel: () => void }): React.JSX.Element {
  const [draft, setDraft] = useState(value);
  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Enter') {
      e.preventDefault();
      const trimmed = draft.trim();
      if (trimmed !== '') onSubmit(trimmed);
      else onCancel();
    } else if (e.key === 'Escape') {
      onCancel();
    }
  }
  return (
    <input
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => (draft.trim() !== '' ? onSubmit(draft.trim()) : onCancel())}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      className="min-w-0 flex-1 rounded border border-gym-accent-dim bg-gym-panel3 px-1 py-0.5 text-xs text-gym-text focus:outline-none"
    />
  );
}

function AddMenu({ onAddFolder, onAddRequest }: { onAddFolder: () => void; onAddRequest: () => void }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <IconButton
        title="Add to this collection"
        onClick={() => setOpen((o) => !o)}
      >
        <Plus size={12} />
      </IconButton>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-5 z-20 min-w-[140px] rounded-md border border-gym-border bg-gym-panel2 py-1 shadow-popover">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddFolder();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-gym-text-dim hover:bg-gym-panel3 hover:text-gym-text"
            >
              New folder
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onAddRequest();
              }}
              className="block w-full px-3 py-1.5 text-left text-xs text-gym-text-dim hover:bg-gym-panel3 hover:text-gym-text"
            >
              New request
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function ItemRow({
  collectionId,
  item,
  depth,
  expanded,
  onToggleExpand,
}: {
  collectionId: string;
  item: CollectionItem;
  depth: number;
  expanded: Set<string>;
  onToggleExpand: (id: string) => void;
}): React.JSX.Element {
  const draftLinkedTo = useStore((s) => s.draftLinkedTo);
  const loadRequestFromCollection = useStore((s) => s.loadRequestFromCollection);
  const renameCollectionItem = useStore((s) => s.renameCollectionItem);
  const deleteCollectionItem = useStore((s) => s.deleteCollectionItem);
  const createFolder = useStore((s) => s.createFolder);
  const createRequestItem = useStore((s) => s.createRequestItem);
  const [renaming, setRenaming] = useState(false);

  const isActive = item.kind === 'request' && draftLinkedTo?.collectionId === collectionId && draftLinkedTo.itemId === item.id;
  const isOpen = item.kind === 'folder' && expanded.has(item.id);
  const name = item.kind === 'folder' ? item.name : item.request.name;
  const indent = 8 + depth * 14;

  function handleDelete(): void {
    const label = item.kind === 'folder' ? 'this folder and everything inside it' : `"${name}"`;
    if (window.confirm(`Delete ${label}? This cannot be undone.`)) deleteCollectionItem(collectionId, item.id);
  }

  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => (item.kind === 'folder' ? onToggleExpand(item.id) : loadRequestFromCollection(collectionId, item.id))}
        onKeyDown={(e) => e.key === 'Enter' && (item.kind === 'folder' ? onToggleExpand(item.id) : loadRequestFromCollection(collectionId, item.id))}
        style={{ paddingLeft: indent }}
        className={`group flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-xs transition-colors ${
          isActive ? 'bg-gym-accent-dim/40 text-gym-text' : 'text-gym-text-dim hover:bg-gym-panel2 hover:text-gym-text'
        }`}
      >
        {item.kind === 'folder' ? (
          <>
            <ChevronRight size={12} className={`shrink-0 text-gym-text-faint transition-transform ${isOpen ? 'rotate-90' : ''}`} />
            {isOpen ? <FolderOpen size={13} className="shrink-0 text-gym-text-faint" /> : <Folder size={13} className="shrink-0 text-gym-text-faint" />}
          </>
        ) : (
          <>
            <span className="w-3 shrink-0" />
            <span className={`w-9 shrink-0 font-mono text-[9px] font-bold ${methodColor(item.request.method)}`}>{item.request.method}</span>
          </>
        )}
        {renaming ? (
          <InlineNameField
            value={name}
            onSubmit={(v) => {
              renameCollectionItem(collectionId, item.id, v);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate">{name}</span>
        )}
        {!renaming && (
          <div className="flex shrink-0 items-center gap-0.5">
            {item.kind === 'folder' && <AddMenu onAddFolder={() => createFolder(collectionId, item.id)} onAddRequest={() => createRequestItem(collectionId, item.id)} />}
            <IconButton title="Rename" onClick={() => setRenaming(true)}>
              <Pencil size={11} />
            </IconButton>
            <IconButton title="Delete" danger onClick={handleDelete}>
              <Trash2 size={11} />
            </IconButton>
          </div>
        )}
      </div>
      {item.kind === 'folder' && isOpen && (
        <div>
          {item.items.length === 0 && <p style={{ paddingLeft: indent + 18 }} className="py-1 text-[11px] italic text-gym-text-faint">Empty</p>}
          {item.items.map((child) => (
            <ItemRow key={child.id} collectionId={collectionId} item={child} depth={depth + 1} expanded={expanded} onToggleExpand={onToggleExpand} />
          ))}
        </div>
      )}
    </div>
  );
}

function CollectionBlock({ collection }: { collection: Collection }): React.JSX.Element {
  const [open, setOpen] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [renaming, setRenaming] = useState(false);
  const renameCollection = useStore((s) => s.renameCollection);
  const deleteCollection = useStore((s) => s.deleteCollection);
  const createFolder = useStore((s) => s.createFolder);
  const createRequestItem = useStore((s) => s.createRequestItem);

  function toggleExpand(id: string): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleDelete(): void {
    if (window.confirm(`Delete the "${collection.name}" collection and everything inside it? This cannot be undone.`)) deleteCollection(collection.id);
  }

  return (
    <div className="border-b border-gym-border/60 pb-1">
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === 'Enter' && setOpen((o) => !o)}
        className="group flex cursor-pointer items-center gap-1.5 py-1.5 pl-2 pr-2 text-xs font-semibold"
      >
        <ChevronRight size={12} className={`shrink-0 text-gym-text-faint transition-transform ${open ? 'rotate-90' : ''}`} />
        {renaming ? (
          <InlineNameField
            value={collection.name}
            onSubmit={(v) => {
              renameCollection(collection.id, v);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-gym-text">{collection.name}</span>
        )}
        {!renaming && (
          <div className="flex shrink-0 items-center gap-0.5">
            <AddMenu onAddFolder={() => createFolder(collection.id, null)} onAddRequest={() => createRequestItem(collection.id, null)} />
            <IconButton title="Rename collection" onClick={() => setRenaming(true)}>
              <Pencil size={11} />
            </IconButton>
            <IconButton title="Delete collection" danger onClick={handleDelete}>
              <Trash2 size={11} />
            </IconButton>
          </div>
        )}
      </div>
      {open && (
        <div>
          {collection.items.length === 0 && <p className="py-1 pl-8 text-[11px] italic text-gym-text-faint">No requests yet</p>}
          {collection.items.map((item) => (
            <ItemRow key={item.id} collectionId={collection.id} item={item} depth={0} expanded={expanded} onToggleExpand={toggleExpand} />
          ))}
        </div>
      )}
    </div>
  );
}

function EnvironmentSelector(): React.JSX.Element {
  const environments = useStore((s) => s.environments);
  const activeEnvironmentId = useStore((s) => s.activeEnvironmentId);
  const setActiveEnvironment = useStore((s) => s.setActiveEnvironment);
  const [editorOpen, setEditorOpen] = useState(false);

  return (
    <div className="flex items-center gap-1.5 border-b border-gym-border px-2 py-2">
      <select
        value={activeEnvironmentId ?? ''}
        onChange={(e) => setActiveEnvironment(e.target.value === '' ? null : e.target.value)}
        aria-label="Active environment"
        className="min-w-0 flex-1 rounded-md border border-gym-border bg-gym-panel2 px-2 py-1 text-xs text-gym-text focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
      >
        <option value="">No environment</option>
        {environments.map((env) => (
          <option key={env.id} value={env.id}>
            {env.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        title="Manage environments"
        onClick={() => setEditorOpen(true)}
        className="shrink-0 rounded-md border border-gym-border bg-gym-panel2 p-1.5 text-gym-text-dim hover:border-gym-border-strong hover:text-gym-text"
      >
        <Settings2 size={13} />
      </button>
      {editorOpen && <EnvEditor onClose={() => setEditorOpen(false)} />}
    </div>
  );
}

export function Sidebar(): React.JSX.Element {
  const collections = useStore((s) => s.collections);
  const createCollection = useStore((s) => s.createCollection);
  const newRequestDraft = useStore((s) => s.newRequestDraft);
  const workspaceLoaded = useStore((s) => s.workspaceLoaded);

  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-gym-border bg-gym-panel">
      <EnvironmentSelector />
      <div className="flex items-center justify-between border-b border-gym-border px-2.5 py-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-gym-text-faint">Collections</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            title="New blank request"
            onClick={newRequestDraft}
            className="rounded p-1 text-gym-text-faint hover:bg-gym-panel2 hover:text-gym-text"
          >
            <File size={13} />
          </button>
          <button
            type="button"
            title="New collection"
            onClick={() => createCollection()}
            className="rounded p-1 text-gym-text-faint hover:bg-gym-panel2 hover:text-gym-text"
          >
            <Plus size={13} />
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {!workspaceLoaded && <p className="px-3 py-4 text-center text-[11px] text-gym-text-faint">Loading workspace.</p>}
        {workspaceLoaded && collections.length === 0 && (
          <p className="px-3 py-4 text-center text-[11px] leading-relaxed text-gym-text-faint">
            No collections yet. Click + to create one, or Save from the request builder.
          </p>
        )}
        {collections.map((c) => (
          <CollectionBlock key={c.id} collection={c} />
        ))}
      </div>
      <ResetProgressControl />
    </div>
  );
}
