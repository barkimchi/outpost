/**
 * Pure, immutable operations over the collection tree persisted in `workspace.json`
 * (`shared/src/api.ts`'s `Collection` / `CollectionItem`). The store (`state/store.ts`)
 * calls these and assigns the result; nothing here mutates its input, so every call is a
 * plain, testable function of (tree, ids) -> new tree.
 */
import type { Collection, CollectionFolderItem, CollectionItem, CollectionRequestItem, SavedRequest } from '@gym/shared';

function mapCollectionItems(items: CollectionItem[], itemId: string, fn: (item: CollectionItem) => CollectionItem): CollectionItem[] {
  return items.map((item) => {
    if (item.id === itemId) return fn(item);
    if (item.kind === 'folder') return { ...item, items: mapCollectionItems(item.items, itemId, fn) };
    return item;
  });
}

function removeFromItems(items: CollectionItem[], itemId: string): CollectionItem[] {
  const out: CollectionItem[] = [];
  for (const item of items) {
    if (item.id === itemId) continue;
    out.push(item.kind === 'folder' ? { ...item, items: removeFromItems(item.items, itemId) } : item);
  }
  return out;
}

function findInItems(items: CollectionItem[], itemId: string): CollectionItem | null {
  for (const item of items) {
    if (item.id === itemId) return item;
    if (item.kind === 'folder') {
      const found = findInItems(item.items, itemId);
      if (found) return found;
    }
  }
  return null;
}

export function findCollection(collections: Collection[], collectionId: string): Collection | null {
  return collections.find((c) => c.id === collectionId) ?? null;
}

export function findItem(collections: Collection[], collectionId: string, itemId: string): CollectionItem | null {
  const collection = findCollection(collections, collectionId);
  return collection ? findInItems(collection.items, itemId) : null;
}

export function findRequestItem(collections: Collection[], collectionId: string, itemId: string): CollectionRequestItem | null {
  const item = findItem(collections, collectionId, itemId);
  return item && item.kind === 'request' ? item : null;
}

export function renameCollection(collections: Collection[], collectionId: string, name: string): Collection[] {
  return collections.map((c) => (c.id === collectionId ? { ...c, name } : c));
}

export function deleteCollection(collections: Collection[], collectionId: string): Collection[] {
  return collections.filter((c) => c.id !== collectionId);
}

/** Renames a folder, or a request item's `request.name` (the name shown in the sidebar). */
export function renameItem(collections: Collection[], collectionId: string, itemId: string, name: string): Collection[] {
  return collections.map((c) => {
    if (c.id !== collectionId) return c;
    return {
      ...c,
      items: mapCollectionItems(c.items, itemId, (item) =>
        item.kind === 'folder' ? { ...item, name } : { ...item, request: { ...item.request, name } },
      ),
    };
  });
}

export function deleteItem(collections: Collection[], collectionId: string, itemId: string): Collection[] {
  return collections.map((c) => (c.id === collectionId ? { ...c, items: removeFromItems(c.items, itemId) } : c));
}

/** Inserts `item` at the root of a collection (`parentFolderId: null`) or inside a folder
 *  found anywhere in that collection's tree. No-ops (returns the tree unchanged) if
 *  `parentFolderId` is given but no such folder exists, rather than silently dropping the
 *  item into the wrong place. */
export function insertItem(collections: Collection[], collectionId: string, parentFolderId: string | null, item: CollectionItem): Collection[] {
  return collections.map((c) => {
    if (c.id !== collectionId) return c;
    if (parentFolderId === null) return { ...c, items: [...c.items, item] };
    return { ...c, items: insertIntoFolder(c.items, parentFolderId, item) };
  });
}

function insertIntoFolder(items: CollectionItem[], folderId: string, newItem: CollectionItem): CollectionItem[] {
  return items.map((item) => {
    if (item.kind !== 'folder') return item;
    if (item.id === folderId) return { ...item, items: [...item.items, newItem] };
    return { ...item, items: insertIntoFolder(item.items, folderId, newItem) };
  });
}

/** Replaces the `SavedRequest` payload of an existing request item in place (used by the
 *  builder's Save button when the current draft is linked to an already-saved request). */
export function updateRequestInTree(collections: Collection[], collectionId: string, itemId: string, request: SavedRequest): Collection[] {
  return collections.map((c) => {
    if (c.id !== collectionId) return c;
    return { ...c, items: mapCollectionItems(c.items, itemId, (item) => (item.kind === 'request' ? { ...item, request } : item)) };
  });
}

/** Every folder in a collection, flattened with a `/`-joined display path, for a "save
 *  into which folder" picker (`SaveRequestModal.tsx`). Depth-first, parent before child. */
export function listFolders(collection: Collection): Array<{ id: string; path: string }> {
  const out: Array<{ id: string; path: string }> = [];
  function walk(items: CollectionItem[], prefix: string): void {
    for (const item of items) {
      if (item.kind !== 'folder') continue;
      const path = prefix === '' ? item.name : `${prefix} / ${item.name}`;
      out.push({ id: item.id, path });
      walk(item.items, path);
    }
  }
  walk(collection.items, '');
  return out;
}

export function newFolder(id: string, name = 'New Folder'): CollectionFolderItem {
  return { kind: 'folder', id, name, items: [] };
}

export function newRequestItem(request: SavedRequest): CollectionRequestItem {
  return { kind: 'request', id: request.id, request };
}
