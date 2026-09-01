import { useState } from 'react';
import { useStore } from '../../state/store.js';
import { listFolders } from '../../lib/collections.js';
import { Modal } from '../Modal.js';

/** "Save As" for a request that is not yet linked to a saved collection item (the builder's
 *  Save button opens this the first time; afterward `saveCurrentRequest()` with no target
 *  updates that same saved item in place, matching Postman's own Save vs Save As split). */
export function SaveRequestModal({ onClose }: { onClose: () => void }): React.JSX.Element {
  const request = useStore((s) => s.request);
  const collections = useStore((s) => s.collections);
  const createCollection = useStore((s) => s.createCollection);
  const saveCurrentRequest = useStore((s) => s.saveCurrentRequest);

  const [name, setName] = useState(request.name === 'Untitled request' ? '' : request.name);
  const [collectionId, setCollectionId] = useState(collections[0]?.id ?? '');
  const [folderId, setFolderId] = useState('');

  const selectedCollection = collections.find((c) => c.id === collectionId) ?? null;
  const folders = selectedCollection ? listFolders(selectedCollection) : [];

  function handleNewCollection(): void {
    createCollection();
    setTimeout(() => {
      const latest = useStore.getState().collections;
      const created = latest[latest.length - 1];
      if (created) setCollectionId(created.id);
    }, 0);
  }

  function handleSave(): void {
    const trimmed = name.trim();
    if (trimmed === '' || collectionId === '') return;
    saveCurrentRequest({ collectionId, parentFolderId: folderId === '' ? null : folderId, name: trimmed });
    onClose();
  }

  const canSave = name.trim() !== '' && collectionId !== '';

  return (
    <Modal title="Save Request" onClose={onClose}>
      <div className="space-y-4">
        <div>
          <label htmlFor="save-request-name" className="mb-1 block text-[11px] font-medium text-gym-text-faint">
            Request name
          </label>
          <input
            id="save-request-name"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Get authenticated user"
            className="w-full rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 text-xs text-gym-text placeholder:text-gym-text-faint focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
          />
        </div>

        <div>
          <label htmlFor="save-request-collection" className="mb-1 block text-[11px] font-medium text-gym-text-faint">
            Collection
          </label>
          <div className="flex gap-2">
            <select
              id="save-request-collection"
              value={collectionId}
              onChange={(e) => {
                setCollectionId(e.target.value);
                setFolderId('');
              }}
              className="min-w-0 flex-1 rounded-md border border-gym-border bg-gym-panel2 px-2 py-1.5 text-xs text-gym-text focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
            >
              {collections.length === 0 && <option value="">No collections yet</option>}
              {collections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleNewCollection}
              className="shrink-0 rounded-md border border-gym-border bg-gym-panel2 px-2.5 py-1.5 text-xs text-gym-text-dim hover:border-gym-accent-dim hover:text-gym-accent-soft"
            >
              New
            </button>
          </div>
        </div>

        {folders.length > 0 && (
          <div>
            <label htmlFor="save-request-folder" className="mb-1 block text-[11px] font-medium text-gym-text-faint">
              Folder
            </label>
            <select
              id="save-request-folder"
              value={folderId}
              onChange={(e) => setFolderId(e.target.value)}
              className="w-full rounded-md border border-gym-border bg-gym-panel2 px-2 py-1.5 text-xs text-gym-text focus:outline-none focus:ring-1 focus:ring-gym-accent-dim"
            >
              <option value="">Collection root</option>
              {folders.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.path}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="rounded-md px-3 py-1.5 text-xs text-gym-text-dim hover:text-gym-text">
            Cancel
          </button>
          <button
            type="button"
            disabled={!canSave}
            onClick={handleSave}
            className="rounded-md bg-gym-accent px-3.5 py-1.5 text-xs font-semibold text-gym-bg transition-opacity hover:opacity-90 disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </Modal>
  );
}
