/* ── Oxiline Pressure XS Pro sync (Web Bluetooth) ──
   Device protocol reverse-engineered from the official Oxiline Health app.
   Service 0xFFE0, notify 0xFFE1, write 0xFFE2 (write-with-response).
*/
const OxilineSync = (() => {

  const SERVICE_UUID = 0xffe0;
  const NOTIFY_UUID  = 0xffe1;
  const WRITE_UUID   = 0xffe2;

  const CMD_READ_CURRENT = [0xBE, 0xB0, 0x03, 0xD7, 0xFF, 0x02, 0x8D];
  const CMD_ADVANCE      = [0xBE, 0xB0, 0x02, 0x00, 0x00, 0x33, 0x00];

  const CONNECT_SETTLE_MS = 1000;
  const READ_TIMEOUT_MS   = 4000;
  const MAX_PARSE_RETRIES = 2;
  const MAX_RECORDS       = 500; // safety net against a runaway loop

  class OxilineSyncError extends Error {
    constructor(code, message, partialCount = 0) {
      super(message);
      this.code = code; // 'unsupported' | 'cancelled' | 'connect-failed' | 'mid-run-failure'
      this.partialCount = partialCount;
    }
  }

  function crc8Maxim(bytes) {
    let crc = 0;
    for (const b of bytes) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >> 1) ^ 0x8C : (crc >> 1);
    }
    return crc & 0xFF;
  }

  /* Decode one 16-byte D0 C2 0C CC record. Returns null if header doesn't match. */
  function decodeRecord(bytes) {
    if (!bytes || bytes.length < 16) return null;
    if (bytes[0] !== 0xD0 || bytes[1] !== 0xC2 || bytes[2] !== 0x0C || bytes[3] !== 0xCC) return null;
    const p = bytes.subarray(4, 16);
    const systolic  = p[0];
    const diastolic = p[1];
    const bpm       = p[2];
    const deviceFlag= p[3];
    const year      = (p[4] << 8) | p[5];
    const month     = p[6];
    const day       = p[7];
    const hour      = p[8];
    const minute    = p[9];
    const second    = p[10];
    const crc       = p[11];
    const crcOk     = crc8Maxim(bytes.subarray(0, 15)) === crc;
    const timestamp = new Date(year, month - 1, day, hour, minute, second).getTime();
    return { systolic, diastolic, bpm, deviceFlag, timestamp, crcOk };
  }

  /* ── Self-check against confirmed test vectors (non-fatal, logs only) ── */
  (function selfCheck() {
    const vectors = [
      ['D0 C2 0C CC 90 57 38 10 07 EA 07 07 0E 31 1A 00', 144, 87, 56, 2026, 7, 7, 14, 49, 26],
      ['D0 C2 0C CC 7A 49 36 10 07 EA 07 07 0F 06 2E 23', 122, 73, 54, 2026, 7, 7, 15, 6, 46],
      ['D0 C2 0C CC 74 4D 3B 11 07 EA 07 07 14 34 39 33', 116, 77, 59, 2026, 7, 7, 20, 52, 57],
      ['D0 C2 0C CC 7F 55 38 11 07 EA 07 07 13 07 02 A8', 127, 85, 56, 2026, 7, 7, 19, 7, 2],
      ['D0 C2 0C CC 7D 53 39 10 07 EA 07 07 11 29 23 45', 125, 83, 57, 2026, 7, 7, 17, 41, 35],
    ];
    for (const [hex, sys, dia, bpm, y, mo, d, h, mi, s] of vectors) {
      const bytes = new Uint8Array(hex.split(' ').map(h => parseInt(h, 16)));
      const rec = decodeRecord(bytes);
      const expected = new Date(y, mo - 1, d, h, mi, s).getTime();
      const ok = rec && rec.systolic === sys && rec.diastolic === dia && rec.bpm === bpm &&
                 rec.timestamp === expected && rec.crcOk;
      if (!ok) console.error('[OxilineSync] self-check FAILED for vector', hex, rec);
    }
  })();

  function isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  function waitForNotification(char, timeoutMs) {
    return new Promise(resolve => {
      let done = false;
      const timer = setTimeout(() => {
        if (done) return;
        done = true;
        char.removeEventListener('characteristicvaluechanged', onValue);
        resolve(null);
      }, timeoutMs);
      function onValue(e) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        char.removeEventListener('characteristicvaluechanged', onValue);
        resolve(new Uint8Array(e.target.value.buffer));
      }
      char.addEventListener('characteristicvaluechanged', onValue);
    });
  }

  async function writeCmd(char, arr) {
    const data = new Uint8Array(arr);
    if (char.writeValueWithResponse) await char.writeValueWithResponse(data);
    else await char.writeValue(data);
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* ── Main sync sequence ──
     opts.onStatus(stage, info): 'connecting' | 'in-progress' | 'stopping'
     opts.onRecord(record): async, called for each valid decoded record (device order: newest → oldest)
     Resolves { count, stopReason } on a clean finish.
     Rejects with OxilineSyncError on failure (partialCount = records saved so far).
  */
  async function sync(opts = {}) {
    const onStatus = opts.onStatus || (() => {});
    const onRecord = opts.onRecord || (() => {});

    if (!isSupported()) throw new OxilineSyncError('unsupported', 'Web Bluetooth not available');

    let device, count = 0, disconnectedUnexpectedly = false;

    function armDisconnectWatch() {
      device.addEventListener('gattserverdisconnected', () => {
        disconnectedUnexpectedly = true;
      }, { once: true });
    }

    onStatus('connecting');
    try {
      device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: 'XS' }],
        optionalServices: [SERVICE_UUID],
      });
    } catch (err) {
      if (err && err.name === 'NotFoundError' && /cancel/i.test(err.message || '')) {
        throw new OxilineSyncError('cancelled', 'User cancelled device selection');
      }
      throw new OxilineSyncError('connect-failed', err && err.message || 'Could not find device');
    }

    let server, ffe1, ffe2;
    try {
      armDisconnectWatch();
      server = await device.gatt.connect();
      const service = await server.getPrimaryService(SERVICE_UUID);
      ffe1 = await service.getCharacteristic(NOTIFY_UUID);
      ffe2 = await service.getCharacteristic(WRITE_UUID);
      await ffe1.startNotifications();
    } catch (err) {
      try { device.gatt.disconnect(); } catch {}
      throw new OxilineSyncError('connect-failed', err && err.message || 'Could not connect to device');
    }

    try {
      await sleep(CONNECT_SETTLE_MS);

      let lastTimestamp = null;
      let stopReason = 'done';
      let cmd = CMD_READ_CURRENT;

      while (count < MAX_RECORDS) {
        if (disconnectedUnexpectedly) throw new OxilineSyncError('mid-run-failure', 'Device disconnected', count);

        let record = null, attempt = 0;
        while (attempt <= MAX_PARSE_RETRIES) {
          await writeCmd(ffe2, cmd);
          const raw = await waitForNotification(ffe1, READ_TIMEOUT_MS);
          if (disconnectedUnexpectedly) throw new OxilineSyncError('mid-run-failure', 'Device disconnected', count);
          if (!raw) { stopReason = 'timeout'; record = null; break; }
          record = decodeRecord(raw);
          if (record && record.crcOk) break;
          attempt++;
          record = null;
          // retry: re-send the same command silently
        }

        if (!record) {
          if (stopReason !== 'timeout') stopReason = 'parse-error';
          break;
        }

        if (lastTimestamp !== null && record.timestamp === lastTimestamp) {
          stopReason = 'reached-oldest';
          break;
        }
        lastTimestamp = record.timestamp;

        onStatus('in-progress', { count: count + 1 });
        await onRecord(record);
        count++;

        cmd = CMD_ADVANCE;
      }

      return { count, stopReason };
    } finally {
      try { await ffe1.stopNotifications(); } catch {}
      try { device.gatt.disconnect(); } catch {}
    }
  }

  return { isSupported, sync, decodeRecord, crc8Maxim, OxilineSyncError, CMD_READ_CURRENT, CMD_ADVANCE };
})();
