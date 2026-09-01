import { describe, expect, it } from 'vitest';
import { defaultSavedRequest } from '@gym/shared';
import type { Collection } from '@gym/shared';
import { deleteItem, findRequestItem, insertItem, newFolder, newRequestItem, renameItem, updateRequestInTree } from './collections.js';

function emptyCollection(): Collection {
  return { id: 'c1', name: 'GitHub', items: [] };
}

describe('insertItem / findItem', () => {
  it('inserts a request at collection root and finds it back', () => {
    const req = newRequestItem(defaultSavedRequest('r1', 'Get user'));
    const collections = insertItem([emptyCollection()], 'c1', null, req);
    const found = findRequestItem(collections, 'c1', 'r1');
    expect(found?.request.name).toBe('Get user');
  });

  it('inserts into a nested folder, not the root', () => {
    const folder = newFolder('f1', 'Auth');
    let collections = insertItem([emptyCollection()], 'c1', null, folder);
    const req = newRequestItem(defaultSavedRequest('r1'));
    collections = insertItem(collections, 'c1', 'f1', req);

    expect(collections[0]?.items).toHaveLength(1);
    expect(collections[0]?.items[0]).toMatchObject({ kind: 'folder', id: 'f1' });
    const inFolder = (collections[0]?.items[0] as { items: unknown[] }).items;
    expect(inFolder).toHaveLength(1);
  });

  it('is a no-op when the target folder does not exist', () => {
    const collections = [emptyCollection()];
    const req = newRequestItem(defaultSavedRequest('r1'));
    const result = insertItem(collections, 'c1', 'nonexistent-folder', req);
    expect(result[0]?.items).toEqual([]);
  });
});

describe('renameItem', () => {
  it('renames a folder', () => {
    let collections = insertItem([emptyCollection()], 'c1', null, newFolder('f1', 'Old'));
    collections = renameItem(collections, 'c1', 'f1', 'New');
    expect(collections[0]?.items[0]).toMatchObject({ name: 'New' });
  });

  it('renames a request (updates request.name, not a separate item name)', () => {
    let collections = insertItem([emptyCollection()], 'c1', null, newRequestItem(defaultSavedRequest('r1', 'Old')));
    collections = renameItem(collections, 'c1', 'r1', 'New');
    expect(findRequestItem(collections, 'c1', 'r1')?.request.name).toBe('New');
  });
});

describe('deleteItem', () => {
  it('removes a request from a nested folder', () => {
    let collections = insertItem([emptyCollection()], 'c1', null, newFolder('f1'));
    collections = insertItem(collections, 'c1', 'f1', newRequestItem(defaultSavedRequest('r1')));
    collections = deleteItem(collections, 'c1', 'r1');
    expect(findRequestItem(collections, 'c1', 'r1')).toBeNull();
    // the folder itself survives
    expect(collections[0]?.items).toHaveLength(1);
  });

  it('removes a folder and everything inside it', () => {
    let collections = insertItem([emptyCollection()], 'c1', null, newFolder('f1'));
    collections = insertItem(collections, 'c1', 'f1', newRequestItem(defaultSavedRequest('r1')));
    collections = deleteItem(collections, 'c1', 'f1');
    expect(collections[0]?.items).toEqual([]);
  });
});

describe('updateRequestInTree', () => {
  it('replaces the saved payload of an existing request item, leaving its id/position alone', () => {
    let collections = insertItem([emptyCollection()], 'c1', null, newRequestItem(defaultSavedRequest('r1', 'Old')));
    const updated = { ...defaultSavedRequest('r1', 'Old'), url: 'http://x/y', method: 'POST' };
    collections = updateRequestInTree(collections, 'c1', 'r1', updated);
    expect(findRequestItem(collections, 'c1', 'r1')?.request).toMatchObject({ url: 'http://x/y', method: 'POST' });
  });
});
