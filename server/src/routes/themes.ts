/**
 * Themes (lib/custom-themes.ts).
 *
 *   GET    /api/themes                     { active, activeBase, builtIn, custom }
 *   POST   /api/themes                     { name, from }  duplicate a theme
 *   PUT    /api/themes/active              { id }          the theme in use for everyone
 *   PUT    /api/themes/:id                 { name }
 *   DELETE /api/themes/:id
 *   PUT    /api/themes/:id/assets          { path, dataBase64 }  replace a picture or sound
 *   DELETE /api/themes/:id/assets?path=    back to the original
 *   GET    /api/themes/:id/files?path=     a replaced file, to look at a theme not in use
 */
import { Router, type Response } from 'express';
import { listThemes, createTheme, renameTheme, deleteTheme, setActiveTheme, setAsset, revertAsset, overrideFile, ThemeError } from '../lib/custom-themes.js';

const router = Router();
function fail(res: Response, err: unknown): void {
  if (err instanceof ThemeError) { res.status(err.status).json({ error: err.message }); return; }
  console.error('[themes]', err);
  res.status(500).json({ error: 'the theme could not be changed' });
}
const ok = (res: Response, fn: () => unknown) => { try { res.json(fn()); } catch (err) { fail(res, err); } };

router.get('/', (_req, res) => ok(res, listThemes));
router.post('/', (req, res) => ok(res, () => createTheme(req.body ?? {})));
router.put('/active', (req, res) => ok(res, () => { setActiveTheme(String(req.body?.id ?? '')); return listThemes(); }));
router.put('/:id', (req, res) => ok(res, () => renameTheme(req.params.id, req.body?.name)));
router.delete('/:id', (req, res) => { try { deleteTheme(req.params.id); res.status(204).send(); } catch (err) { fail(res, err); } });
router.put('/:id/assets', (req, res) => ok(res, () => {
  const data = String(req.body?.dataBase64 ?? '');
  if (!data) throw new ThemeError('send the file (dataBase64)');
  return setAsset(req.params.id, req.body?.path, Buffer.from(data, 'base64'));
}));
router.delete('/:id/assets', (req, res) => ok(res, () => revertAsset(req.params.id, req.query.path)));
router.get('/:id/files', (req, res) => {
  const f = overrideFile(req.params.id, String(req.query.path ?? ''));
  if (!f) { res.status(404).json({ error: 'that theme does not replace this file' }); return; }
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(f);
});

export default router;
