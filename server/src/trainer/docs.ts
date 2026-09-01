import type { Request, Response } from 'express';
import { getDoc, listDocs } from '../content/index.js';

/** `GET /_trainer/api/docs` and `GET /_trainer/api/docs/:id` handlers (docs/SPEC.md
 *  section 10), thin wrappers over `content/index.ts`'s registry. */

export function listDocsHandler(_req: Request, res: Response): void {
  res.json(listDocs());
}

export function getDocHandler(req: Request, res: Response): void {
  const id = req.params.id ?? '';
  const doc = getDoc(id);
  if (!doc) {
    res.status(404).json({ error: 'Not Found', message: `no such doc: ${id}` });
    return;
  }
  res.json(doc);
}
