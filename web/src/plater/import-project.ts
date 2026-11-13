import type { Config } from '../api/types';
import type { LayerEvent, PlateObject, State } from '../state/store';
import type { ProjectItem } from './threemf';
import { getState, markStale, newId, setState, toast } from '../state/store';
import { documentGeneration, undoable } from '../state/history';
import { beginBusy } from '../state/busy';
import { importing } from '../flow/import';
import { importObjectsDialog } from '../components/Ask';
import { bedArea, newProject } from '../actions';
import { bakeStl, bedBounds, instanceBox, loadProject, nextFreeSpot, outsideBed } from './geometry';
import { listedPlates } from './plates';

type ImportedPlate = { index: number; objects: PlateObject[]; name?: string; settings?: Config; locked?: boolean; events?: LayerEvent[] };

function placeObjects(existing: PlateObject[], incoming: PlateObject[]): PlateObject[] {
  const area = bedArea();
  const placed = [...existing];
  const occupied = placed.flatMap((o) => o.instances.map((i) => instanceBox(o, i)));
  const collide = (a: ReturnType<typeof instanceBox>, b: ReturnType<typeof instanceBox>) =>
    a.min.x < b.max.x - 0.001 && a.max.x > b.min.x + 0.001 &&
    a.min.y < b.max.y - 0.001 && a.max.y > b.min.y + 0.001 &&
    a.min.z < b.max.z - 0.001 && a.max.z > b.min.z + 0.001;
  for (const object of incoming) {
    let next = object;
    if (outsideBed([object], area, Infinity).size || occupied.some((b) => collide(instanceBox(object, object.instances[0]), b))) {
      const spot = nextFreeSpot(placed, object, area) ?? bedBounds(area).center;
      next = { ...object, instances: object.instances.map((i) => ({ ...i, x: spot.x, y: spot.y })) };
    }
    placed.push(next);
  }
  return placed;
}

export function objectsPatch(state: State, imported: ImportedPlate[], filaments?: { colours: string[]; adopt: boolean }): Partial<State> {
  const needed = Math.max(0, ...imported.flatMap((p) => p.objects.map((o) => o.extruder)), filaments?.colours.length ?? 0);
  const slots = Math.max(1, state.filamentSlots.length, needed);
  const plates = listedPlates(state).map((p) => ({ ...p }));
  let nextIndex = Math.max(...plates.map((p) => p.index)) + 1;
  for (const [i, incoming] of imported.entries()) {
    const index = i === 0 ? state.plateIndex : nextIndex++;
    const previous = plates.find((p) => p.index === index);
    const objects = incoming.objects.map((o) => ({ ...o, extruder: Math.max(1, Math.min(slots, o.extruder)) }));
    if (previous) previous.objects = placeObjects(previous.objects, objects);
    else plates.push({ index, name: incoming.name ?? '', origin: [0, 0], settings: incoming.settings ?? {}, events: incoming.events ?? [],
      ...(incoming.locked ? { locked: true } : {}), objects: placeObjects([], objects) });
  }
  const active = plates.find((p) => p.index === state.plateIndex)!;
  const last = active.objects.at(-1);
  const patch: Partial<State> = { objects: active.objects, projectPlates: plates.length > 1 || state.projectPlates.length ? plates : [],
    selected: last ? { object: last.id, instance: last.instances[0].id, allInstances: true } : null,
    tab: 'prepare', job: markStale(state.job) };
  if (slots > state.filamentSlots.length) {
    patch.filamentSlots = [...state.filamentSlots, ...Array.from({ length: slots - state.filamentSlots.length }, () => state.filamentSlots.at(-1) ?? '')];
    patch.slotColours = [...state.slotColours, ...Array.from({ length: slots - state.slotColours.length }, () => undefined)];
  }
  if (filaments?.adopt && filaments.colours.length) patch.slotColours = filaments.colours.map((c) => c || undefined);
  return patch;
}

const filamentColoursOf = (settings: Config): string[] => {
  const value = settings.filament_colour;
  return (Array.isArray(value) ? value : typeof value === 'string' ? value.split(';') : []).map((c) => String(c ?? ''));
};

const uniformProfile = (profile: number[]): boolean => {
  if (profile.length < 6 || profile.length % 2) return false;
  const [_, first, second, third] = profile;
  if (second !== first || third !== first) return false;
  for (let i = 5; i < profile.length; i += 2) if (profile[i] !== profile[profile.length - 1]) return false;
  return true;
};

async function importObjectsNative(file: File, allowNew: boolean, sourceUrl?: string): Promise<number> {
  const generation = documentGeneration();
  const task = importing.begin('loading');
  const busy = beginBusy(`Reading ${file.name}`, task.signal);
  let committed = false;
  try {
    const { explodeProject } = await import('./explode');
    const result = await explodeProject(file);
    if (!task.current()) return 0;
    for (const plate of result.plates) for (const object of plate.objects) {
      if (sourceUrl) object.sourceUrl = sourceUrl;
      if (object.layerProfile && uniformProfile(object.layerProfile)) delete object.layerProfile;
    }
    const objects = result.plates.flatMap((p) => p.objects);
    if (!objects.length) throw new Error(`${file.name}: no 3D meshes found in this file`);
    const choice = await importObjectsDialog(file.name, objects.length, [], allowNew);
    if (!choice || !task.current() || generation !== documentGeneration()) return 0;
    if (choice === 'new') {
      task.done();
      if (!await newProject(true)) return 0;
    }
    if (choice !== 'new' && !task.current()) return 0;
    undoable('Import objects', () => setState((state) => objectsPatch(state, result.plates, { colours: filamentColoursOf(result.settings), adopt: choice === 'new' })));
    committed = true;
    task.done();
    return objects.length;
  } catch (error) {
    if (!committed) throw error;
    if (task.current()) { task.fail(error); toast(error instanceof Error ? error.message : String(error)); }
    return 0;
  } finally {
    busy.end();
    if (task.current()) task.done();
  }
}

export async function importObjects(file: File, allowNew = false, sourceUrl?: string): Promise<number> {
  const s = getState();
  if (s.features?.explode === true && !s.api?.mock) {
    try {
      return await importObjectsNative(file, allowNew, sourceUrl);
    } catch {
      // engine explode unavailable or failed before committing — parse the file in the browser instead
    }
  }
  return importObjectsParsed(file, allowNew, sourceUrl);
}

async function importObjectsParsed(file: File, allowNew = false, sourceUrl?: string): Promise<number> {
  const generation = documentGeneration();
  const task = importing.begin('loading');
  const busy = beginBusy(`Reading ${file.name}`, task.signal);
  const plates = new Map<number, ImportedPlate>();
  let items: ProjectItem[] = [], skipped: string[] = [], colours: string[] = [];
  const objects: PlateObject[] = [];
  let committed = false;
  try {
    await loadProject(file, {
      items(list, materials) { items = list; skipped = materials.skipped ?? []; colours = materials.colours ?? []; },
      mesh(i, geometry, centre) {
        if (!task.current()) { geometry.dispose(); return; }
        const item = items[i];
        const triangles = (geometry.index?.count ?? geometry.attributes.position.count) / 3;
        const object: PlateObject = { id: newId(), name: item.name, geometry, rotX: 0, rotY: 0, scale: [1, 1, 1],
          extruder: item.extruder, settings: {}, source: new File([], 'object.stl'),
          simplification: { trianglesBefore: triangles, trianglesAfter: triangles, maxErrorMm: 0, kept: 'original' }, ...(sourceUrl ? { sourceUrl } : {}), instances: [{ id: newId(), x: centre.x, y: centre.y, z: Math.max(0, centre.z), rotZ: 0 }] };
        objects.push(object);
        const plate = plates.get(item.plateIndex) ?? { index: item.plateIndex, objects: [] };
        plate.objects.push(object); plates.set(item.plateIndex, plate);
      },
      missing() { skipped.push('objects without meshes'); },
    }, true);
    busy.end();
    if (!task.current()) return 0;
    if (!objects.length) throw new Error(`${file.name}: no 3D meshes found in this file`);
    const choice = await importObjectsDialog(file.name, objects.length, [...new Set(skipped)], allowNew);
    if (!choice || !task.current() || generation !== documentGeneration()) return 0;
    const [{ blobDigest }, { assignBlobKey }] = await Promise.all([import('../api/blobs'), import('../persist/session')]);
    await Promise.all(objects.map(async (o) => {
      o.source = new File([await bakeStl(o)], `${o.name.replace(/\.[^.]+$/, '') || 'object'}.stl`, { type: 'model/stl' });
      assignBlobKey(o.source, `sha256-${await blobDigest(o.source)}`);
    }));
    if (!task.current()) return 0;
    if (choice === 'new') {
      task.done();
      if (!await newProject(true)) return 0;
    }
    if (choice !== 'new' && !task.current()) return 0;
    undoable('Import objects', () => setState((state) => objectsPatch(state, [...plates.values()].sort((a, b) => a.index - b.index), { colours, adopt: choice === 'new' })));
    committed = true;
    task.done();
    return objects.length;
  } catch (error) {
    if (task.current()) { task.fail(error); toast(error instanceof Error ? error.message : String(error)); }
    return 0;
  } finally {
    busy.end();
    if (!committed) for (const o of objects) o.geometry.dispose();
    if (task.current()) task.done();
  }
}
