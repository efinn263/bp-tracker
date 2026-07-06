/* ── DB v2: IndexedDB wrapper (adds notes store) ── */
const DB = (() => {
  const NAME = 'bp-tracker', VER = 2;
  let _db = null;

  function open() {
    return new Promise((res, rej) => {
      if (_db) return res(_db);
      const req = indexedDB.open(NAME, VER);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('readings')) {
          d.createObjectStore('readings',  { keyPath:'id' }).createIndex('ts','timestamp');
        }
        if (!d.objectStoreNames.contains('medEvents')) {
          d.createObjectStore('medEvents', { keyPath:'id' }).createIndex('ts','timestamp');
        }
        if (!d.objectStoreNames.contains('notes')) {
          d.createObjectStore('notes',     { keyPath:'id' }).createIndex('ts','timestamp');
        }
      };
      req.onsuccess = e => { _db = e.target.result; res(_db); };
      req.onerror   = e => rej(e.target.error);
    });
  }

  function tx(store, mode, fn) {
    return open().then(d => new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      const req = fn(s);
      if (req && typeof req.onsuccess !== 'undefined') {
        req.onsuccess = e => res(e.target.result);
        req.onerror   = e => rej(e.target.error);
      } else {
        t.oncomplete = () => res();
        t.onerror    = e => rej(e.target.error);
      }
    }));
  }

  function getRange(store, start, end) {
    return open().then(d => new Promise((res, rej) => {
      const idx = d.transaction(store,'readonly').objectStore(store).index('ts');
      const rng = (start&&end) ? IDBKeyRange.bound(+start,+end)
                : start        ? IDBKeyRange.lowerBound(+start)
                : end          ? IDBKeyRange.upperBound(+end) : null;
      const req = rng ? idx.getAll(rng) : idx.getAll();
      req.onsuccess = e => res(e.target.result);
      req.onerror   = e => rej(e.target.error);
    }));
  }

  function norm(r) {
    r.id        = r.id || crypto.randomUUID();
    r.timestamp = r.timestamp instanceof Date ? r.timestamp.getTime() : +r.timestamp;
    return r;
  }

  return {
    addReading:    r  => tx('readings',  'readwrite', s => s.put(norm(r))),
    deleteReading: id => tx('readings',  'readwrite', s => s.delete(id)),
    addMedEvent:   e  => tx('medEvents', 'readwrite', s => s.put(norm(e))),
    deleteMedEvent:id => tx('medEvents', 'readwrite', s => s.delete(id)),
    addNote:       n  => tx('notes',     'readwrite', s => s.put(norm(n))),
    deleteNote:    id => tx('notes',     'readwrite', s => s.delete(id)),
    countReadings: () => tx('readings',  'readonly',  s => s.count()),

    getReadings:  (s,e) => getRange('readings',  s, e),
    getMedEvents: (s,e) => getRange('medEvents', s, e),
    getNotes:     ()    => getRange('notes', null, null),

    async exportAll() {
      const [readings, medEvents, notes] = await Promise.all([
        this.getReadings(), this.getMedEvents(), this.getNotes()
      ]);
      return { version:2, exportedAt:new Date().toISOString(), readings, medEvents, notes };
    },

    async importAll(data, merge=false) {
      if (!merge) {
        await tx('readings',  'readwrite', s => s.clear());
        await tx('medEvents', 'readwrite', s => s.clear());
        await tx('notes',     'readwrite', s => s.clear());
      }
      for (const r of (data.readings   || [])) await this.addReading(norm(r));
      for (const e of (data.medEvents  || [])) await this.addMedEvent(norm(e));
      for (const n of (data.notes      || [])) await this.addNote(norm(n));
    },
  };
})();
